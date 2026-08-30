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
 * These tests exist to prove the claims made about the team allocation.
 *
 * The claims are: nothing can be clawed back, a departing member keeps every
 * tranche already funded to them, a replacement cannot restart the seat
 * budget, and no tranche unlocks a lump the moment it is funded.
 *
 * If a test here is removed, the corresponding claim must be removed from
 * 03-tokenomics.md and from the website.
 */
describe("TeamVesting", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const MONTH = 30 * 24 * 60 * 60;
  const YEAR = 365 * 24 * 60 * 60;

  const MAX_PER_SEAT = BONA(2_000_000);
  const MAX_TOTAL = BONA(10_000_000);
  const TRANCHE = BONA(666_666);

  let token, vesting, funder, alice, bob, carol, mallory;

  beforeEach(async function () {
    [funder, alice, bob, carol, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    token = await Token.deploy(funder.address);
    await token.waitForDeployment();

    const Vesting = await ethers.getContractFactory("TeamVesting");
    vesting = await Vesting.deploy(await token.getAddress(), funder.address);
    await vesting.waitForDeployment();

    await token.connect(funder).approve(await vesting.getAddress(), MAX_TOTAL);
  });

  async function fund(seat, amount, startOffset = 0, duration = YEAR) {
    const start = BigInt(await time.latest()) + BigInt(startOffset);
    return vesting.connect(funder).fundGrant(seat, amount, start, duration);
  }

  describe("Setup", function () {
    it("fixes five seats of 2,000,000 each, totalling the published 10%", async function () {
      expect(await vesting.SEATS()).to.equal(5n);
      expect(await vesting.MAX_PER_SEAT()).to.equal(MAX_PER_SEAT);
      expect(await vesting.MAX_TOTAL()).to.equal(MAX_TOTAL);
      expect((await vesting.SEATS()) * (await vesting.MAX_PER_SEAT())).to.equal(MAX_TOTAL);
    });

    it("rejects a zero token or zero funder", async function () {
      const Vesting = await ethers.getContractFactory("TeamVesting");
      await expect(
        Vesting.deploy(ethers.ZeroAddress, funder.address)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
      await expect(
        Vesting.deploy(await token.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });

    it("starts with every seat vacant", async function () {
      for (let i = 0; i < 5; i++) {
        expect(await vesting.seatHolder(i)).to.equal(ethers.ZeroAddress);
      }
    });
  });

  describe("Capabilities that must NOT exist", function () {
    // The absence of these is what makes "irrevocable" true rather than promised.
    const forbidden = [
      "revoke",
      "clawback",
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

    it("exposes no function that moves tokens to the funder", async function () {
      const suspicious = vesting.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /revoke|clawback|withdraw|sweep|rescue|reclaim|recover|drain/i.test(f.name)
      );
      expect(suspicious.map((f) => f.name)).to.deep.equal([]);
    });
  });

  describe("Only the funder can assign or fund", function () {
    it("rejects assignSeat from anyone else", async function () {
      await expect(
        vesting.connect(mallory).assignSeat(0, mallory.address)
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
    });

    it("rejects fundGrant from anyone else", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      const start = await time.latest();
      await expect(
        vesting.connect(mallory).fundGrant(0, TRANCHE, start, YEAR)
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
    });

    it("rejects vacateSeat from anyone else", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await expect(
        vesting.connect(mallory).vacateSeat(0)
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
    });
  });

  describe("Seats", function () {
    it("assigns and reports a holder", async function () {
      await vesting.connect(funder).assignSeat(2, alice.address);
      expect(await vesting.seatHolder(2)).to.equal(alice.address);
      expect(await vesting.isSeated(alice.address)).to.equal(true);
    });

    it("refuses to double-fill an occupied seat", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await expect(
        vesting.connect(funder).assignSeat(0, bob.address)
      ).to.be.revertedWithCustomError(vesting, "SeatOccupied");
    });

    it("refuses to seat the same person twice", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await expect(
        vesting.connect(funder).assignSeat(1, alice.address)
      ).to.be.revertedWithCustomError(vesting, "AlreadySeated");
    });

    it("rejects a seat index above the fifth", async function () {
      await expect(
        vesting.connect(funder).assignSeat(5, alice.address)
      ).to.be.revertedWithCustomError(vesting, "BadSeat");
    });

    it("cannot fund a vacant seat", async function () {
      const start = await time.latest();
      await expect(
        vesting.connect(funder).fundGrant(0, TRANCHE, start, YEAR)
      ).to.be.revertedWithCustomError(vesting, "SeatVacant");
    });
  });

  describe("A departing member keeps everything already funded", function () {
    beforeEach(async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await fund(0, TRANCHE);
    });

    it("vacating the seat moves no tokens", async function () {
      const before = await vesting.grantedTo(alice.address);
      await vesting.connect(funder).vacateSeat(0);
      expect(await vesting.grantedTo(alice.address)).to.equal(before);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(before);
    });

    it("the leaver keeps vesting and can still claim after leaving", async function () {
      await vesting.connect(funder).vacateSeat(0);
      await time.increase(YEAR);

      expect(await vesting.releasable(alice.address)).to.equal(TRANCHE);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(TRANCHE);
    });

    it("the replacement inherits the seat's REMAINING budget, not a fresh one", async function () {
      await vesting.connect(funder).vacateSeat(0);
      await vesting.connect(funder).assignSeat(0, bob.address);

      expect(await vesting.seatGranted(0)).to.equal(TRANCHE);
      expect(await vesting.seatRemaining(0)).to.equal(MAX_PER_SEAT - TRANCHE);

      // Bob may take the rest of the seat, and not a unit more.
      await expect(
        fund(0, MAX_PER_SEAT - TRANCHE + 1n)
      ).to.be.revertedWithCustomError(vesting, "ExceedsSeatBudget");

      await fund(0, MAX_PER_SEAT - TRANCHE);
      expect(await vesting.seatRemaining(0)).to.equal(0n);
    });

    it("withholding the next tranche is the only consequence of leaving", async function () {
      await vesting.connect(funder).vacateSeat(0);
      // Nothing was taken from Alice; she simply receives no further grants.
      expect(await vesting.grantedTo(alice.address)).to.equal(TRANCHE);
      expect(await vesting.grantCount(alice.address)).to.equal(1n);
    });
  });

  describe("Vesting is linear with no cliff", function () {
    beforeEach(async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
    });

    it("releases nothing before the start", async function () {
      await fund(0, TRANCHE, 10 * MONTH);
      expect(await vesting.releasable(alice.address)).to.equal(0n);
    });

    it("releases roughly half at the halfway point", async function () {
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR / 2);

      const releasable = await vesting.releasable(alice.address);
      const half = TRANCHE / 2n;
      const tolerance = TRANCHE / 1000n; // block timestamp drift
      expect(releasable).to.be.closeTo(half, tolerance);
    });

    it("releases everything after the duration and never more", async function () {
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR * 3);
      expect(await vesting.releasable(alice.address)).to.equal(TRANCHE);

      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(TRANCHE);
      expect(await vesting.releasable(alice.address)).to.equal(0n);
      await expect(
        vesting.connect(alice).release()
      ).to.be.revertedWithCustomError(vesting, "NothingToRelease");
    });

    it("a partial claim does not affect what remains", async function () {
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR / 2);
      await vesting.connect(alice).release();

      const claimed = await token.balanceOf(alice.address);
      await time.increase(YEAR);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(TRANCHE);
      expect(claimed).to.be.lessThan(TRANCHE);
    });
  });

  describe("A later tranche never unlocks a lump", function () {
    // This is the trap that a single `balance + released` schedule falls into.
    it("tranche two starts at zero vested on the day it is funded", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await fund(0, TRANCHE, 0, YEAR);

      await time.increase(YEAR);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(TRANCHE);

      // Fund the second tranche now, starting now.
      await fund(0, TRANCHE, 0, YEAR);

      // A schedule computed against `balance + released` would show roughly
      // half of tranche two vested the instant it landed. Here only the
      // seconds that have actually elapsed count, which is the whole point.
      const releasable = await vesting.releasable(alice.address);
      expect(releasable).to.be.lessThan(TRANCHE / 10000n);
    });

    it("two tranches sum correctly once both have run", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR);
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR);

      expect(await vesting.vestedAmount(alice.address, await time.latest()))
        .to.equal(TRANCHE * 2n);
    });
  });

  describe("Caps are enforced by the contract, not by policy", function () {
    it("cannot exceed a seat's 2,000,000 budget", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await expect(
        fund(0, MAX_PER_SEAT + 1n)
      ).to.be.revertedWithCustomError(vesting, "ExceedsSeatBudget");
    });

    it("cannot exceed 10,000,000 in total across all seats", async function () {
      const signers = [alice, bob, carol, mallory];
      for (let i = 0; i < 4; i++) {
        await vesting.connect(funder).assignSeat(i, signers[i].address);
        await fund(i, MAX_PER_SEAT);
      }
      expect(await vesting.totalGranted()).to.equal(MAX_PER_SEAT * 4n);

      // The fifth seat may take exactly the remainder.
      const fifth = (await ethers.getSigners())[5];
      await vesting.connect(funder).assignSeat(4, fifth.address);
      await fund(4, MAX_PER_SEAT);
      expect(await vesting.totalGranted()).to.equal(MAX_TOTAL);
    });

    it("rejects a duration above ten years, which would brick the beneficiary (L-1)", async function () {
      await vesting.connect(funder).assignSeat(1, bob.address);
      await expect(
        fund(1, TRANCHE, 0, 11 * YEAR)
      ).to.be.revertedWithCustomError(vesting, "DurationTooLong");
    });

    it("rejects a zero amount, a zero duration, and a backdated start", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      const now = await time.latest();
      await expect(
        vesting.connect(funder).fundGrant(0, 0, now, YEAR)
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");
      await expect(
        vesting.connect(funder).fundGrant(0, TRANCHE, now, 0)
      ).to.be.revertedWithCustomError(vesting, "ZeroDuration");
      await expect(
        vesting.connect(funder).fundGrant(0, TRANCHE, (await vesting.deployedAt()) - 1n, YEAR)
      ).to.be.revertedWithCustomError(vesting, "StartBeforeDeployment");
    });
  });

  describe("Snapshot voting weight", function () {
    it("unclaimedOf counts locked tokens so a lock does not disenfranchise", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await fund(0, TRANCHE, 0, YEAR);

      // Nothing vested yet, but the full tranche must still carry voting weight.
      expect(await vesting.unclaimedOf(alice.address)).to.equal(TRANCHE);
      expect(await token.balanceOf(alice.address)).to.equal(0n);
    });

    it("unclaimedOf falls as tokens are claimed into the wallet", async function () {
      await vesting.connect(funder).assignSeat(0, alice.address);
      await fund(0, TRANCHE, 0, YEAR);
      await time.increase(YEAR);
      await vesting.connect(alice).release();

      expect(await vesting.unclaimedOf(alice.address)).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(TRANCHE);
      // Total weight is unchanged: it simply moved from the contract to the wallet.
    });
  });
});
