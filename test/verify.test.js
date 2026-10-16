// Run: npm test   (uses real historical mainnet transactions saved in test/fixtures,
// and re-fetches them live from public RPC when the network is available)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
process.env.LICENSE_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-')), 'licenses.json');
const pay = require('../payments');

const USDC_SIG = '47kLJu4bYpy5MMMD5apj9i24PDiQBhv1Ujed865foFex5NfamqPoTbo3nBonJaCKx4QCqcweTzteEPXnahx9d6ZF';
const SOL_SIG = '2n3A24nVwbU68Zik2JfTwqaJJDCtWukKP9TqLbMSpFLoVs3yqP1W9RGruh8FPRXUSvRLXXWy5CJvshFNSLtqcZJL';
const usdcTx = require('./fixtures/usdc-transfer.json'); // 6000 USDC Binance -> 5ipJ3j8U... (ATA created in same tx)
const solTx = require('./fixtures/sol-transfer.json');   // 0.2477784 SOL Binance -> FDV1co3E...
const U = { recipient: '5ipJ3j8U6zwe1c3oKz53zFyxPgfM2vtPujty7gNryFyR', reference: '7KJjY7rArbydeLBF7gQ5LdqXRKRYyPArT99NEctsHsgU', currency: 'USDC' };
const S = { recipient: 'FDV1co3EJb9tPJYMp25GKYiMAhGmdZmgDLKAUdgeGZU6', reference: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', currency: 'SOL' };
const RANDOM = 'E4gJZ7k2eZDHNxZMWdnXu5XytwpkcYbeLzXXkKMMS8Qv';

test('USDC: accepts correct recipient + amount', () => {
  const v = pay.verifyTransaction(usdcTx, { ...U, minAmount: 9 });
  assert.ok(v.ok); assert.strictEqual(v.received, 6000);
  assert.ok(pay.verifyTransaction(usdcTx, { ...U, minAmount: 6000 }).ok);
});
test('USDC: rejects underpayment', () => assert.ok(!pay.verifyTransaction(usdcTx, { ...U, minAmount: 6000.000001 }).ok));
test('USDC: rejects wrong recipient', () => assert.ok(!pay.verifyTransaction(usdcTx, { ...U, recipient: RANDOM, minAmount: 9 }).ok));
test('USDC: rejects missing reference', () => assert.match(pay.verifyTransaction(usdcTx, { ...U, reference: RANDOM, minAmount: 9 }).reason, /reference/));
test('USDC: sender side (balance went down) is not a payment', () => assert.ok(!pay.verifyTransaction(usdcTx, { ...U, recipient: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', minAmount: 9 }).ok));
test('USDC tx does not count as SOL payment', () => assert.ok(!pay.verifyTransaction(usdcTx, { ...U, currency: 'SOL', minAmount: 0.01 }).ok));
test('SOL: accepts correct amount, rejects more', () => {
  assert.ok(pay.verifyTransaction(solTx, { ...S, minAmount: 0.2477784 }).ok);
  assert.ok(!pay.verifyTransaction(solTx, { ...S, minAmount: 0.2477785 }).ok);
  assert.ok(!pay.verifyTransaction(solTx, { ...S, recipient: RANDOM, minAmount: 0.1 }).ok);
});
test('failed tx rejected', () => {
  const bad = JSON.parse(JSON.stringify(usdcTx)); bad.meta.err = { InstructionError: [0, 'x'] };
  assert.ok(!pay.verifyTransaction(bad, { ...U, minAmount: 9 }).ok);
});

test('checkout -> poll -> license issued once, signature not reusable', async () => {
  const h = pay._testHooks();
  // fake RPC that serves the real historical tx for our reference
  h.setRpc(async (m, p) => m === 'getSignaturesForAddress' ? [{ signature: USDC_SIG, err: null, blockTime: usdcTx.blockTime }] : usdcTx);
  const db = h.db();
  const mk = id => { db.checkouts[id] = { id, created: Date.now(), status: 'pending', options: [{ currency: 'USDC', amount: 9, reference: U.reference }] }; };
  // recipient is fixed to the owner wallet; that tx paid someone else -> must stay pending
  mk('c1'); let r = await pay.checkCheckout('c1');
  assert.strictEqual(r.status, 'pending'); assert.match(r.lastError, /received 0 USDC/);
  // pretend the owner's wallet was the receiver by rewriting owner in the real tx
  for (const b of usdcTx.meta.postTokenBalances) if (b.owner === U.recipient) b.owner = pay.RECIPIENT;
  r = await pay.checkCheckout('c1');
  assert.strictEqual(r.status, 'paid'); assert.match(r.license.key, /^SSPRO-/);
  const days = (r.license.expiresAt - Date.now()) / 864e5; assert.ok(days > 29.9 && days <= 30);
  assert.ok(pay.validLicense(r.license.key)); assert.ok(!pay.validLicense('SSPRO-FAKE'));
  assert.ok(JSON.parse(fs.readFileSync(process.env.LICENSE_FILE)).licenses[r.license.key]);
  mk('c2'); assert.strictEqual((await pay.checkCheckout('c2')).status, 'pending'); // same signature can't buy twice
  for (const b of usdcTx.meta.postTokenBalances) if (b.owner === pay.RECIPIENT) b.owner = U.recipient;
});

test('LIVE: same transactions fetched from public Solana RPC verify identically', async t => {
  let live;
  try { live = await Promise.all([USDC_SIG, SOL_SIG].map(s => pay.rpc('getTransaction', [s, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]))); }
  catch (e) { return t.skip('network/RPC unavailable: ' + e.message); }
  assert.strictEqual(pay.verifyTransaction(live[0], { ...U, minAmount: 9 }).received, 6000);
  assert.ok(pay.verifyTransaction(live[1], { ...S, minAmount: 0.2477784 }).ok);
});
