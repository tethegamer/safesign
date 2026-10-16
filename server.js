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

const { scanToken, getJSON, safe, isEvm, isSol, EVM_CHAINS } = require('./scanner');

app.post('/api/scan-token', rateLimit, async (req, res) => {
  const address = String(req.body?.address || '').trim();
  const chainId = req.body?.chainId ? Number(req.body.chainId) : null;
  try {
    if (!isEvm(address) && !isSol(address)) { refund(req, res); return res.status(400).json({ error: 'That does not look like a Solana or EVM (0x…) token address.', remaining: res.locals.remaining }); }
    res.json({ ...(await scanToken(address, chainId)), remaining: res.locals.remaining });
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
