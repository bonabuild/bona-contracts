const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Minimal time helpers, so the suite adds no dependency beyond what the
 * token tests already use.
 */
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
 * These tests exist to prove the claims made about sale-round vesting.
 *
 * The claims are: a buyer's tokens cannot be cancelled or redirected, the
 * six-month lock is enforced by the contract rather than by the round that
 * calls it, a grant never arrives partly vested, and locked tokens still
 * carry voting weight so a buyer can vote in the round they funded.
 *
 * If a test here is removed, the corresponding claim must be removed from
 * 08-sale-rounds.md and from the website.
 */
describe("RoundVesting", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const DAY = 24 * 60 * 60;
  const SIX_MONTHS = 180 * DAY;

  const MAX_TOTAL = BONA(30_000_000);
  const BOUGHT = BONA(100_000);

  let token, vesting, round, otherRound;
  let funder, alice, bob, mallory;

  beforeEach(async function () {
    [funder, alice, bob, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    token = await Token.deploy(funder.address);
    await token.waitForDeployment();

    const Vesting = await ethers.getContractFactory("RoundVesting");
    vesting = await Vesting.deploy(await token.getAddress(), funder.address);
    await vesting.waitForDeployment();

    const Round = await ethers.getContractFactory("MockRound");
    round = await Round.deploy(await token.getAddress(), await vesting.getAddress());
    await round.waitForDeployment();
    otherRound = await Round.deploy(await token.getAddress(), await vesting.getAddress());
    await otherRound.waitForDeployment();

    await vesting.connect(funder).authoriseGranter(await round.getAddress());

    // A settled round holds the BONA it is about to grant.
    await token.connect(funder).transfer(await round.getAddress(), BONA(5_000_000));
    await token.connect(funder).transfer(await otherRound.getAddress(), BONA(5_000_000));

    // In production the vesting contract exists long before any round closes.
    // Without this the suite cannot exercise backdating at all, because every
    // past timestamp would also predate deployment.
    await time.increase(60 * DAY);
  });

  async function settle(who, amount = BOUGHT, startOffset = 0, duration = SIX_MONTHS, from = round) {
    const start = BigInt(await time.latest()) + BigInt(startOffset);
    return from.settleFor(who.address, amount, start, duration);
  }

  describe("Setup", function () {
    it("caps the pool at the published 30,000,000", async function () {
      expect(await vesting.MAX_TOTAL()).to.equal(MAX_TOTAL);
      expect(await vesting.remainingPool()).to.equal(MAX_TOTAL);
    });

    it("enforces six months as a contract constant, not a policy", async function () {
      expect(await vesting.MIN_DURATION()).to.equal(BigInt(SIX_MONTHS));
    });

    it("rejects a zero token or zero funder", async function () {
      const Vesting = await ethers.getContractFactory("RoundVesting");
      await expect(
        Vesting.deploy(ethers.ZeroAddress, funder.address)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
      await expect(
        Vesting.deploy(await token.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });
  });

  describe("Capabilities that must NOT exist", function () {
    const forbidden = [
      "revoke",
      "clawback",
      "cancel",
      "cancelGrant",
      "withdraw",
      "sweep",
      "rescue",
      "owner",
      "transferOwnership",
      "pause",
      "setSchedule",
      "updateGrant",
    ];

    for (const fn of forbidden) {
      it(`has no ${fn}() function`, async function () {
        const found = vesting.interface.fragments.filter(
          (f) => f.type === "function" && f.name === fn
        );
        expect(found, `${fn}() must not exist`).to.have.lengthOf(0);
      });
    }

    it("exposes no function that could take a buyer's grant back", async function () {
      const suspicious = vesting.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /clawback|cancel|withdraw|sweep|rescue|reclaim|recover|drain|seize/i.test(f.name)
      );
      expect(suspicious.map((f) => f.name)).to.deep.equal([]);
    });

    it("revokeGranter only stops future grants; existing ones are untouched", async function () {
      await settle(alice);
      const before = await vesting.grantedTo(alice.address);

      await vesting.connect(funder).revokeGranter(await round.getAddress());
      expect(await vesting.grantedTo(alice.address)).to.equal(before);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(before);

      await expect(settle(bob)).to.be.revertedWithCustomError(vesting, "NotGranter");

      // Alice's tokens still arrive on schedule.
      await time.increase(SIX_MONTHS);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);
    });
  });

  describe("Only authorised round contracts may grant", function () {
    it("rejects a grant from an unauthorised contract", async function () {
      await expect(
        settle(alice, BOUGHT, 0, SIX_MONTHS, otherRound)
      ).to.be.revertedWithCustomError(vesting, "NotGranter");
    });

    it("rejects a grant called directly by an EOA", async function () {
      const start = await time.latest();
      await expect(
        vesting.connect(mallory).grant(mallory.address, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "NotGranter");
    });

    it("refuses to authorise an EOA as a granter", async function () {
      await expect(
        vesting.connect(funder).authoriseGranter(mallory.address)
      ).to.be.revertedWithCustomError(vesting, "NotAContract");
    });

    it("only the funder can authorise or revoke", async function () {
      await expect(
        vesting.connect(mallory).authoriseGranter(await otherRound.getAddress())
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
      await expect(
        vesting.connect(mallory).revokeGranter(await round.getAddress())
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
    });
  });

  describe("The six-month lock cannot be bypassed by the round", function () {
    it("rejects a duration above five years, which would brick the beneficiary (L-1)", async function () {
      // start + duration overflowing uint64 reverts vestedAmount forever, and
      // there is deliberately no admin path to undo a grant.
      await expect(
        settle(alice, BOUGHT, 0, 6 * 365 * DAY)
      ).to.be.revertedWithCustomError(vesting, "DurationTooLong");
    });

    it("rejects a duration shorter than 180 days", async function () {
      await expect(
        settle(alice, BOUGHT, 0, SIX_MONTHS - 1)
      ).to.be.revertedWithCustomError(vesting, "DurationTooShort");
      await expect(
        settle(alice, BOUGHT, 0, 1)
      ).to.be.revertedWithCustomError(vesting, "DurationTooShort");
    });

    it("rejects a start backdated beyond 30 days", async function () {
      const now = BigInt(await time.latest());
      const tooOld = now - BigInt(31 * DAY);
      await expect(
        round.settleFor(alice.address, BOUGHT, tooOld, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "StartTooFarInPast");
    });

    it("allows a modest backdate, so buyers vest from the round's close", async function () {
      const now = BigInt(await time.latest());
      const closed = now - BigInt(5 * DAY);
      await round.settleFor(alice.address, BOUGHT, closed, SIX_MONTHS);

      // Five days of a 180-day schedule — a sliver, not a bypass.
      const vested = await vesting.releasable(alice.address);
      expect(vested).to.be.greaterThan(0n);
      expect(vested).to.be.lessThan(BOUGHT / 30n);
    });

    it("rejects a start before the contract existed", async function () {
      const deployedAt = await vesting.deployedAt();
      await expect(
        round.settleFor(alice.address, BOUGHT, deployedAt - 1n, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "StartBeforeDeployment");
    });
  });

  describe("Vesting is linear from the round's close", function () {
    it("releases nothing before the start", async function () {
      await settle(alice, BOUGHT, 30 * DAY);
      expect(await vesting.releasable(alice.address)).to.equal(0n);
    });

    it("a grant arrives at zero vested, never partly unlocked", async function () {
      await settle(alice);
      const releasable = await vesting.releasable(alice.address);
      expect(releasable).to.be.lessThan(BOUGHT / 10000n);
    });

    it("releases roughly half at three months", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS / 2);
      expect(await vesting.releasable(alice.address)).to.be.closeTo(
        BOUGHT / 2n,
        BOUGHT / 1000n
      );
    });

    it("releases everything after six months and never more", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS * 2);
      expect(await vesting.releasable(alice.address)).to.equal(BOUGHT);

      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);
      await expect(
        vesting.connect(alice).release()
      ).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });

    it("nobody can claim another buyer's tokens", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS);
      await expect(
        vesting.connect(mallory).release()
      ).to.be.revertedWithCustomError(vesting, "NothingToRelease");
      expect(await token.balanceOf(mallory.address)).to.equal(0n);
    });
  });

  describe("A buyer in several rounds", function () {
    beforeEach(async function () {
      await vesting.connect(funder).authoriseGranter(await otherRound.getAddress());
    });

    it("a later round's grant does not retroactively unlock", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);

      await settle(alice, BOUGHT, 0, SIX_MONTHS, otherRound);
      expect(await vesting.releasable(alice.address)).to.be.lessThan(BOUGHT / 10000n);
    });

    it("grants from two rounds sum once both have run", async function () {
      await settle(alice);
      await settle(alice, BOUGHT, 0, SIX_MONTHS, otherRound);
      await time.increase(SIX_MONTHS * 2);

      expect(await vesting.vestedAmount(alice.address, await time.latest()))
        .to.equal(BOUGHT * 2n);
      expect(await vesting.grantCount(alice.address)).to.equal(2n);
    });

    it("records which round each grant came from", async function () {
      await settle(alice);
      const [amount, , , granter] = await vesting.grantAt(alice.address, 0);
      expect(amount).to.equal(BOUGHT);
      expect(granter).to.equal(await round.getAddress());
      expect(await vesting.grantedBy(await round.getAddress())).to.equal(BOUGHT);
    });
  });

  describe("The pool cap is enforced by the contract", function () {
    it("cannot grant beyond 30,000,000 in total", async function () {
      const big = BONA(5_000_000);
      await token.connect(funder).transfer(await round.getAddress(), BONA(30_000_000));

      for (let i = 0; i < 6; i++) {
        await settle(alice, big);
      }
      expect(await vesting.totalGranted()).to.equal(MAX_TOTAL);
      expect(await vesting.remainingPool()).to.equal(0n);

      await expect(settle(alice, 1n)).to.be.revertedWithCustomError(
        vesting,
        "ExceedsTotalCap"
      );
    });

    it("rejects a zero amount and a zero beneficiary", async function () {
      const start = await time.latest();
      await expect(
        round.settleFor(alice.address, 0, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");
      await expect(
        round.settleFor(ethers.ZeroAddress, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });
  });

  describe("Snapshot voting weight", function () {
    it("a buyer can vote from the day they pay, before anything vests", async function () {
      await settle(alice);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BOUGHT);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it("total weight is unchanged as tokens move from the contract to the wallet", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS / 2);
      await vesting.connect(alice).release();

      const inWallet = await token.balanceOf(alice.address);
      const stillLocked = await vesting.unclaimedOf(alice.address);
      expect(inWallet + stillLocked).to.equal(BOUGHT);
    });

    it("weight reaches zero only once everything is claimed", async function () {
      await settle(alice);
      await time.increase(SIX_MONTHS);
      await vesting.connect(alice).release();
      expect(await vesting.unclaimedOf(alice.address)).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);
    });
  });
});
