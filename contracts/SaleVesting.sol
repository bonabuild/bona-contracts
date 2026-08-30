// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SaleVesting
 * @notice Holds BONA bought from the project and releases it linearly over six
 *         months from the day of purchase.
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
 *                                deployment, whose only powers are to reserve
 *                                capacity for a granter contract and to
 *                                release capacity that granter has not used.
 *                                It cannot move tokens.
 *
 *      - No schedule changes.    A grant's amount, start and duration are
 *                                written once and never updated.
 *
 *      - No pause.               Claiming cannot be halted.
 *
 * @dev WHY CAPACITY IS RESERVED UP FRONT, NOT CHECKED AT GRANT TIME.
 *
 *      An external review of the previous version found the failure this
 *      design exists to prevent, and it is worth stating in full because it
 *      is subtle and it fires late.
 *
 *      That version checked `totalGranted + amount > MAX_TOTAL` inside
 *      `grant`. First come, first served. Two granters whose combined
 *      allocations exceeded the remaining capacity would each work fine until
 *      the pool ran low, and then a buyer's grant would simply revert. If the
 *      granter had already taken that buyer's money, the money was gone and
 *      the BONA was unreachable: exactly the outcome, paid but unable to
 *      claim, that the rest of this system is arranged to make impossible. It
 *      would have surfaced near exhaustion, which is when the most money has
 *      been taken.
 *
 *      So capacity is reserved when a granter is authorised. The funder
 *      cannot reserve more than remains, and `grant` draws only against the
 *      caller's own reservation. A granter can never be starved by another
 *      granter's activity, and the cap is enforced once, at authorisation,
 *      where a mistake is still free to fix.
 *
 * @dev WHY A GRANTER CAN COMMIT PART OF ITS RESERVATION.
 *
 *      The same review found that de-authorising a granter blocked buyers who
 *      had paid but not yet claimed. Here, releasing a reservation is the
 *      funder's only way to stop a granter, and it cannot reach below what
 *      that granter has committed. A sale contract that separates payment
 *      from claiming calls `commit` for what it owes; a sale contract that
 *      writes the grant in the same transaction as the payment, which is what
 *      this project deploys, has nothing to commit, because it never carries
 *      an obligation across two transactions.
 *
 *      `commit` only ever raises the floor. Nothing lowers it but granting.
 *
 * @dev WHY EACH GRANT IS INDEPENDENT.
 *
 *      A schedule computed against `balance + released`, the common pattern
 *      and the one OpenZeppelin's VestingWallet uses, treats tokens added
 *      later as retroactively vested. A second purchase would arrive
 *      part-unlocked. Here every grant carries its own start and duration, so
 *      a grant always begins at 0% vested, and a buyer's releasable balance
 *      is the sum across their grants.
 *
 * @dev VOTING WEIGHT.
 *
 *      `unclaimedOf` exists so the Snapshot strategy can read
 *      `wallet balance + unclaimed vesting balance`. Without it a buyer would
 *      pay and then be unable to vote, which is the one failure this project
 *      cannot ship: they would have been sold something other than what was
 *      advertised.
 */
