// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRoundVesting {
    function grant(address beneficiary, uint256 amount, uint64 start, uint64 duration) external;
    function MAX_BACKDATE() external view returns (uint64);
    function MIN_DURATION() external view returns (uint64);
    function MAX_VESTING_DURATION() external view returns (uint64);
}

/// @dev Minimal Chainlink aggregator surface, so no dependency is added.
interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/**
 * @title SaleRound
 * @notice One BonaBuild sale round: a fixed price, an escrow, a floor, and a
 *         refund that nobody has to approve.
 *         https://bonabuild.org
 *
 * @dev This is the only contract in the project that holds real money, so it
 *      is the one with the most to say about what it cannot do.
 *
 *      - No price changes.       `bonaPerUsdc` and `bonaPerEth` are immutable.
 *                                The last buyer pays exactly what the first
 *                                buyer paid, and no key can alter that.
 *
 *      - No goal or deadline changes. Also immutable. A round whose terms
 *                                moved mid-flight would hand a better deal to
 *                                one group of buyers than another.
 *
 *      - No owner, no admin.     There is a `treasury` (the multisig) which
 *                                may settle a successful round and reclaim
 *                                genuinely unsold BONA. It cannot touch buyer
 *                                funds, cannot cancel, cannot pause.
 *
 *      - No pause.               Contributing, refunding and claiming cannot
 *                                be halted.
 *
 *      - No tiers or bonuses.    One price, one schedule, everyone.
 *
 * @dev ESCROW, AND WHY THE REFUND IS A MECHANISM RATHER THAN A PROMISE.
 *
 *      Contributions stay in this contract until the floor is met. Had they
 *      gone straight to the multisig, returning them would depend on the
 *      signers choosing to. Here, if the round fails, each buyer calls
 *      `refund()` and takes their own money back. Nobody approves it. Nobody
 *      can stop it.
 *
 * @dev THE STALLED-SETTLEMENT ESCAPE HATCH.
 *
 *      Settlement needs a multisig vote, which means the multisig could in
 *      principle sit on a successful round forever, leaving buyers with
 *      neither their money nor their tokens. So after SETTLEMENT_GRACE past
 *      the close, an unsettled round becomes refundable exactly as a failed
 *      one. The power to delay is not the power to keep.
 *
 * @dev ACCOUNTING IN BONA, NOT IN DOLLARS.
 *
 *      Progress is measured in BONA sold rather than USD raised. Because both
 *      prices are frozen, BONA is a common unit both lanes convert into
 *      exactly, so the goal and the floor need no oracle to be measured. The
 *      oracle exists only for the circuit breaker below, and never prices
 *      anything.
 *
 * @dev THE CIRCUIT BREAKER.
 *
 *      Both prices are frozen for the round, so a swing in ETH's market price
 *      makes one lane cheaper than the other in real terms. That is a genuine
 *      unfairness between buyers, so it is bounded: if ETH/USD moves more than
 *      BREAKER_BPS from the published reference, the ETH lane closes and the
 *      round continues in USDC only.
 *
 *      Note what the oracle does and does not do. It NEVER sets a price. It
 *      only answers whether the ETH lane stays open, so "fixed, pre-published
 *      price" remains literally true. It also fails CLOSED: a stale, negative
 *      or reverting feed shuts the ETH lane rather than opening it.
 */
