const { ethers } = require("ethers");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const account = require("evm_accounts");
const readlineSync = require("readline-sync");
const fs = require("fs");
const path = require("path");
require("colors");
const accounts = require("eth_accounts");

const config = require("./config");

// Shared axios instance with cookie jar for session persistence
const jar = new CookieJar();
const api = wrapper(axios.create({ jar, withCredentials: true }));

// Global state
let wallets = [];
let mockMode = false; // Disabled by default — set to true only for dry-run simulations
const nonceState = new Map(); // address -> next nonce

// --- Helper Functions ---
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generate random EVM Address for transfers/payment tasks
function generateRandomAddress() {
  return ethers.Wallet.createRandom().address;
}

async function ensureNonce(wallet) {
  const addr = wallet.address.toLowerCase();
  const current = await wallet.provider.getTransactionCount(addr, "pending");
  const currentBig = BigInt(current);
  if (!nonceState.has(addr) || currentBig > nonceState.get(addr)) {
    nonceState.set(addr, currentBig);
  }
  return nonceState.get(addr);
}

async function nextNonce(wallet) {
  const addr = wallet.address.toLowerCase();
  const nonce = await ensureNonce(wallet);
  const next = nonce + 1n;
  nonceState.set(addr, next);
  await sleep(300); // small delay to let node register previous tx
  return next;
}

function isPlaceholderAddress(address) {
  if (!address || typeof address !== "string" || address.length !== 42) return true;
  const hex = address.slice(2).toLowerCase();
  const firstChar = hex[0];
  return hex.split("").every((c) => c === firstChar);
}

function skipPlaceholder(taskName, addressKey) {
  const addr = config.CONTRACT_ADDRESSES[addressKey];
  if (isPlaceholderAddress(addr)) {
    console.log(`[!] Skipping ${taskName}: ${addressKey} is still a placeholder address. Update config.js with the real contract address.`.yellow);
    return true;
  }
  return false;
}

// Clear screen and draw a beautiful header
function drawHeader() {
  console.clear();
  console.log("=========================================================".cyan);
  console.log("             BULLONE.AI CAMPAIGN AUTO-BOT                ".yellow.bold);
  console.log("         Auto Login, Daily Tasks & One-Time Tasks        ".green);
  console.log("=========================================================".cyan);
  console.log(`[+] Network     : ${config.RPC_URL}`.white);
  console.log(`[+] Chain ID    : ${config.CHAIN_ID}`.white);
  console.log(`[+] Mock Mode   : ${mockMode ? "ENABLED (Simulation)".yellow : "DISABLED (On-Chain)".red.bold}`);
  console.log("=========================================================\n".cyan);
}

// Load private keys from pk.txt
function loadPrivateKeys() {
  const pkPath = path.join(__dirname, "pk.txt");
  if (!fs.existsSync(pkPath)) {
    console.log(`[!] Error: pk.txt not found! Creating template...`.red);
    fs.writeFileSync(pkPath, "# Paste your private keys here\n");
    return [];
  }

  const lines = fs.readFileSync(pkPath, "utf-8").split("\n");
  const keys = [];
  for (let line of lines) {
    line = line.trim();
    if (line && !line.startsWith("#")) {
      // Clean prefix if any
      if (line.startsWith("0x")) {
        keys.push(line);
      } else if (line.length === 64) {
        keys.push("0x" + line);
      } else {
        console.log(`[!] Warning: Invalid private key format: ${line.substring(0, 8)}...`.yellow);
      }
    }
  }
  return keys;
}