contract SaleVesting {
    using SafeERC20 for IERC20;

    /// @notice The token being vested.
    IERC20 public immutable token;

    /**
     * @notice The project multisig. Reserves and releases capacity, nothing
     *         else. It cannot move a token held here.
     */
    address public immutable funder;

    /// @notice Contract deployment time. Grants may not start before it.
    uint64 public immutable deployedAt;

    /// @notice Hard cap: 60,000,000 BONA, the published sale allocation.
    uint256 public constant MAX_TOTAL = 60_000_000 * 1e18;

    /**
     * @notice Shortest vesting a granter may write: six months.
     * @dev The published lock, enforced here rather than promised. An
     *      authorised sale contract cannot quietly grant over one second.
     */
    uint64 public constant MIN_DURATION = 180 days;

    /**
     * @notice Longest vesting a granter may write: five years.
     * @dev An oversized duration would overflow the vesting arithmetic and
     *      brick the beneficiary permanently. (L-1)
     */
    uint64 public constant MAX_VESTING_DURATION = 1825 days;

    /**
     * @notice How far in the past a grant may start: thirty days.
     * @dev Lets a sale date a grant from the moment of purchase without
     *      letting a granter hand over tokens that are already vested. At
     *      worst one sixth of a grant can be vested at creation.
     */
    uint64 public constant MAX_BACKDATE = 30 days;

    /**
     * @notice Most grants one beneficiary may hold: 500.
     * @dev `vestedAmount` loops over a beneficiary's grants, so an unbounded
     *      count is a gas limit waiting to be hit — and the person who hits it
     *      is the buyer, who then cannot call `release()` at all. Their own
     *      tokens would be stranded by their own purchases.
     *
     *      500 is far above any honest buying pattern and far below the gas
     *      limit, so the bound never binds in practice and always binds in
     *      theory. A buyer at the limit keeps everything already granted; they
     *      simply cannot add a 501st grant to the same address.
     */
    uint256 public constant MAX_GRANTS_PER_BENEFICIARY = 500;

    struct Grant {
        uint128 amount;
        uint64 start;
        uint64 duration;
        address granter;
    }

    mapping(address => Grant[]) private _grants;

    /// @notice Tokens already claimed by each buyer.
    mapping(address => uint256) public released;

    /// @notice Total ever granted to each buyer, across all purchases.
    mapping(address => uint256) public grantedTo;

    /// @notice Capacity still available to each granter. Granting spends it.
    mapping(address => uint256) public reservationOf;

    /// @notice The floor a granter's reservation cannot be released below.
    mapping(address => uint256) public committedOf;

    /// @notice Total ever granted by each granter, publicly readable.
    mapping(address => uint256) public grantedBy;

    /// @notice Reserved across all granters, granted or not. Never above MAX_TOTAL.
    uint256 public totalReserved;

    /// @notice Total granted into this contract.
    uint256 public totalGranted;

    /// @notice Total claimed out of this contract.
    uint256 public totalReleased;

    event CapacityReserved(address indexed granter, uint256 amount, uint256 reservation);
    event CapacityReleased(address indexed granter, uint256 amount, uint256 reservation);
    event Committed(address indexed granter, uint256 committed);
    event Granted(
        address indexed beneficiary,
        address indexed granter,
        uint256 amount,
        uint64 start,
        uint64 duration
    );
    event Released(address indexed beneficiary, uint256 amount);

    error NotFunder();
    error NoReservation();
    error ZeroAddress();
    error NotAContract();
    error ZeroAmount();
    error ExceedsTotalCap();
    error ExceedsReservation();
    error BelowCommitment();
    error CommitmentCannotShrink();
    error DurationTooShort();
    error DurationTooLong();
    error StartBeforeDeployment();
    error StartTooFarInPast();
    error TooManyGrants();
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
    // Funder actions. None of them can move a token.
    // ---------------------------------------------------------------------

    /**
     * @notice Reserve grantable capacity for a sale contract.
     * @dev Must be a contract. An EOA granter would mean a single key could
     *      write grants against the sale pool, which is exactly the shape of
     *      privilege this project refuses.
     *
     *      Reserving in small amounts and topping up is the intended pattern:
     *      it bounds what any single failure in the sale contract can reach.
     */
    function reserveCapacity(address granter, uint256 amount) external onlyFunder {
        if (granter == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (granter.code.length == 0) revert NotAContract();
        if (totalReserved + amount > MAX_TOTAL) revert ExceedsTotalCap();

        totalReserved += amount;
        reservationOf[granter] += amount;
        emit CapacityReserved(granter, amount, reservationOf[granter]);
    }

    /**
     * @notice Take back capacity a granter has not used. This is how a sale is
     *         stopped: with no reservation left, `grant` reverts.
     * @dev Cannot reach below the granter's committed floor, so it can never
     *      strand a buyer whose purchase the granter has already accepted.
     */
    function releaseCapacity(address granter, uint256 amount) external onlyFunder {
        if (amount == 0) revert ZeroAmount();
        uint256 current = reservationOf[granter];
        if (amount > current) revert ExceedsReservation();
        uint256 remaining = current - amount;
        if (remaining < committedOf[granter]) revert BelowCommitment();

        reservationOf[granter] = remaining;
        totalReserved -= amount;
        emit CapacityReleased(granter, amount, remaining);
    }

    // ---------------------------------------------------------------------
    // Granter actions
    // ---------------------------------------------------------------------

    /**
     * @notice Declare capacity the funder may no longer take back.
     * @dev For a sale contract that accepts payment in one transaction and
     *      writes the grant in another, this is what makes the second
     *      transaction always possible. Raise-only: a granter cannot walk back
     *      an obligation it has declared.
     */
    function commit(uint256 amount) external {
        uint256 current = committedOf[msg.sender];
        if (amount < current) revert CommitmentCannotShrink();
        if (amount > reservationOf[msg.sender]) revert ExceedsReservation();

        committedOf[msg.sender] = amount;
        emit Committed(msg.sender, amount);
    }

    /**
     * @notice Create a vesting grant. Pulls the tokens from the calling sale.
     * @dev The granter must have approved this contract for `amount` first.
     *      Capacity comes from the caller's own reservation, so no granter can
     *      be starved by another's activity.
     *
     * @param beneficiary The buyer.
     * @param amount      Tokens purchased.
     * @param start       When vesting begins. Bounded by MAX_BACKDATE.
     * @param duration    At least MIN_DURATION.
     */
    function grant(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration
    ) external {
        if (beneficiary == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (duration < MIN_DURATION) revert DurationTooShort();
        if (duration > MAX_VESTING_DURATION) revert DurationTooLong();
        if (start < deployedAt) revert StartBeforeDeployment();
        if (start + MAX_BACKDATE < block.timestamp) revert StartTooFarInPast();
        if (_grants[beneficiary].length >= MAX_GRANTS_PER_BENEFICIARY) revert TooManyGrants();

        uint256 reservation = reservationOf[msg.sender];
        if (reservation == 0) revert NoReservation();
        if (amount > reservation) revert ExceedsReservation();

        unchecked {
            reservationOf[msg.sender] = reservation - amount;
        }

        // Granting is the one thing that lowers a commitment: the obligation
        // it stood for has just been met.
        uint256 committed = committedOf[msg.sender];
        if (committed != 0) {
            committedOf[msg.sender] = amount >= committed ? 0 : committed - amount;
        }

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

    /// @notice Vested but not yet claimed, which is what `release()` pays now.
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

    /// @notice What the funder may still reserve against the 60,000,000 pool.
    function reservableRemaining() external view returns (uint256) {
        return MAX_TOTAL - totalReserved;
    }
}
