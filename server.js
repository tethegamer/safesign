// SafeSign backend: Express server + API proxy to free public security APIs.
const express = require('express');
const path = require('path');

const pay = require('./payments');
const app = express();
const PORT = process.env.PORT || 3000;
const FREE_SCANS_PER_DAY = Number(process.env.FREE_SCANS_PER_DAY || 5);
app.set('trust proxy', true); // so req.ip works behind Render/Railway proxies
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Simple in-memory per-IP daily rate limit ----------
const usage = new Map(); // ip -> { day, count }
const today = () => new Date().toISOString().slice(0, 10);
function rateLimit(req, res, next) {
  if (pay.validLicense(req.get('x-license-key'))) { res.locals.remaining = 'unlimited'; return next(); }
  const ip = req.ip || 'unknown';
  const d = today();
  let u = usage.get(ip);
  if (!u || u.day !== d) { u = { day: d, count: 0 }; usage.set(ip, u); }
  if (u.count >= FREE_SCANS_PER_DAY) {
    return res.status(429).json({ error: `Free limit reached (${FREE_SCANS_PER_DAY} scans/day). Upgrade to Pro for unlimited scans, or come back tomorrow (resets 00:00 UTC).`, remaining: 0 });
  }
  u.count++;
  res.locals.remaining = FREE_SCANS_PER_DAY - u.count;
  next();
}
// Don't charge a scan for invalid input
function refund(req, res) { if (res.locals.remaining === 'unlimited') return; const u = usage.get(req.ip || 'unknown'); if (u && u.count > 0) u.count--; res.locals.remaining++; }
app.get('/api/usage', (req, res) => {
  const u = usage.get(req.ip);
  const used = u && u.day === today() ? u.count : 0;
  res.json({ limit: FREE_SCANS_PER_DAY, used, remaining: Math.max(0, FREE_SCANS_PER_DAY - used) });
});

