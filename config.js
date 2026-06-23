/**
 * Configuration file for Bullone.ai Campaign Automation Bot
 * Updated for Campaign Season 1 (discord=verified)
 * - Bullink Core testnet (chainId 10688)
 * - https://www.bullone.ai/campaign?discord=verified
 *
 * Source: reverse-engineered from bullone.ai frontend JS chunks
 */

module.exports = {
  // --- Network Configuration ---
  RPC_URL: "https://core-testnet-rpc.bullink.com", // Bullink Core testnet RPC
  CHAIN_ID: 10688,                                  // Bullink Core Chain testnet ID
  EXPLORER_URL: "https://www.bullscan.info",        // Bullink Core testnet block explorer

  // --- Bullink Ecosystem ---
  // Bullink uses 3 chains: Core, Spot, Pay. Core is the base L1 (chainId 10688).
  // Spot and Pay are derived account-spaces accessed via bridge, not separate RPCs.
  SPOT_CHAIN_ID: 10699, // Bullink Spot exchange chain id (from NEXT_PUBLIC_DEX_CHAIN_ID)
  PAY_CHAIN_ID: 10711,  // Bullink Pay chain id (from docs.bullink.com Networks page)

  // --- Campaign API Configuration ---
  API_BASE_URL: "https://www.bullone.ai",           // Bullone frontend (also serves API routes)
  REFERRAL_CODE: "verified",                        // Discord verified campaign referral code

  // --- Contract Addresses (Bullink Core testnet / Campaign S1) ---
  CONTRACT_ADDRESSES: {
    // Native BULL is the base token — represented as 0xffff...ffff in the exchange
    tBULL_TOKEN: "0xffffffffffffffffffffffffffffffffffffffff",

    // Confirmed from frontend NEXT_PUBLIC env
    tUSDT_TOKEN: "0x103E4B36bcaC55dfeD2Ba8c8eCF36daBfC75E1f7", // tUSDT token (decimals 6)
    BRIDGE_CONTRACT: "0x0000000000000000000000000000000000001003", // Core Bridge (depositTo / depositTokenTo)
    NFT_CONTRACT: "0x45BE09FDB5B14591dF8B0b64B057cDF3cEC98101", // Campaign S1 Testnet NFT (mint / hasMinted)

    // Bullone Spot is off-chain. Trades go through dex-ui-api.bullink.com gateway.
    // There is NO on-chain AMM router for standard swapExact*.
    // For any on-chain “trade-like” activity, use bridge deposit to Spot instead.
    DEX_ROUTER: "0x0000000000000000000000000000000000000000",   // no-op / placeholder for AMM tasks

    // Confirmed from precompile table (docs.bullink.com CoreChain Precompile Addresses)
    STAKING_CONTRACT: "0x0000000000000000000000000000000000001000", // Core Staking precompile

    // PAYEE_REGISTRY: Not in public docs. Payee state is accessed via PayChain JSON-RPC (pay_getPayee, etc.)
    // If a Core EVM contract exists, it hasn't been published yet. Leave placeholder and skip or ask Bullink team.
    PAYEE_REGISTRY: "0x5555555555555555555555555555555555555555",  // Merchant/Payee system contract (unknown)

    // Faucet addresses
    FAUCET_tBULL: "0xffffffffffffffffffffffffffffffffffffffff",   // Native BULL — no separate faucet contract confirmed
    FAUCET_tUSDT: "0x103E4B36bcaC55dfeD2Ba8c8eCF36daBfC75E1f7", // tUSDT faucet is the token contract itself
    FAUCET_ETH: "0xFEEeD497F44b8E7C4D70FA9dABB2CB548b13Dd2f",  // tETH token contract (from docs)
  },

  // --- DEX / Gateway configs (off-chain) ---
  DEX_EXCHANGE_API_BASE_URL: "https://dex-ui-api.bullink.com",
  DEX_GATEWAY_ID: 1, // from NEXT_PUBLIC_DEX_GATEWAY_ID

  // --- Sepolia bridge (optional, if campaign supports cross-chain bridge) ---
  SEPOLIA_RPC_URL: "https://rpc.sepolia.org",
  SEPOLIA_CHAIN_ID: 11155111,
  SEPOLIA_BRIDGE_CONTRACTS: {
    tUSD: "0x510de08d4b3388ec81aa116324c9aca2c8c757bb",
    tETH: "0xe4352dcc13531d256824f5b1c8cc8f517a432144"
  },

  // --- Auth ---
  // Bullone uses wallet nonce flow:
  //   POST /api/auth/wallet/nonce      body: { walletAddress }
  //   POST /api/auth/wallet/verify     body: { challengeId, signature }
  //   GET  /api/auth/session           -> current session state

  // --- Contract ABIs (Standard Interfaces for EVM Interactions) ---
  ABIs: {
    // Standard ERC20 Interface
    ERC20: [
      "function balanceOf(address owner) view returns (uint256)",
      "function transfer(address to, uint256 value) returns (bool)",
      "function approve(address spender, uint256 value) returns (bool)",
      "function allowance(address owner, address spender) view returns (uint256)"
    ],

    // Uniswap V2 Style Router (for Trade task) — Bullone Spot does NOT use this on-chain.
    // Kept here for backwards compatibility; actual trades are off-chain via Spot DEX gateway.
    DEX_ROUTER: [
      "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] memory amounts)",
      "function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] memory amounts)",
      "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] memory amounts)",
      "function getAmountsOut(uint amountIn, address[] path) view returns (uint[] memory amounts)"
    ],

    // Payee Registry / Merchant System
    PAYEE_REGISTRY: [
      "function createPayee(string name, address payoutAddress) returns (bool)",
      "function pay(address payeeAddress, uint256 amount) payable returns (bool)",
      "function batchPay(address[] payeeAddresses, uint256[] amounts) payable returns (bool)",
      "function withdrawPayee() returns (bool)",
      "function refundPayee(bytes32 txId, uint256 amount) returns (bool)",
      "function payeeBalance(address payeeAddress) view returns (uint256)"
    ],

    // Staking / Delegation Interface
    STAKING: [
      "function delegate(address validator) payable returns (bool)",
      "function undelegate(address validator, uint256 amount) returns (bool)",
      "function claimRewards(address validator) returns (bool)",
      "function getPendingRewards(address delegator, address validator) view returns (uint256)"
    ],

    // Bridge Contract Interface (actual ABI from frontend JS)
    BRIDGE: [
      "function depositTokenTo(address token, address to, uint256 amount, uint64 targetChainId)",
      "function depositTo(address to, uint64 targetChainId)"
    ],

    // NFT Mint Contract (Standard ERC721 / commemorative NFT)
    NFT: [
      "function mint() public returns (uint256)",
      "function mintNFT() public returns (uint256)",
      "function balanceOf(address owner) view returns (uint256)",
      "function hasMinted(address user) view returns (bool)"
    ],

    // Faucet Contracts
    FAUCET: [
      "function claim() public returns (bool)",
      "function requestTokens() public returns (bool)",
      "function request() public returns (bool)"
    ]
  }
};
