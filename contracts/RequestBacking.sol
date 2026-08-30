// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title RequestBacking
 * @notice Members open software requests and back the ones they need by
 *         locking BONA against them. The quadratic ranking built from these
 *         locks decides what BonaBuild builds next.
 *         https://bonabuild.org
 *
 * @dev DESIGN: what this contract deliberately does NOT have.
 *
 *      - No withdrawal lock.     A backer can withdraw at any time, in any
 *                                request state, without anyone's permission.
 *                                See "WHY BACKING NEVER FREEZES" below.
 *
 *      - No spend, no burn.      Backing moves tokens into this contract and
 *                                nowhere else. Nothing is paid, so there is
 *                                nothing to refund. Every locked token can
 *                                only ever return to the address that locked
 *                                it.
 *
 *      - No sweep / rescue.      No path exists for anyone — curator
 *                                included — to move a backer's tokens.
 *
 *      - No permissioned opening. Anyone may open a request. Spam needs no
 *                                gate because an unbacked request scores
 *                                zero and ranks nowhere.
 *
 *      - No on-chain ranking.    See "WHY THE SCORE IS COMPUTED OFF-CHAIN".
 *
 *      - No pause.               Backing and withdrawal cannot be halted.
 *
 * @dev WHY BACKING NEVER FREEZES.
 *
 *      The tempting design freezes withdrawals once a request enters the
 *      build queue, so that backing cannot be pulled after it has influenced
 *      the roadmap. It was rejected: it hands the curator a way to hold a
 *      member's tokens hostage indefinitely, and it buys almost nothing,
 *      because backing never funds the build in the first place — a sale
 *      round does. The ranking is a live measure of present demand. If
 *      support evaporates, the ranking should say so.
 *
 *      So request status is informational. It records what is happening in
 *      the world; it has no power over anyone's custody.
 *
 * @dev WHY SCARCITY STILL MAKES THE SIGNAL MEAN SOMETHING.
 *
 *      If withdrawal is free, what stops a member backing everything? Their
 *      balance. A token can sit behind one request or another, not both, so
 *      backing forces a choice between requests. That is the scarcity
 *      quadratic funding needs. A free vote produces a wish list; a
 *      commitment of finite capital produces a roadmap.
 *
 * @dev WHY THE SCORE IS COMPUTED OFF-CHAIN.
 *
 *      The ranking is (SUM of sqrt(c))^2 over backers, and it is counted per
 *      MEMBER ACCOUNT rather than per wallet — because counting per wallet
 *      would let one holder split across many and manufacture the appearance
 *      of broad support. The account layer lives off-chain, so the score must
 *      too. This contract's job is to be the honest, complete, public record
 *      of who locked what against which request. The score is published with
 *      its inputs so anyone can recompute it from these events.
 *
 *      The sybil weakness is real and is documented rather than hidden. See
 *      09-requests-and-backing.md.
 *
 * @dev VOTING WEIGHT.
 *
 *      `unclaimedOf` reports everything this contract holds for an address,
 *      matching TeamVesting and RoundVesting, so one Snapshot `contract-call`
 *      strategy shape reads all three. Backing a request must never cost a
 *      member their vote.
 */