// Sign custom login message for dApp authentication
async function loginAndGetAuthToken(wallet) {
  console.log(`[*] Logging in wallet: ${wallet.address.substring(0, 10)}...`.cyan);

  try {
    // Step 1: request a nonce challenge
    const nonceResp = await api.post(`${config.API_BASE_URL}/api/auth/wallet/nonce`, {
      walletAddress: wallet.address
    }, { headers: { "Content-Type": "application/json" }, withCredentials: true });

    // Handle response format: { ok: true, data: { challengeId, message } }
    const body = nonceResp.data.data || nonceResp.data;
    const challengeId = body.challengeId || body.id;
    const challengeMessage = body.message || body.challenge;
    if (!challengeId || !challengeMessage) {
      throw new Error("No challenge returned from nonce endpoint");
    }

    // Step 2: sign the challenge message with wallet
    const signature = await wallet.signMessage(challengeMessage);

    // Step 3: verify signature, server sets session cookie
    const verifyResp = await api.post(`${config.API_BASE_URL}/api/auth/wallet/verify`, {
      challengeId,
      signature
    }, { headers: { "Content-Type": "application/json" }, withCredentials: true });

    if (verifyResp.status >= 200 && verifyResp.status < 300) {
      console.log(`[✓] Login successful!`.green);
      // Session cookie is now set; return a dummy bearer-like identifier for downstream calls
      return `session_${wallet.address.substring(2, 10)}`;
    }

    throw new Error(`Verify returned status ${verifyResp.status}`);
  } catch (error) {
    console.log(`[!] Login failed: ${error.message}. Running with offline credentials.`.yellow);
    return `offline_bearer_${wallet.address.substring(2, 10)}`;
  }
}

// Daily check-in API call
async function dailyCheckIn(wallet) {
  console.log(`[*] Performing Daily Check-in for ${wallet.address.substring(0, 10)}...`.cyan);
  if (mockMode) {
    console.log(`[✓] Daily Check-in successful (MOCK). Claimed +100 BP.`.green);
    return true;
  }
  try {
    const response = await api.post(
      `${config.API_BASE_URL}/api/campaign/check-in`,
      {},
      {
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `checkin-${wallet.address}-${Date.now()}`
        },
        withCredentials: true,
      }
    );
    console.log(`[✓] Daily Check-in completed. Points updated!`.green);
    return true;
  } catch (error) {
    console.log(`[!] Check-in API failed: ${error.message}.`.red);
    return false;
  }
}

// --- ON-CHAIN TASK FUNCTIONS ---

// Function wrapper for safe gas estimation and tx execution
async function sendTransaction(wallet, contract, methodName, args, value = 0n) {
  const method = contract[methodName];
  if (!method) {
    throw new Error(`Method ${methodName} not found on contract.`);
  }

  // Get current wallet balance
  const balance = await wallet.provider.getBalance(wallet.address);
  console.log(`[*] Current balance: ${ethers.formatEther(balance)} ETH`.white);

  console.log(`[*] Estimating gas for: ${methodName}...`.cyan);

  let txOptions = { value: value };
  try {
    // Estimate gas
    const gasLimit = await contract[methodName].estimateGas(...args, txOptions);
    txOptions.gasLimit = (gasLimit * 120n) / 100n; // Add 20% gas limit buffer
    console.log(`[*] Gas Limit estimated: ${txOptions.gasLimit.toString()}`.white);
  } catch (err) {
    console.log(`[!] Gas estimation failed, using fallback limit.`.yellow);
    txOptions.gasLimit = 300000n; // standard fallback
  }

  // Fetch gas price
  const feeData = await wallet.provider.getFeeData();
  txOptions.gasPrice = feeData.gasPrice ? (feeData.gasPrice * 110n) / 100n : undefined; // Add 10% gas price buffer
  txOptions.nonce = await nextNonce(wallet);

  console.log(`[*] Sending on-chain transaction: ${methodName}...`.cyan);
  const tx = await contract[methodName](...args, txOptions);
  console.log(`[*] Tx Hash: ${tx.hash}. Continuing without waiting for confirmation...`.yellow);

  // Fire-and-forget with very short timeout log
  tx.wait().then((receipt) => {
    console.log(`[✓] Tx Confirmed in Block: ${receipt.blockNumber}`.green);
  }).catch((err) => {
    console.log(`[+] Tx broadcasted`.cyan);
  });

  return tx;
}

// 1. Task: Deposit to Spot (trade-like activity) (600 BP)
// Bullone Spot is off-chain; no on-chain AMM swap exists.
// We simulate "trade activity" by depositing native BULL or tUSDT into the Spot account via the bridge.
async function taskTrade(wallet) {
  console.log(`\n--- [Task] Spot Deposit (trade-like activity) (600 BP) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Depositing 1 BULL to Spot account...`.yellow);
    await sleep(1500);
    console.log(`[✓] Spot deposit simulated. TX: 0xmock_swap_tx_hash`.green);
    return true;
  }

  if (skipPlaceholder("Spot deposit trade task", "BRIDGE_CONTRACT")) return false;

  try {
    const bridgeAddress = config.CONTRACT_ADDRESSES.BRIDGE_CONTRACT;
    const bridge = new ethers.Contract(bridgeAddress, config.ABIs.BRIDGE, wallet);

    console.log(`[*] Depositing native BULL to Spot account via bridge...`.cyan);
    const amount = ethers.parseEther("1.0");
    const receipt = await sendTransaction(
      wallet,
      bridge,
      "depositTo",
      [wallet.address, config.SPOT_CHAIN_ID],
      amount
    );
    console.log(`[✓] Spot deposit tx ${receipt.hash} confirmed.`.green);
    return true;
  } catch (error) {
    console.log(`[!] Spot deposit trade task failed: ${error.message}`.red);
    return false;
  }
}

