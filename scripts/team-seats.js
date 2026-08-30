/**
 * team-seats.js — assign BonaBuild core-team seats in TeamVesting.
 *
 * Usage:
 *   $env:TEAM_VESTING = "0x..."          # deployed TeamVesting address
 *   npx hardhat run scripts/team-seats.js --network baseSepolia
 *   npx hardhat run scripts/team-seats.js --network base       # mainnet
 *
 * On mainnet the funder is the Safe multisig, which this script cannot sign
 * for. So on mainnet it VALIDATES and PRINTS the calldata for the Safe, and
 * sends nothing. On a testnet where the funder is the deployer EOA, it can
 * execute directly.
 *
 * Every address is checked before anything is printed or sent:
 *   - EIP-55 checksum, so a typo cannot pass
 *   - not the zero address, not the token, not the vesting contract itself
 *   - not a contract, unless ALLOW_CONTRACT_BENEFICIARY is set
 *   - not already seated
 *
 * A wrong address here is unrecoverable: there is no revoke function, by
 * design. Read the printed table before approving anything in the Safe.
 */
const { ethers, network } = require("hardhat");

/**
 * Seats 0..4. `address: null` leaves the seat vacant, which is valid — an
 * unfilled seat simply never receives a tranche, and its 2,000,000 BONA
 * stays in the multisig.
 *
 * Names describe the SEAT, not the person. Holders change; the seat and its
 * budget do not. When someone is replaced, `vacateSeat` then `assignSeat`
 * puts a new address in the same seat under the same label — and moves no
 * tokens, because the departing holder keeps every tranche already funded.
 */
const SEATS = [
  { seat: 0, name: "Team Lead",     address: "0x38b1FD31b6d69AfA580F349DA9582984842C4d3F" },
  { seat: 1, name: "Developer 1",   address: "0x4D6A232174Fb166DDf68ec481F8dC9744d9A4654" },
  { seat: 2, name: "Developer 2",   address: "0xb91233355d422455C9109e4CCAe318260d6C361c" },
  { seat: 3, name: "Deputy Lead",   address: "0x26177569d4912ad538BED506EF5c5D36eED50870" },
  { seat: 4, name: "Developer 3",   address: null },
];

async function main() {
  const vestingAddress = process.env.TEAM_VESTING || "";
  if (!ethers.isAddress(vestingAddress)) {
    throw new Error(
      "TEAM_VESTING is not set to a valid address. Deploy TeamVesting first."
    );
  }

  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY and try again.");

  const vesting = await ethers.getContractAt("TeamVesting", vestingAddress);
  const funder = await vesting.funder();
  const token = await vesting.token();
  const isMainnet = network.name === "base";

  console.log("");
  console.log("  TeamVesting    :", vestingAddress);
  console.log("  Token          :", token);
  console.log("  Funder         :", funder);
  console.log("  Network        :", `${network.name} (chainId ${network.config.chainId})`);
  console.log("  Signer         :", signer.address);
  console.log("");

  // ---- validate every address before doing anything ----
  const seen = new Set();
  const planned = [];

  for (const entry of SEATS) {
    const { seat, name, address } = entry;

    if (address === null) {
      console.log(`  seat ${seat}  ${name.padEnd(14)} — VACANT, nothing to do`);
      continue;
    }

    let checksummed;
    try {
      checksummed = ethers.getAddress(address);
    } catch {
      throw new Error(
        `seat ${seat} (${name}): "${address}" is not a valid EVM address. ` +
          `If it is a Solana or other non-EVM address it cannot be used — BONA is on Base.`
      );
    }

    if (checksummed === ethers.ZeroAddress) {
      throw new Error(`seat ${seat} (${name}): zero address.`);
    }
    if (checksummed.toLowerCase() === token.toLowerCase()) {
      throw new Error(`seat ${seat} (${name}): this is the token address.`);
    }
    if (checksummed.toLowerCase() === vestingAddress.toLowerCase()) {
      throw new Error(`seat ${seat} (${name}): this is the vesting contract itself.`);
    }
    if (seen.has(checksummed.toLowerCase())) {
      throw new Error(`seat ${seat} (${name}): duplicate address.`);
    }
    seen.add(checksummed.toLowerCase());

    const code = await ethers.provider.getCode(checksummed);
    const isContract = code !== "0x";
    if (isContract && !process.env.ALLOW_CONTRACT_BENEFICIARY) {
      throw new Error(
        `seat ${seat} (${name}): ${checksummed} is a contract, not an EOA. ` +
          `Exchange deposit addresses and unsupported smart wallets lose tokens ` +
          `permanently. Set ALLOW_CONTRACT_BENEFICIARY=1 only if you are certain ` +
          `this contract can hold and transact BONA on Base.`
      );
    }

    const already = await vesting.seatHolder(seat);
    if (already !== ethers.ZeroAddress) {
      console.log(
        `  seat ${seat}  ${name.padEnd(14)} — already held by ${already}, skipping`
      );
      continue;
    }
    if (await vesting.isSeated(checksummed)) {
      throw new Error(`seat ${seat} (${name}): ${checksummed} already holds another seat.`);
    }

    planned.push({ seat, name, address: checksummed, isContract });
  }

  if (planned.length === 0) {
    console.log("\n  Nothing to assign.\n");
    return;
  }

  console.log("\n  To assign:\n");
  for (const p of planned) {
    console.log(`  seat ${p.seat}  ${p.name.padEnd(14)} ${p.address}`);
  }

  // ---- mainnet: print Safe calldata, send nothing ----
  if (isMainnet || signer.address.toLowerCase() !== funder.toLowerCase()) {
    console.log("\n  The signer is not the funder, so nothing will be sent.");
    console.log("  Queue these calls in the Safe, one per seat:\n");
    for (const p of planned) {
      const data = vesting.interface.encodeFunctionData("assignSeat", [
        p.seat,
        p.address,
      ]);
      console.log(`  seat ${p.seat} — ${p.name}`);
      console.log(`    to    : ${vestingAddress}`);
      console.log(`    value : 0`);
      console.log(`    data  : ${data}`);
      console.log("");
    }
    console.log("  Before approving, check each address character by character.");
    console.log("  There is no revoke function. A wrong address is unrecoverable.\n");
    return;
  }

  // ---- testnet with an EOA funder: execute ----
  for (const p of planned) {
    const tx = await vesting.assignSeat(p.seat, p.address);
    await tx.wait();
    console.log(`  assigned seat ${p.seat} to ${p.address}  (${tx.hash})`);
  }

  console.log("\n  Seats now:\n");
  const holders = await vesting.allSeatHolders();
  holders.forEach((h, i) => {
    console.log(`  seat ${i}  ${h === ethers.ZeroAddress ? "(vacant)" : h}`);
  });
  console.log("");
}

main().catch((err) => {
  console.error("\n  FAILED:", err.message, "\n");
  process.exitCode = 1;
});
