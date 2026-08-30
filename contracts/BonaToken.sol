// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title BonaBuild (BONA)
 * @notice Governance and contribution token for the BonaBuild software commons.
 *         https://bonabuild.org
 *
 * @dev DESIGN: what this contract deliberately does NOT have.
 *
 *      This contract is intentionally minimal. Every capability listed below
 *      was considered and left out, because each one is a way for the deployer
 *      to harm holders later. Their absence is the point.
 *
 *      - No mint function.       The entire supply is created once, in the
 *                                constructor. There is no code path that can
 *                                ever create another BONA. This is stronger
 *                                than "renouncing" a mint role after the fact,
 *                                because the capability never exists at all.
 *
 *      - No owner / no admin.    The contract does not inherit Ownable or
 *                                AccessControl. There is no privileged address,
 *                                so there is nothing to transfer, compromise,
 *                                or forget to renounce.
 *
 *      - No pause.               Transfers cannot be halted by anyone.
 *
 *      - No blacklist / freeze.  No address can be blocked from sending or
 *                                receiving. Holders keep custody, always.
 *
 *      - No transfer fee / tax.  transfer(x) moves exactly x. No hidden
 *                                deduction, no reflection, no burn-on-transfer.
 *
 *      - No upgradeability.      Not a proxy. The bytecode deployed is the
 *                                bytecode that runs, permanently.
 *
 *      What it does have beyond a plain ERC-20 is ERC20Permit (EIP-2612),
 *      which lets holders approve spending with a signature instead of a
 *      transaction. It costs holders nothing and cannot be used against them.
 *
 * @dev GOVERNANCE NOTE
 *      ERC20Votes is deliberately not included. Voting runs on Snapshot,
 *      which reads balances at a past block and costs voters no gas.
 *      ERC20Votes would add checkpoint writes to every transfer and would
 *      require holders to self-delegate before their tokens counted — a
 *      well-known trap that silently disenfranchises most holders.
 *      If binding on-chain execution is ever adopted, it will be added as a
 *      separate wrapper rather than by changing this contract, which cannot
 *      be changed.
 */
contract BonaToken is ERC20, ERC20Permit {
    /// @notice Total supply, fixed forever at 100,000,000 BONA (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 100_000_000 * 1e18;

    /**
     * @param initialHolder Address receiving the entire supply at deployment.
     *                      This should be the project multisig, never an EOA.
     *                      Allocations are distributed from there, in public.
     */
    constructor(address initialHolder)
        ERC20("BonaBuild", "BONA")
        ERC20Permit("BonaBuild")
    {
        require(initialHolder != address(0), "BONA: initial holder is zero address");
        _mint(initialHolder, TOTAL_SUPPLY);
    }
}
