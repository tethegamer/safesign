# 🛡️ SafeSign — crypto wallet safety checker

SafeSign checks crypto addresses **before you sign or buy**:

1. **Token risk scanner**: paste a Solana or EVM token address and get a 0–100 risk score with plain-English flags (mint/freeze authority, honeypot, taxes, holder concentration, locked liquidity, low liquidity, new token…).
2. **Wallet approvals checker**: paste an EVM wallet (0x…) to see which contracts can spend your tokens on Ethereum, BNB Chain, Base, Arbitrum and Polygon, with a one-click link to **revoke.cash**.
3. **Landing page + pricing**: Free (5 scans/day per IP) and Pro (9 USDC or the same value in SOL for 30 days, **real payments via Solana Pay** to the owner's wallet). See *Pro payments* below.

Data sources (free, no API keys needed): [RugCheck](https://rugcheck.xyz), [GoPlus Security](https://gopluslabs.io), [DexScreener](https://dexscreener.com).

---

## Part 1: Run it on your computer

### Step 1: Install Node.js
1. Go to <https://nodejs.org> and download the **LTS** version (v18 or newer).
2. Run the installer and keep the default options.
3. Open a terminal (Mac: **Terminal** app. Windows: **Command Prompt** or **PowerShell**) and type:
   ```bash
   node -v
   ```
   If it prints something like `v20.x.x`, Node is installed.

### Step 2: Download and unzip
1. Download `safesign.zip`.
2. Unzip it (double-click on Mac; on Windows, right-click → **Extract All**). You get a folder named `safesign`.

### Step 3: Open the folder in the terminal
```bash
cd path/to/safesign
```
Tip: type `cd ` (with a space), drag the folder into the terminal window, then press Enter.

### Step 4: Install dependencies
```bash
npm install
```
### Step 5: Start the app
```bash
npm start
```
You should see `SafeSign running at http://localhost:3000`.

### Step 6: Open it
Go to **http://localhost:3000** in your browser. Try:
- Token: `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK on Solana)
- Wallet: `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth)

To stop the server, press `Ctrl + C` in the terminal.

### Optional settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `FREE_SCANS_PER_DAY` | `5` | Free scans per IP per day |
| `SOL_RECIPIENT` | `E4gJZ7k2eZDHNxZMWdnXu5XytwpkcYbeLzXXkKMMS8Qv` | Wallet that receives Pro payments |
| `PRO_PRICE_USD` | `9` | Pro price (USDC amount; SOL amount is computed from it) |
| `SOLANA_RPC` | `https://api.mainnet-beta.solana.com` | Solana RPC used to verify payments (use a free Helius/QuickNode URL in production; the public one is rate-limited) |
| `LICENSE_FILE` | `data/licenses.json` | Where checkouts and license keys are stored |

Example: `FREE_SCANS_PER_DAY=20 npm start` (Mac/Linux).

---

## Part 2: Deploy for free on the internet

First put the code on GitHub:
1. Create a free account at <https://github.com>.
2. Click **New repository**, name it `safesign`, then click **Create**.
3. Click **uploading an existing file** and drag in every file from the `safesign` folder (not `node_modules`). Click **Commit changes**.

### Option A: Render
1. Sign up at <https://render.com> using GitHub.
2. Click **New + → Web Service** and choose your `safesign` repo.
3. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
4. Click **Create Web Service**. After a few minutes you get a URL like `https://safesign.onrender.com`.
   (Free Render services sleep when idle, so the first visit after a while can take about 30 seconds.)

### Option B: Railway
1. Sign up at <https://railway.app> using GitHub.
2. Click **New Project → Deploy from GitHub repo** and pick `safesign`.
3. Railway detects Node and runs `npm install` and `npm start` on its own.
4. Open the service, go to **Settings → Networking → Generate Domain** to get a public URL.
   (Railway gives you a trial credit. After that a small paid plan may be required.)

The app reads the `PORT` the host provides, so no changes are needed.

---

## Part 3: Next steps to make money (Stripe)

The Pro button is only a placeholder right now. To charge for real:
1. Create a Stripe account at <https://stripe.com>. Add a **Product** called "SafeSign Pro" with a **$9/month recurring price**.
2. Quickest option: create a **Payment Link** in Stripe and point the `#proBtn` button in `public/app.js` at it. Note that this collects money but does not unlock anything automatically.
3. Proper option:
   - `npm install stripe`. Add a `POST /api/checkout` route that creates a Checkout Session (`mode: 'subscription'`) and redirects to `session.url`.
   - Add a `/api/stripe-webhook` route that listens for `checkout.session.completed` and `customer.subscription.deleted`.
   - Store Pro users in a database (for example SQLite, Postgres, or Supabase) with an API key or a login (magic-link email).
   - In `rateLimit` in `server.js`, skip the limit for requests that carry a valid Pro key.
   - Keep `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in environment variables (in Render or Railway, under "Environment"). Never commit them.
4. Other ideas: email alerts when a new risky approval shows up, a watchlist, a Telegram bot, and a browser extension that warns before you sign.

---

## Project structure
```
safesign/
├── server.js        # Express server, rate limit, API logic
├── package.json
└── public/
    ├── index.html   # Landing page, scanners, pricing
    ├── style.css    # Dark, mobile-friendly UI
    └── app.js       # Frontend logic
```

## Limitations
- The rate limit is kept in memory. It resets when the server restarts and is per-IP only (shared IPs share a limit).
- The risk score is a simple weighted heuristic. It is **not financial advice**, and a low score does not guarantee a token is safe.
- Holder concentration can include exchange or liquidity-pool wallets, which makes big tokens look more concentrated than they are.
- Approvals cover 5 EVM chains through GoPlus. Solana delegations and ENS names are not supported yet.
- The free public APIs have their own rate limits. If one fails, SafeSign shows the results it got and says which source failed.


---

## Pro payments (Solana Pay)

**How it works**
1. User clicks **Upgrade to Pro**. The server creates a checkout with a fresh random **reference key** for each payment option:
   - **9 USDC** (mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, the official USDC on Solana)
   - **SOL** equal to $9 at the live price (CoinGecko, with Binance/Coinbase fallback). The quote is valid for 1 hour.
2. The page shows a Solana Pay QR code and a **Pay with Phantom** button (a `solana:` link that opens Phantom or any Solana wallet on mobile) for each option.
3. Every 5 seconds the browser asks the server, and the server checks the public Solana RPC: `getSignaturesForAddress(reference)`, then `getTransaction`. It accepts a payment only if the transaction succeeded, includes the reference key, and the recipient wallet's USDC (or SOL) balance went up by at least the quoted amount. Each transaction signature can only be used once.
4. Then the server issues a license key (`SSPRO-…`) valid for **30 days** and saves it in `data/licenses.json`. The browser keeps it in `localStorage` and sends it with each scan (`x-license-key` header), so scans become unlimited. Users can paste the key on another device under **Already have a license key?**.

**Security:** no private keys anywhere. The server only reads public blockchain data, and money goes straight from the buyer's wallet to the owner's wallet.

**Notes**
- `data/licenses.json` is the license database. Back it up. On Render/Railway free plans the disk resets on redeploy, so attach a persistent disk/volume, or licenses will be lost.
- The recipient wallet does not need a USDC account beforehand: Phantom creates one automatically, and the payer covers the small fee.
- No auto-renew: users pay again after 30 days.

**Tests:** `npm test` checks the verification logic against real historical mainnet transactions (a 6000 USDC transfer and a SOL transfer, saved in `test/fixtures` and re-fetched live when online). It covers: correct payment, underpayment, wrong recipient, missing reference, failed transaction, and that a signature can't be reused, plus the full checkout → license flow.
