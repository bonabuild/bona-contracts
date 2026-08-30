/**
 * BONA — deploy one SaleRound
 *
 * Run AFTER the round proposal has passed its vote. Every parameter below
 * must match the proposal exactly — the numbers members approved are the
 * numbers that get frozen into the contract.
 *
 * Prices are DERIVED, not chosen:
 *
 *   bonaPerUsdc = allocation / goalUsd
 *   bonaPerEth  = bonaPerUsdc * referenceEthUsd
 *
 * Usage:
 *   $env:DEPLOYER_PRIVATE_KEY = "0x..."
 *   $env:BONA_TOKEN     = "0x..."     # deployed BonaToken
 *   $env:ROUND_VESTING  = "0x..."     # deployed RoundVesting
 *   $env:MULTISIG       = "0x..."     # treasury. Mandatory on mainnet
 *   $env:USDC_TOKEN     = "0x..."     # mandatory on mainnet — verify at circle.com
 *   $env:ETH_USD_FEED   = "0x..."     # mandatory on mainnet — verify at data.chain.link
 *                                     # set to "none" for a USDC-only round
 *   $env:GOAL_USD       = "30000"     # round goal in whole USD
 *   $env:FLOOR_USD      = "15000"     # round floor in whole USD
 *   $env:ALLOCATION     = "3000000"   # BONA allocated to this round
 *   $env:REFERENCE_ETH  = "3000"      # published ETH/USD reference, whole USD
 *   $env:DURATION_DAYS  = "14"        # at most 14
 *
 *   npx hardhat run scripts/deploy-round.js --network baseSepolia
 *   npx hardhat run scripts/deploy-round.js --network base
 *
 * After deployment the round still cannot sell anything until the multisig:
 *   1. transfers the allocation of BONA to the round address, and
 *   2. calls RoundVesting.authoriseGranter(round).
 * Both are printed as Safe calldata at the end.
 */

const fs = require("node:fs");
const path = require("node:path");
const { ethers, network, run } = require("hardhat");

