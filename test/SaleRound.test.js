const { expect } = require("chai");
const { ethers } = require("hardhat");

const time = {
  async latest() {
    return (await ethers.provider.getBlock("latest")).timestamp;
  },
  async increase(seconds) {
    await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
    await ethers.provider.send("evm_mine", []);
  },
};

/**
 * These tests exist to prove the claims made about sale rounds.
 *
 * The claims are: one price for everyone that no key can change, money held
 * in escrow until the floor is met, a refund nobody has to approve, an ETH
 * lane that closes on its own when the market moves, and an oracle that never
 * prices anything.
 *
 * If a test here is removed, the corresponding claim must be removed from
 * 08-sale-rounds.md and from the website.
 */
describe("SaleRound", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const DAY = 24 * 60 * 60;
  const SIX_MONTHS = 180 * DAY;

  // $30,000 round: 3,000,000 BONA at 0.01 USDC, ETH reference $3,000.
  const ALLOCATION = BONA(3_000_000);
  const FLOOR = BONA(1_500_000);
  const BONA_PER_USDC = BONA(100); // 1 USDC = 100 BONA
  const BONA_PER_ETH = BONA(300_000); // 1 ETH = 300,000 BONA
  const REFERENCE = 3000n * 10n ** 8n; // $3,000, feed has 8 decimals
  const DURATION = 14 * DAY;

  let bona, usdc, vesting, feed, round;
  let treasury, alice, bob, mallory;

  async function deployRound(overrides = {}) {
    const Round = await ethers.getContractFactory("SaleRound");
    const r = await Round.deploy(
      await bona.getAddress(),
      await usdc.getAddress(),
      await vesting.getAddress(),
      overrides.treasury ?? treasury.address,
      overrides.feed ?? (await feed.getAddress()),
      overrides.bonaPerUsdc ?? BONA_PER_USDC,
      overrides.bonaPerEth ?? BONA_PER_ETH,
      overrides.allocation ?? ALLOCATION,
      overrides.floor ?? FLOOR,
      overrides.duration ?? DURATION,
      overrides.reference ?? REFERENCE,
      overrides.vestingDuration ?? SIX_MONTHS
    );
    await r.waitForDeployment();
    return r;
  }

  beforeEach(async function () {
    [treasury, alice, bob, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    bona = await Token.deploy(treasury.address);
    await bona.waitForDeployment();

    const Usdc = await ethers.getContractFactory("MockUSDC");
    usdc = await Usdc.deploy(treasury.address, USDC(10_000_000));
    await usdc.waitForDeployment();

    const Vesting = await ethers.getContractFactory("RoundVesting");
    vesting = await Vesting.deploy(await bona.getAddress(), treasury.address);
    await vesting.waitForDeployment();

    const Feed = await ethers.getContractFactory("MockAggregator");
    feed = await Feed.deploy(REFERENCE, 8);
    await feed.waitForDeployment();

    round = await deployRound();

    // The multisig pre-funds the round with its allocation and authorises it.
    await bona.connect(treasury).transfer(await round.getAddress(), ALLOCATION);
    await vesting.connect(treasury).authoriseGranter(await round.getAddress());

    for (const who of [alice, bob, mallory]) {
      await usdc.connect(treasury).transfer(who.address, USDC(1_000_000));
      await usdc.connect(who).approve(await round.getAddress(), USDC(1_000_000));
    }
  });

  describe("Terms are frozen at deployment", function () {
    it("exposes one price for everyone", async function () {
      expect(await round.bonaPerUsdc()).to.equal(BONA_PER_USDC);
      expect(await round.bonaPerEth()).to.equal(BONA_PER_ETH);
      expect(await round.quoteUsdc(USDC(100))).to.equal(BONA(10_000));
      expect(await round.quoteEth(ethers.parseEther("1"))).to.equal(BONA(300_000));
    });

    it("has no function that could change a price, goal or deadline", async function () {
      const suspicious = round.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /setPrice|setGoal|setFloor|setDeadline|extend|updatePrice|pause|owner|transferOwnership/i.test(
            f.name
          )
      );
      expect(suspicious.map((f) => f.name)).to.deep.equal([]);
    });

    it("refuses a duration beyond 14 days", async function () {
      await expect(deployRound({ duration: 15 * DAY })).to.be.revertedWithCustomError(
        round,
        "BadDeadline"
      );
    });

    it("refuses a floor above the allocation, and a zero floor", async function () {
      await expect(
        deployRound({ floor: ALLOCATION + 1n })
      ).to.be.revertedWithCustomError(round, "BadFloor");
      await expect(deployRound({ floor: 0 })).to.be.revertedWithCustomError(
        round,
        "BadFloor"
      );
    });

    it("refuses a vesting duration below the six-month minimum", async function () {
      await expect(
        deployRound({ vestingDuration: SIX_MONTHS - 1 })
      ).to.be.revertedWithCustomError(round, "BadVestingDuration");
    });

    it("refuses an ETH lane without a reference price", async function () {
      await expect(deployRound({ reference: 0 })).to.be.revertedWithCustomError(
        round,
        "BadReference"
      );
    });

    it("refuses a feed that does not use 8 decimals (I-1)", async function () {
      const Feed = await ethers.getContractFactory("MockAggregator");
      const weird = await Feed.deploy(3000n * 10n ** 18n, 18);
      await weird.waitForDeployment();
      await expect(
        deployRound({ feed: await weird.getAddress() })
      ).to.be.revertedWithCustomError(round, "BadFeedDecimals");
    });

    it("refuses a vesting duration RoundVesting would later reject (L-1)", async function () {
      // Without this check a settled round's claims would revert forever:
      // money taken, tokens unreachable.
      await expect(
        deployRound({ vestingDuration: 6 * 365 * DAY })
      ).to.be.revertedWithCustomError(round, "BadVestingDuration");
    });
  });

  describe("Buying at the frozen price", function () {
    it("credits USDC buyers exactly", async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      expect(await round.bonaOwed(alice.address)).to.equal(BONA(100_000));
      expect(await round.usdcContributed(alice.address)).to.equal(USDC(1000));
      expect(await round.bonaSold()).to.equal(BONA(100_000));
    });

    it("credits ETH buyers exactly, including via a plain transfer", async function () {
      await round.connect(alice).contributeEth({ value: ethers.parseEther("1") });
      expect(await round.bonaOwed(alice.address)).to.equal(BONA(300_000));

      await bob.sendTransaction({
        to: await round.getAddress(),
        value: ethers.parseEther("2"),
      });
      expect(await round.bonaOwed(bob.address)).to.equal(BONA(600_000));
    });

    it("the last buyer pays what the first buyer paid", async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      await round.connect(bob).contributeUsdc(USDC(1000));
      expect(await round.bonaOwed(alice.address)).to.equal(
        await round.bonaOwed(bob.address)
      );
    });

    it("cannot oversell the allocation", async function () {
      await round.connect(alice).contributeUsdc(USDC(29_000));
      expect(await round.remainingBona()).to.equal(BONA(100_000));
      await expect(
        round.connect(bob).contributeUsdc(USDC(1001))
      ).to.be.revertedWithCustomError(round, "ExceedsAllocation");
      await round.connect(bob).contributeUsdc(USDC(1000));
      expect(await round.remainingBona()).to.equal(0n);
    });

    it("closes as soon as the goal is reached", async function () {
      await round.connect(alice).contributeUsdc(USDC(30_000));
      expect(await round.closedAt()).to.be.greaterThan(0n);
      await expect(
        round.connect(bob).contributeUsdc(USDC(1))
      ).to.be.revertedWithCustomError(round, "RoundClosed");
    });

    it("stops accepting money at the deadline", async function () {
      await time.increase(DURATION);
      await expect(
        round.connect(alice).contributeUsdc(USDC(100))
      ).to.be.revertedWithCustomError(round, "RoundClosed");
    });

    it("rejects a zero contribution", async function () {
      await expect(
        round.connect(alice).contributeUsdc(0)
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
      await expect(
        round.connect(alice).contributeEth({ value: 0 })
      ).to.be.revertedWithCustomError(round, "ZeroAmount");
    });
  });

  describe("The circuit breaker closes the ETH lane, and only the ETH lane", function () {
    it("stays open inside the 20% band", async function () {
      await feed.setAnswer((REFERENCE * 119n) / 100n);
      expect(await round.ethLaneOpen()).to.equal(true);
      await round.connect(alice).contributeEth({ value: ethers.parseEther("1") });
      expect(await round.bonaOwed(alice.address)).to.equal(BONA(300_000));
    });

    it("closes when ETH rises beyond 20%", async function () {
      await feed.setAnswer((REFERENCE * 121n) / 100n);
      expect(await round.ethLaneOpen()).to.equal(false);
      await expect(
        round.connect(alice).contributeEth({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "EthLaneBroken");
    });

    it("closes when ETH falls beyond 20%", async function () {
      await feed.setAnswer((REFERENCE * 79n) / 100n);
      await expect(
        round.connect(alice).contributeEth({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "EthLaneBroken");
    });

    it("USDC keeps running while the ETH lane is closed", async function () {
      await feed.setAnswer((REFERENCE * 150n) / 100n);
      await round.connect(alice).contributeUsdc(USDC(1000));
      expect(await round.bonaOwed(alice.address)).to.equal(BONA(100_000));
    });

    it("fails closed on a stale feed", async function () {
      const now = await time.latest();
      await feed.setStale(now - 2 * 3600);
      expect(await round.ethLaneOpen()).to.equal(false);
      await expect(
        round.connect(alice).contributeEth({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "EthLaneBroken");
    });

    it("fails closed on a non-positive answer", async function () {
      await feed.setAnswer(0);
      expect(await round.ethLaneOpen()).to.equal(false);
      await feed.setAnswer(-1);
      expect(await round.ethLaneOpen()).to.equal(false);
    });

    it("fails closed when the feed reverts", async function () {
      await feed.setShouldRevert(true);
      expect(await round.ethLaneOpen()).to.equal(false);
      await expect(
        round.connect(alice).contributeEth({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(round, "EthLaneBroken");
    });

    it("the oracle never changes what a buyer pays", async function () {
      const before = await round.quoteEth(ethers.parseEther("1"));
      await feed.setAnswer((REFERENCE * 119n) / 100n);
      expect(await round.quoteEth(ethers.parseEther("1"))).to.equal(before);
      await round.connect(alice).contributeEth({ value: ethers.parseEther("1") });
      expect(await round.bonaOwed(alice.address)).to.equal(before);
    });

    it("a USDC-only round needs no feed at all", async function () {
      const usdcOnly = await deployRound({
        feed: ethers.ZeroAddress,
        bonaPerEth: 0,
        reference: 0,
      });
      expect(await usdcOnly.ethLaneOpen()).to.equal(false);
      await usdc.connect(alice).approve(await usdcOnly.getAddress(), USDC(1000));
      await usdcOnly.connect(alice).contributeUsdc(USDC(1000));
      await expect(
        usdcOnly.connect(alice).contributeEth({ value: ethers.parseEther("1") })
      ).to.be.revertedWithCustomError(usdcOnly, "EthLaneDisabled");
    });
  });

  describe("Escrow: money is not ours until the floor is met", function () {
    it("holds funds in the contract while the round runs", async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      await round.connect(bob).contributeEth({ value: ethers.parseEther("1") });

      expect(await usdc.balanceOf(await round.getAddress())).to.equal(USDC(1000));
      expect(await ethers.provider.getBalance(await round.getAddress())).to.equal(
        ethers.parseEther("1")
      );
    });

    it("cannot be settled before the round closes", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await expect(round.connect(treasury).settle()).to.be.revertedWithCustomError(
        round,
        "StillOpen"
      );
    });

    it("cannot be settled below the floor", async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      await time.increase(DURATION);
      await expect(round.connect(treasury).settle()).to.be.revertedWithCustomError(
        round,
        "FloorNotMet"
      );
    });

    it("only the treasury can settle", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await time.increase(DURATION);
      await expect(round.connect(mallory).settle()).to.be.revertedWithCustomError(
        round,
        "NotTreasury"
      );
    });

    it("sends everything to the treasury once the floor is met", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await round.connect(bob).contributeEth({ value: ethers.parseEther("1") });
      await time.increase(DURATION);

      const usdcBefore = await usdc.balanceOf(treasury.address);
      await round.connect(treasury).settle();

      expect(await usdc.balanceOf(treasury.address)).to.equal(usdcBefore + USDC(20_000));
      expect(await ethers.provider.getBalance(await round.getAddress())).to.equal(0n);
      expect(await usdc.balanceOf(await round.getAddress())).to.equal(0n);
      expect(await round.status()).to.equal(1n); // Settled
    });

    it("surfaces a failed ETH transfer instead of losing it", async function () {
      const Rejecting = await ethers.getContractFactory("RejectingTreasury");
      const bad = await Rejecting.deploy();
      await bad.waitForDeployment();

      const r = await deployRound({ treasury: await bad.getAddress() });
      await bona.connect(treasury).transfer(await r.getAddress(), ALLOCATION);
      await r.connect(alice).contributeEth({ value: ethers.parseEther("6") });
      await time.increase(DURATION);

      await expect(bad.settle(await r.getAddress())).to.be.reverted;
      expect(await ethers.provider.getBalance(await r.getAddress())).to.equal(
        ethers.parseEther("6")
      );
    });
  });

  describe("The refund nobody has to approve", function () {
    beforeEach(async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      await round.connect(bob).contributeEth({ value: ethers.parseEther("1") });
      await time.increase(DURATION);
    });

    it("anyone may mark a failed round failed", async function () {
      await round.connect(mallory).markFailed();
      expect(await round.status()).to.equal(2n); // Failed
    });

    it("returns USDC exactly", async function () {
      await round.connect(mallory).markFailed();
      const before = await usdc.balanceOf(alice.address);
      await round.connect(alice).refund();
      expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(1000));
    });

    it("returns ETH exactly", async function () {
      await round.connect(mallory).markFailed();
      const before = await ethers.provider.getBalance(bob.address);
      const tx = await round.connect(bob).refund();
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      expect(await ethers.provider.getBalance(bob.address)).to.equal(
        before + ethers.parseEther("1") - gas
      );
    });

    it("is available before anyone marks the round failed", async function () {
      expect(await round.refundable()).to.equal(true);
      await round.connect(alice).refund();
      expect(await round.usdcContributed(alice.address)).to.equal(0n);
    });

    it("cannot be taken twice", async function () {
      await round.connect(alice).refund();
      await expect(round.connect(alice).refund()).to.be.revertedWithCustomError(
        round,
        "NothingToRefund"
      );
    });

    it("cannot take someone else's money", async function () {
      await expect(round.connect(mallory).refund()).to.be.revertedWithCustomError(
        round,
        "NothingToRefund"
      );
    });

    it("is not available while the round is still running", async function () {
      const fresh = await deployRound();
      await usdc.connect(alice).approve(await fresh.getAddress(), USDC(1000));
      await fresh.connect(alice).contributeUsdc(USDC(1000));
      expect(await fresh.refundable()).to.equal(false);
      await expect(fresh.connect(alice).refund()).to.be.revertedWithCustomError(
        fresh,
        "NotRefundable"
      );
    });
  });

  describe("A stalled settlement cannot hold buyers hostage", function () {
    it("opens refunds if a successful round is left unsettled too long", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await time.increase(DURATION);

      // Floor met, so no refund yet — the treasury is expected to settle.
      expect(await round.refundable()).to.equal(false);

      await time.increase(31 * DAY);
      expect(await round.refundable()).to.equal(true);

      const before = await usdc.balanceOf(alice.address);
      await round.connect(alice).refund();
      expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(20_000));
    });

    it("a refund frees the BONA behind it — nothing is stranded (M-1 regression)", async function () {
      // Before the fix, a stalled-path refund zeroed the buyer's claim but
      // left bonaSold intact, so the BONA behind the refunded purchase was
      // neither claimable nor reclaimable — stuck in the contract forever.
      await round.connect(alice).contributeUsdc(USDC(20_000)); // 2,000,000 BONA
      await time.increase(DURATION + 31 * DAY);

      await round.connect(alice).refund();

      expect(await round.bonaSold()).to.equal(0n);
      expect(await round.reclaimable()).to.equal(ALLOCATION);

      // And with sales below the floor again, the round can be marked failed.
      await round.connect(mallory).markFailed();
      await round.connect(treasury).reclaimUnsold();
      expect(await bona.balanceOf(await round.getAddress())).to.equal(0n);
    });

    it("settle after a partial refund pays the remaining balances, and the remaining buyer keeps their claim (M-1 regression)", async function () {
      await round.connect(alice).contributeUsdc(USDC(5_000)); // 500,000 BONA
      await round.connect(bob).contributeUsdc(USDC(20_000)); // 2,000,000 BONA
      await time.increase(DURATION + 31 * DAY);

      // Alice refunds during the grace window.
      await round.connect(alice).refund();

      // Sales still clear the floor without her, so the treasury may settle —
      // and receives only what the escrow actually holds.
      const before = await usdc.balanceOf(treasury.address);
      await round.connect(treasury).settle();
      expect(await usdc.balanceOf(treasury.address)).to.equal(before + USDC(20_000));

      // Bob's purchase is fully intact.
      await round.connect(bob).claimGrant();
      expect(await vesting.unclaimedOf(bob.address)).to.equal(BONA(2_000_000));

      // And Alice, having refunded, has nothing left to claim.
      await expect(round.connect(alice).claimGrant()).to.be.revertedWithCustomError(
        round,
        "NothingOwed"
      );
    });

    it("an underfunded round cannot be settled (L-2 regression)", async function () {
      // A round the multisig never funded with its allocation must not be
      // able to take the money while leaving every claim to revert.
      const bare = await deployRound();
      await usdc.connect(alice).approve(await bare.getAddress(), USDC(20_000));
      await bare.connect(alice).contributeUsdc(USDC(20_000));
      await time.increase(DURATION);

      await expect(bare.connect(treasury).settle()).to.be.revertedWithCustomError(
        bare,
        "RoundUnderfunded"
      );

      // The money is not trapped: the grace window opens the refund.
      await time.increase(31 * DAY);
      const before = await usdc.balanceOf(alice.address);
      await bare.connect(alice).refund();
      expect(await usdc.balanceOf(alice.address)).to.equal(before + USDC(20_000));
    });
  });

  describe("Claiming into vesting", function () {
    beforeEach(async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await time.increase(DURATION);
      await round.connect(treasury).settle();
    });

    it("moves the purchase into RoundVesting, not the wallet", async function () {
      await round.connect(alice).claimGrant();

      expect(await bona.balanceOf(alice.address)).to.equal(0n);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BONA(2_000_000));
      expect(await round.bonaOwed(alice.address)).to.equal(0n);
    });

    it("vests over six months from the round's close", async function () {
      await round.connect(alice).claimGrant();
      expect(await vesting.releasable(alice.address)).to.be.lessThan(BONA(20_000));

      await time.increase(SIX_MONTHS);
      expect(await vesting.releasable(alice.address)).to.equal(BONA(2_000_000));
    });

    it("cannot be claimed twice", async function () {
      await round.connect(alice).claimGrant();
      await expect(round.connect(alice).claimGrant()).to.be.revertedWithCustomError(
        round,
        "NothingOwed"
      );
    });

    it("cannot be claimed before settlement", async function () {
      const fresh = await deployRound();
      await bona.connect(treasury).transfer(await fresh.getAddress(), ALLOCATION);
      await usdc.connect(alice).approve(await fresh.getAddress(), USDC(1000));
      await fresh.connect(alice).contributeUsdc(USDC(1000));
      await expect(fresh.connect(alice).claimGrant()).to.be.revertedWithCustomError(
        fresh,
        "NotSettled"
      );
    });

    it("a very late claimer is delayed, never blocked", async function () {
      // Past RoundVesting's 30-day backdate limit: the start is clamped rather
      // than the claim reverting.
      await time.increase(90 * DAY);
      await round.connect(alice).claimGrant();
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BONA(2_000_000));
    });

    it("nobody who bought nothing can claim", async function () {
      await expect(round.connect(mallory).claimGrant()).to.be.revertedWithCustomError(
        round,
        "NothingOwed"
      );
    });
  });

  describe("Unsold BONA can go back, buyers' BONA cannot", function () {
    it("returns only what was never sold", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000)); // 2,000,000 BONA
      await time.increase(DURATION);
      await round.connect(treasury).settle();

      expect(await round.reclaimable()).to.equal(BONA(1_000_000));

      const before = await bona.balanceOf(treasury.address);
      await round.connect(treasury).reclaimUnsold();
      expect(await bona.balanceOf(treasury.address)).to.equal(before + BONA(1_000_000));

      // Alice's purchase is untouched and still claimable.
      await round.connect(alice).claimGrant();
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BONA(2_000_000));
    });

    it("cannot be called by anyone else", async function () {
      await expect(
        round.connect(mallory).reclaimUnsold()
      ).to.be.revertedWithCustomError(round, "NotTreasury");
    });

    it("reclaims everything when the round failed, since nothing is owed", async function () {
      await round.connect(alice).contributeUsdc(USDC(1000));
      await time.increase(DURATION);
      await round.connect(mallory).markFailed();

      expect(await round.reclaimable()).to.equal(ALLOCATION);
      await round.connect(treasury).reclaimUnsold();
      expect(await bona.balanceOf(await round.getAddress())).to.equal(0n);

      // And Alice still gets her money.
      await round.connect(alice).refund();
      expect(await round.usdcContributed(alice.address)).to.equal(0n);
    });

    it("cannot strand a buyer who has not yet claimed", async function () {
      await round.connect(alice).contributeUsdc(USDC(20_000));
      await time.increase(DURATION);
      await round.connect(treasury).settle();
      await round.connect(treasury).reclaimUnsold();

      // Everything Alice bought is still here for her.
      await round.connect(alice).claimGrant();
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BONA(2_000_000));
    });
  });
});
