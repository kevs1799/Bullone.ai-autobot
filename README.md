# 🤖 Bullone.ai Campaign Automation Bot (CommonJS)

Multi-wallet Node.js automation bot for completing daily and one-time tasks on the Bullone.ai / Bullink Core testnet campaign.

---

## ✨ Features
- 🔑 **Multi-Wallet Support**: Process multiple accounts automatically from `pk.txt`.
- 🔐 **Auto Login**: Automatic wallet-signature authentication via Bullone API (nonce / verify / session cookie flow).
- 📅 **Daily Tasks**:
  1. **Spot Deposit** (trade-like activity) — deposit native BULL to Spot via bridge.
  2. **Standard Transfer** — send native asset to a random address.
  3. **Batch Transfer** — batchPay via registry or sequential fallback.
  4. **Pay a Payee** — pay a merchant/payee account.
  5. **Receive as Payee** — trigger receive credits by self-pay in registry.
- 🏆 **One-Time Tasks**:
  - Claim testnet faucets (ETH / tUSDT / tBULL).
  - Bridge deposits to Spot (BULL + tUSDT).
  - Inner transfers to PayChain / SpotChain.
  - Staking (stake, unstake, claim rewards).
  - Merchant Payee (create account, withdraw, refund).
  - X/Twitter retweet verification.
  - Mint commemorative testnet NFT.
- 🌉 **Sepolia Bridge**: Bridge 0.01 ETH from Sepolia to Bullink Core tETH using raw calldata against an unverified bridge contract.
- ⚙️ **Mock Mode Toggle**: Test flows without spending real tokens.
- 🛡️ **Smart Gas Buffer**: Auto gas limit (+20%) and gas price (+10%) buffers to prevent stuck txs.
- 🔁 **24-Hour Auto-Loop**: Run repeatedly every 24 hours when launched with CLI mode (non-interactive).

---

## 🛠️ Requirements
- [Node.js](https://nodejs.org/) >= 16
- npm

---

## 🚀 Installation & Usage

```bash
cd bullone-bot
npm install
```

### Configure wallets
Edit `pk.txt` and add your EVM private keys (one per line):

```text
0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890
```

### Run

```bash
# Interactive menu (requires TTY)
node bot.js

# Direct mode with 24-hour auto-loop (recommended for servers)
node bot.js 1   # Daily Check-in & Daily Tasks
node bot.js 2   # One-Time Tasks
node bot.js 3   # Everything
node bot.js 4   # Bridge from Sepolia to Core tETH
node bot.js 5   # Toggle Mock Mode
node bot.js 6   # Exit
```

**Server / nohup usage:**
```bash
nohup node bot.js 3 > bot.log 2>&1 &
```

The bot will run the selected mode once, then sleep for 24 hours and repeat automatically. Use mode `6` to stop the loop.

---

## 🎮 Menu Options
1. `Run Daily Check-in & Daily Tasks` — login + check-in API + 5 daily on-chain tasks.
2. `Run One-Time Tasks` — faucets, bridge, staking, merchant, retweet, NFT mint.
3. `Run EVERYTHING` — run daily + one-time tasks for all wallets.
4. `Bridge from Sepolia to Bullink Core (tETH)` — standalone Sepolia → Core bridge.
5. `Toggle MOCK_MODE / LIVE_MODE` — switch between simulation and real transactions.
6. `Exit` — quit.

---

## ⚠️ Security & Disclaimer
- Use throwaway wallets for testnet campaigns only. Never use a main wallet with real funds.
- Testnet contracts and API endpoints change frequently. Keep `config.js` and ABIs up to date.
- This bot is provided as-is. You are responsible for your own keys and transactions.
