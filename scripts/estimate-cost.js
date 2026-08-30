/**
 * Measures the real cost of deploying BONA to Base.
 *
 * Deployment gas is measured by actually deploying to the local Hardhat
 * network, then priced against Base mainnet's current gas price and the
 * live ETH price. No guessing.
 *
 *   npx hardhat run scripts/estimate-cost.js
 */

const { ethers } = require("hardhat");

const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";

async function ethPriceUsd() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
      { signal: AbortSignal.timeout(15000) }
    );
    const json = await res.json();
    return json?.ethereum?.usd ?? null;
  } catch {
    return null;
  }
}

async function main() {
  // --- 1. Measure deployment gas locally ---------------------------------
  const [signer] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("BonaToken");
  const token = await Factory.deploy(signer.address);
  await token.waitForDeployment();
  const receipt = await token.deploymentTransaction().wait();
  const deployGas = receipt.gasUsed;

  // A representative transfer, for member-facing cost
  const transferTx = await token.transfer(
    "0x000000000000000000000000000000000000dEaD",
    ethers.parseUnits("1", 18)
  );
  const transferGas = (await transferTx.wait()).gasUsed;

  // --- 2. Live Base gas price --------------------------------------------
  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const feeData = await base.getFeeData();
  const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
  const blockNumber = await base.getBlockNumber();

  // --- 3. Live ETH price --------------------------------------------------
  const usd = await ethPriceUsd();

  const fmt = (gas) => {
    const wei = gas * gasPrice;
    const eth = Number(ethers.formatEther(wei));
    return {
      eth,
      usd: usd ? eth * usd : null,
    };
  };

  const deploy = fmt(deployGas);
  const transfer = fmt(transferGas);

  console.log("=".repeat(62));
  console.log("  BONA — measured deployment cost on Base");
  console.log("=".repeat(62));
  console.log(`  Base block        : ${blockNumber}`);
  console.log(`  Base gas price    : ${ethers.formatUnits(gasPrice, "gwei")} gwei`);
  console.log(`  ETH price         : ${usd ? "$" + usd.toLocaleString() : "unavailable"}`);
  console.log("-".repeat(62));
  console.log(`  Contract deploy   : ${deployGas.toLocaleString()} gas`);
  console.log(
    `                      ${deploy.eth.toFixed(8)} ETH` +
      (deploy.usd !== null ? `  ≈ $${deploy.usd.toFixed(4)}` : "")
  );
  console.log(`  One transfer      : ${transferGas.toLocaleString()} gas`);
  console.log(
    `                      ${transfer.eth.toFixed(8)} ETH` +
      (transfer.usd !== null ? `  ≈ $${transfer.usd.toFixed(4)}` : "")
  );
  console.log("=".repeat(62));
  console.log("\n  NOTE: Base is an L2. The figures above are L2 execution gas.");
  console.log("  A small L1 data fee is added per transaction on top, typically");
  console.log("  a few cents or less since EIP-4844. Budget a small multiple.");
}

main().catch((err) => {
  console.error("Estimation failed:", err.message || err);
  process.exitCode = 1;
});
