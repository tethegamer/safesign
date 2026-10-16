// SafeSign Telegram bot (@SafeSignScanBot). Long polling, no extra dependencies.
// Run: TELEGRAM_BOT_TOKEN=... node bot.js   (run ONE poller per token; do not run on the Render web service)
const { scanToken } = require('./scanner');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SITE = process.env.SITE_URL || 'https://safesign-pg8h.onrender.com';
const OWNER = (process.env.BOT_OWNER || 'dawgypicks').toLowerCase();
const PER_CHAT_PER_MIN = Number(process.env.BOT_SCANS_PER_MIN || 4);
const API = `https://api.telegram.org/bot${TOKEN}`;

const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const money = n => n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: Number(n) < 1 ? 8 : 0 });

// ---------- address detection ----------
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/g;
const SOL_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
function findAddresses(text) {
  text = String(text || '');
  const evm = text.match(EVM_RE) || [];
  // require digits + upper + lower to avoid matching long normal words
  const sol = (text.replace(EVM_RE, ' ').match(SOL_RE) || []).filter(a => /\d/.test(a) && /[A-Z]/.test(a) && /[a-z]/.test(a));
  return [...new Set([...evm, ...sol])].slice(0, 2);
}

// ---------- formatting ----------
function formatReport(r) {
  const icon = r.riskScore >= 50 ? '🔴' : r.riskScore >= 20 ? '🟡' : '🟢';
  const ic = { danger: '🚨', warn: '⚠️', ok: '✅', info: 'ℹ️' };
  const bad = r.flags.filter(f => f.level === 'danger' || f.level === 'warn');
  const shown = (bad.length ? bad : r.flags).slice(0, 5);
  const x = r.dex || {};
  const lines = [
    `${icon} <b>${esc(r.name || 'Unknown token')}${r.symbol ? ' ($' + esc(r.symbol) + ')' : ''}</b> on ${esc(r.chain)}`,
    `<b>Risk score: ${r.riskScore}/100 — ${esc(r.riskLevel)}</b>`,
    esc(r.summary),
    '',
    ...shown.map(f => `${ic[f.level] || '•'} <b>${esc(f.title)}</b>: ${esc(f.detail)}`),
  ];
  if (bad.length > shown.length) lines.push(`…and ${bad.length - shown.length} more warning(s) in the full report.`);
  if (x.found) lines.push('', `💧 Liquidity ${money(x.liquidityUsd)} · 📊 24h vol ${money(x.volume24h)} · 💲 ${money(x.priceUsd)}`);
  lines.push('', `<code>${esc(r.address)}</code>`, '<i>Informational only, not financial advice.</i>');
  return lines.join('\n');
}
const buttons = addr => ({ inline_keyboard: [[
  { text: '📄 Full report', url: `${SITE}/?address=${encodeURIComponent(addr)}#scan` },
  { text: '⭐ Go Pro', url: `${SITE}/#pricing` },
]] });

// ---------- Telegram API ----------
async function tg(method, body) {
  const r = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.description}`);
  return j.result;
}
const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

// ---------- rate limit + cache ----------
const hits = new Map(); // chatId -> [timestamps]
function allowed(chatId) {
  const now = Date.now(), arr = (hits.get(chatId) || []).filter(t => now - t < 60000);
  if (arr.length >= PER_CHAT_PER_MIN) { hits.set(chatId, arr); return false; }
  arr.push(now); hits.set(chatId, arr); return true;
}
const cache = new Map(); // address -> {t, report}
async function cachedScan(addr) {
  const c = cache.get(addr);
  if (c && Date.now() - c.t < 5 * 60000) return c.r;
  const r = await scanToken(addr);
  cache.set(addr, { t: Date.now(), r });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return r;
}
const stats = { scans: 0, chats: new Set(), started: new Date() };

async function doScan(msg, addr, quiet) {
  const chat = msg.chat.id;
  if (!allowed(chat)) { if (!quiet) await send(chat, `⏳ Slow down a little: max ${PER_CHAT_PER_MIN} scans per minute in this chat.`, { reply_to_message_id: msg.message_id }); return; }
  tg('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  try {
    const r = await cachedScan(addr);
    stats.scans++; stats.chats.add(chat);
    await send(chat, formatReport(r), { reply_to_message_id: msg.message_id, reply_markup: buttons(addr) });
  } catch (e) {
    if (quiet && !e.badInput) return console.error('scan failed', addr, e.message);
    await send(chat, `⚠️ ${esc(e.message)}`, { reply_to_message_id: msg.message_id });
  }
}

let me;
const WELCOME = () => `🛡️ <b>SafeSign: check before you sign</b>