// ---------- Helpers ----------
async function getJSON(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json', 'user-agent': 'SafeSign/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function safe(name, fn, errors) {
  try { return await fn(); } catch (e) { errors.push(`${name} unavailable (${e.name === 'AbortError' ? 'timeout' : e.message})`); return null; }
}
const isEvm = a => /^0x[a-fA-F0-9]{40}$/.test(a);
const isSol = a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const pct = x => `${(x).toFixed(1)}%`;
const usd = n => n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const EVM_CHAINS = { 1: 'Ethereum', 56: 'BNB Chain', 8453: 'Base', 42161: 'Arbitrum', 137: 'Polygon', 10: 'Optimism', 43114: 'Avalanche' };

// DexScreener: works for any chain; returns best pair info
async function dexscreener(address) {
  const d = await getJSON(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  const pairs = (d.pairs || []).filter(p => p.baseToken && p.baseToken.address.toLowerCase() === address.toLowerCase());
  const all = pairs.length ? pairs : (d.pairs || []);
  if (!all.length) return { found: false };
  all.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = all[0];
  return {
    found: true, chainId: top.chainId, name: top.baseToken?.name, symbol: top.baseToken?.symbol,
    priceUsd: top.priceUsd, liquidityUsd: all.reduce((s, p) => s + (p.liquidity?.usd || 0), 0),
    volume24h: all.reduce((s, p) => s + (p.volume?.h24 || 0), 0), fdv: top.fdv, pairs: all.length,
    pairCreatedAt: Math.min(...all.map(p => p.pairCreatedAt || Infinity)), url: top.url,
  };
}

// flag helper: level = danger | warn | ok | info ; weight adds to risk score
function flag(list, level, title, detail, weight = 0) { list.push({ level, title, detail, weight }); }

function liquidityFlags(flags, dex) {
  if (!dex) return;
  if (!dex.found) return flag(flags, 'danger', 'No trading pairs found', 'DexScreener has no liquidity pool for this token. You may not be able to sell it.', 25);
  const L = dex.liquidityUsd;
  if (L < 10000) flag(flags, 'danger', 'Very low liquidity', `Only ${usd(L)} of liquidity. Even small sells can crash the price, and it is easy to manipulate.`, 20);
  else if (L < 100000) flag(flags, 'warn', 'Low liquidity', `${usd(L)} liquidity. Large trades will move the price a lot.`, 8);
  else flag(flags, 'ok', 'Healthy liquidity', `${usd(L)} in liquidity across ${dex.pairs} pool(s).`);
  if (isFinite(dex.pairCreatedAt)) {
    const days = (Date.now() - dex.pairCreatedAt) / 864e5;
    if (days < 3) flag(flags, 'warn', 'Brand-new token', `First pool created ${days < 1 ? 'less than a day' : Math.floor(days) + ' days'} ago. Most rug pulls happen in the first days.`, 10);
  }
}

// ---------- Solana token scan ----------
async function scanSolana(address) {
  const errors = [], flags = [];
  const [rc, dex] = await Promise.all([
    safe('RugCheck', () => getJSON(`https://api.rugcheck.xyz/v1/tokens/${address}/report`, 30000), errors),
    safe('DexScreener', () => dexscreener(address), errors),
  ]);
  let name = dex?.name, symbol = dex?.symbol;
  if (rc) {
    name = name || rc.tokenMeta?.name; symbol = symbol || rc.tokenMeta?.symbol;
    if (rc.mintAuthority) flag(flags, 'danger', 'Mint authority is active', 'The creator can print unlimited new tokens at any time, diluting your holdings to zero.', 25);
    else flag(flags, 'ok', 'Mint authority revoked', 'No one can create new tokens. Supply is fixed.');
    if (rc.freezeAuthority) flag(flags, 'danger', 'Freeze authority is active', 'The creator can freeze your tokens so you cannot sell or transfer them.', 25);
    else flag(flags, 'ok', 'Freeze authority revoked', 'No one can freeze your tokens.');
    const holders = (rc.topHolders || []).filter(h => !h.insider || true);
    const top10 = holders.slice(0, 10).reduce((s, h) => s + (h.pct || 0), 0);
    if (holders.length) {
      if (top10 > 50) flag(flags, 'danger', 'Top holders own most of the supply', `Top 10 wallets hold ${pct(top10)} (may include exchange/pool wallets). A few wallets could dump on you.`, 15);
      else if (top10 > 30) flag(flags, 'warn', 'Concentrated holdings', `Top 10 wallets hold ${pct(top10)} of supply.`, 7);
      else flag(flags, 'ok', 'Holdings well distributed', `Top 10 wallets hold ${pct(top10)} of supply.`);
    }
    const lp = (rc.markets || []).map(m => m.lp?.lpLockedPct).filter(x => typeof x === 'number');
    if (lp.length) {
      const best = Math.max(...lp);
      if (best < 50) flag(flags, 'warn', 'Liquidity mostly unlocked', `Best pool has only ${pct(best)} of liquidity locked/burned. Unlocked liquidity can be pulled ("rug pull"). Note: large established tokens often have unlocked LP from many providers.`, 8);
      else flag(flags, 'ok', 'Liquidity locked', `${pct(best)} of liquidity is locked or burned in the main pool.`);
    }
    if (rc.rugged) flag(flags, 'danger', 'Marked as RUGGED', 'RugCheck has flagged this token as already rug-pulled.', 50);
    for (const r of rc.risks || []) {
      if (/mint authority|freeze authority|top 10|single holder|liquidity/i.test(r.name)) continue; // already covered
      flag(flags, r.level === 'danger' ? 'danger' : 'warn', r.name, r.description || '', r.level === 'danger' ? 12 : 4);
    }
  }
  const gp = await safe('GoPlus (Solana)', () => getJSON(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`), errors);
  const g = gp?.result?.[address];
  if (g) {
    if (g.transfer_fee && Object.keys(g.transfer_fee).length && g.transfer_fee.current_fee_rate)
      flag(flags, 'warn', 'Transfer fee', 'This token charges a fee on every transfer.', 8);
    if (g.non_transferable === '1') flag(flags, 'danger', 'Non-transferable', 'Tokens cannot be transferred — likely a scam.', 30);
  }
  liquidityFlags(flags, dex);
  if (!rc && !dex) throw new Error('All data sources failed. Please try again in a minute.');
  return { chain: 'Solana', name, symbol, dex, flags, errors };
}

// ---------- EVM token scan ----------
async function scanEvm(address, chainId) {
  const errors = [], flags = [];
  const dex = await safe('DexScreener', () => dexscreener(address), errors);
  const dsMap = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137, optimism: 10, avalanche: 43114 };
  const chain = chainId || (dex?.found && dsMap[dex.chainId]) || 1;
  const gp = await safe('GoPlus', () => getJSON(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${address}`), errors);
  const g = gp?.result?.[address.toLowerCase()];
  if (g) {
    const yes = k => g[k] === '1';
    if (yes('is_honeypot')) flag(flags, 'danger', 'HONEYPOT', 'You can buy this token but you will NOT be able to sell it.', 60);
    else if (g.is_honeypot === '0') flag(flags, 'ok', 'Not a honeypot', 'Simulated sells succeed.');
    if (yes('cannot_sell_all')) flag(flags, 'danger', 'Cannot sell all tokens', 'The contract prevents selling your full balance.', 20);
    const bt = Number(g.buy_tax || 0) * 100, st = Number(g.sell_tax || 0) * 100;
    if (bt > 10 || st > 10) flag(flags, 'danger', 'High trading tax', `Buy tax ${pct(bt)}, sell tax ${pct(st)}. You lose that much on every trade.`, 20);
    else if (bt > 0 || st > 0) flag(flags, 'warn', 'Trading tax', `Buy tax ${pct(bt)}, sell tax ${pct(st)}.`, 5);
    if (yes('is_mintable')) flag(flags, 'warn', 'Mintable', 'The owner can create new tokens, which can dilute holders.', 12);
    if (yes('hidden_owner')) flag(flags, 'danger', 'Hidden owner', 'The contract has a hidden owner who keeps control.', 20);
    if (yes('can_take_back_ownership')) flag(flags, 'danger', 'Ownership can be reclaimed', 'Even if ownership looks renounced, it can be taken back.', 20);
    if (yes('owner_change_balance')) flag(flags, 'danger', 'Owner can change balances', 'The owner can edit anyone’s balance — including setting yours to zero.', 30);
    if (yes('transfer_pausable')) flag(flags, 'warn', 'Transfers can be paused', 'The owner can freeze all trading.', 10);
    if (yes('is_blacklisted')) flag(flags, 'warn', 'Blacklist function', 'The owner can block specific wallets from selling.', 10);
    if (yes('slippage_modifiable')) flag(flags, 'warn', 'Tax can be changed', 'The owner can raise the tax at any time (even to 100%).', 12);
    if (yes('is_proxy')) flag(flags, 'warn', 'Upgradeable contract', 'The contract code can be replaced by the owner.', 6);
    if (g.is_open_source === '0') flag(flags, 'danger', 'Source code not verified', 'Nobody can review what this contract does.', 15);
    if (yes('selfdestruct')) flag(flags, 'danger', 'Self-destruct', 'The contract can destroy itself.', 20);
    const holders = (g.holders || []).filter(h => h.is_contract !== 1 || !h.is_locked);
    const top10 = holders.slice(0, 10).reduce((s, h) => s + Number(h.percent || 0) * 100, 0);
    if (holders.length) {
      if (top10 > 50) flag(flags, 'danger', 'Top holders own most of the supply', `Top 10 wallets hold ${pct(top10)} (may include exchange/pool wallets).`, 12);
      else if (top10 > 30) flag(flags, 'warn', 'Concentrated holdings', `Top 10 wallets hold ${pct(top10)}.`, 6);
      else flag(flags, 'ok', 'Holdings well distributed', `Top 10 wallets hold ${pct(top10)}.`);
    }
    const lph = g.lp_holders || [];
    if (lph.length) {
      const locked = lph.filter(h => h.is_locked === 1 || /0x0{36}dead$|^0x0{40}$/i.test(h.address)).reduce((s, h) => s + Number(h.percent || 0) * 100, 0);
      if (locked >= 50) flag(flags, 'ok', 'Liquidity locked', `${pct(locked)} of LP tokens are locked or burned.`);
      else flag(flags, 'warn', 'Liquidity mostly unlocked', `Only ${pct(locked)} of LP tokens are locked/burned; liquidity could be removed.`, 8);
    }
    if (yes('is_in_dex') === false && g.is_in_dex === '0') flag(flags, 'warn', 'Not listed on a DEX', 'GoPlus found no DEX listing.', 10);
  } else if (gp) {
    errors.push('GoPlus had no data for this token on ' + (EVM_CHAINS[chain] || chain));
  }
  liquidityFlags(flags, dex);
  if (!g && !dex) throw new Error('All data sources failed. Please try again in a minute.');
  return { chain: EVM_CHAINS[chain] || `Chain ${chain}`, name: dex?.name || g?.token_name, symbol: dex?.symbol || g?.token_symbol, dex, flags, errors };
}

function finalize(r) {
  const score = Math.min(100, r.flags.reduce((s, f) => s + f.weight, 0));
  const level = score >= 50 ? 'High risk' : score >= 20 ? 'Medium risk' : 'Low risk';
  const summary = score >= 50 ? 'Serious red flags found. We would avoid this token.'
    : score >= 20 ? 'Some warning signs. Only trade with money you can afford to lose.'
    : 'No major red flags found. That does not guarantee it is safe — always do your own research.';
  r.flags.sort((a, b) => ({ danger: 0, warn: 1, info: 2, ok: 3 }[a.level] - { danger: 0, warn: 1, info: 2, ok: 3 }[b.level]));
  return { ...r, riskScore: score, riskLevel: level, summary };
}

app.post('/api/scan-token', rateLimit, async (req, res) => {
  const address = String(req.body?.address || '').trim();
  const chainId = req.body?.chainId ? Number(req.body.chainId) : null;
  try {
    let r;
    if (isEvm(address)) r = await scanEvm(address, chainId);
    else if (isSol(address)) r = await scanSolana(address);
    else { refund(req, res); return res.status(400).json({ error: 'That does not look like a Solana or EVM (0x…) token address.', remaining: res.locals.remaining }); }
    res.json({ address, ...finalize(r), remaining: res.locals.remaining });
  } catch (e) {
    res.status(502).json({ error: e.message, remaining: res.locals.remaining });
  }
});

// ---------- Wallet approvals ----------
app.post('/api/approvals', rateLimit, async (req, res) => {
  const address = String(req.body?.address || '').trim();
  if (!isEvm(address)) { refund(req, res); return res.status(400).json({ error: 'Enter an EVM wallet address starting with 0x (40 hex characters). ENS names are not supported yet.', remaining: res.locals.remaining }); }
  const errors = [], approvals = [];
  const APPROVAL_CHAINS = Object.fromEntries(Object.entries(EVM_CHAINS).filter(([id]) => !['10','43114'].includes(id))); // GoPlus approvals API does not support OP/AVAX
  await Promise.all(Object.entries(APPROVAL_CHAINS).map(async ([id, chainName]) => {
    const d = await safe(`GoPlus approvals (${chainName})`, () => getJSON(`https://api.gopluslabs.io/api/v2/token_approval_security/${id}?addresses=${address}`), errors);
    if (!d) return;
    if (d.code !== 1) { errors.push(`GoPlus ${chainName}: ${d.message}`); return; }
    for (const t of d.result || []) for (const a of t.approved_list || []) {
      const info = a.address_info || {};
      const unlimited = /unlimited/i.test(String(a.approved_amount));
      const reasons = []; let risk = 0;
      if (info.doubt_list || (info.malicious_behavior || []).length) { risk += 3; reasons.push('Spender is flagged as suspicious/malicious — revoke now.'); }
      if (t.malicious_address || (t.malicious_behavior || []).length) { risk += 3; reasons.push('This token itself is flagged as malicious (often a scam airdrop). Do not interact with it; revoke the approval.'); }
      if (unlimited) { risk += 1; reasons.push('Unlimited approval: this contract can take ALL of this token from your wallet, now or in future.'); }
      if (!info.is_open_source) { risk += 1; reasons.push('Spender contract is not open source, so its behavior cannot be verified.'); }
      if (info.is_contract === 0) { risk += 1; reasons.push('Spender is a regular wallet, not a contract — unusual and often a scam sign.'); }
      if (info.trust_list) reasons.push('Spender is on GoPlus trusted list.');
      const ageDays = a.approved_time ? (Date.now() / 1000 - a.approved_time) / 86400 : null;
      if (ageDays && ageDays > 365) reasons.push(`Approval is ${Math.floor(ageDays / 365)}+ year(s) old — revoke if you no longer use this app.`);
      approvals.push({
        chain: chainName, chainId: Number(id), token: t.token_symbol || t.token_name || t.token_address, tokenAddress: t.token_address,
        spender: a.approved_contract, spenderName: info.contract_name || info.tag || null, amount: a.approved_amount,
        approvedAt: a.approved_time ? new Date(a.approved_time * 1000).toISOString().slice(0, 10) : null,
        riskLevel: risk >= 3 ? 'danger' : risk >= 1 ? 'warn' : 'ok', reasons,
      });
    }
  }));
  approvals.sort((a, b) => ({ danger: 0, warn: 1, ok: 2 }[a.riskLevel] - { danger: 0, warn: 1, ok: 2 }[b.riskLevel]));
  if (errors.length === Object.keys(APPROVAL_CHAINS).length) return res.status(502).json({ error: 'Approval data source (GoPlus) is unavailable. Please try again shortly.', remaining: res.locals.remaining });
  res.json({ address, chainsChecked: Object.values(APPROVAL_CHAINS), approvals, revokeUrl: `https://revoke.cash/address/${address}`, errors, remaining: res.locals.remaining });
});

// ---------- Pro payments (Solana Pay) ----------
app.post('/api/checkout', async (req, res) => {
  try { res.json(await pay.createCheckout()); } catch (e) { res.status(502).json({ error: 'Could not create checkout: ' + e.message }); }
});
app.get('/api/checkout/:id', async (req, res) => {
  try { res.json(await pay.checkCheckout(req.params.id)); } catch (e) { res.json({ status: 'pending', lastError: 'RPC: ' + e.message }); }
});
app.get('/api/license/:key', (req, res) => {
  const l = pay.validLicense(req.params.key);
  res.json(l ? { valid: true, expiresAt: l.expiresAt } : { valid: false });
});

app.listen(PORT, () => console.log(`SafeSign running at http://localhost:${PORT}`));
