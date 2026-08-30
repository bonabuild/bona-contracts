/**
 * BONA — deployment script
 *
 * Usage:
 *   $env:DEPLOYER_PRIVATE_KEY = "0x..."
 *   $env:INITIAL_HOLDER       = "0x..."   # multisig that receives the supply
 *
 *   npx hardhat run scripts/deploy.js --network baseSepolia   # test first
 *   npx hardhat run scripts/deploy.js --network base          # mainnet
 *
 * The script refuses to deploy to mainnet unless INITIAL_HOLDER is set
 * explicitly, so the supply can never land on an unintended address.
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
  const initialHolder = process.env.INITIAL_HOLDER || "";

  // --- Safety checks -------------------------------------------------------
  if (isMainnet && !initialHolder) {
    throw new Error(
      "INITIAL_HOLDER is not set. On mainnet this must be the project " +
        "multisig address — refusing to default to the deployer EOA."
    );
  }
  if (initialHolder && !ethers.isAddress(initialHolder)) {
    throw new Error(`INITIAL_HOLDER is not a valid address: ${initialHolder}`);
  }

  const holder = initialHolder || deployer.address;
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("=".repeat(64));
  console.log("  BONA — deployment");
  console.log("=".repeat(64));
  console.log(`  Network        : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`  Deployer       : ${deployer.address}`);
  console.log(`  Deployer ETH   : ${ethers.formatEther(balance)}`);
  console.log(`  Initial holder : ${holder}`);
  if (holder === deployer.address) {
    console.log("  NOTE           : supply goes to the deployer EOA (testnet only)");
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
  console.log("  Deploying BonaToken...");
  const Factory = await ethers.getContractFactory("BonaToken");
  const token = await Factory.deploy(holder);
  await token.waitForDeployment();

  const address = await token.getAddress();
  const deployTx = token.deploymentTransaction();
  const receipt = await deployTx.wait();

  console.log("\n" + "=".repeat(64));
  console.log(`  BONA DEPLOYED: ${address}`);
  console.log("=".repeat(64));

  // --- Verify on-chain state ----------------------------------------------
  // Public RPCs are load-balanced: the node answering a read may not have
  // indexed the deployment yet, which surfaces as BAD_DATA ("0x") moments
  // after a successful deploy. Retry briefly instead of failing a deploy
  // that already happened.
  async function readState() {
    return Promise.all([
      token.name(),
      token.symbol(),
      token.decimals(),
      token.totalSupply(),
      token.balanceOf(holder),
    ]);
  }
  let state;
  for (let attempt = 1; ; attempt++) {
    try {
      state = await readState();
      break;
    } catch (err) {
      if (attempt >= 6) throw err;
      console.log(`  read-back not indexed yet, retrying (${attempt}/5) ...`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const [name, symbol, decimals, totalSupply, holderBalance] = state;

  console.log(`  name          : ${name}`);
  console.log(`  symbol        : ${symbol}`);
  console.log(`  decimals      : ${decimals}`);
  console.log(`  totalSupply   : ${ethers.formatUnits(totalSupply, decimals)}`);
  console.log(`  holder balance: ${ethers.formatUnits(holderBalance, decimals)}`);
  console.log(`  gas used      : ${receipt.gasUsed}`);
  console.log(`  tx hash       : ${deployTx.hash}`);

  if (totalSupply !== holderBalance) {
    console.log("\n  WARNING: total supply and holder balance differ. Investigate.");
  }

  // --- Record --------------------------------------------------------------
  const explorer = isMainnet
    ? "https://basescan.org"
    : "https://sepolia.basescan.org";

  const record = {
    network: network.name,
    chainId: Number(network.config.chainId),
    address,
    name,
    symbol,
    decimals: Number(decimals),
    totalSupply: totalSupply.toString(),
    initialHolder: holder,
    deployer: deployer.address,
    txHash: deployTx.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    explorer: `${explorer}/token/${address}`,
  };

  const outDir = path.join(__dirname, "..", "deployment");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));

  console.log(`\n  Record written : ${outFile}`);
  console.log(`  Explorer       : ${record.explorer}`);

  // --- Verify source -------------------------------------------------------
  if (!process.env.BASESCAN_API_KEY) {
    console.log("\n  BASESCAN_API_KEY not set — skipping source verification.");
    console.log("  Verify later with:");
    console.log(`    npx hardhat verify --network ${network.name} ${address} ${holder}`);
    return;
  }

  console.log("\n  Waiting for block confirmations before verifying...");
  await deployTx.wait(5);

  try {
    await run("verify:verify", { address, constructorArguments: [holder] });
    console.log("  Source verified on Basescan.");
  } catch (err) {
    const msg = String(err.message || err);
    if (msg.toLowerCase().includes("already verified")) {
      console.log("  Source was already verified.");
    } else {
      console.log(`  Verification failed: ${msg}`);
      console.log("  Retry with:");
      console.log(`    npx hardhat verify --network ${network.name} ${address} ${holder}`);
    }
  }
}

main().catch((err) => {
  console.error("\nDEPLOYMENT FAILED:", err.message || err);
  process.exitCode = 1;
});
