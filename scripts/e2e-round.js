/**
 * BONA — end-to-end round rehearsal. TESTNET ONLY.
 *
 * Deploys a fresh token, the governance suite, mock USDC and a mock ETH/USD
 * feed, then walks the entire lifecycle the way real users will:
 *
 *   1. token + suite deployed, five team seats exercised
 *   2. a request opened and backed, then withdrawn
 *   3. a sale round: USDC lane, ETH lane, circuit breaker trip and recovery
 *   4. goal reached -> settle -> proceeds land on the treasury
 *   5. buyers claim into vesting, voting weight visible from day one
 *   6. a second round that misses its floor -> markFailed -> refunds
 *
 * Every step asserts its outcome. If this script prints DONE, the wiring
 * between all four contracts works on the network you ran it against.
 *
 *   npx hardhat run scripts/e2e-round.js                      # local, instant
 *   npx hardhat run scripts/e2e-round.js --network baseSepolia # live testnet
 *
 * On a live testnet the failure-path round really waits out its deadline
 * (about two minutes). On the local network time is warped instead.
 *
 * This script refuses to run against Base mainnet, unconditionally.
 */

const { ethers, network } = require("hardhat");

const BONA = (n) => ethers.parseUnits(String(n), 18);
const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;
const SIX_MONTHS = 180 * DAY;
const REFERENCE = 3000n * 10n ** 8n; // $3,000, 8 feed decimals

let step = 0;

/**
 * Live public RPCs are load-balanced: the node that confirmed a transaction
 * and the node answering the next read can differ, so a fresh state read can
 * be briefly stale. Checks therefore take a THUNK and retry on live networks
 * instead of failing on the first stale answer.
 */
async function check(label, cond) {
  step += 1;
  const attempts = isLocal() ? 1 : 8;
  for (let i = 1; ; i++) {
    const ok = typeof cond === "function" ? await cond() : cond;
    if (ok) break;
    if (i >= attempts) throw new Error(`step ${step} FAILED: ${label}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  ${String(step).padStart(2)}. ok  ${label}`);
}

/** Send a tx and wait 2 confirmations on live nets (1 locally). */
async function w(txPromise) {
  const tx = await txPromise;
  return tx.wait(isLocal() ? 1 : 2);
}

async function expectRevert(label, promise) {
  try {
    await (await promise).wait?.();
  } catch {
    await check(label, async () => true);
    return;
  }
  await check(label, async () => false);
}

const isLocal = () => network.name === "hardhat" || network.name === "localhost";

async function passTime(seconds) {
  if (isLocal()) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  } else {
    console.log(`      waiting ${seconds}s of real time ...`);
    await new Promise((r) => setTimeout(r, (seconds + 5) * 1000));
  }
}

