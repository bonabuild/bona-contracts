/**
 * BONA — governance suite deployment
 *
 * Deploys the three long-lived contracts around the token:
 *
 *   TeamVesting     team allocation, 5 seats, no revoke
 *   SaleVesting     buyer grants, 6-month lock enforced, capacity reserved
 *   RequestBacking  lock BONA behind a request
 *
 * DirectSale is NOT deployed here — it is deployed separately, later, by
 * scripts/deploy-sale.js.
 *
 * Usage:
 *   $env:DEPLOYER_PRIVATE_KEY = "0x..."
 *   $env:BONA_TOKEN           = "0x..."   # deployed BonaToken
 *   $env:MULTISIG             = "0x..."   # funder/curator. Mandatory on mainnet
 *
 *   npx hardhat run scripts/deploy-suite.js --network baseSepolia   # test first
 *   npx hardhat run scripts/deploy-suite.js --network base          # mainnet
 *
 * The script refuses mainnet unless MULTISIG is set explicitly, mirroring
 * deploy.js: a privileged role can never silently default to the deployer EOA.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, run } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY and try again.");
  }

  const isMainnet = network.name === "base";
  const tokenAddress = process.env.BONA_TOKEN || "";
  const multisig = process.env.MULTISIG || "";

  // --- Safety checks -------------------------------------------------------
  if (!ethers.isAddress(tokenAddress)) {
    throw new Error("BONA_TOKEN is not set to a valid address. Deploy the token first.");
  }
  if (isMainnet && !multisig) {
    throw new Error(
      "MULTISIG is not set. On mainnet the funder/curator must be the project " +
        "multisig — refusing to default to the deployer EOA."
    );
  }
  if (multisig && !ethers.isAddress(multisig)) {
    throw new Error(`MULTISIG is not a valid address: ${multisig}`);
  }

  const admin = multisig || deployer.address;
  const balance = await ethers.provider.getBalance(deployer.address);

  // The token must actually be BonaToken on this network.
  const token = await ethers.getContractAt("BonaToken", tokenAddress);
  let symbol;
  try {
    symbol = await token.symbol();
  } catch {
    throw new Error(`No readable ERC-20 at ${tokenAddress} on ${network.name}.`);
  }
  if (symbol !== "BONA") {
    throw new Error(`Token at ${tokenAddress} has symbol ${symbol}, expected BONA.`);
  }

  console.log("=".repeat(64));
  console.log("  BONA — governance suite deployment");
  console.log("=".repeat(64));
  console.log(`  Network        : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`  Deployer       : ${deployer.address}`);
  console.log(`  Deployer ETH   : ${ethers.formatEther(balance)}`);
  console.log(`  Token          : ${tokenAddress}`);
  console.log(`  Funder/curator : ${admin}`);
  if (admin === deployer.address) {
    console.log("  NOTE           : funder is the deployer EOA (testnet only)");
  }
  console.log("=".repeat(64));

  if (balance === 0n) {
    throw new Error("Deployer has no ETH on this network. Fund it first.");
  }

  if (isMainnet) {
    console.log("\n  MAINNET DEPLOYMENT — this cannot be undone.");
    console.log("  Waiting 10 seconds. Press Ctrl+C to abort.\n");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // --- Deploy --------------------------------------------------------------
  const deployed = {};

  for (const name of ["TeamVesting", "SaleVesting", "RequestBacking"]) {
    process.stdout.write(`  Deploying ${name} ... `);
    const Factory = await ethers.getContractFactory(name);
    const contract = await Factory.deploy(tokenAddress, admin);
    await contract.waitForDeployment();
    deployed[name] = await contract.getAddress();
    console.log(deployed[name]);
  }

  // --- Sanity: read back the immutables ------------------------------------
  const teamVesting = await ethers.getContractAt("TeamVesting", deployed.TeamVesting);
  const saleVesting = await ethers.getContractAt("SaleVesting", deployed.SaleVesting);
  const backing = await ethers.getContractAt("RequestBacking", deployed.RequestBacking);

  // Public RPCs are load-balanced; retry briefly if the answering node has
  // not indexed the deployments yet (same race deploy.js guards against).
  async function readChecks() {
    return [
    ["TeamVesting.funder", await teamVesting.funder(), admin],
    ["TeamVesting.token", await teamVesting.token(), tokenAddress],
    ["SaleVesting.funder", await saleVesting.funder(), admin],
    ["SaleVesting.token", await saleVesting.token(), tokenAddress],
    ["RequestBacking.curator", await backing.curator(), admin],
    ["RequestBacking.token", await backing.token(), tokenAddress],
    ];
  }
  let checks;
  for (let attempt = 1; ; attempt++) {
    try {
      checks = await readChecks();
      break;
    } catch (err) {
      if (attempt >= 6) throw err;
      console.log(`  read-back not indexed yet, retrying (${attempt}/5) ...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  for (const [label, actual, expected] of checks) {
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${label} is ${actual}, expected ${expected}`);
    }
  }
  console.log("\n  Immutables verified against inputs.");

  // --- Record --------------------------------------------------------------
  const record = {
    network: network.name,
    chainId: network.config.chainId,
    deployer: deployer.address,
    token: tokenAddress,
    funder: admin,
    contracts: deployed,
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployment");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-suite.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`  Record written : ${outFile}`);

  // --- Verify on Basescan ---------------------------------------------------
  if (process.env.BASESCAN_API_KEY) {
    console.log("\n  Verifying source on Basescan ...");
    for (const [name, address] of Object.entries(deployed)) {
      try {
        await run("verify:verify", {
          address,
          constructorArguments: [tokenAddress, admin],
        });
        console.log(`  ${name} verified.`);
      } catch (err) {
        console.log(`  ${name} verification failed (retry later):`);
        console.log(`    npx hardhat verify --network ${network.name} ${address} ${tokenAddress} ${admin}`);
      }
    }
  } else {
    console.log("\n  BASESCAN_API_KEY not set — verify manually:");
    for (const [name, address] of Object.entries(deployed)) {
      console.log(`    npx hardhat verify --network ${network.name} ${address} ${tokenAddress} ${admin}   # ${name}`);
    }
  }

  console.log("\n  Next steps:");
  console.log("    1. scripts/team-seats.js       — assign the five seats");
  console.log("    2. scripts/deploy-sale.js      — deploy the sale at the published price");
  console.log("    3. Snapshot strategy update    — MUST be live before the sale opens");
  console.log("");
}

main().catch((err) => {
  console.error("\n  FAILED:", err.message, "\n");
  process.exitCode = 1;
});