function requireEnv(name) {
  const v = process.env[name] || "";
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

function requirePositiveInt(name) {
  const v = requireEnv(name);
  if (!/^\d+$/.test(v) || BigInt(v) === 0n) {
    throw new Error(`${name} must be a positive whole number, got "${v}".`);
  }
  return BigInt(v);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY and try again.");
  }

  const isMainnet = network.name === "base";

  // --- Inputs --------------------------------------------------------------
  const tokenAddress = requireEnv("BONA_TOKEN");
  const vestingAddress = requireEnv("ROUND_VESTING");
  const multisig = process.env.MULTISIG || "";
  const usdcAddress = process.env.USDC_TOKEN || "";
  const feedInput = process.env.ETH_USD_FEED || "";

  const goalUsd = requirePositiveInt("GOAL_USD");
  const floorUsd = requirePositiveInt("FLOOR_USD");
  const allocation = requirePositiveInt("ALLOCATION"); // whole BONA
  const durationDays = requirePositiveInt("DURATION_DAYS");

  const ethLane = feedInput.toLowerCase() !== "none";
  const referenceEth = ethLane ? requirePositiveInt("REFERENCE_ETH") : 0n;

  // --- Safety checks -------------------------------------------------------
  for (const [name, v] of [
    ["BONA_TOKEN", tokenAddress],
    ["ROUND_VESTING", vestingAddress],
  ]) {
    if (!ethers.isAddress(v)) throw new Error(`${name} is not a valid address: ${v}`);
  }
  if (isMainnet) {
    if (!multisig) {
      throw new Error("MULTISIG is not set. Mandatory on mainnet — the treasury must be the Safe.");
    }
    if (!usdcAddress) {
      throw new Error(
        "USDC_TOKEN is not set. Mandatory on mainnet, and there is deliberately no " +
          "default: verify the address at circle.com before setting it."
      );
    }
    if (ethLane && !ethers.isAddress(feedInput)) {
      throw new Error(
        "ETH_USD_FEED is not a valid address. Mandatory on mainnet (or \"none\"), and " +
          "there is deliberately no default: verify it at data.chain.link before setting it."
      );
    }
  }
  if (multisig && !ethers.isAddress(multisig)) {
    throw new Error(`MULTISIG is not a valid address: ${multisig}`);
  }
  if (usdcAddress && !ethers.isAddress(usdcAddress)) {
    throw new Error(`USDC_TOKEN is not a valid address: ${usdcAddress}`);
  }
  if (floorUsd > goalUsd) {
    throw new Error(`FLOOR_USD (${floorUsd}) exceeds GOAL_USD (${goalUsd}).`);
  }
  if (durationDays > 14n) {
    throw new Error(`DURATION_DAYS is ${durationDays}; the contract caps rounds at 14 days.`);
  }

  const treasury = multisig || deployer.address;

  // --- Derive the frozen prices --------------------------------------------
  // bonaPerUsdc: BONA-wei per 1 whole USDC. allocation and goal are whole units.
  if ((allocation * 10n ** 18n) % goalUsd !== 0n) {
    console.log("  NOTE: allocation/goal does not divide exactly; price truncates.");
  }
  const bonaPerUsdc = (allocation * 10n ** 18n) / goalUsd;
  const bonaPerEth = ethLane ? bonaPerUsdc * referenceEth : 0n;
  const allocationWei = allocation * 10n ** 18n;
  const floorWei = (allocationWei * floorUsd) / goalUsd;
  const durationSec = durationDays * 24n * 60n * 60n;
  const vestingDuration = 180n * 24n * 60n * 60n; // six months, the published schedule

  // Chainlink feeds use 8 decimals.
  const referenceFeedUnits = referenceEth * 10n ** 8n;

  // --- Testnet conveniences -------------------------------------------------
  let usdc = usdcAddress;
  let feed = ethLane ? feedInput : ethers.ZeroAddress;

  if (!isMainnet && !usdc) {
    process.stdout.write("  No USDC_TOKEN set — deploying MockUSDC ... ");
    const Usdc = await ethers.getContractFactory("MockUSDC");
    const mock = await Usdc.deploy(deployer.address, 10_000_000n * 10n ** 6n);
    await mock.waitForDeployment();
    usdc = await mock.getAddress();
    console.log(usdc);
  }
  if (!isMainnet && ethLane && !ethers.isAddress(feed)) {
    process.stdout.write("  No ETH_USD_FEED set — deploying MockAggregator ... ");
    const Feed = await ethers.getContractFactory("MockAggregator");
    const mock = await Feed.deploy(referenceFeedUnits, 8);
    await mock.waitForDeployment();
    feed = await mock.getAddress();
    console.log(feed);
  }

  // --- Review before anything irreversible ----------------------------------
  console.log("=".repeat(64));
  console.log("  BONA — SaleRound deployment");
  console.log("=".repeat(64));
  console.log(`  Network        : ${network.name} (chainId ${network.config.chainId})`);
  console.log(`  Deployer       : ${deployer.address}`);
  console.log(`  Treasury       : ${treasury}`);
  console.log(`  Token          : ${tokenAddress}`);
  console.log(`  RoundVesting   : ${vestingAddress}`);
  console.log(`  USDC           : ${usdc}`);
  console.log(`  ETH/USD feed   : ${ethLane ? feed : "(ETH lane disabled)"}`);
  console.log("  " + "-".repeat(60));
  console.log(`  Goal           : $${goalUsd}  =  ${allocation} BONA`);
  console.log(`  Floor          : $${floorUsd}  =  ${ethers.formatUnits(floorWei, 18)} BONA`);
  console.log(`  Price          : 1 USDC = ${ethers.formatUnits(bonaPerUsdc, 18)} BONA`);
  if (ethLane) {
    console.log(`  Price          : 1 ETH  = ${ethers.formatUnits(bonaPerEth, 18)} BONA  (ref $${referenceEth})`);
    console.log("  Breaker        : ETH lane closes at ±20% from the reference");
  }
  console.log(`  Duration       : ${durationDays} days`);
  console.log(`  Vesting        : 180 days linear from close`);
  console.log("=".repeat(64));

  if (isMainnet) {
    console.log("\n  MAINNET — these terms freeze permanently at deployment.");
    console.log("  Check every number against the passed proposal.");
    console.log("  Waiting 10 seconds. Press Ctrl+C to abort.\n");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  // --- Deploy ---------------------------------------------------------------
  const constructorArgs = [
    tokenAddress,
    usdc,
    vestingAddress,
    treasury,
    ethLane ? feed : ethers.ZeroAddress,
    bonaPerUsdc,
    bonaPerEth,
    allocationWei,
    floorWei,
    durationSec,
    ethLane ? referenceFeedUnits : 0n,
    vestingDuration,
  ];

  process.stdout.write("  Deploying SaleRound ... ");
  const Round = await ethers.getContractFactory("SaleRound");
  const round = await Round.deploy(...constructorArgs);
  await round.waitForDeployment();
  const roundAddress = await round.getAddress();
  console.log(roundAddress);

  // --- Record ---------------------------------------------------------------
  const record = {
    network: network.name,
    chainId: network.config.chainId,
    round: roundAddress,
    terms: {
      goalUsd: goalUsd.toString(),
      floorUsd: floorUsd.toString(),
      allocationBona: allocation.toString(),
      bonaPerUsdc: bonaPerUsdc.toString(),
      bonaPerEth: bonaPerEth.toString(),
      referenceEthUsd: ethLane ? referenceEth.toString() : null,
      durationDays: durationDays.toString(),
      deadline: (await round.deadline()).toString(),
      vestingDays: "180",
    },
    addresses: {
      token: tokenAddress,
      usdc,
      vesting: vestingAddress,
      treasury,
      feed: ethLane ? feed : null,
    },
    deployedAt: new Date().toISOString(),
  };

  const outDir = path.join(__dirname, "..", "deployment");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}-round-${record.terms.deadline}.json`);
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`  Record written : ${outFile}`);

  if (process.env.BASESCAN_API_KEY) {
    try {
      await run("verify:verify", { address: roundAddress, constructorArguments: constructorArgs });
      console.log("  Source verified on Basescan.");
    } catch {
      console.log("  Verification failed — retry later with hardhat verify.");
    }
  }

  // --- The two Safe transactions that arm the round --------------------------
  const token = await ethers.getContractAt("BonaToken", tokenAddress);
  const vesting = await ethers.getContractAt("RoundVesting", vestingAddress);

  console.log("\n  The round cannot sell anything until the multisig executes:");
  console.log(`\n  1. Fund the round with its allocation`);
  console.log(`     to    : ${tokenAddress}`);
  console.log(`     data  : ${token.interface.encodeFunctionData("transfer", [roundAddress, allocationWei])}`);
  console.log(`\n  2. Authorise it to write grants`);
  console.log(`     to    : ${vestingAddress}`);
  console.log(`     data  : ${vesting.interface.encodeFunctionData("authoriseGranter", [roundAddress])}`);
  console.log("\n  After the round ends: settle() on success, and revokeGranter(round)");
  console.log("  once every buyer has claimed.\n");
}

main().catch((err) => {
  console.error("\n  FAILED:", err.message, "\n");
  process.exitCode = 1;
});