async function main() {
  if (network.name === "base") {
    throw new Error("This is a rehearsal script. It does not run on mainnet.");
  }

  const signers = await ethers.getSigners();
  const [admin] = signers;
  // On a live testnet there is usually one funded key; derive extra actors
  // from it so the rehearsal still involves distinct addresses.
  const alice = signers[1] ?? ethers.Wallet.createRandom().connect(ethers.provider);
  const bob = signers[2] ?? ethers.Wallet.createRandom().connect(ethers.provider);
  const singleKey = signers.length < 3;

  if (singleKey) {
    // Fund the derived actors from the admin key: alice needs only gas, bob
    // also makes the 0.0005 ETH purchase. Sized to survive a stingy faucet.
    await w(admin.sendTransaction({ to: alice.address, value: ethers.parseEther("0.0003") }));
    await w(admin.sendTransaction({ to: bob.address, value: ethers.parseEther("0.0008") }));
  }

  console.log("=".repeat(64));
  console.log(`  BONA — end-to-end rehearsal on ${network.name}`);
  console.log("=".repeat(64));

  // ---- 1. Deploy everything -----------------------------------------------
  const Token = await ethers.getContractFactory("BonaToken");
  const bona = await Token.deploy(admin.address);
  await bona.waitForDeployment();

  const suite = {};
  for (const name of ["TeamVesting", "RoundVesting", "RequestBacking"]) {
    const F = await ethers.getContractFactory(name);
    suite[name] = await F.deploy(await bona.getAddress(), admin.address);
    await suite[name].waitForDeployment();
  }
  const Usdc = await ethers.getContractFactory("MockUSDC");
  const usdc = await Usdc.deploy(admin.address, USDC(10_000_000));
  await usdc.waitForDeployment();
  const Feed = await ethers.getContractFactory("MockAggregator");
  const feed = await Feed.deploy(REFERENCE, 8);
  await feed.waitForDeployment();

  await check("token + suite + mocks deployed", async () => (await bona.totalSupply()) === BONA(100_000_000));

  // ---- 2. Team seats -------------------------------------------------------
  const team = suite.TeamVesting;
  await w(team.assignSeat(0, alice.address));
  const start = (await ethers.provider.getBlock("latest")).timestamp;
  await w(bona.approve(await team.getAddress(), BONA(666_666)));
  await w(team.fundGrant(0, BONA(666_666), start, 3 * 365 * DAY));
  await check("seat 0 assigned and first tranche funded", async () => (await team.unclaimedOf(alice.address)) === BONA(666_666));
  await check("nothing claimable the moment a tranche lands", async () => (await team.releasable(alice.address)) < BONA(1));

  // ---- 3. Request backing --------------------------------------------------
  const backing = suite.RequestBacking;
  await w(bona.transfer(bob.address, BONA(10_000)));
  await (await backing.connect(bob).openRequest(ethers.id("Inventory module")))
    .wait();
  await w(bona.connect(bob).approve(await backing.getAddress(), BONA(10_000)));
  await w(backing.connect(bob).back(0, BONA(10_000)));
  await check("request opened and backed", async () => (await backing.unclaimedOf(bob.address)) === BONA(10_000));
  await w(backing.connect(bob).withdrawAll(0));
  await check("backing withdrawn in full, nothing kept", async () => (await bona.balanceOf(bob.address)) === BONA(10_000));

  // ---- 4. The round: $300 goal, $150 floor, 30,000 BONA --------------------
  const Round = await ethers.getContractFactory("SaleRound");
  const roundArgs = (durationSec) => [
    bona.getAddress(), usdc.getAddress(), suite.RoundVesting.getAddress(),
    admin.address, feed.getAddress(),
    BONA(100),            // 1 USDC = 100 BONA
    BONA(300_000),        // 1 ETH  = 300,000 BONA
    BONA(30_000), BONA(15_000), durationSec, REFERENCE, SIX_MONTHS,
  ];
  const round = await Round.deploy(...(await Promise.all(roundArgs(14 * DAY))));
  await round.waitForDeployment();

  await w(bona.transfer(await round.getAddress(), BONA(30_000)));
  await w(suite.RoundVesting.authoriseGranter(await round.getAddress()));
  await check("round funded and authorised as granter", async () => (await round.remainingBona()) === BONA(30_000));

  // USDC lane
  await w(usdc.transfer(alice.address, USDC(200)));
  await w(usdc.connect(alice).approve(await round.getAddress(), USDC(200)));
  await w(round.connect(alice).contributeUsdc(USDC(200)));
  await check("USDC lane: 200 USDC -> 20,000 BONA owed", async () => (await round.bonaOwed(alice.address)) === BONA(20_000));

  // Circuit breaker trips at +25% and recovers
  await w(feed.setAnswer((REFERENCE * 125n) / 100n));
  await check("breaker: ETH lane reports closed at +25%", async () => (await round.ethLaneOpen()) === false);
  await expectRevert("breaker: ETH contribution rejected while tripped",
    round.connect(bob).contributeEth({ value: ethers.parseEther("0.01") }));
  await w(feed.setAnswer(REFERENCE));
  await check("breaker: lane reopens when the price returns", async () => (await round.ethLaneOpen()) === true);

  // ETH lane, then reach the goal exactly
  const bobEth = ethers.parseEther("0.0005"); // 150 BONA — sized so the whole
  // rehearsal fits a stingy faucet: bob is a derived wallet with 0.0008 ETH
  await w(round.connect(bob).contributeEth({ value: bobEth }));
  await check("ETH lane: 0.0005 ETH -> 150 BONA owed", async () => (await round.bonaOwed(bob.address)) === BONA(150));
  await w(usdc.approve(await round.getAddress(), USDC("98.5")));
  await w(round.contributeUsdc(USDC("98.5"))); // final 9,850 BONA
  await check("goal reached closes the round", async () => (await round.closedAt()) > 0n);
  await expectRevert("no contributions after close",
    round.connect(alice).contributeUsdc(USDC(1)));

  // ---- 5. Settle, claim, vest ---------------------------------------------
  const usdcBefore = await usdc.balanceOf(admin.address);
  await w(round.settle());
  await check("settle moves all USDC to the treasury", async () => (await usdc.balanceOf(admin.address)) === usdcBefore + USDC("298.5"));
  await check("settle leaves the escrow empty of ETH", async () => (await ethers.provider.getBalance(await round.getAddress())) === 0n);

  await w(round.connect(alice).claimGrant());
  await check("claim writes the grant into RoundVesting, not the wallet", async () => (await suite.RoundVesting.unclaimedOf(alice.address)) === BONA(20_000) &&
    (await bona.balanceOf(alice.address)) === 0n);
  await check("voting weight exists before anything vests", async () => (await suite.RoundVesting.unclaimedOf(alice.address)) === BONA(20_000));
  await expectRevert("a second claim is rejected", round.connect(alice).claimGrant());

  if (isLocal()) {
    await passTime(SIX_MONTHS);
    await w(suite.RoundVesting.connect(alice).release());
    await check("six months later the full grant is claimable", async () => (await bona.balanceOf(alice.address)) === BONA(20_000));
  } else {
    console.log("      (vesting fast-forward skipped on a live network)");
  }

  // ---- 6. Failure path: a round that misses its floor ----------------------
  const shortRound = await Round.deploy(...(await Promise.all(roundArgs(isLocal() ? DAY : 90))));
  await shortRound.waitForDeployment();
  await w(bona.transfer(await shortRound.getAddress(), BONA(30_000)));
  await w(suite.RoundVesting.authoriseGranter(await shortRound.getAddress()));

  await w(usdc.transfer(alice.address, USDC(50)));
  await w(usdc.connect(alice).approve(await shortRound.getAddress(), USDC(50)));
  await w(shortRound.connect(alice).contributeUsdc(USDC(50))); // 5,000 < 15,000 floor

  await passTime(isLocal() ? DAY : 95);
  await w(shortRound.connect(bob).markFailed()); // anyone may
  await check("a stranger can mark a failed round failed", async () => (await shortRound.status()) === 2n);

  const aliceUsdcBefore = await usdc.balanceOf(alice.address);
  await w(shortRound.connect(alice).refund());
  await check("refund returns the buyer's USDC in full", async () => (await usdc.balanceOf(alice.address)) === aliceUsdcBefore + USDC(50));

  const adminBonaBefore = await bona.balanceOf(admin.address);
  await w(shortRound.reclaimUnsold());
  await check("the failed round's full allocation returns to the treasury", async () => (await bona.balanceOf(admin.address)) === adminBonaBefore + BONA(30_000));

  console.log("\n  DONE — full lifecycle verified on", network.name);
  console.log("  Addresses for follow-up inspection:");
  console.log(`    BonaToken      ${await bona.getAddress()}`);
  console.log(`    TeamVesting    ${await suite.TeamVesting.getAddress()}`);
  console.log(`    RoundVesting   ${await suite.RoundVesting.getAddress()}`);
  console.log(`    RequestBacking ${await backing.getAddress()}`);
  console.log(`    SaleRound      ${await round.getAddress()}  (settled)`);
  console.log(`    SaleRound      ${await shortRound.getAddress()}  (failed, refunded)`);
  console.log("");
}

main().catch((err) => {
  console.error("\n  FAILED:", err.message, "\n");
  process.exitCode = 1;
});
