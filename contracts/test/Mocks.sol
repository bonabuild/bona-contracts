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
