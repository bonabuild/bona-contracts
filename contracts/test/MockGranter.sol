// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IVestingForMock {
    function grant(address beneficiary, uint256 amount, uint64 start, uint64 duration) external;

    function commit(uint256 amount) external;
}

/**
 * @title MockGranter
 * @notice Test-only stand-in for a sale contract. The vesting contracts
 *         require granters to be contracts, so the suite needs one to grant
 *         through.
 * @dev Never deployed to any live network.
 */
contract MockGranter {
    IERC20 public immutable token;
    IVestingForMock public immutable vesting;

    constructor(IERC20 token_, IVestingForMock vesting_) {
        token = token_;
        vesting = vesting_;
    }

    /// @dev Approve the vesting contract, then create the grant, as a real sale would.
    function settleFor(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration
    ) external {
        token.approve(address(vesting), amount);
        vesting.grant(beneficiary, amount, start, duration);
    }

    /// @dev Declare an obligation the funder may not release capacity below.
    function commitTo(uint256 amount) external {
        vesting.commit(amount);
    }
}
