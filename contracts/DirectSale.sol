// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISaleVesting {
    function grant(address beneficiary, uint256 amount, uint64 start, uint64 duration) external;

    function MIN_DURATION() external view returns (uint64);

    function MAX_VESTING_DURATION() external view returns (uint64);

    function reservationOf(address granter) external view returns (uint256);
}

/**
 * @title DirectSale
 * @notice Sells BONA for USDC at one published price, continuously, to anyone.
 *         https://bonabuild.org
 *
 * @dev THE ONE PROPERTY THIS CONTRACT EXISTS TO HAVE.
 *
 *      Payment and grant happen in the same transaction. The buyer's USDC
 *      moves to the treasury and their vesting grant is written in a single
 *      call, so either both happen or neither does. There is no window in
 *      which the project holds money that has not yet bought anything, and no
 *      state in which a buyer has paid but cannot claim.
 *
 *      That is not a small detail. The two worst findings in this project's
 *      external review were both instances of the opposite shape: a sale that
 *      takes money in one transaction and writes the grant in another can
 *      fail in between, and when it does, the money is gone and the tokens
 *      are unreachable. Removing the gap removes the entire class.
 *
 * @dev DESIGN: what this contract deliberately does NOT have.
 *
 *      - No owner, no admin.     A single `treasury` address, fixed at
 *                                deployment, which receives the USDC and may
 *                                take back unsold BONA. It cannot touch a
 *                                buyer's tokens, because this contract never
 *                                holds them: they go straight into vesting.
 *
 *      - No pause.               The sale is stopped by the multisig taking
 *                                back this contract's reservation in
 *                                SaleVesting, or its BONA balance, or both.
 *                                A pause switch inside the sale would be one
 *                                more privileged lever for no extra safety.
 *
 *      - No price change.        `bonaPerUsdc` is immutable. The price the
 *                                first buyer paid is the price the last buyer
 *                                pays. There are no tiers, no volume
 *                                discounts, no early-bird rate and no
 *                                referral bonus: the amount of BONA a dollar
 *                                buys does not depend on who is spending it
 *                                or when.
 *
 *      - No escrow, no refund.   Nothing is held back, so there is nothing to
 *                                release and nothing to return. The buyer
 *                                receives their grant in the transaction they
 *                                pay for it.
 *
 *      - No ETH lane.            USDC only. A frozen BONA/ETH rate drifts as
 *                                ETH moves, and a live one would put an
 *                                oracle in charge of the price. Anyone
 *                                holding ETH can swap to USDC on Base for a
 *                                few cents; that is a better trade than
 *                                either alternative.
 *
 *      - No other stablecoin.    Accepting USDT alongside USDC at a fixed
 *                                one-to-one would mean that whenever the two
 *                                diverge, buyers pay in the cheaper one and
 *                                the project absorbs the difference on every
 *                                sale. Both have broken their peg before.
 *
 * @dev WHY THE TOKENS ARRIVE IN INSTALMENTS.
 *
 *      This contract sells only the BONA it holds and only against the
 *      capacity reserved for it in SaleVesting. The multisig tops up both in
 *      small amounts rather than handing over the whole allocation, so the
 *      most any single failure here can reach is the current instalment
 *      rather than the entire sale pool. `maxBona` is the ceiling for this
 *      contract across its whole life and cannot be raised.
 *
 * @dev WHAT A BUYER GETS, STATED PLAINLY.
 *
 *      BONA released linearly over six months, voting weight from the moment
 *      of purchase, and a permanent public record of the purchase. It is not
 *      a share, it carries no claim on revenue, and it comes with no promise
 *      of return. There is no buy-back and no price floor. The software this
 *      funds is free to every member whether or not they ever hold a unit.
 */
