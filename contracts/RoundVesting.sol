// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RoundVesting
 * @notice Holds BONA bought in sale rounds and releases it linearly over six
 *         months from the round's close.
 *         https://bonabuild.org
 *
 * @dev DESIGN: what this contract deliberately does NOT have.
 *
 *      - No revoke / clawback.   Once a grant exists, nobody can cancel it,
 *                                reduce it, or redirect it. Buyers paid for
 *                                these tokens.
 *
 *      - No sweep / rescue.      No path exists for anyone to withdraw the
 *                                token held here except a buyer claiming what
 *                                has vested for them.
 *
 *      - No owner, no roles.     A single `funder` address, fixed at
 *                                deployment, whose only powers are to
 *                                authorise and de-authorise granter contracts.
 *                                It cannot move tokens.
 *
 *      - No schedule changes.    A grant's amount, start and duration are
 *                                written once and never updated.
 *
 *      - No pause.               Claiming cannot be halted.
 *
 * @dev WHY A FAILED ROUND NEEDS NO CANCELLATION PATH.
 *
 *      A round that misses its floor refunds every buyer from its own escrow.
 *      The obvious implementation — grant on each contribution, then void the
 *      grants if the round fails — would require a cancellation power over
 *      tokens already granted, and that power would then exist for every
 *      round, including the successful ones.
 *
 *      So grants are created only AFTER a round settles. Before settlement
 *      this contract knows nothing about the round at all, and a failed round
 *      has nothing here to undo. The cancellation case is designed out rather
 *      than guarded against.
 *
 * @dev WHY BUYERS PULL THEIR OWN GRANT.
 *
 *      A settling round could loop over its buyers and grant to each, but a
 *      round with a few thousand buyers would exceed the block gas limit and
 *      strand everyone. Instead the round contract calls `grant` once per
 *      buyer, when that buyer claims. Each buyer pays their own gas and no
 *      round can become too large to settle.
 *
 * @dev WHY EACH GRANT IS INDEPENDENT.
 *
 *      A schedule computed against `balance + released` — the common pattern,
 *      including OpenZeppelin's VestingWallet — treats tokens added later as
 *      retroactively vested. A buyer in round two would find part of it
 *      unlocked on arrival. Here every grant carries its own start and
 *      duration, so a grant always begins at 0% vested, and a buyer's
 *      releasable balance is the sum across their grants.
 *
 * @dev VOTING WEIGHT.
 *
 *      `unclaimedOf` exists so the Snapshot strategy can read
 *      `wallet balance + unclaimed vesting balance`. Without it a buyer would
 *      pay for a round and then be unable to vote in it, which is the one
 *      failure this project cannot ship: they would have been sold something
 *      other than what was advertised.
 */