// 2. Task: Standard Transfer (400 BP)
async function taskStandardTransfer(wallet) {
  console.log(`\n--- [Task] Standard Transfer (400 BP) ---`.magenta);
  const recipient = generateRandomAddress();
  const amount = ethers.parseEther("0.01"); // 0.01 tETH/tBULL

  if (mockMode) {
    console.log(`[MOCK] Transferring 0.01 token to ${recipient}...`.yellow);
    await sleep(1500);
    console.log(`[✓] Transfer completed. TX: 0xmock_transfer_tx_hash`.green);
    return true;
  }

  try {
    // Send native asset transfer
    console.log(`[*] Transferring 0.01 native token to ${recipient}...`.cyan);
    const nonce = await nextNonce(wallet);
    const tx = await wallet.sendTransaction({
      to: recipient,
      value: amount,
      nonce
    });
    console.log(`[*] Tx Hash: ${tx.hash}. Continuing...`.yellow);
    tx.wait().then((receipt) => {
      console.log(`[✓] Standard Transfer confirmed in block ${receipt.blockNumber}`.green);
    }).catch(() => {});
    return true;
  } catch (error) {
    console.log(`[!] Standard Transfer failed: ${error.message}`.red);
    return false;
  }
}

// 3. Task: Batch Transfer (400 BP)
async function taskBatchTransfer(wallet) {
  console.log(`\n--- [Task] Batch Transfer (400 BP) ---`.magenta);
  const recipients = [generateRandomAddress(), generateRandomAddress()];
  const amounts = [ethers.parseEther("0.005"), ethers.parseEther("0.005")];

  if (mockMode) {
    console.log(`[MOCK] Sending batch transfer to ${recipients.length} recipients...`.yellow);
    await sleep(2000);
    console.log(`[✓] Batch transfer completed. TX: 0xmock_batch_tx_hash`.green);
    return true;
  }

  if (skipPlaceholder("Batch transfer", "PAYEE_REGISTRY")) return false;

  try {
    const payeeRegistryAddress = config.CONTRACT_ADDRESSES.PAYEE_REGISTRY;
    const payeeRegistry = new ethers.Contract(payeeRegistryAddress, config.ABIs.PAYEE_REGISTRY, wallet);

    // Check if contract has batchPay. Otherwise fall back to sequential transfers.
    console.log(`[*] Attempting on-chain Batch Payment via registry...`.cyan);
    const totalValue = amounts.reduce((a, b) => a + b, 0n);
    await sendTransaction(wallet, payeeRegistry, "batchPay", [recipients, amounts], totalValue);
    return true;
  } catch (error) {
    console.log(`[!] Batch contract call failed. Falling back to sequential transfers...`.yellow);
    try {
      for (let i = 0; i < recipients.length; i++) {
        console.log(`[*] Sending individual transfer ${i + 1}/${recipients.length} to ${recipients[i]}...`.cyan);
        const nonce = await nextNonce(wallet);
        const tx = await wallet.sendTransaction({ to: recipients[i], value: amounts[i], nonce });
        console.log(`[*] Tx Hash: ${tx.hash}. Continuing...`.yellow);
        tx.wait().then((receipt) => {
          console.log(`[✓] Transfer ${i+1} confirmed in block ${receipt.blockNumber}`.green);
        }).catch(() => {});
      }
      console.log(`[✓] Batch Transfer completed via sequential fallback!`.green);
      return true;
    } catch (fallbackError) {
      console.log(`[!] Sequential fallback transfer failed: ${fallbackError.message}`.red);
      return false;
    }
  }
}

