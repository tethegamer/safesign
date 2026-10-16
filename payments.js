// SafeSign Pro payments via Solana Pay (no private keys: we only READ the public chain).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bs58 = require('bs58');
const QRCode = require('qrcode');

const RECIPIENT = process.env.SOL_RECIPIENT || 'E4gJZ7k2eZDHNxZMWdnXu5XytwpkcYbeLzXXkKMMS8Qv';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PRICE_USD = Number(process.env.PRO_PRICE_USD || 9);
const RPC_URL = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const LICENSE_DAYS = 30;
const CHECKOUT_TTL_MS = 60 * 60 * 1000; // a checkout (and its SOL quote) is valid 1h
const DATA_FILE = process.env.LICENSE_FILE || path.join(__dirname, 'data', 'licenses.json');

// ---------- local JSON store ----------
function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { checkouts: {}, licenses: {}, usedSignatures: {} }; }
}
let db = load();
function save() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
}

// ---------- RPC ----------
async function rpc(method, params, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await rpcOnce(method, params); }
    catch (e) { if (i >= tries - 1 || !/429|5\d\d|fetch failed/.test(e.message)) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
  }
}
async function rpcOnce(method, params) {
  const r = await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`RPC ${j.error.message}`);
  return j.result;
}

// ---------- live SOL price (CoinGecko, fallback Binance) ----------
let priceCache = null;
async function solPriceUsd() {
  if (priceCache && Date.now() - priceCache.t < 60000) return priceCache.p;
  const sources = [
    async () => (await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).json()).solana.usd,
    async () => Number((await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT')).json()).price),
    async () => Number((await (await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot')).json()).data.amount),
  ];
  for (const s of sources) { try { const p = await s(); if (p > 0) { priceCache = { p, t: Date.now() }; return p; } } catch {} }
  throw new Error('SOL price unavailable');
}

// ---------- pure verification (unit-testable) ----------
// tx = getTransaction(..., {encoding:'jsonParsed'}) result. Returns {ok, reason, received}.
function verifyTransaction(tx, { recipient, reference, currency, minAmount }) {
  if (!tx) return { ok: false, reason: 'transaction not found' };
  if (tx.meta?.err) return { ok: false, reason: 'transaction failed on-chain' };
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey));
  if (reference && !keys.includes(reference)) return { ok: false, reason: 'reference key not in transaction' };
  if (currency === 'USDC') {
    // decimals 6; sum balance change of all USDC accounts owned by recipient
    const sum = list => (list || []).filter(b => b.mint === USDC_MINT && b.owner === recipient)
      .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const delta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    const need = BigInt(Math.round(minAmount * 1e6));
    const received = Number(delta) / 1e6;
    return delta >= need ? { ok: true, received } : { ok: false, reason: `recipient received ${received} USDC, need ${minAmount}`, received };
  }
  if (currency === 'SOL') {
    const i = keys.indexOf(recipient);
    if (i < 0) return { ok: false, reason: 'recipient not in transaction' };
    const delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    const need = BigInt(Math.round(minAmount * 1e9));
    const received = Number(delta) / 1e9;
    return delta >= need ? { ok: true, received } : { ok: false, reason: `recipient received ${received} SOL, need ${minAmount}`, received };
  }
  return { ok: false, reason: 'unknown currency' };
}

function payUrl({ currency, amount, reference }) {
  const q = { amount: String(amount), ...(currency === 'USDC' ? { 'spl-token': USDC_MINT } : {}), reference, label: 'SafeSign', message: 'SafeSign Pro - 30 days', memo: 'safesign-pro' };
  return `solana:${RECIPIENT}?` + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

async function createCheckout() {
  const solUsd = await solPriceUsd().catch(() => null);
  const options = [];
  const mk = async (currency, amount) => {
    const reference = bs58.encode(crypto.randomBytes(32)); // unique per option
    const url = payUrl({ currency, amount, reference });
    options.push({ currency, amount, reference, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 260 }) });
  };
  await mk('USDC', PRICE_USD);
  if (solUsd) await mk('SOL', Math.ceil((PRICE_USD / solUsd) * 1e6) / 1e6);
  const id = crypto.randomBytes(12).toString('hex');
  db.checkouts[id] = { id, created: Date.now(), solUsd, status: 'pending', options: options.map(({ qr, ...o }) => o) };
  save();
  return { id, recipient: RECIPIENT, priceUsd: PRICE_USD, solUsd, expiresAt: Date.now() + CHECKOUT_TTL_MS, options };
}

function issueLicense(checkout, sig, opt, received) {
  const key = 'SSPRO-' + crypto.randomBytes(16).toString('hex').toUpperCase();
  const lic = { key, expiresAt: Date.now() + LICENSE_DAYS * 864e5, issuedAt: Date.now(), checkout: checkout.id, signature: sig, currency: opt.currency, amount: received };
  db.licenses[key] = lic; db.usedSignatures[sig] = key;
  checkout.status = 'paid'; checkout.license = key; save();
  return lic;
}

let rpcCall = rpc; // swappable for tests
async function checkCheckout(id) {
  const c = db.checkouts[id];
  if (!c) return { status: 'unknown' };
  if (c.status === 'paid') return { status: 'paid', license: db.licenses[c.license] };
  for (const opt of c.options) {
    const sigs = await rpcCall('getSignaturesForAddress', [opt.reference, { limit: 10, commitment: 'confirmed' }]);
    for (const s of sigs) {
      if (s.err || db.usedSignatures[s.signature]) continue;
      // SOL quote only honored for txs within the checkout window
      if (opt.currency === 'SOL' && s.blockTime && s.blockTime * 1000 > c.created + CHECKOUT_TTL_MS) continue;
      const tx = await rpcCall('getTransaction', [s.signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);
      const v = verifyTransaction(tx, { recipient: RECIPIENT, reference: opt.reference, currency: opt.currency, minAmount: opt.amount });
      if (v.ok) return { status: 'paid', license: issueLicense(c, s.signature, opt, v.received) };
      c.lastError = v.reason;
    }
  }
  const expired = Date.now() > c.created + CHECKOUT_TTL_MS * 24; // still watch late USDC payments for 24h
  return { status: expired ? 'expired' : 'pending', lastError: c.lastError };
}

function validLicense(key) {
  const l = key && db.licenses[key];
  return l && l.expiresAt > Date.now() ? l : null;
}

function _testHooks() { return { setRpc: f => { rpcCall = f; }, db: () => db, save }; }
module.exports = { _testHooks, createCheckout, checkCheckout, validLicense, verifyTransaction, rpc, RECIPIENT, USDC_MINT };