contract RequestBacking {
    using SafeERC20 for IERC20;

    /// @notice The token being locked.
    IERC20 public immutable token;

    /**
     * @notice The address that may update request status. The project multisig.
     * @dev Status is informational. This address cannot move, freeze or
     *      redirect a single locked token.
     */
    address public immutable curator;

    enum Status {
        Open, // accepting backing
        Queued, // selected by the ranking, being scoped or built
        Delivered, // shipped, free to every member
        Cancelled // withdrawn or rejected
    }

    /**
     * @param creator     Who opened it.
     * @param status      Informational only.
     * @param createdAt   Block timestamp at opening.
     * @param totalLocked Sum currently locked against it.
     * @param backerCount Distinct addresses currently backing it, for the
     *                    public record — a request backed by one address and
     *                    a request backed by a hundred should not look alike.
     * @param details     Content hash of the request text, held off-chain.
     */
    struct Request {
        address creator;
        Status status;
        uint64 createdAt;
        uint128 totalLocked;
        uint64 backerCount;
        bytes32 details;
    }

    Request[] private _requests;

    /// @notice Amount locked by an address against a request.
    mapping(uint256 => mapping(address => uint256)) public lockedBy;

    /// @notice Total this contract holds for an address, across all requests.
    mapping(address => uint256) public totalLockedBy;

    /// @notice Total locked across every request.
    uint256 public totalLocked;

    event RequestOpened(uint256 indexed requestId, address indexed creator, bytes32 details);
    event StatusChanged(uint256 indexed requestId, Status status);
    event Backed(uint256 indexed requestId, address indexed backer, uint256 amount, uint256 newTotal);
    event Withdrawn(uint256 indexed requestId, address indexed backer, uint256 amount, uint256 newTotal);

    error NotCurator();
    error ZeroAddress();
    error UnknownRequest();
    error ZeroAmount();
    error RequestClosed();
    error InsufficientLocked();
    error StatusUnchanged();
    error AlreadyFinal();

    modifier onlyCurator() {
        if (msg.sender != curator) revert NotCurator();
        _;
    }

    modifier exists(uint256 requestId) {
        if (requestId >= _requests.length) revert UnknownRequest();
        _;
    }

    /**
     * @param token_   The BONA token.
     * @param curator_ The project multisig. Never an EOA.
     */
    constructor(IERC20 token_, address curator_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (curator_ == address(0)) revert ZeroAddress();
        token = token_;
        curator = curator_;
    }

    // ---------------------------------------------------------------------
    // Anyone
    // ---------------------------------------------------------------------

    /**
     * @notice Open a request. Free, permissionless, no BONA required.
     * @param details Content hash of the request text stored off-chain.
     * @return requestId The new request's id.
     */
    function openRequest(bytes32 details) external returns (uint256 requestId) {
        requestId = _requests.length;
        _requests.push(
            Request({
                creator: msg.sender,
                status: Status.Open,
                createdAt: uint64(block.timestamp),
                totalLocked: 0,
                backerCount: 0,
                details: details
            })
        );
        emit RequestOpened(requestId, msg.sender, details);
    }

    /**
     * @notice Lock BONA against a request. Not a payment — the tokens stay
     *         yours and only ever return to you.
     */
    function back(uint256 requestId, uint256 amount) external exists(requestId) {
        if (amount == 0) revert ZeroAmount();

        Request storage r = _requests[requestId];
        if (r.status == Status.Delivered || r.status == Status.Cancelled) {
            revert RequestClosed();
        }

        if (lockedBy[requestId][msg.sender] == 0) {
            r.backerCount += 1;
        }
        lockedBy[requestId][msg.sender] += amount;
        r.totalLocked += uint128(amount);
        totalLockedBy[msg.sender] += amount;
        totalLocked += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Backed(requestId, msg.sender, amount, r.totalLocked);
    }

    /**
     * @notice Withdraw backing. Always available, in every request state,
     *         without anyone's approval.
     */
    function withdraw(uint256 requestId, uint256 amount) external exists(requestId) {
        if (amount == 0) revert ZeroAmount();

        uint256 locked = lockedBy[requestId][msg.sender];
        if (locked < amount) revert InsufficientLocked();

        Request storage r = _requests[requestId];
        unchecked {
            lockedBy[requestId][msg.sender] = locked - amount;
        }
        if (locked == amount) {
            r.backerCount -= 1;
        }
        r.totalLocked -= uint128(amount);
        totalLockedBy[msg.sender] -= amount;
        totalLocked -= amount;

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(requestId, msg.sender, amount, r.totalLocked);
    }

    /// @notice Withdraw everything locked against a request.
    function withdrawAll(uint256 requestId) external exists(requestId) {
        uint256 locked = lockedBy[requestId][msg.sender];
        if (locked == 0) revert InsufficientLocked();

        Request storage r = _requests[requestId];
        lockedBy[requestId][msg.sender] = 0;
        r.backerCount -= 1;
        r.totalLocked -= uint128(locked);
        totalLockedBy[msg.sender] -= locked;
        totalLocked -= locked;

        token.safeTransfer(msg.sender, locked);
        emit Withdrawn(requestId, msg.sender, locked, r.totalLocked);
    }

    // ---------------------------------------------------------------------
    // Curator. Records what is happening; controls no tokens.
    // ---------------------------------------------------------------------

    /**
     * @notice Record a change in a request's real-world state.
     * @dev Delivered and Cancelled are final: a shipped or rejected request
     *      does not reopen, it is superseded by a new one. Backers of a final
     *      request should withdraw — and can, at any time, as always.
     */
    function setStatus(uint256 requestId, Status status) external onlyCurator exists(requestId) {
        Request storage r = _requests[requestId];
        if (r.status == status) revert StatusUnchanged();
        if (r.status == Status.Delivered || r.status == Status.Cancelled) {
            revert AlreadyFinal();
        }
        r.status = status;
        emit StatusChanged(requestId, status);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice How many requests have been opened.
    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    /// @notice One request.
    function getRequest(uint256 requestId)
        external
        view
        exists(requestId)
        returns (
            address creator,
            Status status,
            uint64 createdAt,
            uint256 lockedTotal,
            uint64 backerCount,
            bytes32 details
        )
    {
        Request storage r = _requests[requestId];
        return (r.creator, r.status, r.createdAt, r.totalLocked, r.backerCount, r.details);
    }

    /**
     * @notice Everything this contract holds for `account`.
     * @dev Same name and shape as TeamVesting and RoundVesting, so a single
     *      Snapshot `contract-call` strategy reads all three. Backing a
     *      request must never cost a member their vote.
     */
    function unclaimedOf(address account) external view returns (uint256) {
        return totalLockedBy[account];
    }
}