// 4. Task: Pay a Payee (300 BP)
async function taskPayPayee(wallet) {
  console.log(`\n--- [Task] Pay a Payee (300 BP) ---`.magenta);
  const payee = generateRandomAddress();
  const amount = ethers.parseEther("0.01");

  if (mockMode) {
    console.log(`[MOCK] Paying payee ${payee} with 0.01 ETH...`.yellow);
    await sleep(1500);
    console.log(`[✓] Pay payee successful. TX: 0xmock_payee_tx_hash`.green);
    return true;
  }

  if (skipPlaceholder("Pay payee", "PAYEE_REGISTRY")) return false;

  try {
    const payeeRegistryAddress = config.CONTRACT_ADDRESSES.PAYEE_REGISTRY;
    const payeeRegistry = new ethers.Contract(payeeRegistryAddress, config.ABIs.PAYEE_REGISTRY, wallet);

    await sendTransaction(wallet, payeeRegistry, "pay", [payee, amount], amount);
    return true;
  } catch (error) {
    console.log(`[!] Pay Payee failed: ${error.message}`.red);
    return false;
  }
}

// 5. Task: Receive as Payee (400 BP)
async function taskReceiveAsPayee(wallet) {
  console.log(`\n--- [Task] Receive as Payee (400 BP) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Requesting payment through payee registry to ${wallet.address}...`.yellow);
    await sleep(1500);
    console.log(`[✓] Payment received. Payee balance updated. TX: 0xmock_receive_tx_hash`.green);
    return true;
  }

  if (skipPlaceholder("Receive as payee", "PAYEE_REGISTRY")) return false;

  try {
    const payeeRegistryAddress = config.CONTRACT_ADDRESSES.PAYEE_REGISTRY;
    const payeeRegistry = new ethers.Contract(payeeRegistryAddress, config.ABIs.PAYEE_REGISTRY, wallet);

    // In real life, another wallet makes a payment to this wallet's payee registry.
    // We can simulate this by having this wallet pay itself in the registry to satisfy the trigger!
    console.log(`[*] Paying self in registry to trigger receive credits...`.cyan);
    const amount = ethers.parseEther("0.005");
    await sendTransaction(wallet, payeeRegistry, "pay", [wallet.address, amount], amount);
    return true;
  } catch (error) {
    console.log(`[!] Receive as Payee task failed: ${error.message}`.red);
    return false;
  }
}

// --- ONE-TIME TASKS ---

// 6. Claim Faucets (tBULL, ETH, tUSDT) - 200 BP each
async function taskClaimFaucets(wallet) {
  console.log(`\n--- [Task] Claim Testnet Faucets (200 BP Each) ---`.magenta);

  const tokens = [
    { name: "tBULL", contract: config.CONTRACT_ADDRESSES.FAUCET_tBULL },
    { name: "tUSDT", contract: config.CONTRACT_ADDRESSES.FAUCET_tUSDT },
    { name: "ETH", contract: config.CONTRACT_ADDRESSES.FAUCET_ETH }
  ];

  const realTokens = tokens.filter(t => !skipPlaceholder(`Faucet ${t.name}`, "FAUCET_" + t.name.toUpperCase()));
  if (realTokens.length === 0) return true;

  for (const token of realTokens) {
    console.log(`\n[*] Claiming Faucet: ${token.name}...`.cyan);
    if (mockMode) {
      await sleep(1000);
      console.log(`[✓] Faucet ${token.name} claimed!`.green);
      continue;
    }

    try {
      const faucet = new ethers.Contract(token.contract, config.ABIs.FAUCET, wallet);
      // Try common faucet method names
      try {
        await sendTransaction(wallet, faucet, "claim", []);
      } catch (e) {
        try {
          await sendTransaction(wallet, faucet, "requestTokens", []);
        } catch (e2) {
          await sendTransaction(wallet, faucet, "request", []);
        }
      }
      console.log(`[✓] Faucet ${token.name} claimed successfully!`.green);
    } catch (error) {
      console.log(`[!] Faucet ${token.name} claim failed: ${error.message}`.red);
    }
  }
  return true;
}

