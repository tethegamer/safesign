const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', {maximumFractionDigits: n < 1 ? 8 : 0});
const lic = () => { try { const l = JSON.parse(localStorage.getItem('safesignPro')); return l && l.expiresAt > Date.now() ? l : null; } catch { return null; } };
function setUsage(rem){ const l = lic(); if (l) $('#usage').textContent = `⭐ Pro: unlimited scans until ${new Date(l.expiresAt).toLocaleDateString()}`; else if (rem != null) $('#usage').textContent = `${rem} free scans left today`; }
fetch('/api/usage').then(r => r.json()).then(d => setUsage(d.remaining)).catch(() => {});

async function post(url, body){
  const r = await fetch(url, {method:'POST', headers:{'content-type':'application/json', 'x-license-key': lic()?.key || ''}, body: JSON.stringify(body)});
  let d; try { d = await r.json(); } catch { d = {error: 'Server returned an invalid response.'}; }
  setUsage(d.remaining);
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}
async function run(form, out, fn){
  const btn = form.querySelector('button'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Checking…'; out.innerHTML = '<p class="muted">Querying security APIs… (can take ~10s)</p>';
  try { out.innerHTML = await fn(); } catch (e) { out.innerHTML = `<p class="err">⚠️ ${esc(e.message)}</p>`; }
  btn.disabled = false; btn.textContent = label;
}
const notes = errs => (errs && errs.length) ? `<p class="note">Some sources had problems: ${errs.map(esc).join('; ')}</p>` : '';

$('#tokenForm').onsubmit = e => { e.preventDefault(); run(e.target, $('#tokenOut'), async () => {
  const d = await post('/api/scan-token', {address: $('#tokenAddr').value});
  const cls = d.riskScore >= 50 ? 'lvl-high' : d.riskScore >= 20 ? 'lvl-med' : 'lvl-low';
  const x = d.dex || {};
  return `<div class="result">
    <div class="scorebox"><div class="score ${cls}">${d.riskScore}<div class="small">/100</div></div>
      <div><b class="${cls}">${esc(d.riskLevel)}</b> — ${esc(d.name || 'Unknown token')} ${d.symbol ? '(' + esc(d.symbol) + ')' : ''} on ${esc(d.chain)}<br><span class="muted">${esc(d.summary)}</span></div></div>
    ${x.found ? `<div class="meta"><div><span>Price</span>${money(x.priceUsd)}</div><div><span>Liquidity</span>${money(x.liquidityUsd)}</div><div><span>24h volume</span>${money(x.volume24h)}</div><div><span>FDV</span>${money(x.fdv)}</div></div>` : ''}
    ${d.flags.map(f => `<div class="flag ${f.level}"><b>${f.level === 'ok' ? '✅' : f.level === 'warn' ? '⚠️' : '🚨'} ${esc(f.title)}</b>${esc(f.detail)}</div>`).join('')}
    ${notes(d.errors)}
    ${x.url ? `<p class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">View chart on DexScreener ↗</a></p>` : ''}</div>`;
});};

$('#apprForm').onsubmit = e => { e.preventDefault(); run(e.target, $('#apprOut'), async () => {
  const d = await post('/api/approvals', {address: $('#apprAddr').value});
  const risky = d.approvals.filter(a => a.riskLevel === 'danger').length; const review = d.approvals.filter(a => a.riskLevel === 'warn').length;
  const head = `<div class="scorebox"><div class="score ${risky ? 'lvl-high' : 'lvl-low'}">${risky}</div><div><b>${d.approvals.length} active approval(s), ${risky} high-risk, ${review} worth reviewing</b><br><span class="muted">Checked: ${d.chainsChecked.map(esc).join(', ')}</span><br><a href="${esc(d.revokeUrl)}" target="_blank" rel="noopener">Revoke approvals on revoke.cash ↗</a></div></div>`;
  const list = d.approvals.length ? d.approvals.map(a => `<div class="flag ${a.riskLevel}"><b>${esc(a.token)} on ${esc(a.chain)} → ${esc(a.spenderName || 'Unknown contract')}</b>
    <div class="mono">Spender: ${esc(a.spender)}</div><div class="small muted">Amount: ${esc(a.amount)}${a.approvedAt ? ' · approved ' + esc(a.approvedAt) : ''}</div>
    <ul class="small">${a.reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul></div>`).join('')
    : '<p class="muted">✅ No active token approvals found on these chains. Nothing to revoke.</p>';
  return `<div class="result">${head}${list}${notes(d.errors)}</div>`;
});};


// ---------- Pro checkout (Solana Pay) ----------
function saveLicense(l){ localStorage.setItem('safesignPro', JSON.stringify({key: l.key, expiresAt: l.expiresAt})); setUsage(); showPro(); }
function showPro(){ const l = lic(); $('#proStatus').innerHTML = l ? `✅ Pro active until <b>${new Date(l.expiresAt).toLocaleString()}</b><br><span class="mono">Key: ${esc(l.key)}</span> (save it to use on another device)` : ''; }
showPro();
// re-validate stored key with server (e.g. after it expired)
if (lic()) fetch('/api/license/' + encodeURIComponent(lic().key)).then(r => r.json()).then(d => { if (!d.valid) { localStorage.removeItem('safesignPro'); showPro(); fetch('/api/usage').then(r => r.json()).then(u => setUsage(u.remaining)); } }).catch(() => {});
$('#licBtn').onclick = async () => {
  const key = $('#licInput').value.trim(); const d = await (await fetch('/api/license/' + encodeURIComponent(key))).json();
  if (d.valid) saveLicense({key, expiresAt: d.expiresAt}); else $('#proStatus').innerHTML = '<span class="err">License key not valid or expired.</span>';
};
let pollTimer;
$('#proBtn').onclick = async () => {
  const box = $('#checkout'); box.hidden = false; box.innerHTML = '<p class="muted">Creating checkout…</p>'; box.scrollIntoView({behavior:'smooth'});
  clearInterval(pollTimer);
  try {
    const r = await fetch('/api/checkout', {method:'POST'}); const c = await r.json(); if (!r.ok) throw new Error(c.error);
    box.innerHTML = `<h2>Pay for SafeSign Pro</h2>
      <p class="muted small">Scan a QR with Phantom, Solflare or any Solana Pay wallet, or tap the button on mobile. Send exactly <b>one</b> of these. Payment goes directly to <span class="mono">${esc(c.recipient)}</span>.</p>
      <div class="plans">${c.options.map(o => `<div class="plan center"><h3>${o.amount} ${o.currency}</h3>
        ${o.currency === 'SOL' ? `<p class="small muted">≈ $${c.priceUsd} at $${c.solUsd.toFixed(2)}/SOL (quote valid 1h)</p>` : '<p class="small muted">USDC on Solana</p>'}
        <img src="${o.qr}" alt="Solana Pay QR" style="background:#fff;border-radius:10px;max-width:100%">
        <p><a class="btn" href="${esc(o.url)}">Pay with Phantom</a></p></div>`).join('')}</div>
      <p id="payState" class="small">⏳ Waiting for payment… (checked every 5s; keep this page open)</p>`;
    const poll = async () => {
      const d = await (await fetch('/api/checkout/' + c.id)).json().catch(() => ({}));
      if (d.status === 'paid') { clearInterval(pollTimer); saveLicense(d.license);
        $('#payState').innerHTML = `🎉 Payment confirmed! Pro is active for 30 days.<br>Your license key: <b class="mono">${esc(d.license.key)}</b>`; }
      else if (d.status === 'expired') { clearInterval(pollTimer); $('#payState').textContent = 'Checkout expired. Start a new one.'; }
      else if (d.lastError) $('#payState').textContent = '⏳ Waiting for payment… (last check: ' + d.lastError + ')';
    };
    pollTimer = setInterval(poll, 5000);
  } catch (e) { box.innerHTML = `<p class="err">⚠️ ${esc(e.message)}</p>`; }
};

// Deep link from the Telegram bot: /?address=<token>#scan prefills and runs the scan
{ const a = new URLSearchParams(location.search).get('address');
  if (a) { $('#tokenAddr').value = a; $('#tokenForm').requestSubmit(); } }
