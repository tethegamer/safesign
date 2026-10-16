const test = require('node:test'); const assert = require('node:assert');
const { findAddresses, formatReport } = require('../bot');
const { finalize } = require('../scanner');
test('detects EVM + Solana addresses, ignores normal text', () => {
  assert.deepStrictEqual(findAddresses('ape into 0x6982508145454Ce325dDbE47a25d4ec3d2311933 now'), ['0x6982508145454Ce325dDbE47a25d4ec3d2311933']);
  assert.deepStrictEqual(findAddresses('ca: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263!'), ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263']);
  assert.deepStrictEqual(findAddresses('hello everyone this is supercalifragilisticexpialidocious stuff'), []);
  assert.deepStrictEqual(findAddresses('https://example.com/abc'), []);
});
test('formats report with score, flags, escaping', () => {
  const r = finalize({ chain: 'Solana', name: 'Evil <Coin>', symbol: 'EVL', address: 'X', dex: { found: true, liquidityUsd: 5000, volume24h: 100, priceUsd: 0.001 }, errors: [],
    flags: [{ level: 'ok', title: 'Fine', detail: 'ok', weight: 0 }, { level: 'danger', title: 'Mint authority is active', detail: 'can print', weight: 25 }, { level: 'danger', title: 'Very low liquidity', detail: 'tiny', weight: 30 }] });
  const t = formatReport({ ...r, address: 'X' });
  assert.match(t, /Risk score: 55\/100 — High risk/); assert.match(t, /Evil &lt;Coin&gt;/); assert.match(t, /🚨 <b>Mint authority/); assert.doesNotMatch(t, /Fine/);
});