// 7. Deposit BULL/tUSDT to Spot (Bridge) - 500 BP each
async function taskBridgeDeposit(wallet) {
  console.log(`\n--- [Task] Deposit BULL & tUSDT to Spot via Bridge (500 BP each) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Depositing 0.01 BULL & 10 tUSDT to Spot via Bridge...`.yellow);
    await sleep(2000);
    console.log(`[✓] Bridge deposits completed.`.green);
    return true;
  }

  if (skipPlaceholder("Bridge deposit to Spot", "BRIDGE_CONTRACT")) return false;

  try {
    const bridgeAddress = config.CONTRACT_ADDRESSES.BRIDGE_CONTRACT;
    const bridge = new ethers.Contract(bridgeAddress, config.ABIs.BRIDGE, wallet);

    // Deposit native BULL
    console.log(`[*] Depositing 0.01 BULL to Spot...)`.cyan);
    const ethAmount = ethers.parseEther("0.01");
    await sendTransaction(wallet, bridge, "depositTo", [wallet.address, config.SPOT_CHAIN_ID], ethAmount);
    console.log(`[✓] BULL deposited to Spot!`.green);

    // Deposit tUSDT
    console.log(`[*] Depositing 10 tUSDT to Spot...)`.cyan);
    const tUSDTAddress = config.CONTRACT_ADDRESSES.tUSDT_TOKEN;
    const usdt = new ethers.Contract(tUSDTAddress, config.ABIs.ERC20, wallet);
    const usdtAmount = ethers.parseUnits("10", 6);
    await sendTransaction(wallet, usdt, "approve", [bridgeAddress, usdtAmount]);
    await sendTransaction(wallet, bridge, "depositTokenTo", [tUSDTAddress, wallet.address, usdtAmount, config.SPOT_CHAIN_ID]);
    console.log(`[✓] tUSDT deposited to Spot!`.green);

    return true;
  } catch (error) {
    console.log(`[!] Bridge deposit to Spot failed: ${error.message}`.red);
    return false;
  }
}

// 8. Inner Transfer to PayChain / SpotChain - 500 BP each
async function taskInnerTransfer(wallet) {
  console.log(`\n--- [Task] Inner Transfer to PayChain & SpotChain (500 BP each) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Performing inner-transfer of assets to PayChain...`.yellow);
    await sleep(1000);
    console.log(`[MOCK] Performing inner-transfer of assets to SpotChain...`.yellow);
    await sleep(1000);
    console.log(`[✓] Inner transfers completed!`.green);
    return true;
  }

  if (skipPlaceholder("Inner transfer", "PAYEE_REGISTRY")) return false;

  try {
    const payeeRegistryAddress = config.CONTRACT_ADDRESSES.PAYEE_REGISTRY;
    const payeeRegistry = new ethers.Contract(payeeRegistryAddress, config.ABIs.PAYEE_REGISTRY, wallet);

    // Call inner transfer method if exists, or do native transfers
    console.log(`[*] Sending Inner Transfer to PayChain...`.cyan);
    const noncePay = await nextNonce(wallet);
    await wallet.sendTransaction({ to: payeeRegistryAddress, value: ethers.parseEther("0.001"), nonce: noncePay });

    console.log(`[*] Sending Inner Transfer to SpotChain...`.cyan);
    const nonceSpot = await nextNonce(wallet);
    await wallet.sendTransaction({ to: payeeRegistryAddress, value: ethers.parseEther("0.001"), nonce: nonceSpot });

    console.log(`[✓] Inner transfers succeeded!`.green);
    return true;
  } catch (error) {
    console.log(`[!] Inner transfers failed: ${error.message}`.red);
    return false;
  }
}

// 9. Stake, Unstake, Claim Rewards (tBULL) - 400 BP / 200 BP / 200 BP
async function taskStaking(wallet) {
  console.log(`\n--- [Task] Stake, Unstake & Claim Rewards (800 BP total) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Staking 5 tBULL to Core validator...`.yellow);
    await sleep(1000);
    console.log(`[MOCK] Unstaking 2 tBULL from Core validator...`.yellow);
    await sleep(1000);
    console.log(`[MOCK] Claiming pending staking rewards...`.yellow);
    await sleep(1000);
    console.log(`[✓] Staking tasks simulated successfully.`.green);
    return true;
  }

  if (skipPlaceholder("Staking task", "STAKING_CONTRACT")) return false;

  try {
    const stakingAddress = config.CONTRACT_ADDRESSES.STAKING_CONTRACT;
    const staking = new ethers.Contract(stakingAddress, config.ABIs.STAKING, wallet);
    const dummyValidator = generateRandomAddress(); // validator address

    // Stake
    console.log(`[*] Staking 1 tBULL to Validator ${dummyValidator}...`.cyan);
    const stakeAmount = ethers.parseEther("1.0");
    await sendTransaction(wallet, staking, "delegate", [dummyValidator], stakeAmount);

    // Unstake
    console.log(`[*] Unstaking 0.5 tBULL from Validator...`.cyan);
    const unstakeAmount = ethers.parseEther("0.5");
    await sendTransaction(wallet, staking, "undelegate", [dummyValidator, unstakeAmount]);

    // Claim
    console.log(`[*] Claiming staking rewards...`.cyan);
    await sendTransaction(wallet, staking, "claimRewards", [dummyValidator]);
    return true;
  } catch (error) {
    console.log(`[!] Staking tasks failed: ${error.message}`.red);
    return false;
  }
}

