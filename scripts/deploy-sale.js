/**
 * BONA — deploy the DirectSale contract
 *
 * The sale is continuous and the price is immutable, so this is the script
 * that fixes the published price into code. Read the printed summary before
 * confirming: nothing here can be edited afterwards.
 *
 * Usage:
 *   $env:DEPLOYER_PRIVATE_KEY = "0x..."
 *   $env:BONA_TOKEN    = "0x..."     # deployed BonaToken
 *   $env:SALE_VESTING  = "0x..."     # deployed SaleVesting
 *   $env:MULTISIG      = "0x..."     # treasury. Mandatory on mainnet
 *   $env:USDC_TOKEN    = "0x..."     # mandatory on mainnet — verify at circle.com
 *   $env:BONA_PER_USDC = "100"       # whole BONA per one whole USDC
 *   $env:MAX_BONA      = "60000000"  # lifetime ceiling for this contract
 *   $env:VESTING_DAYS  = "180"       # buyer vesting, at least SaleVesting.MIN_DURATION
 *   $env:TRANCHE       = "500000"    # BONA in the first instalment
 *
 *   npx hardhat run scripts/deploy-sale.js --network baseSepolia
 *   npx hardhat run scripts/deploy-sale.js --network base
 *
 * After deployment the sale can sell nothing until the multisig does two
 * things, both printed as Safe calldata at the end:
 *   1. transfer the instalment of BONA to the sale address, and
 *   2. call SaleVesting.reserveCapacity(sale, instalment).
 *
 * Both are deliberately instalments rather than the whole allocation. The most
 * any single failure in the sale can reach is whatever is currently in it.
 */
const { ethers, network, run } = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");

function requireEnv(name) {
  const v = process.env[name] || "";
  if (!v) throw new Error(`${name} is not set.`);
  return v;
}

function requirePositiveInt(name) {
  const raw = requireEnv(name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}".`);
  const v = BigInt(raw);
  if (v === 0n) throw new Error(`${name} must be greater than zero.`);
  return v;
}

function requireAddress(name, value) {
  if (!ethers.isAddress(value)) throw new Error(`${name} is not a valid address: ${value}`);
  return ethers.getAddress(value);
}

