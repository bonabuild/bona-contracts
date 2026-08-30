require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");

/**
 * BONA — Hardhat configuration
 *
 * Secrets come from environment variables and are never committed.
 * Set them before deploying:
 *
 *   $env:DEPLOYER_PRIVATE_KEY = "0x..."   # deployer key, funded with ETH on Base
 *   $env:BASESCAN_API_KEY     = "..."     # from basescan.org, for verification
 */

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY || "";

const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Base supports Cancun opcodes (Ecotone upgrade). OpenZeppelin v5
      // uses mcopy, which requires cancun — paris/shanghai will not compile.
      evmVersion: "cancun",
    },
  },

  networks: {
    // Base mainnet — real money.
    base: {
      url: process.env.BASE_RPC_URL || "https://mainnet.base.org",
      chainId: 8453,
      accounts,
    },

    // Base Sepolia testnet — free, use this first.
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
  },

  etherscan: {
    // Etherscan API V2: one key covers Base, Base Sepolia and 60+ EVM chains.
    // The old per-explorer keys and customChains blocks are deprecated.
    apiKey: BASESCAN_API_KEY,
  },
};