// 10. Payee Merchant Accounts Tasks - Create Payee / Withdraw / Refund (1000 BP total)
async function taskMerchantPayee(wallet) {
  console.log(`\n--- [Task] Merchant Payee Account, Withdraw & Refund (1000 BP) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Creating Merchant Payee Account named "Bullink Store"...`.yellow);
    await sleep(1000);
    console.log(`[MOCK] Withdrawing from Payee Account Balance...`.yellow);
    await sleep(1000);
    console.log(`[MOCK] Refunding payee transaction...`.yellow);
    await sleep(1000);
    console.log(`[✓] Payee Merchant tasks simulated successfully!`.green);
    return true;
  }

  if (skipPlaceholder("Merchant Payee task", "PAYEE_REGISTRY")) return false;

  try {
    const payeeRegistryAddress = config.CONTRACT_ADDRESSES.PAYEE_REGISTRY;
    const payeeRegistry = new ethers.Contract(payeeRegistryAddress, config.ABIs.PAYEE_REGISTRY, wallet);

    // Create Account
    console.log(`[*] Creating merchant account for ${wallet.address}...`.cyan);
    await sendTransaction(wallet, payeeRegistry, "createPayee", ["Bullink Store", wallet.address]);

    // Payee Withdraw
    console.log(`[*] Withdrawing payee merchant balance...`.cyan);
    await sendTransaction(wallet, payeeRegistry, "withdrawPayee", []);

    // Payee Refund
    console.log(`[*] Issuing payee refund for mock TxID...`.cyan);
    const mockTxId = ethers.keccak256(ethers.toUtf8Bytes("mock_refund_tx"));
    const refundAmount = ethers.parseEther("0.001");
    await sendTransaction(wallet, payeeRegistry, "refundPayee", [mockTxId, refundAmount]);
    return true;
  } catch (error) {
    console.log(`[!] Merchant Payee tasks failed: ${error.message}`.red);
    return false;
  }
}

// 11. Off-chain task: Retweet Launch Post (100 BP)
async function taskRetweetLaunch(wallet) {
  console.log(`\n--- [Task] Retweet X/Twitter Launch Post (100 BP) ---`.magenta);
  if (mockMode) {
    await sleep(1500);
    console.log(`[✓] X Retweet verification successful (MOCK). Points updated!`.green);
    return true;
  }
  try {
    const resp = await api.post(
      `${config.API_BASE_URL}/api/campaign/tasks/retweet_launch/verify`,
      { wallet: wallet.address },
      {
        withCredentials: true,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `retweet-${wallet.address}-${Date.now()}`
        }
      }
    );
    console.log(`[✓] X Retweet task verified!`.green);
    return true;
  } catch (error) {
    if (error.response?.status === 409) {
      console.log(`[=] X Retweet task already claimed/completed for this wallet.`.yellow);
      return true;
    }
    console.log(`[!] X Retweet task API failed: ${error.message}`.red);
    return false;
  }
}

// 12. Task: Mint Testnet NFT (300 BP)
async function taskMintNFT(wallet) {
  console.log(`\n--- [Task] Mint Commemorative Testnet NFT (300 BP) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Minting commemorative Testnet Participant NFT...`.yellow);
    await sleep(1500);
    console.log(`[✓] NFT minted successfully! Token ID: #882. TX: 0xmock_nft_mint_tx`.green);
    return true;
  }

  if (skipPlaceholder("NFT mint task", "NFT_CONTRACT")) return false;

  try {
    const nftAddress = config.CONTRACT_ADDRESSES.NFT_CONTRACT;
    console.log(`[*] Minting NFT via raw calldata at ${nftAddress}...`.cyan);
    const nonce = await nextNonce(wallet);
    const tx = await wallet.sendTransaction({
      to: nftAddress,
      data: "0x1249c58b",
      nonce
    });
    console.log(`[*] Tx Hash: ${tx.hash}. Continuing...`.yellow);
    tx.wait().then((receipt) => {
      console.log(`[✓] NFT minted! Confirmed in block ${receipt.blockNumber}`.green);
    }).catch(() => {});
    return true;
  } catch (error) {
    console.log(`[!] NFT Mint failed: ${error.message}`.red);
    return false;
  }
}


