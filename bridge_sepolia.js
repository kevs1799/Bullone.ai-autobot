const { ethers } = require("ethers");
const fs = require("fs");

const PRIVATE_KEY = fs.readFileSync("pk.txt", "utf8").trim();
const WALLET = new ethers.Wallet(PRIVATE_KEY);

// Sepolia config
const SEPOLIA_RPC = "https://rpc.sepolia.org";
const BRIDGE_TETH = "0xe4352dcc13531d256824f5b1c8cc8f517a432144";

// Calldata you provided: 0x33bb7f91...
const CALldata = "0x33bb7f910000000000000000000000009be7a4b801d945ec86b3e7ebc29c153e14d5e2c2";

async function main() {
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const wallet = WALLET.connect(provider);

  const balance = await provider.getBalance(wallet.address);
  console.log("Wallet:", wallet.address);
  console.log("Sepolia ETH:", ethers.formatEther(balance));

  if (balance < ethers.parseEther("0.01")) {
    console.log("[!] Insufficient Sepolia ETH. Need at least 0.01 ETH + gas (~0.005 ETH).");
    return;
  }

  const tx = {
    to: BRIDGE_TETH,
    data: CALldata,
    value: ethers.parseEther("0.01"),
    gasLimit: 200000
  };

  console.log("\nSending bridge tx...");
  const sent = await wallet.sendTransaction(tx);
  console.log("TX:", sent.hash);
  console.log("Waiting confirmation...");
  const receipt = await sent.wait();
  console.log("Block:", receipt.blockNumber);
  console.log("Status:", receipt.status === 1 ? "Success" : "Failed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
