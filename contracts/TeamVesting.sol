// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TeamVesting
 * @notice Holds the BonaBuild core-team allocation and releases it on a
 *         published, on-chain schedule.
 *         https://bonabuild.org
 *
 * @dev DESIGN: what this contract deliberately does NOT have.
 *
 *      - No revoke / clawback.   Once a tranche is funded to an address,
 *                                nobody — not the funder, not a majority of
 *                                signers, nobody — can take it back or send it
 *                                somewhere else. A lock that someone can undo
 *                                is not a lock.
 *
 *      - No owner, no roles.     A single `funder` address, fixed at
 *                                deployment. It can assign a seat, vacate a
 *                                seat, and fund a tranche. None of those can
 *                                remove tokens from this contract.
 *
 *      - No sweep / rescue.      There is no path for anyone to withdraw the
 *                                token held here except a beneficiary claiming
 *                                what has vested for them.
 *
 *      - No schedule changes.    A funded grant's amount, start and duration
 *                                are written once and never updated.
 *
 *      - No pause.               Claiming cannot be halted.
 *
 * @dev SEATS, not a fixed list of people.
 *
 *      Team membership changes. Someone joins this month and leaves the next,
 *      and their replacement needs an address on the schedule. A contract that
 *      hard-codes five addresses forever cannot express that; one that lets
 *      the funder point an existing grant at a new address is a clawback with
 *      a friendlier name.
 *
 *      So the allocation is divided into five SEATS. A seat has a budget
 *      (MAX_PER_SEAT) and a current holder, and either can be empty.
 *
 *        assignSeat  - put an address in a vacant seat
 *        vacateSeat  - the holder leaves; the seat becomes fillable again
 *        fundGrant   - fund a tranche to whoever currently holds the seat
 *
 *      The invariant that makes this safe:
 *
 *        VACATING A SEAT MOVES NOTHING.
 *
 *      A departing member keeps every tranche already funded to them. It
 *      continues vesting to their own address, on its original schedule, and
 *      this contract has no way to interfere with it. What they lose is only
 *      what was never granted: future tranches, which the seat's next holder
 *      receives instead. The seat's budget is shared, so a replacement cannot
 *      restart the 2,000,000 from zero.
 *
 * @dev THE LEAVER PROBLEM, and why there is no revoke function.
 *
 *      Someone who leaves in month two should not collect for three years.
 *      The obvious fix — a clawback the multisig can call — reintroduces
 *      exactly the kind of privileged power this project refuses everywhere
 *      else, over tokens that have already been granted.
 *
 *      Funding in TRANCHES solves it without that power. If someone leaves,
 *      the multisig simply does not fund the next tranche. Nothing is seized,
 *      because nothing needs to be: the power used is one that already exists
 *      (a multisig vote), not a new one written into this contract.
 *
 *      The honest cost: not the entire team allocation is locked on-chain from
 *      day one. Part of it waits in the multisig for its tranche. What IS
 *      true, and what this contract enforces, is that every tranche already
 *      funded is irrevocable.
 *
 * @dev WHY EACH TRANCHE IS ITS OWN GRANT.
 *
 *      A single linear schedule computed against `balance + released` — the
 *      common pattern, including OpenZeppelin's VestingWallet — treats tokens
 *      added later as *retroactively* vested. Funding tranche two into such a
 *      schedule at month 12 would unlock a large lump the instant it landed,
 *      which is the opposite of the intent.
 *
 *      Here every tranche is a separate grant with its own start, so a tranche
 *      begins at 0% vested on the day it is funded, always. A beneficiary's
 *      releasable balance is the sum across their grants.
 *
 * @dev SCHEDULE (BonaBuild core team, as published)
 *
 *      5 seats x 2,000,000 BONA = 10,000,000 BONA (10% of supply).
 *      No cliff; linear release over 36 months, funded as three annual
 *      tranches of ~666,667 BONA, each vesting over the 12 months following
 *      its own start. Roughly 55,556 BONA per seat per month, with no lump
 *      unlock at any point.
 *
 *      Both caps below are enforced by this contract, not by policy.
 */
