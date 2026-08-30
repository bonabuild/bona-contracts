// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Test-only six-decimal stablecoin. USDC's decimals matter to the
 *         price maths, so the suite must not test against an 18-decimal stand-in.
 */
contract MockUSDC is ERC20 {
    constructor(address holder, uint256 supply) ERC20("USD Coin", "USDC") {
        _mint(holder, supply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}

/**
 * @title MockAggregator
 * @notice Test-only Chainlink ETH/USD feed with a settable answer and age.
 */
contract MockAggregator {
    int256 public answer;
    uint256 public updatedAt;
    uint8 public immutable decimals;
    bool public shouldRevert;

    constructor(int256 answer_, uint8 decimals_) {
        answer = answer_;
        decimals = decimals_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    /// @dev Set the answer without refreshing `updatedAt`, to simulate staleness.
    function setStale(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setShouldRevert(bool v) external {
        shouldRevert = v;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        require(!shouldRevert, "feed down");
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/**
 * @title RejectingTreasury
 * @notice Test-only contract that refuses ETH, to prove settlement surfaces a
 *         failed transfer instead of silently losing it.
 */
contract RejectingTreasury {
    function settle(address round) external {
        (bool ok, bytes memory data) = round.call(abi.encodeWithSignature("settle()"));
        if (!ok) {
            assembly {
                revert(add(data, 32), mload(data))
            }
        }
    }

    receive() external payable {
        revert("no ETH");
    }
}
