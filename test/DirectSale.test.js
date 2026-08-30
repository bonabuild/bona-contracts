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
 * These tests exist to prove the claims made about the sale.
 *
 * The claims are: one published price for everyone with no way to change it,
 * the buyer's money and the buyer's grant move in the same transaction, the
 * project never holds a dollar that has not bought anything, what the
 * contract can sell is bounded three separate ways, and nothing here can
 * reach a token that belongs to a buyer.
 *
 * If a test here is removed, the corresponding claim must be removed from the
 * website and the documentation in the same commit.
 */
describe("DirectSale", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const USDC = (n) => ethers.parseUnits(String(n), 6);
  const DAY = 24 * 60 * 60;
  const SIX_MONTHS = 180 * DAY;

  // The published price: 1 USDC = 100 BONA.
  const PRICE = BONA(100);
  const MAX_BONA = BONA(60_000_000);
  const TRANCHE = BONA(500_000);

  let bona, usdc, vesting, sale;
  let treasury, alice, bob, mallory;

  beforeEach(async function () {
    [treasury, alice, bob, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    bona = await Token.deploy(treasury.address);
    await bona.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy(treasury.address, USDC(1_000_000));
    await usdc.waitForDeployment();

    const Vesting = await ethers.getContractFactory("SaleVesting");
    vesting = await Vesting.deploy(await bona.getAddress(), treasury.address);
    await vesting.waitForDeployment();

    const Sale = await ethers.getContractFactory("DirectSale");
    sale = await Sale.deploy(
      await bona.getAddress(),
      await usdc.getAddress(),
      await vesting.getAddress(),
      treasury.address,
      PRICE,
      MAX_BONA,
      SIX_MONTHS
    );
    await sale.waitForDeployment();

    // Buyers need dollars. The mock mints its whole supply to the deployer,
    // so hand some out from there.
    await usdc.transfer(alice.address, USDC(10_000));
    await usdc.transfer(bob.address, USDC(10_000));
    await usdc.connect(alice).approve(await sale.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await sale.getAddress(), ethers.MaxUint256);
  });

  /** Arm the sale the way the multisig will: an instalment of each. */
  async function arm(amount = TRANCHE) {
    await bona.transfer(await sale.getAddress(), amount);
    await vesting.reserveCapacity(await sale.getAddress(), amount);
  }

  describe("Terms are fixed at deployment", function () {
    it("publishes one price, and nothing can change it", async function () {
      expect(await sale.bonaPerUsdc()).to.equal(PRICE);

      const names = sale.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const f of [
        "setPrice",
        "updatePrice",
        "setRate",
        "pause",
        "unpause",
        "owner",
        "transferOwnership",
        "setTreasury",
        "setVesting",
        "withdraw",
        "sweep",
        "rescue",
      ]) {
        expect(names, `${f}() must not exist`).to.not.include(f);
      }
    });

    it("quotes the published price before any transaction", async function () {
      expect(await sale.quote(USDC(1))).to.equal(BONA(100));
      expect(await sale.quote(USDC(10))).to.equal(BONA(1_000));
      expect(await sale.quote(USDC(2_500))).to.equal(BONA(250_000));
    });

    it("rejects a zero address, a zero price and a zero ceiling", async function () {
      const Sale = await ethers.getContractFactory("DirectSale");
      const args = [
        await bona.getAddress(),
        await usdc.getAddress(),
        await vesting.getAddress(),
        treasury.address,
        PRICE,
        MAX_BONA,
        SIX_MONTHS,
      ];
      const swap = (i, v) => args.map((a, j) => (i === j ? v : a));

      for (const i of [0, 1, 2, 3]) {
        await expect(Sale.deploy(...swap(i, ethers.ZeroAddress))).to.be.reverted;
      }
      await expect(Sale.deploy(...swap(4, 0))).to.be.revertedWithCustomError(sale, "BadPrice");
      await expect(Sale.deploy(...swap(5, 0))).to.be.revertedWithCustomError(
        sale,
        "BadAllocation"
      );
    });

    /**
     * A sale deployed outside the vesting contract's accepted window would
     * take a buyer's money and then revert on the grant — every time, for
     * every buyer. Catching it at deployment costs nothing. (L-1)
     */
    it("refuses a vesting duration the vesting contract would reject", async function () {
      const Sale = await ethers.getContractFactory("DirectSale");
      const base = [
        await bona.getAddress(),
        await usdc.getAddress(),
        await vesting.getAddress(),
        treasury.address,
        PRICE,
        MAX_BONA,
      ];
      await expect(Sale.deploy(...base, SIX_MONTHS - 1)).to.be.revertedWithCustomError(
        sale,
        "BadVestingDuration"
      );
      const tooLong = Number(await vesting.MAX_VESTING_DURATION()) + 1;
      await expect(Sale.deploy(...base, tooLong)).to.be.revertedWithCustomError(
        sale,
        "BadVestingDuration"
      );
    });
  });

  describe("Buying", function () {
    beforeEach(arm);

    it("gives the published amount of BONA for the dollars paid", async function () {
      await sale.connect(alice).buy(USDC(10));

      expect(await sale.bonaSold()).to.equal(BONA(1_000));
      expect(await sale.boughtBy(alice.address)).to.equal(BONA(1_000));
      expect(await vesting.grantedTo(alice.address)).to.equal(BONA(1_000));
    });

    it("charges the first buyer and the last buyer the same", async function () {
      await sale.connect(alice).buy(USDC(100));
      await sale.connect(bob).buy(USDC(100));
      await time.increase(90 * DAY);
      await sale.connect(alice).buy(USDC(100));

      expect(await vesting.grantedTo(bob.address)).to.equal(BONA(10_000));
      expect(await vesting.grantedTo(alice.address)).to.equal(BONA(20_000));
    });

    /**
     * The property the whole contract is arranged around: the dollars land in
     * the multisig and the grant is written in one call, so the project never
     * holds money that has not yet bought anything.
     */
    it("sends the USDC straight to the multisig and keeps none", async function () {
      const before = await usdc.balanceOf(treasury.address);
      await sale.connect(alice).buy(USDC(250));

      expect(await usdc.balanceOf(treasury.address)).to.equal(before + USDC(250));
      expect(await usdc.balanceOf(await sale.getAddress())).to.equal(0);
      expect(await sale.usdcReceived()).to.equal(USDC(250));
    });

    it("writes the vesting grant in the same transaction as the payment", async function () {
      await expect(sale.connect(alice).buy(USDC(10)))
        .to.emit(sale, "Bought")
        .withArgs(alice.address, USDC(10), BONA(1_000))
        .and.to.emit(vesting, "Granted");

      expect(await vesting.grantCount(alice.address)).to.equal(1);
    });

    it("leaves the buyer with no BONA in hand, and full voting weight", async function () {
      await sale.connect(alice).buy(USDC(10));

      expect(await bona.balanceOf(alice.address)).to.equal(0);
      expect(await vesting.unclaimedOf(alice.address)).to.equal(BONA(1_000));
    });

    it("vests over six months from the moment of purchase", async function () {
      await sale.connect(alice).buy(USDC(10));

      await time.increase(SIX_MONTHS / 2);
      expect(await vesting.releasable(alice.address)).to.be.closeTo(BONA(500), BONA(1));

      await time.increase(SIX_MONTHS / 2 + DAY);
      expect(await vesting.releasable(alice.address)).to.equal(BONA(1_000));
      await vesting.connect(alice).release();
      expect(await bona.balanceOf(alice.address)).to.equal(BONA(1_000));
    });

    it("refuses a purchase below the minimum", async function () {
      await expect(sale.connect(alice).buy(USDC(1) - 1n)).to.be.revertedWithCustomError(
        sale,
        "BelowMinimum"
      );
      await expect(sale.connect(alice).buy(0)).to.be.revertedWithCustomError(
        sale,
        "BelowMinimum"
      );
      await sale.connect(alice).buy(USDC(1));
    });
  });

  describe("Nothing is taken that is not matched by a grant", function () {
    /**
     * The failure class this design removes. If the grant cannot be written —
     * no capacity reserved, no BONA in the contract, the buyer at their grant
     * limit — the buyer's USDC must stay in the buyer's wallet.
     */
    it("takes no money when the sale has no reserved capacity", async function () {
      await bona.transfer(await sale.getAddress(), TRANCHE); // tokens but no reservation
      const buyer = await usdc.balanceOf(alice.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);

      await expect(sale.connect(alice).buy(USDC(10))).to.be.revertedWithCustomError(
        vesting,
        "NoReservation"
      );

      expect(await usdc.balanceOf(alice.address)).to.equal(buyer);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
      expect(await sale.bonaSold()).to.equal(0);
    });

    it("takes no money when the sale holds no BONA", async function () {
      await vesting.reserveCapacity(await sale.getAddress(), TRANCHE); // capacity but no tokens
      const buyer = await usdc.balanceOf(alice.address);
      const treasuryBefore = await usdc.balanceOf(treasury.address);

      await expect(sale.connect(alice).buy(USDC(10))).to.be.reverted;

      expect(await usdc.balanceOf(alice.address)).to.equal(buyer);
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);
    });

    it("takes no money once the reservation runs out mid-sale", async function () {
      await bona.transfer(await sale.getAddress(), BONA(10_000));
      await vesting.reserveCapacity(await sale.getAddress(), BONA(1_000));

      await sale.connect(alice).buy(USDC(10)); // exactly the reservation
      const before = await usdc.balanceOf(bob.address);

      await expect(sale.connect(bob).buy(USDC(10))).to.be.revertedWithCustomError(
        vesting,
        "NoReservation"
      );
      expect(await usdc.balanceOf(bob.address)).to.equal(before);
    });
  });

  describe("What the sale can sell is bounded three ways", function () {
    it("stops at its own lifetime ceiling", async function () {
      const Sale = await ethers.getContractFactory("DirectSale");
      const small = await Sale.deploy(
        await bona.getAddress(),
        await usdc.getAddress(),
        await vesting.getAddress(),
        treasury.address,
        PRICE,
        BONA(1_000),
        SIX_MONTHS
      );
      await small.waitForDeployment();
      await bona.transfer(await small.getAddress(), BONA(100_000));
      await vesting.reserveCapacity(await small.getAddress(), BONA(100_000));
      await usdc.connect(alice).approve(await small.getAddress(), ethers.MaxUint256);

      await small.connect(alice).buy(USDC(10)); // 1,000 BONA — the whole ceiling
      expect(await small.remainingBona()).to.equal(0);
      await expect(small.connect(alice).buy(USDC(1))).to.be.revertedWithCustomError(
        small,
        "SoldOut"
      );
    });

    it("availableBona reports the tightest of the three limits", async function () {
      // Ceiling is huge; the instalment is what binds.
      await bona.transfer(await sale.getAddress(), BONA(5_000));
      await vesting.reserveCapacity(await sale.getAddress(), BONA(9_000));
      expect(await sale.availableBona()).to.equal(BONA(5_000)); // held < reserved

      await bona.transfer(await sale.getAddress(), BONA(10_000));
      expect(await sale.availableBona()).to.equal(BONA(9_000)); // reserved < held
    });

    it("the multisig cannot reserve past the published sale allocation", async function () {
      await expect(
        vesting.reserveCapacity(await sale.getAddress(), BONA(60_000_001))
      ).to.be.revertedWithCustomError(vesting, "ExceedsTotalCap");
    });
  });

  describe("Reclaiming unsold tokens", function () {
    beforeEach(arm);

    it("only the multisig may reclaim", async function () {
      await expect(sale.connect(mallory).reclaimUnsold()).to.be.revertedWithCustomError(
        sale,
        "NotTreasury"
      );
    });

    /**
     * Safe to take everything precisely because a purchase moves the buyer's
     * BONA out in the same transaction: nothing held here is ever owed.
     */
    it("returns the whole balance and cannot touch a buyer's tokens", async function () {
      await sale.connect(alice).buy(USDC(10));
      const bought = BONA(1_000);

      const before = await bona.balanceOf(treasury.address);
      await sale.reclaimUnsold();

      expect(await bona.balanceOf(await sale.getAddress())).to.equal(0);
      expect(await bona.balanceOf(treasury.address)).to.equal(before + TRANCHE - bought);

      // The buyer's tokens are in vesting, untouched, and still theirs.
      expect(await vesting.unclaimedOf(alice.address)).to.equal(bought);
      await time.increase(SIX_MONTHS + DAY);
      await vesting.connect(alice).release();
      expect(await bona.balanceOf(alice.address)).to.equal(bought);
    });

    it("emptying the contract is how the sale is stopped", async function () {
      await sale.reclaimUnsold();
      await expect(sale.connect(alice).buy(USDC(10))).to.be.reverted;
    });

    it("reverts when there is nothing to reclaim", async function () {
      await sale.reclaimUnsold();
      await expect(sale.reclaimUnsold()).to.be.revertedWithCustomError(
        sale,
        "NothingToReclaim"
      );
    });
  });
});