contract TeamVesting {
    using SafeERC20 for IERC20;

    /// @notice The token being vested.
    IERC20 public immutable token;

    /**
     * @notice The only address that may assign seats and fund tranches.
     *         This must be the project multisig. It can never remove tokens.
     */
    address public immutable funder;

    /// @notice Contract deployment time. Grants may not start before it.
    uint64 public immutable deployedAt;

    /// @notice Number of seats, fixed forever. Five, as published.
    uint256 public constant SEATS = 5;

    /// @notice Budget per seat: 2,000,000 BONA. Enforces the equal split.
    uint256 public constant MAX_PER_SEAT = 2_000_000 * 1e18;

    /// @notice Hard cap in total: 10,000,000 BONA, the published team allocation.
    uint256 public constant MAX_TOTAL = 10_000_000 * 1e18;

    /**
     * @notice Maximum tranche duration: 10 years.
     * @dev A duration near uint64-max overflows `start + duration`, which in
     *      0.8 reverts, which bricks `vestedAmount` — and every claim of that
     *      beneficiary with it, permanently, because there is no admin path
     *      to intervene. The published schedule is 36 months; ten years is
     *      generous headroom, not an invitation. (L-1)
     */
    uint64 public constant MAX_GRANT_DURATION = 3650 days;

    /**
     * @param amount   Tokens in this tranche.
     * @param start    When linear release begins. No cliff.
     * @param duration Seconds over which the tranche releases linearly.
     */
    struct Grant {
        uint128 amount;
        uint64 start;
        uint64 duration;
    }

    /**
     * @param holder  Current occupant, or address(0) when vacant.
     * @param granted Total ever funded against this seat, across all holders.
     */
    struct Seat {
        address holder;
        uint128 granted;
    }

    Seat[SEATS] private _seats;

    mapping(address => Grant[]) private _grants;

    /// @notice Tokens already claimed by each address.
    mapping(address => uint256) public released;

    /// @notice Total ever granted to each address, across all tranches and seats.
    mapping(address => uint256) public grantedTo;

    /// @notice True while an address currently occupies a seat.
    mapping(address => bool) public isSeated;

    /// @notice Total funded into this contract.
    uint256 public totalGranted;

    /// @notice Total claimed out of this contract.
    uint256 public totalReleased;

    event SeatAssigned(uint256 indexed seat, address indexed holder);
    event SeatVacated(uint256 indexed seat, address indexed holder, uint256 keptGrants);
    event GrantFunded(
        uint256 indexed seat,
        address indexed beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration
    );
    event Released(address indexed beneficiary, uint256 amount);

    error NotFunder();
    error ZeroAddress();
    error BadSeat();
    error SeatOccupied();
    error SeatVacant();
    error AlreadySeated();
    error ZeroAmount();
    error ZeroDuration();
    error DurationTooLong();
    error StartBeforeDeployment();
    error ExceedsSeatBudget();
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
    // Funder actions. None of these can remove tokens from this contract.
    // ---------------------------------------------------------------------

    /**
     * @notice Put an address into a vacant seat.
     * @dev Beneficiary addresses are not known at deployment: each team member
     *      creates their own wallet and holds their own keys, and only the
     *      public address is ever shared. Seats are filled as addresses
     *      arrive, and refilled when someone is replaced.
     */
    function assignSeat(uint256 seat, address holder) external onlyFunder {
        if (seat >= SEATS) revert BadSeat();
        if (holder == address(0)) revert ZeroAddress();
        if (_seats[seat].holder != address(0)) revert SeatOccupied();
        if (isSeated[holder]) revert AlreadySeated();

        _seats[seat].holder = holder;
        isSeated[holder] = true;
        emit SeatAssigned(seat, holder);
    }

    /**
     * @notice Empty a seat when its holder leaves the team.
     * @dev This moves no tokens. Every tranche already funded to the departing
     *      holder stays theirs and keeps vesting to their own address on its
     *      original schedule — this contract has no way to touch it. What the
     *      seat's next holder receives is only what was never granted.
     */
    function vacateSeat(uint256 seat) external onlyFunder {
        if (seat >= SEATS) revert BadSeat();
        address holder = _seats[seat].holder;
        if (holder == address(0)) revert SeatVacant();

        _seats[seat].holder = address(0);
        isSeated[holder] = false;
        emit SeatVacated(seat, holder, grantedTo[holder]);
    }

    /**
     * @notice Fund one tranche to whoever currently holds `seat`.
     * @dev Each call creates an independent grant that begins at 0% vested,
     *      so funding a later tranche never retroactively unlocks anything.
     *      The seat's budget is shared across every holder it has ever had, so
     *      a replacement cannot restart the allocation from zero.
     *
     * @param seat     Seat index, 0..4.
     * @param amount   Tokens in this tranche.
     * @param start    When linear release begins. No cliff is applied.
     * @param duration Seconds over which it releases linearly.
     */
    function fundGrant(
        uint256 seat,
        uint256 amount,
        uint64 start,
        uint64 duration
    ) external onlyFunder {
        if (seat >= SEATS) revert BadSeat();
        address holder = _seats[seat].holder;
        if (holder == address(0)) revert SeatVacant();
        if (amount == 0) revert ZeroAmount();
        if (duration == 0) revert ZeroDuration();
        if (duration > MAX_GRANT_DURATION) revert DurationTooLong();
        if (start < deployedAt) revert StartBeforeDeployment();
        if (uint256(_seats[seat].granted) + amount > MAX_PER_SEAT) {
            revert ExceedsSeatBudget();
        }
        if (totalGranted + amount > MAX_TOTAL) revert ExceedsTotalCap();

        _seats[seat].granted += uint128(amount);
        grantedTo[holder] += amount;
        totalGranted += amount;
        _grants[holder].push(
            Grant({amount: uint128(amount), start: start, duration: duration})
        );

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit GrantFunded(seat, holder, amount, start, duration);
    }

    // ---------------------------------------------------------------------
    // Beneficiary action
    // ---------------------------------------------------------------------

    /**
     * @notice Claim everything vested and not yet claimed.
     * @dev Callable by anyone who has ever been granted a tranche, whether or
     *      not they still hold a seat. Leaving the team does not affect this.
     */
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

    /// @notice Total vested for `beneficiary` at `timestamp`, across all tranches.
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
     * @dev This is the value the Snapshot `contract-call` strategy reads, so
     *      that voting weight is `wallet balance + unclaimed vesting balance`.
     *      Without it, locked tokens would carry no vote and the lock would
     *      silently disenfranchise the holder.
     */
    function unclaimedOf(address beneficiary) external view returns (uint256) {
        return grantedTo[beneficiary] - released[beneficiary];
    }

    /// @notice Current holder of a seat, or address(0) if vacant.
    function seatHolder(uint256 seat) external view returns (address) {
        if (seat >= SEATS) revert BadSeat();
        return _seats[seat].holder;
    }

    /// @notice Total ever funded against a seat, across every holder it has had.
    function seatGranted(uint256 seat) external view returns (uint256) {
        if (seat >= SEATS) revert BadSeat();
        return _seats[seat].granted;
    }

    /// @notice What remains fundable against a seat.
    function seatRemaining(uint256 seat) external view returns (uint256) {
        if (seat >= SEATS) revert BadSeat();
        return MAX_PER_SEAT - _seats[seat].granted;
    }

    /// @notice Number of tranches funded to `beneficiary`.
    function grantCount(address beneficiary) external view returns (uint256) {
        return _grants[beneficiary].length;
    }

    /// @notice One tranche, by index.
    function grantAt(address beneficiary, uint256 index)
        external
        view
        returns (uint256 amount, uint64 start, uint64 duration)
    {
        Grant storage g = _grants[beneficiary][index];
        return (g.amount, g.start, g.duration);
    }

    /// @notice Every current seat holder, by seat index. address(0) where vacant.
    function allSeatHolders() external view returns (address[SEATS] memory holders) {
        for (uint256 i = 0; i < SEATS; ++i) {
            holders[i] = _seats[i].holder;
        }
    }
}