Paste any <b>Solana</b> or <b>EVM</b> (Ethereum, Base, BNB, Arbitrum, Polygon…) token address and I reply with a plain-English risk score: rug-pull flags, honeypots, mint/freeze authority, taxes, liquidity.

• <code>/scan &lt;address&gt;</code> — scan a token
• Or just paste the address

<b>In groups:</b> add me to the group. I always answer /scan, mentions and replies. To auto-scan every pasted address, the group admin can make me an admin, or the bot owner can turn off privacy mode in @BotFather (/setprivacy → Disable).

🌐 Web app & approvals checker: ${SITE}`;

async function handle(msg) {
  const text = msg.text || msg.caption || '';
  if (!text) return;
  const chat = msg.chat.id, priv = msg.chat.type === 'private';
  const m = text.match(/^\/(\w+)(?:@(\w+))?\s*([\s\S]*)$/);
  if (m) {
    const [, cmd, target, args] = m;
    if (target && me && target.toLowerCase() !== me.username.toLowerCase()) return; // command for another bot
    if (cmd === 'start' || cmd === 'help') return send(chat, WELCOME(), { reply_markup: { inline_keyboard: [[{ text: '🌐 Open SafeSign', url: SITE }]] } });
    if (cmd === 'scan') {
      const addrs = findAddresses(args) .concat(findAddresses(msg.reply_to_message?.text));
      if (!addrs.length) return send(chat, 'Usage: <code>/scan &lt;token address&gt;</code>\nExample: <code>/scan DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263</code>', { reply_to_message_id: msg.message_id });
      return doScan(msg, addrs[0], false);
    }
    if (cmd === 'stats' && (msg.from?.username || '').toLowerCase() === OWNER)
      return send(chat, `Scans: ${stats.scans}\nChats: ${stats.chats.size}\nUp since: ${stats.started.toISOString()}`);
    return;
  }
  // auto-detect pasted addresses (DMs; groups when bot can see messages)
  const addrs = findAddresses(text);
  const mentioned = me && (text.includes('@' + me.username) || msg.reply_to_message?.from?.id === me.id);
  if (!addrs.length) { if (priv || mentioned) await send(chat, 'Send me a Solana or EVM token address to scan, or /help.'); return; }
  for (const a of addrs) await doScan(msg, a, !priv && !mentioned);
}

async function setup() {
  await tg('setMyCommands', { commands: [
    { command: 'scan', description: 'Scan a token address for rug/honeypot risks' },
    { command: 'start', description: 'What this bot does' },
    { command: 'help', description: 'How to use SafeSign in DMs and groups' },
  ] });
  await tg('setMyDescription', { description: 'SafeSign checks crypto tokens before you buy. Paste any Solana or EVM token address and get a plain-English risk score: rug-pull flags, honeypots, mint/freeze authority, taxes and liquidity. Works in groups too. Full reports and approvals checker: ' + SITE });
  await tg('setMyShortDescription', { short_description: 'Paste a Solana/EVM token address → instant rug & honeypot risk score. ' + SITE });
}

async function main() {
  if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
  me = await tg('getMe');
  console.log(`Bot @${me.username} started`);
  await tg('deleteWebhook', {}).catch(() => {});
  await setup().catch(e => console.error('setup failed:', e.message));
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) handle(u.message).catch(e => console.error('handler:', e.message));
      }
    } catch (e) { console.error('poll:', e.message); await new Promise(r => setTimeout(r, 5000)); }
  }
}

if (require.main === module) main();
module.exports = { findAddresses, formatReport, buttons, handle, _setMe: m => { me = m; } };