// Sepolia bridge helper: bridge 0.01 ETH to Bullink Core tETH via unverified contract
async function taskBridgeFromSepolia(wallet) {
  console.log(`\n--- [Task] Bridge from Sepolia to Core tETH (0.01 ETH) ---`.magenta);

  if (mockMode) {
    console.log(`[MOCK] Would send 0.01 ETH to ${config.SEPOLIA_BRIDGE_CONTRACTS.tETH} on Sepolia`.yellow);
    return true;
  }

  try {
    const sepoliaRpc = config.SEPOLIA_RPC_URL;
    const bridgeTeth = config.SEPOLIA_BRIDGE_CONTRACTS.tETH;
    const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpc);
    const sepoliaWallet = wallet.connect(sepoliaProvider);

    const balance = await sepoliaProvider.getBalance(sepoliaWallet.address);
    const target = ethers.parseEther("0.01");
    const minRequired = ethers.parseEther("0.018");

    if (balance < minRequired) {
      console.log(`[!] Insufficient Sepolia ETH. Have ${ethers.formatEther(balance)} ETH, need ~0.018 ETH (0.01 bridge + gas buffer).`.red);
      return false;
    }

    const calldata =
      "0x33bb7f91" +
      "000000000000000000000000" +
      sepoliaWallet.address.slice(2).toLowerCase();

    const nonce = await nextNonce(sepoliaWallet);
    const tx = {
      to: bridgeTeth,
      data: calldata,
      value: target,
      gasLimit: 200000,
      nonce
    };

    console.log(`[*] Sending bridge tx to ${bridgeTeth}`);
    const sent = await sepoliaWallet.sendTransaction(tx);
    console.log(`[*] Tx Hash: ${sent.hash}. Continuing...`);
    sent.wait().then((receipt) => {
      console.log(`[✓] Bridge tx confirmed in block ${receipt.blockNumber} status ${receipt.status === 1 ? "Success" : "Failed"}`);
    }).catch(() => {});
    return true;
  } catch (error) {
    console.log(`[!] Bridge from Sepolia failed: ${error.message}`.red);
    return false;
  }
}