contract RoundVesting {
    using SafeERC20 for IERC20;

    /// @notice The token being vested.
    IERC20 public immutable token;

    /**
     * @notice The only address that may authorise granters.
     *         This must be the project multisig. It can never move tokens.
     */
    address public immutable funder;

    /// @notice Contract deployment time. Grants may not start before it.
    uint64 public immutable deployedAt;

    /// @notice Hard cap: 30,000,000 BONA, the published sale-round pool.
    uint256 public constant MAX_TOTAL = 30_000_000 * 1e18;

    /**
     * @notice Minimum vesting duration: 180 days.
     * @dev Makes "six months" a property of the contract rather than a policy
     *      a granter could quietly ignore. Without it, an authorised round
     *      could set a one-second duration and the lock would not exist.
     */
    uint64 public constant MIN_DURATION = 180 days;

    /**
     * @notice Maximum vesting duration: 5 years.
     * @dev Not a policy choice — a safety rail with two jobs. A duration near
     *      uint64-max makes `start + duration` overflow, which in 0.8 reverts,
     *      which bricks `vestedAmount` — and with it every claim the
     *      beneficiary has, forever, because there is deliberately no admin
     *      path to intervene. And any absurdly long schedule is a mistake by
     *      definition: the published schedule is six months. (L-1)
     */
    uint64 public constant MAX_VESTING_DURATION = 1825 days;

    /**
     * @notice How far in the past a grant may start: 30 days.
     * @dev A round settles days after it closes, and buyers should vest from
     *      the close rather than from whenever they got round to claiming. But
     *      unbounded backdating would let a granter set a start six months ago
     *      and hand over fully vested tokens. Bounded at 30 days against a
     *      180-day minimum, at most one sixth of a grant can be vested when it
     *      is created.
     */
    uint64 public constant MAX_BACKDATE = 30 days;

    /**
     * @param amount   Tokens in this grant.
     * @param start    When linear release begins. No cliff.
     * @param duration Seconds over which it releases linearly.
     * @param granter  The round contract that created it — the public record
     *                 of which round a buyer's tokens came from.
     */
    struct Grant {
        uint128 amount;
        uint64 start;
        uint64 duration;
        address granter;
    }

    mapping(address => Grant[]) private _grants;

    /// @notice Tokens already claimed by each buyer.
    mapping(address => uint256) public released;

    /// @notice Total ever granted to each buyer, across all rounds.
    mapping(address => uint256) public grantedTo;

    /// @notice Contracts allowed to create grants. Round contracts, one per round.
    mapping(address => bool) public isGranter;

    /// @notice Total ever granted by each granter — per-round totals, publicly readable.
    mapping(address => uint256) public grantedBy;

    /// @notice Total funded into this contract.
    uint256 public totalGranted;

    /// @notice Total claimed out of this contract.
    uint256 public totalReleased;

    event GranterAuthorised(address indexed granter);
    event GranterRevoked(address indexed granter);
    event Granted(
        address indexed beneficiary,
        address indexed granter,
        uint256 amount,
        uint64 start,
        uint64 duration
    );
    event Released(address indexed beneficiary, uint256 amount);

    error NotFunder();
    error NotGranter();
    error ZeroAddress();
    error NotAContract();
    error AlreadyGranter();
    error UnknownGranter();
    error ZeroAmount();
    error DurationTooShort();
    error DurationTooLong();
    error StartBeforeDeployment();
    error StartTooFarInPast();
    error ExceedsTotalCap();
    error NothingToRelease();

    modifier onlyFunder() {
        if (msg.sender != funder) revert NotFunder();
        _;
    }

    /**
     * @param token_  The BONA token.
     * @param funder_ The project multisig. Never an EOA.
     */
    constructor(IERC20 token_, address funder_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (funder_ == address(0)) revert ZeroAddress();
        token = token_;
        funder = funder_;
        deployedAt = uint64(block.timestamp);
    }

    // ---------------------------------------------------------------------
    // Funder actions. Neither can move tokens.
    // ---------------------------------------------------------------------

    /**
     * @notice Authorise a round contract to create grants.
     * @dev Must be a contract. An EOA granter would mean a single key could
     *      write grants against the sale pool, which is exactly the shape of
     *      privilege this project refuses.
     */
    function authoriseGranter(address granter) external onlyFunder {
        if (granter == address(0)) revert ZeroAddress();
        if (isGranter[granter]) revert AlreadyGranter();
        if (granter.code.length == 0) revert NotAContract();

        isGranter[granter] = true;
        emit GranterAuthorised(granter);
    }

    /**
     * @notice Stop a round contract from creating further grants.
     * @dev Existing grants are untouched and keep vesting. This ends a round's
     *      ability to write new ones; it cannot undo what it already wrote.
     */
    function revokeGranter(address granter) external onlyFunder {
        if (!isGranter[granter]) revert UnknownGranter();
        isGranter[granter] = false;
        emit GranterRevoked(granter);
    }

    // ---------------------------------------------------------------------
    // Granter action
    // ---------------------------------------------------------------------

    /**
     * @notice Create a vesting grant. Pulls the tokens from the calling round.
     * @dev Called by a settled round contract when a buyer claims. The round
     *      must have approved this contract for `amount` first.
     *
     * @param beneficiary The buyer.
     * @param amount      Tokens purchased in the round.
     * @param start       The round's close. Bounded by MAX_BACKDATE.
     * @param duration    At least MIN_DURATION.
     */
    function grant(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration
    ) external {
        if (!isGranter[msg.sender]) revert NotGranter();
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration < MIN_DURATION) revert DurationTooShort();
        if (duration > MAX_VESTING_DURATION) revert DurationTooLong();
        if (start < deployedAt) revert StartBeforeDeployment();
        if (start + MAX_BACKDATE < block.timestamp) revert StartTooFarInPast();
        if (totalGranted + amount > MAX_TOTAL) revert ExceedsTotalCap();

        grantedTo[beneficiary] += amount;
        grantedBy[msg.sender] += amount;
        totalGranted += amount;
        _grants[beneficiary].push(
            Grant({
                amount: uint128(amount),
                start: start,
                duration: duration,
                granter: msg.sender
            })
        );

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Granted(beneficiary, msg.sender, amount, start, duration);
    }

    // ---------------------------------------------------------------------
    // Beneficiary action
    // ---------------------------------------------------------------------

    /// @notice Claim everything vested and not yet claimed.
    function release() external {
        uint256 amount = releasable(msg.sender);
        if (amount == 0) revert NothingToRelease();

        released[msg.sender] += amount;
        totalReleased += amount;

        token.safeTransfer(msg.sender, amount);
        emit Released(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Total vested for `beneficiary` at `timestamp`, across all grants.
    function vestedAmount(address beneficiary, uint64 timestamp)
        public
        view
        returns (uint256 total)
    {
        Grant[] storage grants = _grants[beneficiary];
        for (uint256 i = 0; i < grants.length; ++i) {
            Grant storage g = grants[i];
            if (timestamp <= g.start) {
                continue;
            }
            if (timestamp >= g.start + g.duration) {
                total += g.amount;
            } else {
                total += (uint256(g.amount) * (timestamp - g.start)) / g.duration;
            }
        }
    }

    /// @notice Vested but not yet claimed — what `release()` would pay right now.
    function releasable(address beneficiary) public view returns (uint256) {
        return vestedAmount(beneficiary, uint64(block.timestamp)) - released[beneficiary];
    }

    /**
     * @notice Everything still held here for `beneficiary`, vested or not.
     * @dev The value the Snapshot `contract-call` strategy reads, so voting
     *      weight is `wallet balance + unclaimed vesting balance` and a buyer
     *      can vote from the day they pay.
     */
    function unclaimedOf(address beneficiary) external view returns (uint256) {
        return grantedTo[beneficiary] - released[beneficiary];
    }

    /// @notice Number of grants held for `beneficiary`.
    function grantCount(address beneficiary) external view returns (uint256) {
        return _grants[beneficiary].length;
    }

    /// @notice One grant, by index.
    function grantAt(address beneficiary, uint256 index)
        external
        view
        returns (uint256 amount, uint64 start, uint64 duration, address granter)
    {
        Grant storage g = _grants[beneficiary][index];
        return (g.amount, g.start, g.duration, g.granter);
    }

    /// @notice What remains grantable against the 30,000,000 sale pool.
    function remainingPool() external view returns (uint256) {
        return MAX_TOTAL - totalGranted;
    }
}
