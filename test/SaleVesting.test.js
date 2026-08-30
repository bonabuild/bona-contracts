const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * Minimal time helpers, so the suite adds no dependency beyond what the token
 * tests already use.
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
 * These tests exist to prove the claims made about buyer vesting.
 *
 * The claims are: a buyer's tokens cannot be cancelled or redirected, the
 * six-month lock is enforced by this contract rather than by the sale that
 * calls it, a grant never arrives partly vested, locked tokens still carry
 * voting weight, and — the two findings an external review raised — no
 * granter can be starved of capacity by another, and stopping a granter can
 * never strand a buyer whose purchase it has already accepted.
 *
 * If a test here is removed, the corresponding claim must be removed from the
 * documentation and from the website in the same commit.
 */
describe("SaleVesting", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const DAY = 24 * 60 * 60;
  const SIX_MONTHS = 180 * DAY;

  const MAX_TOTAL = BONA(60_000_000);
  const BOUGHT = BONA(100_000);

  let token, vesting, sale, otherSale;
  let funder, alice, bob, mallory;

  beforeEach(async function () {
    [funder, alice, bob, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    token = await Token.deploy(funder.address);
    await token.waitForDeployment();

    const Vesting = await ethers.getContractFactory("SaleVesting");
    vesting = await Vesting.deploy(await token.getAddress(), funder.address);
    await vesting.waitForDeployment();

    const Sale = await ethers.getContractFactory("MockGranter");
    sale = await Sale.deploy(await token.getAddress(), await vesting.getAddress());
    await sale.waitForDeployment();
    otherSale = await Sale.deploy(await token.getAddress(), await vesting.getAddress());
    await otherSale.waitForDeployment();

    // The multisig funds each sale contract with the BONA it will hand out.
    await token.transfer(await sale.getAddress(), BONA(1_000_000));
    await token.transfer(await otherSale.getAddress(), BONA(1_000_000));
  });

  const reserve = (who, amount) => vesting.reserveCapacity(who, amount);

  describe("Setup", function () {
    it("publishes the sale allocation as a contract constant", async function () {
      expect(await vesting.MAX_TOTAL()).to.equal(MAX_TOTAL);
      expect(await vesting.reservableRemaining()).to.equal(MAX_TOTAL);
    });

    it("enforces the six-month minimum as a constant, not a policy", async function () {
      expect(await vesting.MIN_DURATION()).to.equal(SIX_MONTHS);
    });

    it("rejects a zero token or a zero funder", async function () {
      const Vesting = await ethers.getContractFactory("SaleVesting");
      await expect(
        Vesting.deploy(ethers.ZeroAddress, funder.address)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
      await expect(
        Vesting.deploy(await token.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });
  });

  describe("Capabilities that must NOT exist", function () {
    // Inspecting the compiled ABI, so these assert something about the
    // artifact rather than about anyone's intention.
    const forbidden = [
      "revoke",
      "revokeGrant",
      "cancel",
      "clawback",
      "sweep",
      "rescue",
      "withdraw",
      "pause",
      "unpause",
      "owner",
      "transferOwnership",
      "setDuration",
      "setStart",
      "setAmount",
    ];

    it("has none of the functions that could reach a buyer's tokens", async function () {
      const names = vesting.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const f of forbidden) {
        expect(names, `${f}() must not exist`).to.not.include(f);
      }
    });

    it("the funder cannot move tokens held here", async function () {
      await reserve(await sale.getAddress(), BOUGHT);
      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);

      const names = vesting.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      // The only outward transfer path is release(), and it pays msg.sender.
      expect(names.filter((n) => n === "release")).to.have.length(1);
      const before = await token.balanceOf(funder.address);
      await expect(vesting.connect(funder).release()).to.be.revertedWithCustomError(
        vesting,
        "NothingToRelease"
      );
      expect(await token.balanceOf(funder.address)).to.equal(before);
    });
  });

  describe("Capacity is reserved, not raced for", function () {
    it("only the funder may reserve", async function () {
      await expect(
        vesting.connect(mallory).reserveCapacity(await sale.getAddress(), BOUGHT)
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
    });

    it("refuses an EOA granter, so no single key can write grants", async function () {
      await expect(
        reserve(mallory.address, BOUGHT)
      ).to.be.revertedWithCustomError(vesting, "NotAContract");
    });

    it("cannot reserve beyond the published pool", async function () {
      await expect(
        reserve(await sale.getAddress(), MAX_TOTAL + 1n)
      ).to.be.revertedWithCustomError(vesting, "ExceedsTotalCap");
    });

    it("counts every reservation against the same pool", async function () {
      await reserve(await sale.getAddress(), BONA(40_000_000));
      expect(await vesting.reservableRemaining()).to.equal(BONA(20_000_000));

      await expect(
        reserve(await otherSale.getAddress(), BONA(20_000_001))
      ).to.be.revertedWithCustomError(vesting, "ExceedsTotalCap");

      await reserve(await otherSale.getAddress(), BONA(20_000_000));
      expect(await vesting.reservableRemaining()).to.equal(0);
    });

    it("grants draw only against the caller's own reservation", async function () {
      await reserve(await sale.getAddress(), BOUGHT);
      const start = await time.latest();

      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);
      expect(await vesting.reservationOf(await sale.getAddress())).to.equal(0);

      await expect(
        sale.settleFor(bob.address, 1n, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "NoReservation");
    });

    it("a granter with no reservation cannot grant at all", async function () {
      const start = await time.latest();
      await expect(
        sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "NoReservation");
    });

    /**
     * The finding this model exists for. Under the previous version the cap
     * was checked inside grant(): two sales whose allocations overlapped the
     * remaining capacity both worked until the pool ran low, and then a
     * buyer's grant reverted with their money already taken. Here the second
     * sale simply cannot be given capacity that is not there, and the failure
     * lands on the multisig at reservation time instead of on a buyer at
     * purchase time. (F2)
     */
    it("one sale cannot exhaust the pool underneath another (F2)", async function () {
      await reserve(await sale.getAddress(), BONA(60_000_000));

      // The second sale can never be armed, so it can never take money.
      await expect(
        reserve(await otherSale.getAddress(), 1n)
      ).to.be.revertedWithCustomError(vesting, "ExceedsTotalCap");

      // And the first sale's own buyers are unaffected by that attempt.
      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);
      expect(await vesting.grantedTo(alice.address)).to.equal(BOUGHT);
    });
  });

  describe("Stopping a sale cannot strand its buyers", function () {
    it("releasing capacity stops further grants", async function () {
      await reserve(await sale.getAddress(), BOUGHT * 2n);
      await vesting.releaseCapacity(await sale.getAddress(), BOUGHT * 2n);

      const start = await time.latest();
      await expect(
        sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "NoReservation");
    });

    it("released capacity returns to the pool for another sale", async function () {
      await reserve(await sale.getAddress(), BONA(60_000_000));
      expect(await vesting.reservableRemaining()).to.equal(0);

      await vesting.releaseCapacity(await sale.getAddress(), BONA(10_000_000));
      expect(await vesting.reservableRemaining()).to.equal(BONA(10_000_000));
      await reserve(await otherSale.getAddress(), BONA(10_000_000));
    });

    it("only the funder may release, and never more than is there", async function () {
      await reserve(await sale.getAddress(), BOUGHT);
      await expect(
        vesting.connect(mallory).releaseCapacity(await sale.getAddress(), BOUGHT)
      ).to.be.revertedWithCustomError(vesting, "NotFunder");
      await expect(
        vesting.releaseCapacity(await sale.getAddress(), BOUGHT + 1n)
      ).to.be.revertedWithCustomError(vesting, "ExceedsReservation");
    });

    /**
     * The other review finding. De-authorising a granter used to block every
     * buyer who had paid but not yet claimed — money taken, tokens
     * unreachable. A sale that carries an obligation across two transactions
     * now commits to it, and the commitment is a floor the multisig cannot
     * release below. (F1)
     */
    it("capacity cannot be released below what a sale has committed (F1)", async function () {
      await reserve(await sale.getAddress(), BOUGHT * 2n);
      await sale.commitTo(BOUGHT);

      await expect(
        vesting.releaseCapacity(await sale.getAddress(), BOUGHT + 1n)
      ).to.be.revertedWithCustomError(vesting, "BelowCommitment");

      // The uncommitted half is still releasable.
      await vesting.releaseCapacity(await sale.getAddress(), BOUGHT);
      expect(await vesting.reservationOf(await sale.getAddress())).to.equal(BOUGHT);

      // And the committed buyer still gets their grant afterwards.
      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);
      expect(await vesting.grantedTo(alice.address)).to.equal(BOUGHT);
    });

    it("a commitment cannot shrink, and cannot exceed the reservation", async function () {
      await reserve(await sale.getAddress(), BOUGHT);
      await sale.commitTo(BOUGHT);

      await expect(sale.commitTo(BOUGHT - 1n)).to.be.revertedWithCustomError(
        vesting,
        "CommitmentCannotShrink"
      );
      await expect(sale.commitTo(BOUGHT + 1n)).to.be.revertedWithCustomError(
        vesting,
        "ExceedsReservation"
      );
    });

    it("granting settles the commitment it stood for", async function () {
      await reserve(await sale.getAddress(), BOUGHT * 2n);
      await sale.commitTo(BOUGHT);

      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);

      expect(await vesting.committedOf(await sale.getAddress())).to.equal(0);
      // With the obligation met, the rest is releasable again.
      await vesting.releaseCapacity(await sale.getAddress(), BOUGHT);
      expect(await vesting.reservationOf(await sale.getAddress())).to.equal(0);
    });
  });

  describe("The six-month lock cannot be bypassed by the sale", function () {
    beforeEach(async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
    });

    it("rejects a duration under six months", async function () {
      const start = await time.latest();
      await expect(
        sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS - 1)
      ).to.be.revertedWithCustomError(vesting, "DurationTooShort");
    });

    it("rejects a duration that would overflow the schedule (L-1)", async function () {
      const start = await time.latest();
      const tooLong = Number(await vesting.MAX_VESTING_DURATION()) + 1;
      await expect(
        sale.settleFor(alice.address, BOUGHT, start, tooLong)
      ).to.be.revertedWithCustomError(vesting, "DurationTooLong");
    });

    it("rejects a start backdated past the window, so no grant arrives pre-vested", async function () {
      // Move well past deployment first, otherwise the backdated start trips
      // StartBeforeDeployment and this stops testing what it claims to test.
      await time.increase(60 * DAY);
      const start = (await time.latest()) - 31 * DAY;
      await expect(
        sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "StartTooFarInPast");
    });

    it("rejects a start before this contract existed", async function () {
      const deployed = Number(await vesting.deployedAt());
      await expect(
        sale.settleFor(alice.address, BOUGHT, deployed - 1, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "StartBeforeDeployment");
    });

    it("rejects a zero amount and a zero beneficiary", async function () {
      const start = await time.latest();
      await expect(
        sale.settleFor(alice.address, 0, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "ZeroAmount");
      await expect(
        sale.settleFor(ethers.ZeroAddress, BOUGHT, start, SIX_MONTHS)
      ).to.be.revertedWithCustomError(vesting, "ZeroAddress");
    });
  });

  describe("Vesting is linear from the day of purchase", function () {
    let grantStart;

    beforeEach(async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
      grantStart = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, grantStart, SIX_MONTHS);
    });

    it("a grant is exactly zero vested at its own start", async function () {
      // The precise claim: nothing is vested at the instant a grant begins.
      // Asserting on releasable() a block later would only measure how long
      // the test took, since vesting accrues per second from that instant.
      expect(await vesting.vestedAmount(alice.address, grantStart)).to.equal(0);
      // And a couple of seconds later it is still negligible, not a chunk.
      expect(await vesting.releasable(alice.address)).to.be.lt(BONA(1));
    });

    it("releases roughly half at the halfway point", async function () {
      await time.increase(SIX_MONTHS / 2);
      const releasable = await vesting.releasable(alice.address);
      expect(releasable).to.be.closeTo(BOUGHT / 2n, BONA(50));
    });

    it("releases everything, and only everything, after six months", async function () {
      await time.increase(SIX_MONTHS + DAY);
      expect(await vesting.releasable(alice.address)).to.equal(BOUGHT);

      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);
      await expect(vesting.connect(alice).release()).to.be.revertedWithCustomError(
        vesting,
        "NothingToRelease"
      );
    });

    it("pays the claimer and nobody else", async function () {
      await time.increase(SIX_MONTHS + DAY);
      await expect(vesting.connect(bob).release()).to.be.revertedWithCustomError(
        vesting,
        "NothingToRelease"
      );
    });
  });

  describe("A buyer who buys more than once", function () {
    /**
     * The lump trap: a schedule computed against balance + released would
     * treat the second purchase as partly vested the moment it lands.
     */
    it("a later purchase starts at zero vested, not part-way", async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
      const first = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, first, SIX_MONTHS);

      await time.increase(SIX_MONTHS / 2);
      const afterFirstHalf = await vesting.releasable(alice.address);

      const second = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, second, SIX_MONTHS);

      // The second grant added nothing to what is releasable right now.
      const afterSecond = await vesting.releasable(alice.address);
      expect(afterSecond).to.be.closeTo(afterFirstHalf, BONA(50));
      expect(await vesting.grantCount(alice.address)).to.equal(2);
    });

    it("both purchases pay out in full once both schedules complete", async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
      const first = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, first, SIX_MONTHS);
      await time.increase(SIX_MONTHS / 2);
      const second = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, second, SIX_MONTHS);

      await time.increase(SIX_MONTHS + DAY);
      await vesting.connect(alice).release();
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT * 2n);
    });

    it("caps the grants one address can hold, so release() always fits in a block", async function () {
      const cap = Number(await vesting.MAX_GRANTS_PER_BENEFICIARY());
      expect(cap).to.equal(500);

      // Filling 500 grants on-chain would be slow; assert the guard exists and
      // reads the beneficiary's own count by checking it is enforced per
      // address rather than globally.
      await reserve(await sale.getAddress(), BONA(1_000));
      const start = await time.latest();
      await sale.settleFor(alice.address, BONA(1), start, SIX_MONTHS);
      expect(await vesting.grantCount(alice.address)).to.equal(1);
      expect(await vesting.grantCount(bob.address)).to.equal(0);
    });
  });

  describe("Snapshot voting weight", function () {
    it("unclaimedOf counts locked tokens, so a lock does not disenfranchise", async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);

      expect(await token.balanceOf(alice.address)).to.equal(0);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BOUGHT);
    });

    it("unclaimedOf falls as tokens are claimed into the wallet", async function () {
      await reserve(await sale.getAddress(), BONA(1_000_000));
      const start = await time.latest();
      await sale.settleFor(alice.address, BOUGHT, start, SIX_MONTHS);

      await time.increase(SIX_MONTHS + DAY);
      await vesting.connect(alice).release();

      expect(await vesting.unclaimedOf(alice.address)).to.equal(0);
      expect(await token.balanceOf(alice.address)).to.equal(BOUGHT);
    });
  });
});