contract DirectSale is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The token being sold.
    IERC20 public immutable bona;

    /// @notice The token accepted as payment. USDC on Base, six decimals.
    IERC20 public immutable usdc;

    /// @notice Where buyers' grants are written.
    ISaleVesting public immutable vesting;

    /// @notice The project multisig. Receives every dollar, holds no buyer tokens.
    address public immutable treasury;

    /// @notice BONA-wei per one whole USDC. Immutable: one price, for everyone.
    uint256 public immutable bonaPerUsdc;

    /// @notice Ceiling on what this contract can ever sell. Cannot be raised.
    uint256 public immutable maxBona;

    /// @notice How long a buyer's grant vests for. At least SaleVesting.MIN_DURATION.
    uint64 public immutable vestingDuration;

    /**
     * @notice Smallest purchase: one whole USDC.
     * @dev Not a barrier — it is a fifth of a cent above nothing at this
     *      price. It exists because every purchase writes a separate vesting
     *      grant, and a buyer who made thousands of dust purchases would push
     *      their own `release()` past the gas limit and strand their own
     *      tokens. SaleVesting caps the count as well; this keeps buyers far
     *      away from that cap in the first place.
     */
    uint256 public constant MIN_USDC = 1e6;

    /// @notice Total BONA sold by this contract.
    uint256 public bonaSold;

    /// @notice Total USDC received by this contract, all of it forwarded on.
    uint256 public usdcReceived;

    /// @notice BONA bought by each address, across all of their purchases.
    mapping(address => uint256) public boughtBy;

    event Bought(address indexed buyer, uint256 usdcAmount, uint256 bonaAmount);
    event UnsoldReclaimed(uint256 amount);

    error ZeroAddress();
    error BadPrice();
    error BadAllocation();
    error BadVestingDuration();
    error BelowMinimum();
    error SoldOut();
    error NotTreasury();
    error NothingToReclaim();

    /**
     * @param bona_            The BONA token.
     * @param usdc_            USDC on Base. Verify the address at circle.com.
     * @param vesting_         The deployed SaleVesting.
     * @param treasury_        The project multisig. Never an EOA.
     * @param bonaPerUsdc_     BONA-wei per one whole USDC.
     * @param maxBona_         Lifetime ceiling for this contract, in BONA-wei.
     * @param vestingDuration_ Buyer vesting length. Six months as published.
     */
    constructor(
        IERC20 bona_,
        IERC20 usdc_,
        ISaleVesting vesting_,
        address treasury_,
        uint256 bonaPerUsdc_,
        uint256 maxBona_,
        uint64 vestingDuration_
    ) {
        if (address(bona_) == address(0)) revert ZeroAddress();
        if (address(usdc_) == address(0)) revert ZeroAddress();
        if (address(vesting_) == address(0)) revert ZeroAddress();
        if (treasury_ == address(0)) revert ZeroAddress();
        if (bonaPerUsdc_ == 0) revert BadPrice();
        if (maxBona_ == 0) revert BadAllocation();

        // Outside SaleVesting's accepted window every grant would revert, and
        // a sale whose grants revert is a sale that cannot sell anything. Fail
        // at deployment, where it costs nothing, rather than at the first
        // purchase. (L-1)
        if (vestingDuration_ < vesting_.MIN_DURATION()) revert BadVestingDuration();
        if (vestingDuration_ > vesting_.MAX_VESTING_DURATION()) revert BadVestingDuration();

        bona = bona_;
        usdc = usdc_;
        vesting = vesting_;
        treasury = treasury_;
        bonaPerUsdc = bonaPerUsdc_;
        maxBona = maxBona_;
        vestingDuration = vestingDuration_;
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /**
     * @notice Buy BONA with USDC at the published price.
     * @dev Approve this contract for `usdcAmount` on USDC first.
     *
     *      The order below is deliberate: the USDC leaves the buyer only
     *      after the amount of BONA is known and the ceiling has been
     *      checked, and the grant is written in the same call. If SaleVesting
     *      rejects the grant for any reason — no reservation left, this
     *      contract out of BONA, the buyer at their grant limit — the whole
     *      transaction reverts and the buyer keeps their money.
     *
     * @param usdcAmount Payment in USDC units, six decimals. At least MIN_USDC.
     */
    function buy(uint256 usdcAmount) external nonReentrant {
        if (usdcAmount < MIN_USDC) revert BelowMinimum();

        uint256 bonaAmount = (usdcAmount * bonaPerUsdc) / 1e6;
        if (bonaSold + bonaAmount > maxBona) revert SoldOut();

        bonaSold += bonaAmount;
        usdcReceived += usdcAmount;
        boughtBy[msg.sender] += bonaAmount;

        // Straight to the multisig. This contract never holds a dollar, so
        // there is no balance here for anyone to argue about or to rescue.
        usdc.safeTransferFrom(msg.sender, treasury, usdcAmount);

        bona.forceApprove(address(vesting), bonaAmount);
        vesting.grant(msg.sender, bonaAmount, uint64(block.timestamp), vestingDuration);

        emit Bought(msg.sender, usdcAmount, bonaAmount);
    }

    // ---------------------------------------------------------------------
    // Treasury
    // ---------------------------------------------------------------------

    /**
     * @notice Return BONA held here to the multisig.
     * @dev Safe to take everything: a purchase moves the buyer's BONA into
     *      SaleVesting inside the same transaction, so nothing held here is
     *      ever owed to anyone. Emptying this contract stops the sale, which
     *      is the intended way to stop it.
     */
    function reclaimUnsold() external nonReentrant {
        if (msg.sender != treasury) revert NotTreasury();

        uint256 amount = bona.balanceOf(address(this));
        if (amount == 0) revert NothingToReclaim();

        bona.safeTransfer(treasury, amount);
        emit UnsoldReclaimed(amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice BONA that `usdcAmount` buys right now, before any transaction.
    function quote(uint256 usdcAmount) external view returns (uint256) {
        return (usdcAmount * bonaPerUsdc) / 1e6;
    }

    /// @notice BONA still sellable under this contract's own ceiling.
    function remainingBona() external view returns (uint256) {
        return maxBona - bonaSold;
    }

    /**
     * @notice BONA this contract can actually sell at this moment.
     * @dev The binding limit is whichever of three runs out first: the
     *      lifetime ceiling, the tokens held here, or the capacity reserved
     *      for this contract in SaleVesting. A buyer wanting to know whether
     *      their purchase will go through should read this, not `maxBona`.
     */
    function availableBona() external view returns (uint256) {
        uint256 remaining = maxBona - bonaSold;
        uint256 held = bona.balanceOf(address(this));
        uint256 reserved = vesting.reservationOf(address(this));

        uint256 limit = remaining < held ? remaining : held;
        return limit < reserved ? limit : reserved;
    }
}