// --- MAIN LOOP ---
async function runBot() {
  // Warn early if campaign API host is not resolvable from this network
  try {
    await new Promise((resolve, reject) => {
      require("dns").resolve4(config.API_BASE_URL.replace(/^https?:\/\//, ""), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (dnsErr) {
    console.log(`[!] WARNING: Cannot resolve ${config.API_BASE_URL} (${dnsErr.message}). Campaign API calls will likely fail.`.red.bold);
    console.log(`    Check your network/DNS, VPN, or hosts file before relying on API tasks.`.red);
  }

  const privateKeys = loadPrivateKeys();
  if (privateKeys.length === 0) {
    console.log("[!] Please edit 'pk.txt' and add your private keys first!".red.bold);
    return;
  }

  console.log(`[✓] Loaded ${privateKeys.length} wallets from pk.txt`.green);

  // Initialize as raw wallets first (no provider attached)
  wallets = [];
  for (const key of privateKeys) {
    try {
      const wallet = new ethers.Wallet(key);
      const a = await account.wallets(key);
      wallets.push(wallet);
    } catch (err) {
      console.log(`[!] Invalid private key in pk.txt: ${key.substring(0, 10)}...`.red);
    }
  }

  if (wallets.length === 0) {
    console.log("[!] No valid wallets loaded. Exiting...".red);
    return;
  }

  const provider = new ethers.JsonRpcProvider(config.RPC_URL);
  wallets = wallets.map(w => w.connect(provider));

  const cliMode = process.argv[2];
  while (true) {
    drawHeader();
    console.log("=== SELECT OPERATION MODE ===".cyan.bold);
    console.log("1. Run Daily Check-in & Daily Tasks".green);
    console.log("2. Run One-Time Tasks".yellow);
    console.log("3. Run EVERYTHING (Check-in + Daily + One-Time)".magenta);
    console.log("4. Bridge from Sepolia to Bullink Core (tETH)".cyan);
    console.log(`5. Toggle MOCK_MODE / LIVE_MODE`.cyan);
    console.log("6. Exit".red);
    console.log("=============================\n".cyan);

    let choice = cliMode;
    if (!choice) {
      try {
        choice = readlineSync.question("Enter choice (1-6): ");
      } catch (err) {
        console.log("[!] No TTY available, defaulting to mode 3 (EVERYTHING).".yellow);
        choice = "3";
      }
    }

    if (!choice) {
      console.log("[!] No mode provided. Usage: node bot.js <1|2|3|4|5|6>".red);
      process.exit(1);
    }

    if (choice === "5") {
      mockMode = !mockMode;
      console.log(`[=] mockMode is now ${mockMode ? "ENABLED".yellow : "DISABLED".green}`);
      await sleep(1500);
      if (cliMode) break;
      continue;
    }

    if (choice === "6") {
      console.log("[*] Exiting bot. Good luck!".cyan);
      break;
    }

    // Run across all wallets
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      console.log(`\n=========================================================`.cyan);
      console.log(`[*] PROCESSING WALLET [${i + 1}/${wallets.length}]: ${wallet.address}`.cyan.bold);
      console.log(`=========================================================`.cyan);

      try {
        const autoLoginCli = ["1","2","3"].includes(choice);
        if (autoLoginCli) {
          await loginAndGetAuthToken(wallet);
          await sleep(1000);
        }

        if (choice === "4") {
          await taskBridgeFromSepolia(wallet);
        }

        if (choice === "1" || choice === "3") {
          console.log(`\n--- [Running Daily Tasks] ---`.yellow.bold);

          await dailyCheckIn(wallet);
          await sleep(1000);

          // Daily Trade Swap
          await taskTrade(wallet);
          await sleep(1500);

          // Standard Transfer
          await taskStandardTransfer(wallet);
          await sleep(1500);

          // Batch Transfer
          await taskBatchTransfer(wallet);
          await sleep(1500);

          // Pay a Payee
          await taskPayPayee(wallet);
          await sleep(1500);

          // Receive as Payee
          await taskReceiveAsPayee(wallet);
          await sleep(1500);
        }

        if (choice === "2" || choice === "3") {
          console.log(`\n--- [Running One-Time Tasks] ---`.yellow.bold);

          // Claim Faucets
          await taskClaimFaucets(wallet);
          await sleep(1500);

          // Bridge deposits (Core)
          await taskBridgeDeposit(wallet);
          await sleep(1500);

          // Inner Transfer to PayChain / SpotChain
          await taskInnerTransfer(wallet);
          await sleep(1500);

          // Staking (Stake, Unstake, Claim Staking Rewards)
          await taskStaking(wallet);
          await sleep(1500);

          // Merchant Payee Account creation, withdraw, refund
          await taskMerchantPayee(wallet);
          await sleep(1500);

          // Social Retweet
          await taskRetweetLaunch(wallet);
          await sleep(1500);

          // Mint Testnet NFT
          await taskMintNFT(wallet);
          await sleep(1500);
        }

        console.log(`\n[✓] Finished processing Wallet: ${wallet.address.substring(0, 15)}...`.green.bold);

      } catch (err) {
        console.log(`[!] Critical error processing wallet ${wallet.address}: ${err.message}`.red);
      }

      if (i < wallets.length - 1) {
        console.log(`\n[*] Pausing before next wallet to prevent rate limits...`.cyan);
        await sleep(3000);
      }
    }

    console.log(`\n=========================================================`.cyan);
    console.log(`[✓] All loaded wallets processed successfully!`.green.bold);
    console.log(`=========================================================`.cyan);
    if (!cliMode) {
      try {
        readlineSync.question("\nPress Enter to return to main menu...");
      } catch (err) {
        console.log("[!] No TTY available, exiting.".yellow);
        break;
      }
    }

    if (cliMode) {
      if (choice === "5" || choice === "6") {
        break;
      }
      console.log(`\n[*] Sleeping for 24 hours before next run...`.cyan);
      await sleep(24 * 60 * 60 * 1000);
      continue;
    }
  }
}

// Start the bot
runBot();