contract SaleRound is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        Open,
        Settled,
        Failed
    }

    /// @notice The token being sold.
    IERC20 public immutable bona;

    /// @notice USDC on Base. 6 decimals.
    IERC20 public immutable usdc;

    /// @notice Where grants are written once the round settles.
    IRoundVesting public immutable vesting;

    /// @notice The project multisig. Receives proceeds on settlement.
    address public immutable treasury;

    /// @notice Chainlink ETH/USD feed. address(0) disables the ETH lane entirely.
    IAggregatorV3 public immutable ethUsdFeed;

    /// @notice BONA (18 dec) per 1 whole USDC (1e6). Frozen.
    uint256 public immutable bonaPerUsdc;

    /// @notice BONA (18 dec) per 1 whole ETH (1e18 wei). Frozen.
    uint256 public immutable bonaPerEth;

    /// @notice Total BONA this round may sell — the goal.
    uint256 public immutable bonaAllocation;

    /// @notice Minimum BONA that must sell, or the round fails and refunds.
    uint256 public immutable bonaFloor;

    /// @notice Round close. Immutable, and at most MAX_DURATION from deployment.
    uint64 public immutable deadline;

    /// @notice Published ETH/USD reference, in the feed's own decimals. Frozen.
    int256 public immutable referenceEthUsd;

    /// @notice Vesting duration applied to every grant this round writes.
    uint64 public immutable vestingDuration;

    /// @dev Cached from RoundVesting so grants never fail its backdate check.
    uint64 private immutable _vestingMaxBackdate;

    /// @notice Longest a round may run: 14 days.
    uint64 public constant MAX_DURATION = 14 days;

    /// @notice ETH lane closes beyond this deviation from the reference: 20%.
    uint256 public constant BREAKER_BPS = 2000;

    /// @notice A feed older than this is treated as unusable. Must exceed the
    ///         feed's heartbeat, or the ETH lane will close for no reason.
    uint256 public constant MAX_ORACLE_AGE = 1 hours;

    /// @notice After this long unsettled past the close, buyers may refund.
    uint64 public constant SETTLEMENT_GRACE = 30 days;

    Status public status;

    /// @notice When the round stopped accepting contributions.
    uint64 public closedAt;

    /// @notice BONA sold so far, across both lanes.
    uint256 public bonaSold;

    /// @notice BONA already written into vesting grants.
    uint256 public bonaGranted;

    uint256 public totalEth;
    uint256 public totalUsdc;

    mapping(address => uint256) public ethContributed;
    mapping(address => uint256) public usdcContributed;

    /// @notice BONA a buyer has bought and not yet moved into vesting.
    mapping(address => uint256) public bonaOwed;

    event Contributed(address indexed buyer, uint256 ethAmount, uint256 usdcAmount, uint256 bonaAmount);
    event GoalReached(uint64 at, uint256 bonaSold);
    event Settled(uint64 at, uint256 ethAmount, uint256 usdcAmount, uint256 bonaSold);
    event Failed(uint64 at, uint256 bonaSold, uint256 bonaFloor);
    event Refunded(address indexed buyer, uint256 ethAmount, uint256 usdcAmount);
    event GrantClaimed(address indexed buyer, uint256 bonaAmount, uint64 start);
    event UnsoldReclaimed(uint256 amount);
    event EthLaneClosed(int256 current, int256 referencePrice);

    error ZeroAddress();
    error BadPrice();
    error BadAllocation();
    error BadFloor();
    error BadDeadline();
    error BadReference();
    error BadVestingDuration();
    error NotTreasury();
    error RoundNotOpen();
    error RoundClosed();
    error ZeroAmount();
    error ExceedsAllocation();
    error EthLaneDisabled();
    error EthLaneBroken();
    error FloorNotMet();
    error FloorAlreadyMet();
    error StillOpen();
    error NotSettled();
    error NothingOwed();
    error NothingToRefund();
    error NotRefundable();
    error EthTransferFailed();
    error NothingReclaimable();
    error BadFeedDecimals();
    error RoundUnderfunded();

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert NotTreasury();
        _;
    }

    /**
     * @param bona_            The BONA token.
     * @param usdc_            USDC on Base.
     * @param vesting_         RoundVesting. Must have authorised this contract.
     * @param treasury_        The project multisig.
     * @param ethUsdFeed_      Chainlink ETH/USD, or address(0) for a USDC-only round.
     * @param bonaPerUsdc_     BONA-wei per 1 USDC. Frozen.
     * @param bonaPerEth_      BONA-wei per 1 ETH. Frozen. Zero disables the ETH lane.
     * @param bonaAllocation_  Total BONA for sale — the goal.
     * @param bonaFloor_       Minimum BONA that must sell.
     * @param duration_        Seconds until close. At most MAX_DURATION.
     * @param referenceEthUsd_ Published ETH/USD reference in the feed's decimals.
     * @param vestingDuration_ Applied to every grant. At least RoundVesting.MIN_DURATION.
     */
    constructor(
        IERC20 bona_,
        IERC20 usdc_,
        IRoundVesting vesting_,
        address treasury_,
        IAggregatorV3 ethUsdFeed_,
        uint256 bonaPerUsdc_,
        uint256 bonaPerEth_,
        uint256 bonaAllocation_,
        uint256 bonaFloor_,
        uint64 duration_,
        int256 referenceEthUsd_,
        uint64 vestingDuration_
    ) {
        if (address(bona_) == address(0)) revert ZeroAddress();
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(vesting_) == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (bonaPerUsdc_ == 0) revert BadPrice();
        if (bonaAllocation_ == 0) revert BadAllocation();
        if (bonaFloor_ == 0 || bonaFloor_ > bonaAllocation_) revert BadFloor();
        if (duration_ == 0 || duration_ > MAX_DURATION) revert BadDeadline();

        // An ETH lane needs both a price and a working reference, or neither.
        bool ethLane = address(ethUsdFeed_) != address(0);
        if (ethLane) {
            if (bonaPerEth_ == 0) revert BadPrice();
            if (referenceEthUsd_ <= 0) revert BadReference();
            // The breaker compares the feed's answer to the reference raw, so
            // both must be in the same units. Chainlink USD feeds use 8
            // decimals; anything else here means a misconfigured feed. (I-1)
            if (ethUsdFeed_.decimals() != 8) revert BadFeedDecimals();
        }

        // Outside RoundVesting's accepted window a grant call reverts — and a
        // settled round whose grants revert has taken the money and stranded
        // every buyer. So the window is checked here, where it still only
        // costs a failed deployment. (L-1)
        if (vestingDuration_ < vesting_.MIN_DURATION()) revert BadVestingDuration();
        if (vestingDuration_ > vesting_.MAX_VESTING_DURATION()) revert BadVestingDuration();

        bona = bona_;
        usdc = usdc_;
        vesting = vesting_;
        treasury = treasury_;
        ethUsdFeed = ethUsdFeed_;
        bonaPerUsdc = bonaPerUsdc_;
        bonaPerEth = ethLane ? bonaPerEth_ : 0;
        bonaAllocation = bonaAllocation_;
        bonaFloor = bonaFloor_;
        deadline = uint64(block.timestamp) + duration_;
        referenceEthUsd = ethLane ? referenceEthUsd_ : int256(0);
        vestingDuration = vestingDuration_;
        _vestingMaxBackdate = vesting_.MAX_BACKDATE();
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /// @notice Buy with ETH at the frozen price. Reverts if the ETH lane is closed.
    receive() external payable {
        _contributeEth();
    }

    /// @notice Buy with ETH at the frozen price.
    function contributeEth() external payable {
        _contributeEth();
    }

    function _contributeEth() private {
        if (msg.value == 0) revert ZeroAmount();
        if (bonaPerEth == 0) revert EthLaneDisabled();
        _requireOpen();
        _requireEthLaneOpen();

        uint256 bonaAmount = (msg.value * bonaPerEth) / 1e18;
        ethContributed[msg.sender] += msg.value;
        totalEth += msg.value;
        _record(msg.sender, bonaAmount);

        emit Contributed(msg.sender, msg.value, 0, bonaAmount);
    }

    /**
     * @notice Buy with USDC at the frozen price.
     * @dev Approve this contract for `usdcAmount` first.
     */
    function contributeUsdc(uint256 usdcAmount) external nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();
        _requireOpen();

        uint256 bonaAmount = (usdcAmount * bonaPerUsdc) / 1e6;
        usdcContributed[msg.sender] += usdcAmount;
        totalUsdc += usdcAmount;
        _record(msg.sender, bonaAmount);

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        emit Contributed(msg.sender, 0, usdcAmount, bonaAmount);
    }

    function _record(address buyer, uint256 bonaAmount) private {
        if (bonaAmount == 0) revert ZeroAmount();
        if (bonaSold + bonaAmount > bonaAllocation) revert ExceedsAllocation();

        bonaSold += bonaAmount;
        bonaOwed[buyer] += bonaAmount;

        if (bonaSold == bonaAllocation) {
            closedAt = uint64(block.timestamp);
            emit GoalReached(closedAt, bonaSold);
        }
    }

    function _requireOpen() private view {
        if (status != Status.Open) revert RoundNotOpen();
        if (block.timestamp >= deadline || closedAt != 0) revert RoundClosed();
    }

    /**
     * @dev Fails closed. A stale, non-positive or reverting feed shuts the ETH
     *      lane; it never opens it. USDC is unaffected either way.
     */
    function _requireEthLaneOpen() private {
        (bool ok, int256 price) = _readEthUsd();
        if (!ok) revert EthLaneBroken();

        int256 ref = referenceEthUsd;
        int256 diff = price > ref ? price - ref : ref - price;
        if (uint256(diff) * 10_000 > uint256(ref) * BREAKER_BPS) {
            emit EthLaneClosed(price, ref);
            revert EthLaneBroken();
        }
    }

    function _readEthUsd() private view returns (bool ok, int256 price) {
        try ethUsdFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (false, 0);
            // A feed timestamped in the future would underflow the age check
            // below and revert. That revert is NOT caught by the catch clause
            // — it happens in the success branch — so `ethLaneOpen()` would
            // panic instead of returning false, which is the one thing this
            // function promises never to do. An impossible timestamp is a
            // broken feed: fail closed, like every other bad reading. (S-1)
            if (updatedAt == 0 || updatedAt > block.timestamp) return (false, 0);
            if (block.timestamp - updatedAt > MAX_ORACLE_AGE) return (false, 0);
            return (true, answer);
        } catch {
            return (false, 0);
        }
    }

    // ---------------------------------------------------------------------
    // Closing
    // ---------------------------------------------------------------------

    /**
     * @notice Settle a successful round: proceeds to the multisig.
     * @dev The multisig calls this after the confirming vote. It can delay,
     *      but SETTLEMENT_GRACE means it cannot delay indefinitely without
     *      handing buyers their refund instead.
     */
    function settle() external onlyTreasury nonReentrant {
        if (status != Status.Open) revert RoundNotOpen();
        if (!_isClosed()) revert StillOpen();
        if (bonaSold < bonaFloor) revert FloorNotMet();

        // A settled round must be able to honour every future claimGrant.
        // Settling an underfunded round would take the buyers' money while
        // leaving their claims to revert. (L-2)
        if (bona.balanceOf(address(this)) < bonaSold) revert RoundUnderfunded();

        if (closedAt == 0) closedAt = deadline;
        status = Status.Settled;

        // Actual balances, not the running totals: if any buyer refunded
        // during the settlement grace window, the totals exceed what the
        // escrow still holds, and the remaining buyers keep their claims.
        uint256 ethAmount = address(this).balance;
        uint256 usdcAmount = usdc.balanceOf(address(this));

        if (usdcAmount > 0) usdc.safeTransfer(treasury, usdcAmount);
        if (ethAmount > 0) {
            (bool sent, ) = treasury.call{value: ethAmount}("");
            if (!sent) revert EthTransferFailed();
        }

        emit Settled(uint64(block.timestamp), ethAmount, usdcAmount, bonaSold);
    }

    /**
     * @notice Mark a round that missed its floor as failed. Callable by anyone.
     * @dev Permissionless on purpose: buyers must never need our cooperation
     *      to reach their refund.
     */
    function markFailed() external {
        if (status != Status.Open) revert RoundNotOpen();
        if (!_isClosed()) revert StillOpen();
        if (bonaSold >= bonaFloor) revert FloorAlreadyMet();

        if (closedAt == 0) closedAt = deadline;
        status = Status.Failed;
        emit Failed(uint64(block.timestamp), bonaSold, bonaFloor);
    }

    function _isClosed() private view returns (bool) {
        return closedAt != 0 || block.timestamp >= deadline;
    }

    // ---------------------------------------------------------------------
    // Buyer actions
    // ---------------------------------------------------------------------

    /**
     * @notice Move purchased BONA into vesting. Buyer pays their own gas.
     * @dev Buyers pull rather than the round pushing, so a round with
     *      thousands of buyers can never become too large to settle.
     *
     *      Vesting starts at the round's close, except that a buyer who
     *      claims very late is given the earliest start RoundVesting will
     *      accept. Without that clamp their claim would simply revert, which
     *      would punish them for being slow rather than merely delaying them.
     */
    function claimGrant() external nonReentrant {
        if (status != Status.Settled) revert NotSettled();

        uint256 amount = bonaOwed[msg.sender];
        if (amount == 0) revert NothingOwed();

        bonaOwed[msg.sender] = 0;
        bonaGranted += amount;

        uint64 start = closedAt;
        uint64 earliest = uint64(block.timestamp) - _vestingMaxBackdate + 1 hours;
        if (start < earliest) start = earliest;

        bona.forceApprove(address(vesting), amount);
        vesting.grant(msg.sender, amount, start, vestingDuration);

        emit GrantClaimed(msg.sender, amount, start);
    }

    /**
     * @notice Take your own money back from a failed or stalled round.
     * @dev Needs nobody's approval. If the round succeeded but was never
     *      settled within SETTLEMENT_GRACE of closing, this opens too.
     */
    function refund() external nonReentrant {
        if (!refundable()) revert NotRefundable();

        uint256 ethAmount = ethContributed[msg.sender];
        uint256 usdcAmount = usdcContributed[msg.sender];
        if (ethAmount == 0 && usdcAmount == 0) revert NothingToRefund();

        ethContributed[msg.sender] = 0;
        usdcContributed[msg.sender] = 0;

        // A refund un-sells the purchase. Without these decrements the BONA
        // behind a refunded purchase would count as owed forever — never
        // claimable (bonaOwed is zeroed) and never reclaimable — and settle()
        // would try to move totals the escrow no longer holds. (M-1)
        bonaSold -= bonaOwed[msg.sender];
        totalEth -= ethAmount;
        totalUsdc -= usdcAmount;
        bonaOwed[msg.sender] = 0;

        if (usdcAmount > 0) usdc.safeTransfer(msg.sender, usdcAmount);
        if (ethAmount > 0) {
            (bool sent, ) = msg.sender.call{value: ethAmount}("");
            if (!sent) revert EthTransferFailed();
        }

        emit Refunded(msg.sender, ethAmount, usdcAmount);
    }

    // ---------------------------------------------------------------------
    // Treasury
    // ---------------------------------------------------------------------

    /**
     * @notice Return BONA that was never sold to the multisig.
     * @dev Strictly bounded to the balance minus everything still owed to
     *      buyers, so it can never reach a buyer's tokens no matter when it
     *      is called or what the round's status is.
     */
    function reclaimUnsold() external onlyTreasury nonReentrant {
        uint256 amount = reclaimable();
        if (amount == 0) revert NothingReclaimable();
        bona.safeTransfer(treasury, amount);
        emit UnsoldReclaimed(amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Whether buyers may currently take their money back.
    function refundable() public view returns (bool) {
        if (status == Status.Failed) return true;
        if (status != Status.Open) return false;
        if (!_isClosed()) return false;
        // Missed the floor, or succeeded and was left unsettled too long.
        if (bonaSold < bonaFloor) return true;
        uint64 closed = closedAt == 0 ? deadline : closedAt;
        return block.timestamp > closed + SETTLEMENT_GRACE;
    }

    /// @notice BONA safe to return to the multisig right now.
    function reclaimable() public view returns (uint256) {
        uint256 balance = bona.balanceOf(address(this));
        uint256 owed = bonaSold - bonaGranted;
        if (status == Status.Failed) owed = 0;
        return balance > owed ? balance - owed : 0;
    }

    /// @notice BONA still available in this round.
    function remainingBona() external view returns (uint256) {
        return bonaAllocation - bonaSold;
    }

    /// @notice Whether the ETH lane is accepting money at this moment.
    function ethLaneOpen() external view returns (bool) {
        if (bonaPerEth == 0) return false;
        (bool ok, int256 price) = _readEthUsd();
        if (!ok) return false;
        int256 ref = referenceEthUsd;
        int256 diff = price > ref ? price - ref : ref - price;
        return uint256(diff) * 10_000 <= uint256(ref) * BREAKER_BPS;
    }

    /// @notice How much BONA a given ETH amount buys, at the frozen price.
    function quoteEth(uint256 ethAmount) external view returns (uint256) {
        return (ethAmount * bonaPerEth) / 1e18;
    }

    /// @notice How much BONA a given USDC amount buys, at the frozen price.
    function quoteUsdc(uint256 usdcAmount) external view returns (uint256) {
        return (usdcAmount * bonaPerUsdc) / 1e6;
    }
}
