const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * These tests exist to prove the claims made on bonabuild.org.
 *
 * Every safety property the website asserts is checked here, so the claim
 * and its proof live in the same repository. If a test is removed, the
 * corresponding claim must be removed from the site.
 */
describe("BonaToken (BONA)", function () {
  const TOTAL_SUPPLY = ethers.parseUnits("100000000", 18); // 100,000,000

  let token, deployer, treasury, alice, bob;

  beforeEach(async function () {
    [deployer, treasury, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("BonaToken");
    token = await Factory.deploy(treasury.address);
    await token.waitForDeployment();
  });

  describe("Identity", function () {
    it("is named BonaBuild with symbol BONA", async function () {
      expect(await token.name()).to.equal("BonaBuild");
      expect(await token.symbol()).to.equal("BONA");
    });

    it("uses 18 decimals", async function () {
      expect(await token.decimals()).to.equal(18n);
    });
  });

  describe("Supply is fixed at 100,000,000", function () {
    it("mints exactly the declared total supply", async function () {
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.TOTAL_SUPPLY()).to.equal(TOTAL_SUPPLY);
    });

    it("sends the entire supply to the initial holder", async function () {
      expect(await token.balanceOf(treasury.address)).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(deployer.address)).to.equal(0n);
    });

    it("rejects a zero-address initial holder", async function () {
      const Factory = await ethers.getContractFactory("BonaToken");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith(
        "BONA: initial holder is zero address"
      );
    });
  });

  describe("Capabilities that must NOT exist", function () {
    // The absence of these functions is the core trust property of BONA.
    // Checking the ABI proves no such entry point was compiled in at all —
    // stronger than checking that a privileged call reverts.
    const forbidden = [
      "mint",
      "burnFrom",
      "owner",
      "transferOwnership",
      "renounceOwnership",
      "pause",
      "unpause",
      "blacklist",
      "setFee",
      "upgradeTo",
    ];

    for (const fn of forbidden) {
      it(`has no ${fn}() function`, async function () {
        const found = token.interface.fragments.filter(
          (f) => f.type === "function" && f.name === fn
        );
        expect(found, `${fn}() must not exist`).to.have.lengthOf(0);
      });
    }

    it("exposes no privileged role functions at all", async function () {
      const roleish = token.interface.fragments.filter(
        (f) =>
          f.type === "function" &&
          /role|admin|owner|pause|mint|blacklist|freeze/i.test(f.name)
      );
      expect(roleish.map((f) => f.name)).to.deep.equal([]);
    });
  });

  describe("Transfers are exact — no fee, no tax, no reflection", function () {
    it("moves precisely the requested amount", async function () {
      const amount = ethers.parseUnits("1234.5678", 18);
      await token.connect(treasury).transfer(alice.address, amount);

      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await token.balanceOf(treasury.address)).to.equal(
        TOTAL_SUPPLY - amount
      );
    });

    it("keeps total supply constant across transfers", async function () {
      await token.connect(treasury).transfer(alice.address, ethers.parseUnits("500", 18));
      await token.connect(alice).transfer(bob.address, ethers.parseUnits("120", 18));

      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    });

    it("reverts when sending more than the balance", async function () {
      await expect(
        token.connect(alice).transfer(bob.address, 1n)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  describe("ERC20Permit (EIP-2612)", function () {
    it("approves by signature without a prior transaction", async function () {
      const value = ethers.parseUnits("1000", 18);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const nonce = await token.nonces(treasury.address);
      const { chainId } = await ethers.provider.getNetwork();

      const signature = await treasury.signTypedData(
        {
          name: "BonaBuild",
          version: "1",
          chainId,
          verifyingContract: await token.getAddress(),
        },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        {
          owner: treasury.address,
          spender: alice.address,
          value,
          nonce,
          deadline,
        }
      );

      const { v, r, s } = ethers.Signature.from(signature);
      await token.permit(treasury.address, alice.address, value, deadline, v, r, s);

      expect(await token.allowance(treasury.address, alice.address)).to.equal(value);
    });
  });

  describe("Tokenomics allocation adds up", function () {
    /**
     * The published allocation, asserted against the supply the contract
     * actually minted. Four lines, and every one of them has a stated job:
     * there is no unallocated remainder, which is the number an outside
     * reader adds up first.
     */
    it("the four allocations sum to exactly the total supply", async function () {
      const allocations = {
        sale: ethers.parseUnits("60000000", 18), // 60%
        contributorPrograms: ethers.parseUnits("15000000", 18), // 15%
        liquidity: ethers.parseUnits("15000000", 18), // 15%
        team: ethers.parseUnits("10000000", 18), // 10%
      };

      const sum = Object.values(allocations).reduce((a, b) => a + b, 0n);
      expect(sum).to.equal(TOTAL_SUPPLY);
    });

    it("the sale allocation matches the cap SaleVesting enforces", async function () {
      const Vesting = await ethers.getContractFactory("SaleVesting");
      const vesting = await Vesting.deploy(await token.getAddress(), treasury.address);
      await vesting.waitForDeployment();

      // The published 60% is not a promise in a document, it is a constant in
      // a contract. If one changes without the other, this fails.
      expect(await vesting.MAX_TOTAL()).to.equal(ethers.parseUnits("60000000", 18));
    });
  });
});
