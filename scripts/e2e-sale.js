/**
 * BONA — end-to-end sale rehearsal
 *
 * Deploys SaleVesting and DirectSale, arms them the way the multisig will,
 * and walks the whole buyer path against a real chain. Every failure mode
 * that matters is exercised deliberately, because a rehearsal that only
 * proves the happy path proves the least interesting thing.
 *
 *   npx hardhat run scripts/e2e-sale.js                        # local
 *   npx hardhat run scripts/e2e-sale.js --network baseSepolia  # testnet
 *
 * Refuses to run against mainnet. This deploys throwaway contracts and a
 * test stablecoin; neither belongs on a network where the addresses matter.
 *
 * On a live network, reads can lag writes: public RPC endpoints are load
 * balanced and a fresh read may land on a node that has not seen the block
 * yet. Every assertion below therefore retries, and every transaction waits
 * for two confirmations. That is not defensive noise — it is the lesson from
 * the previous testnet run, where it would otherwise have failed at random.
 */
const { ethers, network } = require("hardhat");

const BONA = (n) => ethers.parseUnits(String(n), 18);
const USD = (n) => ethers.parseUnits(String(n), 6);
const LIVE = !["hardhat", "localhost"].includes(network.name);

let step = 0;
let failures = 0;

/** Wait for a transaction to be settled enough to read back. */
async function w(txPromise) {
  const tx = await txPromise;
  await tx.wait(LIVE ? 2 : 1);
  return tx;
}

/**
 * Assert, retrying on a live network. `actual` is a thunk so it can be
 * re-read rather than re-compared against a stale value.
 */
async function check(label, actual, expected) {
  const attempts = LIVE ? 8 : 1;
  let got;
  for (let i = 0; i < attempts; i++) {
    got = typeof actual === "function" ? await actual() : actual;
    if (String(got) === String(expected)) {
      console.log(`  ${String(++step).padStart(2)}. ok    ${label}`);
      return;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2500));
  }
  failures++;
  console.log(`  ${String(++step).padStart(2)}. FAIL  ${label}`);
  console.log(`        expected ${expected}`);
  console.log(`        got      ${got}`);
}

/** Assert that a call reverts, and that it leaves the buyer's money alone. */
async function checkRevertNoCharge(label, fn, usdc, buyer) {
  const before = await usdc.balanceOf(buyer);
  let reverted = false;
  try {
    const tx = await fn();
    await tx.wait(LIVE ? 2 : 1);
  } catch {
    reverted = true;
  }
  const after = await usdc.balanceOf(buyer);
  const ok = reverted && after === before;
  if (ok) {
    console.log(`  ${String(++step).padStart(2)}. ok    ${label}`);
  } else {
    failures++;
    console.log(`  ${String(++step).padStart(2)}. FAIL  ${label}`);
    console.log(`        reverted: ${reverted}, balance moved: ${before !== after}`);
  }
}