async function main() {
  const isMainnet = network.name === "base";
  const [signer] = await ethers.getSigners();

  const tokenAddress = requireAddress("BONA_TOKEN", requireEnv("BONA_TOKEN"));
  const vestingAddress = requireAddress("SALE_VESTING", requireEnv("SALE_VESTING"));

  // No defaults on mainnet. A wrong USDC address would take a worthless token
  // as payment and hand out real BONA for it, and a default is exactly the
  // kind of value nobody double-checks.
  const usdcAddress = requireAddress("USDC_TOKEN", requireEnv("USDC_TOKEN"));

  let treasury = process.env.MULTISIG || "";
  if (isMainnet) {
    if (!treasury) throw new Error("MULTISIG is mandatory on mainnet. Never an EOA.");
    treasury = requireAddress("MULTISIG", treasury);
    if ((await ethers.provider.getCode(treasury)) === "0x") {
      throw new Error("MULTISIG has no code. On mainnet the treasury must be the Safe.");
    }
  } else {
    treasury = treasury ? requireAddress("MULTISIG", treasury) : signer.address;
  }

  const bonaPerUsdcWhole = requirePositiveInt("BONA_PER_USDC");
  const maxBonaWhole = requirePositiveInt("MAX_BONA");
  const vestingDays = requirePositiveInt("VESTING_DAYS");
  const trancheWhole = requirePositiveInt("TRANCHE");

  const bonaPerUsdc = bonaPerUsdcWhole * 10n ** 18n;
  const maxBona = maxBonaWhole * 10n ** 18n;
  const tranche = trancheWhole * 10n ** 18n;
  const vestingDuration = vestingDays * 86_400n;

  // ---- checks that cost nothing now and everything later ----
  const vesting = await ethers.getContractAt("SaleVesting", vestingAddress);
  const minDuration = await vesting.MIN_DURATION();
  const maxDuration = await vesting.MAX_VESTING_DURATION();
  if (vestingDuration < minDuration) {
    throw new Error(
      `VESTING_DAYS is below SaleVesting.MIN_DURATION (${Number(minDuration) / 86400} days).`
    );
  }
  if (vestingDuration > maxDuration) {
    throw new Error(
      `VESTING_DAYS is above SaleVesting.MAX_VESTING_DURATION (${Number(maxDuration) / 86400} days).`
    );
  }

  const reservable = await vesting.reservableRemaining();
  if (maxBona > reservable) {
    throw new Error(
      `MAX_BONA (${maxBonaWhole}) exceeds what SaleVesting can still reserve ` +
        `(${ethers.formatUnits(reservable, 18)}).`
    );
  }
  if (tranche > maxBona) throw new Error("TRANCHE cannot exceed MAX_BONA.");

  const usdcContract = await ethers.getContractAt(
    ["function decimals() view returns (uint8)", "function symbol() view returns (string)"],
    usdcAddress
  );
  let usdcDecimals;
  let usdcSymbol;
  try {
    usdcDecimals = Number(await usdcContract.decimals());
    usdcSymbol = await usdcContract.symbol();
  } catch {
    throw new Error(`USDC_TOKEN at ${usdcAddress} does not answer decimals()/symbol().`);
  }
  // The price maths divides by 1e6. A payment token with other decimals would
  // silently sell BONA at the wrong price in either direction.
  if (usdcDecimals !== 6) {
    throw new Error(`USDC_TOKEN reports ${usdcDecimals} decimals; the sale requires 6.`);
  }

  console.log("=".repeat(66));
  console.log("  BONA — DirectSale deployment");
  console.log("=".repeat(66));
  console.log(`  Network        : ${network.name}`);
  console.log(`  Deployer       : ${signer.address}`);
  console.log(`  Treasury       : ${treasury}${isMainnet ? "  (Safe)" : ""}`);
  console.log(`  BONA           : ${tokenAddress}`);
  console.log(`  SaleVesting    : ${vestingAddress}`);
  console.log(`  Payment token  : ${usdcAddress}  (${usdcSymbol}, ${usdcDecimals} decimals)`);
  console.log("-".repeat(66));
  console.log(`  Price          : 1 ${usdcSymbol} = ${bonaPerUsdcWhole} BONA   (immutable)`);
  console.log(`  Lifetime cap   : ${maxBonaWhole} BONA  =  $${maxBonaWhole / bonaPerUsdcWhole}`);
  console.log(`  Buyer vesting  : ${vestingDays} days, linear from purchase`);
  console.log(`  First instalment: ${trancheWhole} BONA`);
  console.log("=".repeat(66));

  if (isMainnet) {
    console.log("\n  MAINNET DEPLOYMENT — the price cannot be changed afterwards.");
    console.log("  Waiting 10 seconds. Press Ctrl+C to abort.\n");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  const Sale = await ethers.getContractFactory("DirectSale");
  const sale = await Sale.deploy(
    tokenAddress,
    usdcAddress,
    vestingAddress,
    treasury,
    bonaPerUsdc,
    maxBona,
    vestingDuration
  );
  await sale.waitForDeployment();
  const saleAddress = await sale.getAddress();
  console.log(`\n  DirectSale deployed: ${saleAddress}`);

  // ---- read the immutables back off the chain, not out of our own variables ----
  const live = !["hardhat", "localhost"].includes(network.name);
  if (live) await sale.deploymentTransaction().wait(2);

  const checks = [
    ["bona", (await sale.bona()).toLowerCase(), tokenAddress.toLowerCase()],
    ["usdc", (await sale.usdc()).toLowerCase(), usdcAddress.toLowerCase()],
    ["vesting", (await sale.vesting()).toLowerCase(), vestingAddress.toLowerCase()],
    ["treasury", (await sale.treasury()).toLowerCase(), treasury.toLowerCase()],
    ["bonaPerUsdc", (await sale.bonaPerUsdc()).toString(), bonaPerUsdc.toString()],
    ["maxBona", (await sale.maxBona()).toString(), maxBona.toString()],
    ["vestingDuration", (await sale.vestingDuration()).toString(), vestingDuration.toString()],
  ];
  for (const [name, got, want] of checks) {
    if (got !== want) throw new Error(`Immutable ${name} is ${got}, expected ${want}.`);
  }
  console.log("  Immutables verified against the inputs above.");

  // A last sanity check in the units a buyer will actually see.
  const quoted = await sale.quote(1_000_000n); // one whole USDC
  console.log(`  Sanity: 1 ${usdcSymbol} quotes ${ethers.formatUnits(quoted, 18)} BONA`);

  // ---- record ----
  const dir = path.join(__dirname, "..", "deployment");
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    DirectSale: saleAddress,
    bona: tokenAddress,
    usdc: usdcAddress,
    saleVesting: vestingAddress,
    treasury,
    bonaPerUsdc: bonaPerUsdc.toString(),
    maxBona: maxBona.toString(),
    vestingDurationDays: Number(vestingDays),
    deployer: signer.address,
    txHash: sale.deploymentTransaction().hash,
  };
  const file = path.join(dir, `${network.name}-sale.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  console.log(`  Record written: deployment/${path.basename(file)}`);

  // ---- verify source ----
  if (live && process.env.BASESCAN_API_KEY) {
    console.log("\n  Verifying source on Basescan ...");
    try {
      await run("verify:verify", {
        address: saleAddress,
        constructorArguments: [
          tokenAddress,
          usdcAddress,
          vestingAddress,
          treasury,
          bonaPerUsdc,
          maxBona,
          vestingDuration,
        ],
      });
      console.log("  Verified.");
    } catch (e) {
      console.log(`  Verification failed: ${e.message}`);
      console.log("  Retry with: npx hardhat verify --network " + network.name);
    }
  }

  // ---- the two transactions that arm the sale ----
  const bona = await ethers.getContractAt("BonaToken", tokenAddress);
  const transferData = bona.interface.encodeFunctionData("transfer", [saleAddress, tranche]);
  const reserveData = vesting.interface.encodeFunctionData("reserveCapacity", [
    saleAddress,
    tranche,
  ]);

  console.log("\n" + "=".repeat(66));
  console.log("  The sale cannot sell anything yet. Queue these two in the Safe:");
  console.log("=".repeat(66));
  console.log(`\n  1. Fund the instalment — ${trancheWhole} BONA`);
  console.log(`     to    : ${tokenAddress}`);
  console.log(`     value : 0`);
  console.log(`     data  : ${transferData}`);
  console.log(`\n  2. Reserve matching capacity in SaleVesting`);
  console.log(`     to    : ${vestingAddress}`);
  console.log(`     value : 0`);
  console.log(`     data  : ${reserveData}`);
  console.log("\n  Top both up together as the instalment sells. Reserving more");
  console.log("  capacity than the sale holds in BONA does not let it sell more —");
  console.log("  it just moves which of the two limits binds first.\n");

  console.log("  Then, before announcing:");
  console.log("    - add the sale address to the website config");
  console.log("    - check SaleVesting is in the Snapshot strategies");
  console.log("    - buy one USDC of BONA yourself and claim it back, on this network\n");
}

main().catch((e) => {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exitCode = 1;
});
