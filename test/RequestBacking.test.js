const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * These tests exist to prove the claims made about request backing.
 *
 * The claims are: backing is a lock and never a payment, a backer can
 * withdraw at any time without anyone's permission, the curator controls
 * status and nothing else, opening a request is free and permissionless, and
 * locked tokens still carry voting weight.
 *
 * If a test here is removed, the corresponding claim must be removed from
 * 09-requests-and-backing.md and from the website.
 */
describe("RequestBacking", function () {
  const BONA = (n) => ethers.parseUnits(String(n), 18);
  const Status = { Open: 0, Queued: 1, Delivered: 2, Cancelled: 3 };
  const DETAILS = ethers.id("Inventory module for small distributors");

  let token, backing, curator, alice, bob, carol, mallory;

  beforeEach(async function () {
    [curator, alice, bob, carol, mallory] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("BonaToken");
    token = await Token.deploy(curator.address);
    await token.waitForDeployment();

    const Backing = await ethers.getContractFactory("RequestBacking");
    backing = await Backing.deploy(await token.getAddress(), curator.address);
    await backing.waitForDeployment();

    for (const who of [alice, bob, carol, mallory]) {
      await token.connect(curator).transfer(who.address, BONA(1_000_000));
      await token.connect(who).approve(await backing.getAddress(), BONA(1_000_000));
    }
  });

  async function openRequest(by = alice) {
    await backing.connect(by).openRequest(DETAILS);
    return (await backing.requestCount()) - 1n;
  }

  describe("Opening a request is free and permissionless", function () {
    it("anyone can open one, with no BONA and no approval", async function () {
      const poor = mallory;
      await token.connect(poor).transfer(curator.address, BONA(1_000_000));
      expect(await token.balanceOf(poor.address)).to.equal(0n);

      await expect(backing.connect(poor).openRequest(DETAILS)).to.emit(
        backing,
        "RequestOpened"
      );
      expect(await backing.requestCount()).to.equal(1n);
    });

    it("records the creator, the details hash and an Open status", async function () {
      const id = await openRequest(bob);
      const [creator, status, , lockedTotal, backerCount, details] =
        await backing.getRequest(id);

      expect(creator).to.equal(bob.address);
      expect(status).to.equal(Status.Open);
      expect(lockedTotal).to.equal(0n);
      expect(backerCount).to.equal(0n);
      expect(details).to.equal(DETAILS);
    });

    it("an unbacked request scores nothing, so spam needs no gate", async function () {
      for (let i = 0; i < 5; i++) await backing.connect(mallory).openRequest(DETAILS);
      expect(await backing.requestCount()).to.equal(5n);
      for (let i = 0; i < 5; i++) {
        const [, , , lockedTotal, backerCount] = await backing.getRequest(i);
        expect(lockedTotal).to.equal(0n);
        expect(backerCount).to.equal(0n);
      }
    });

    it("rejects reads of a request that does not exist", async function () {
      await expect(backing.getRequest(0)).to.be.revertedWithCustomError(
        backing,
        "UnknownRequest"
      );
    });
  });

  describe("Backing is a lock, never a payment", function () {
    it("moves tokens into the contract and nowhere else", async function () {
      const id = await openRequest();
      const before = await token.balanceOf(alice.address);

      await backing.connect(alice).back(id, BONA(1000));

      expect(await token.balanceOf(alice.address)).to.equal(before - BONA(1000));
      expect(await token.balanceOf(await backing.getAddress())).to.equal(BONA(1000));
      expect(await backing.lockedBy(id, alice.address)).to.equal(BONA(1000));
    });

    it("returns exactly what was locked, with nothing taken", async function () {
      const id = await openRequest();
      const before = await token.balanceOf(alice.address);

      await backing.connect(alice).back(id, BONA(1000));
      await backing.connect(alice).withdrawAll(id);

      expect(await token.balanceOf(alice.address)).to.equal(before);
      expect(await token.balanceOf(await backing.getAddress())).to.equal(0n);
    });

    it("counts distinct backers, so one loud backer cannot look like a crowd", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(10_000));
      await backing.connect(bob).back(id, BONA(100));
      await backing.connect(carol).back(id, BONA(100));

      const [, , , lockedTotal, backerCount] = await backing.getRequest(id);
      expect(lockedTotal).to.equal(BONA(10_200));
      expect(backerCount).to.equal(3n);
    });

    it("backing twice does not double-count the backer", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(100));
      await backing.connect(alice).back(id, BONA(400));

      const [, , , lockedTotal, backerCount] = await backing.getRequest(id);
      expect(lockedTotal).to.equal(BONA(500));
      expect(backerCount).to.equal(1n);
    });

    it("a backer leaving drops the backer count", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(100));
      await backing.connect(bob).back(id, BONA(100));
      await backing.connect(bob).withdrawAll(id);

      const [, , , , backerCount] = await backing.getRequest(id);
      expect(backerCount).to.equal(1n);
    });

    it("a partial withdrawal keeps the backer counted", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(100));
      await backing.connect(alice).withdraw(id, BONA(60));

      const [, , , lockedTotal, backerCount] = await backing.getRequest(id);
      expect(lockedTotal).to.equal(BONA(40));
      expect(backerCount).to.equal(1n);
    });
  });

  describe("Withdrawal is always available", function () {
    it("works while the request is Queued", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      await backing.connect(curator).setStatus(id, Status.Queued);

      await backing.connect(alice).withdrawAll(id);
      expect(await backing.lockedBy(id, alice.address)).to.equal(0n);
    });

    it("works after the request is Delivered", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      await backing.connect(curator).setStatus(id, Status.Delivered);

      await backing.connect(alice).withdrawAll(id);
      expect(await backing.lockedBy(id, alice.address)).to.equal(0n);
    });

    it("works after the request is Cancelled", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      await backing.connect(curator).setStatus(id, Status.Cancelled);

      await backing.connect(alice).withdrawAll(id);
      expect(await backing.lockedBy(id, alice.address)).to.equal(0n);
    });

    it("cannot withdraw more than locked", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(100));
      await expect(
        backing.connect(alice).withdraw(id, BONA(101))
      ).to.be.revertedWithCustomError(backing, "InsufficientLocked");
    });

    it("cannot withdraw someone else's backing", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      await expect(
        backing.connect(mallory).withdrawAll(id)
      ).to.be.revertedWithCustomError(backing, "InsufficientLocked");
      expect(await backing.lockedBy(id, alice.address)).to.equal(BONA(1000));
    });
  });

  describe("The curator controls status and nothing else", function () {
    const forbidden = [
      "sweep",
      "rescue",
      "withdrawFor",
      "seize",
      "slash",
      "freeze",
      "owner",
      "transferOwnership",
      "pause",
    ];

    for (const fn of forbidden) {
      it(`has no ${fn}() function`, async function () {
        const found = backing.interface.fragments.filter(
          (f) => f.type === "function" && f.name === fn
        );
        expect(found, `${fn}() must not exist`).to.have.lengthOf(0);
      });
    }

    it("exposes no function that could move a backer's tokens", async function () {
      const suspicious = backing.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /sweep|rescue|seize|slash|freeze|reclaim|recover|drain|confiscate/i.test(f.name)
      );
      expect(suspicious.map((f) => f.name)).to.deep.equal([]);
    });

    it("only the curator can change status", async function () {
      const id = await openRequest();
      await expect(
        backing.connect(mallory).setStatus(id, Status.Queued)
      ).to.be.revertedWithCustomError(backing, "NotCurator");
    });

    it("changing status moves no tokens", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      const held = await token.balanceOf(await backing.getAddress());

      await backing.connect(curator).setStatus(id, Status.Queued);
      await backing.connect(curator).setStatus(id, Status.Delivered);

      expect(await token.balanceOf(await backing.getAddress())).to.equal(held);
      expect(await backing.lockedBy(id, alice.address)).to.equal(BONA(1000));
    });

    it("Delivered and Cancelled are final", async function () {
      const id = await openRequest();
      await backing.connect(curator).setStatus(id, Status.Delivered);
      await expect(
        backing.connect(curator).setStatus(id, Status.Open)
      ).to.be.revertedWithCustomError(backing, "AlreadyFinal");
    });

    it("rejects a no-op status change", async function () {
      const id = await openRequest();
      await expect(
        backing.connect(curator).setStatus(id, Status.Open)
      ).to.be.revertedWithCustomError(backing, "StatusUnchanged");
    });
  });

  describe("A closed request accepts no new backing", function () {
    it("rejects backing a Delivered request", async function () {
      const id = await openRequest();
      await backing.connect(curator).setStatus(id, Status.Delivered);
      await expect(
        backing.connect(alice).back(id, BONA(100))
      ).to.be.revertedWithCustomError(backing, "RequestClosed");
    });

    it("rejects backing a Cancelled request", async function () {
      const id = await openRequest();
      await backing.connect(curator).setStatus(id, Status.Cancelled);
      await expect(
        backing.connect(alice).back(id, BONA(100))
      ).to.be.revertedWithCustomError(backing, "RequestClosed");
    });

    it("still accepts backing while Queued", async function () {
      const id = await openRequest();
      await backing.connect(curator).setStatus(id, Status.Queued);
      await backing.connect(alice).back(id, BONA(100));
      expect(await backing.lockedBy(id, alice.address)).to.equal(BONA(100));
    });
  });

  describe("Backing several requests at once", function () {
    it("a member must split a finite balance between requests", async function () {
      const a = await openRequest();
      const b = await openRequest();

      await backing.connect(alice).back(a, BONA(600_000));
      await backing.connect(alice).back(b, BONA(400_000));

      expect(await backing.totalLockedBy(alice.address)).to.equal(BONA(1_000_000));
      expect(await token.balanceOf(alice.address)).to.equal(0n);

      // Nothing left to back a third request with.
      const c = await openRequest();
      await expect(backing.connect(alice).back(c, 1n)).to.be.reverted;
    });

    it("tracks each request separately", async function () {
      const a = await openRequest();
      const b = await openRequest();
      await backing.connect(alice).back(a, BONA(100));
      await backing.connect(alice).back(b, BONA(300));

      expect(await backing.lockedBy(a, alice.address)).to.equal(BONA(100));
      expect(await backing.lockedBy(b, alice.address)).to.equal(BONA(300));
      expect(await backing.totalLocked()).to.equal(BONA(400));
    });
  });

  describe("Snapshot voting weight", function () {
    it("backing does not cost a member their vote", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));

      expect(await backing.unclaimedOf(alice.address)).to.equal(BONA(1000));
      expect(
        (await token.balanceOf(alice.address)) + (await backing.unclaimedOf(alice.address))
      ).to.equal(BONA(1_000_000));
    });

    it("weight returns to the wallet on withdrawal", async function () {
      const id = await openRequest();
      await backing.connect(alice).back(id, BONA(1000));
      await backing.connect(alice).withdrawAll(id);

      expect(await backing.unclaimedOf(alice.address)).to.equal(0n);
      expect(await token.balanceOf(alice.address)).to.equal(BONA(1_000_000));
    });
  });

  describe("The quadratic ranking this contract feeds", function () {
    it("publishes the inputs: a hundred small backers beat one large one", async function () {
      // The score itself is computed off-chain, per member account. What the
      // contract must guarantee is that the inputs are complete and public.
      const many = await openRequest();
      const one = await openRequest();

      await backing.connect(alice).back(one, BONA(10_000));
      await backing.connect(bob).back(many, BONA(100));
      await backing.connect(carol).back(many, BONA(100));

      const [, , , manyTotal, manyBackers] = await backing.getRequest(many);
      const [, , , oneTotal, oneBackers] = await backing.getRequest(one);

      // Totals alone would rank `one` far above `many`...
      expect(oneTotal).to.be.greaterThan(manyTotal);
      // ...which is why the backer count is recorded too, and why the score
      // is (SUM sqrt(c))^2 rather than SUM c.
      expect(manyBackers).to.equal(2n);
      expect(oneBackers).to.equal(1n);
    });
  });
});