async function main() {
  if (network.name === "base") {
    throw new Error("This rehearsal deploys throwaway contracts. Never on mainnet.");
  }

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  if (!deployer) {
    throw new Error("No signer. Set DEPLOYER_PRIVATE_KEY before running against a network.");
  }

  /**
   * The three roles must be three different addresses or the rehearsal proves
   * nothing: "the money reached the treasury" is trivially true when the
   * treasury is the buyer, and "only the treasury may reclaim" cannot fail.
   * A testnet usually offers one funded key, so make the other two and give
   * them just enough gas to act.
   */
  let buyer = signers[1];
  let treasury = signers[2];
  if (!buyer || !treasury) {
    buyer = ethers.Wallet.createRandom().connect(ethers.provider);
    treasury = ethers.Wallet.createRandom().connect(ethers.provider);
    const gas = ethers.parseEther(LIVE ? "0.0004" : "1");
    await w(deployer.sendTransaction({ to: buyer.address, value: gas }));
    await w(deployer.sendTransaction({ to: treasury.address, value: gas }));
    console.log("  (buyer and treasury are fresh keys, funded for gas)");
  }

  console.log("=".repeat(66));
  console.log("  BONA — sale rehearsal");
  console.log("=".repeat(66));
  console.log(`  Network  : ${network.name}${LIVE ? "  (live: retrying reads)" : ""}`);
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Buyer    : ${buyer.address}`);
  console.log(`  Treasury : ${treasury.address}`);
  console.log("=".repeat(66) + "\n");

  // ---- deploy ----
  const Token = await ethers.getContractFactory("BonaToken");
  const bona = await Token.deploy(deployer.address);
  await bona.waitForDeployment();

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy(deployer.address, USD(1_000_000));
  await usdc.waitForDeployment();

  const Vesting = await ethers.getContractFactory("SaleVesting");
  const vesting = await Vesting.deploy(await bona.getAddress(), deployer.address);
  await vesting.waitForDeployment();

  const PRICE = BONA(100); // 1 USDC = 100 BONA
  const CEILING = BONA(60_000_000);
  const TRANCHE = BONA(10_000);
  const SIX_MONTHS = 180 * 24 * 60 * 60;

  const Sale = await ethers.getContractFactory("DirectSale");
  const sale = await Sale.deploy(
    await bona.getAddress(),
    await usdc.getAddress(),
    await vesting.getAddress(),
    treasury.address,
    PRICE,
    CEILING,
    SIX_MONTHS
  );
  await sale.waitForDeployment();

  console.log(`  BonaToken   ${await bona.getAddress()}`);
  console.log(`  MockUSDC    ${await usdc.getAddress()}`);
  console.log(`  SaleVesting ${await vesting.getAddress()}`);
  console.log(`  DirectSale  ${await sale.getAddress()}\n`);

  const saleAddr = await sale.getAddress();

  // ---- the terms are what we asked for ----
  await check("price is the published rate", () => sale.bonaPerUsdc(), PRICE);
  await check("ceiling is immutable and set", () => sale.maxBona(), CEILING);
  await check("vesting is six months", () => sale.vestingDuration(), SIX_MONTHS);
  await check("quote matches the price", () => sale.quote(USD(1)), BONA(100));
  await check("vesting pool cap is the published 60M", () => vesting.MAX_TOTAL(), BONA(60_000_000));

  // ---- fund the buyer ----
  if (buyer.address !== deployer.address) {
    await w(usdc.transfer(buyer.address, USD(500)));
  }
  await w(usdc.connect(buyer).approve(saleAddr, ethers.MaxUint256));

  // ---- an unarmed sale takes nothing ----
  await checkRevertNoCharge(
    "unarmed sale: no BONA, no capacity, buyer not charged",
    () => sale.connect(buyer).buy(USD(1)),
    usdc,
    buyer.address
  );

  await w(bona.transfer(saleAddr, TRANCHE));
  await checkRevertNoCharge(
    "tokens but no reservation: buyer still not charged",
    () => sale.connect(buyer).buy(USD(1)),
    usdc,
    buyer.address
  );

  await w(vesting.reserveCapacity(saleAddr, TRANCHE));
  await check("reservation recorded", () => vesting.reservationOf(saleAddr), TRANCHE);
  await check("available is the tranche", () => sale.availableBona(), TRANCHE);

  // ---- the purchase ----
  const treasuryBefore = await usdc.balanceOf(treasury.address);
  await w(sale.connect(buyer).buy(USD(5)));

  await check("sold the quoted amount", () => sale.bonaSold(), BONA(500));
  await check("recorded against the buyer", () => sale.boughtBy(buyer.address), BONA(500));
  await check("grant written in the same transaction", () => vesting.grantedTo(buyer.address), BONA(500));
  await check("buyer holds no BONA in hand", () => bona.balanceOf(buyer.address), 0n);
  await check("buyer has full voting weight", () => vesting.unclaimedOf(buyer.address), BONA(500));
  await check(
    "every dollar went to the treasury",
    async () => (await usdc.balanceOf(treasury.address)) - treasuryBefore,
    USD(5)
  );
  await check("the sale kept no dollars", () => usdc.balanceOf(saleAddr), 0n);
  await check("reservation was spent", () => vesting.reservationOf(saleAddr), TRANCHE - BONA(500));

  // ---- the guards ----
  await checkRevertNoCharge(
    "a purchase below the minimum is refused",
    () => sale.connect(buyer).buy(USD(1) - 1n),
    usdc,
    buyer.address
  );

  await checkRevertNoCharge(
    "a purchase beyond the reservation is refused, and free",
    () => sale.connect(buyer).buy(USD(500)),
    usdc,
    buyer.address
  );

  // ---- stopping the sale ----
  const left = await vesting.reservationOf(saleAddr);
  await w(vesting.releaseCapacity(saleAddr, left));
  await checkRevertNoCharge(
    "releasing capacity stops the sale without charging anyone",
    () => sale.connect(buyer).buy(USD(1)),
    usdc,
    buyer.address
  );
  await check("released capacity returned to the pool", () => vesting.reservationOf(saleAddr), 0n);

  // ---- the buyer's tokens survive all of it ----
  await check(
    "the earlier buyer still holds their grant",
    () => vesting.unclaimedOf(buyer.address),
    BONA(500)
  );

  await checkRevertNoCharge(
    "only the treasury may reclaim",
    () => sale.connect(buyer).reclaimUnsold(),
    usdc,
    buyer.address
  );
  await w(sale.connect(treasury).reclaimUnsold());
  await check("unsold tokens returned", () => bona.balanceOf(saleAddr), 0n);
  await check(
    "and the buyer's grant is still untouched",
    () => vesting.unclaimedOf(buyer.address),
    BONA(500)
  );

  // ---- vesting maths ----
  if (!LIVE) {
    await ethers.provider.send("evm_increaseTime", [SIX_MONTHS + 86400]);
    await ethers.provider.send("evm_mine", []);
    await check("fully vested after six months", () => vesting.releasable(buyer.address), BONA(500));
    await w(vesting.connect(buyer).release());
    await check("claimed into the wallet", () => bona.balanceOf(buyer.address), BONA(500));
    await check("voting weight follows the tokens out", () => vesting.unclaimedOf(buyer.address), 0n);
  } else {
    console.log("  --. skip  vesting fast-forward is local-only by design");
  }

  console.log("\n" + "=".repeat(66));
  if (failures === 0) {
    console.log(`  ${step}/${step} passed.`);
    console.log("  The buyer was never charged for a purchase that did not complete.");
  } else {
    console.log(`  ${step - failures}/${step} passed, ${failures} FAILED.`);
    process.exitCode = 1;
  }
  console.log("=".repeat(66) + "\n");
}

main().catch((e) => {
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exitCode = 1;
});
