// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IRoundVesting {
    function grant(address beneficiary, uint256 amount, uint64 start, uint64 duration) external;
}

/**
 * @title MockRound
 * @notice Test-only stand-in for SaleRound. RoundVesting requires granters to
 *         be contracts, so the suite needs one to grant through.
 * @dev Never deployed to any live network.
 */
contract MockRound {
    IERC20 public immutable token;
    IRoundVesting public immutable vesting;

    constructor(IERC20 token_, IRoundVesting vesting_) {
        token = token_;
        vesting = vesting_;
    }

    /// @dev Approve the vesting contract, then create the grant, as a real round would.
    function settleFor(
        address beneficiary,
        uint256 amount,
        uint64 start,
        uint64 duration
    ) external {
        token.approve(address(vesting), amount);
        vesting.grant(beneficiary, amount, start, duration);
    }
}
