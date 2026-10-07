import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const { walletTransferHarness, deferred } = createRequire(import.meta.url)('../../../test/walletTransferHarness.cjs');
const text = h => JSON.stringify(h.renderer.toJSON());

for (const account of ['A', 'B']) test(`${account} reviews exact wallet IDs and spendable balance, then refreshes only that account`, async t => {
  const h = walletTransferHarness(); h.accountId = account; await h.start(); t.after(h.close);
  assert.match(text(h), /700/);
  await h.amount('700.00000001'); assert.equal(h.node('wallet-transfer-review').props.state, 'disabled');
  await h.amount('500'); await h.press('wallet-transfer-review');
  assert.ok(h.node('wallet-transfer-summary')); assert.equal(h.requests.length, 0);
  await h.press('wallet-transfer-confirm'); await h.flush();
  assert.ok(h.node('wallet-transfer-success'));
  assert.equal(h.requests[0].path, `/trading-accounts/${account}/wallet-transfers`);
  assert.equal(h.requests[0].body.sourceWalletId, `${account}:securities`);
  assert.equal(h.requests[0].body.destinationWalletId, `${account}:crypto_spot`);
  assert.equal(h.requests[0].body.amount, '500.00000000');
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll(account)]);
  assert.doesNotMatch(text(h), /crypto_spot|crypto_futures|securities/);
});

test('source changes show the selected wallet availability and block the same destination', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-crypto_spot');
  assert.match(text(h), /150/);
  assert.equal(h.node('wallet-transfer-destination-crypto_spot').props.disabled, true);
  await h.press('wallet-transfer-destination-crypto_futures'); await h.amount('20'); await h.press('wallet-transfer-review'); await h.press('wallet-transfer-confirm'); await h.flush();
  assert.equal(h.requests[0].body.sourceWalletId, 'A:crypto_spot');
  assert.equal(h.requests[0].body.destinationWalletId, 'A:crypto_futures');
});

for (const switches of [['B'], ['B', 'A']]) test(`late A response after ${switches.join('→')} never produces a current success or refreshes B`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.gate = deferred(); await h.amount('100'); await h.press('wallet-transfer-review'); await h.press('wallet-transfer-confirm'); await h.flush();
  for (const account of switches) await h.switchAccount(account);
  h.gate.resolve(); await h.flush();
  assert.equal(h.node('wallet-transfer-success'), undefined);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('A')]);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/trading-accounts/A/wallet-transfers');
  assert.equal(h.node('wallet-transfer-amount').props.value, '');
});

test('a failed command can retry the same idempotency key and then succeed', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = new Error('network'); await h.amount('50'); await h.press('wallet-transfer-review'); await h.press('wallet-transfer-confirm'); await h.flush();
  assert.ok(h.node('wallet-transfer-error')); const first = h.requests[0];
  h.failure = null; await h.press('wallet-transfer-confirm'); await h.flush();
  assert.deepEqual(h.requests[1], first); assert.ok(h.node('wallet-transfer-success'));
});

for (const state of ['loading', 'offline', 'integrity', 'missing', 'reserved', 'inactive']) test(`${state} blocks transfer and provides a visible state`, async t => {
  const h = walletTransferHarness();
  if (state === 'loading') h.walletState = { isLoading: true, data: undefined };
  if (state === 'offline') h.walletState = { isError: true, error: new Error('offline'), data: undefined };
  if (state === 'integrity') h.walletState = { isError: true, error: { response: { status: 500, data: { error: { code: 'FINANCIAL_SCOPE_REPAIR_REQUIRED' } } } } };
  if (state === 'missing') h.wallets.A.wallets = h.wallets.A.wallets.filter(w => w.walletScope !== 'crypto_spot');
  if (state === 'reserved') h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '1001';
  if (state === 'inactive') h.accounts.A.status = 'closed';
  await h.start(); t.after(h.close);
  assert.equal(h.node('wallet-transfer-success'), undefined);
  if (state === 'inactive') { await h.amount('1'); assert.equal(h.node('wallet-transfer-review').props.state, 'disabled'); }
  else assert.equal(h.node('wallet-transfer-confirm'), undefined);
  assert.equal(h.requests.length, 0);
});

for (const account of ['A', 'B']) for (const crypto of ['crypto_spot', 'crypto_futures']) for (const reverse of [false, true]) test(`${account}: ${crypto} ${reverse ? 'USD→KRW' : 'KRW→USD'} reviews a server quote before a single composite execute`, async t => {
  const h = walletTransferHarness(); h.accountId = account; await h.start(); t.after(h.close);
  await h.press(`wallet-transfer-source-${reverse ? crypto : 'securities-KRW'}`);
  await h.press(`wallet-transfer-destination-${reverse ? 'securities-KRW' : crypto}`);
  assert.match(text(h), reverse ? /이체 가능 잔액:.*USD/ : /이체 가능 잔액:.*KRW/);
  await h.amount(reverse ? '25' : '1400'); await h.press('wallet-transfer-review'); await h.flush();
  assert.ok(h.node('wallet-transfer-summary')); assert.ok(h.node('wallet-transfer-expected-received'));
  assert.equal(h.requests.length, 1); assert.match(h.requests[0].path, /wallet-transfers\/quote$/);
  assert.equal(h.requests[0].body.amount, reverse ? '25.00000000' : '1400.00000000');
  assert.match(text(h), /적용 예정 환율/); assert.match(text(h), /환전 수수료/); assert.match(text(h), /예상 수령액/);
  await h.press('wallet-transfer-confirm'); await h.flush();
  assert.ok(h.node('wallet-transfer-success')); assert.ok(h.node('wallet-transfer-actual-received'));
  assert.deepEqual(Object.keys(h.requests[1].body).sort(), ['idempotencyKey', 'quoteId']);
  assert.match(h.requests[1].path, /wallet-transfers\/execute$/);
  assert.match(text(h), /1401/); assert.doesNotMatch(text(h), /crypto_spot|crypto_futures|securities/);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll(account), QUERY_KEYS.tradingAccount.portfolioAll(account), ...(account === 'B' ? [QUERY_KEYS.ranking.all] : [])]);
});

test('Securities KRW↔USD cannot be selected on Transfer and has a clear FX guide', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  assert.equal(h.node('wallet-transfer-destination-securities-KRW').props.disabled, true);
  await h.press('wallet-transfer-source-securities-KRW');
  assert.equal(h.node('wallet-transfer-destination-securities').props.disabled, true);
  assert.match(text(h), /환전하기를 이용/);
});

for (const switches of [['B'], ['B', 'A']]) for (const stage of ['quote', 'execute']) test(`cross ${stage} response after ${switches.join('→')} cannot pollute selected account`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-securities-KRW'); await h.amount('1400');
  if (stage === 'quote') h.quoteGate = deferred();
  await h.press('wallet-transfer-review'); await h.flush();
  if (stage === 'execute') { h.gate = deferred(); await h.press('wallet-transfer-confirm'); await h.flush(); }
  for (const account of switches) await h.switchAccount(account);
  (stage === 'quote' ? h.quoteGate : h.gate).resolve(); await h.flush();
  assert.equal(h.node('wallet-transfer-success'), undefined); assert.equal(h.node('wallet-transfer-summary'), undefined);
  assert.equal(h.node('wallet-transfer-amount').props.value, '');
  assert.equal(h.requests.length, stage === 'quote' ? 1 : 2);
  assert.deepEqual(h.invalidations, stage === 'quote' ? [] : [QUERY_KEYS.tradingAccount.walletsAll('A'), QUERY_KEYS.tradingAccount.portfolioAll('A')]);
});

test('cross quote loading/error retry and expired preview require a new quote', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-securities-KRW'); await h.amount('1400');
  h.quoteGate = deferred(); await h.press('wallet-transfer-review'); await h.flush();
  assert.equal(h.node('wallet-transfer-review').props.state, 'loading'); assert.equal(h.node('wallet-transfer-amount').props.editable, false);
  h.quoteFailure = new Error('offline'); h.quoteGate.resolve(); await h.flush();
  assert.ok(h.node('wallet-transfer-error')); assert.equal(h.node('wallet-transfer-confirm'), undefined);
  h.quoteFailure = null; h.quoteGate = null; h.expiresAt = new Date(Date.now() - 1000).toISOString();
  await h.press('wallet-transfer-review'); await h.flush();
  assert.ok(h.node('wallet-transfer-requote')); assert.equal(h.node('wallet-transfer-confirm'), undefined);
  h.expiresAt = null; await h.press('wallet-transfer-requote'); await h.flush();
  assert.ok(h.node('wallet-transfer-confirm')); assert.equal(h.requests.filter(r => r.path.endsWith('/execute')).length, 0);
});

for (const code of ['QUOTE_EXPIRED', 'RATE_CHANGED_REQUOTE_REQUIRED']) test(`cross ${code} rejection explicitly requotes before execution`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-securities-KRW'); await h.amount('1400'); await h.press('wallet-transfer-review'); await h.flush();
  h.failure = { response: { data: { error: { code } } } };
  await h.press('wallet-transfer-confirm'); await h.flush();
  assert.ok(h.node('wallet-transfer-requote')); assert.equal(h.node('wallet-transfer-confirm'), undefined);
  h.failure = null; await h.press('wallet-transfer-requote'); await h.flush(); await h.press('wallet-transfer-confirm'); await h.flush();
  assert.equal(h.requests.length, 4); assert.notEqual(h.requests[1].body.idempotencyKey, h.requests[3].body.idempotencyKey);
  assert.notEqual(h.requests[1].body.quoteId, h.requests[3].body.quoteId); assert.ok(h.node('wallet-transfer-success'));
});

test('cross uncertain execute retry preserves quote and key after local expiry', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.expiresAt = new Date(Date.now() + 1000).toISOString();
  await h.press('wallet-transfer-source-securities-KRW'); await h.amount('1400'); await h.press('wallet-transfer-review'); await h.flush();
  h.failure = new Error('network'); await h.press('wallet-transfer-confirm'); await h.flush();
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('A'), QUERY_KEYS.tradingAccount.portfolioAll('A')]);
  const first = h.requests[1];
  await new Promise(resolve => setTimeout(resolve, 1100)); await h.flush();
  assert.equal(h.node('wallet-transfer-requote'), undefined);
  h.failure = null; await h.press('wallet-transfer-confirm'); await h.flush();
  assert.deepEqual(h.requests[2], first); assert.equal(h.requests.filter(r => r.path.endsWith('/quote')).length, 1); assert.ok(h.node('wallet-transfer-success'));
});

for (const switches of [['B'], ['B', 'A']]) test(`cross uncertain response after ${switches.join('→')} refreshes original A without displaying its error`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-securities-KRW'); await h.amount('1400'); await h.press('wallet-transfer-review'); await h.flush();
  h.gate = deferred(); await h.press('wallet-transfer-confirm'); await h.flush();
  for (const account of switches) await h.switchAccount(account);
  h.gate.reject(new Error('network')); await h.flush();
  assert.equal(h.node('wallet-transfer-error'), undefined); assert.equal(h.node('wallet-transfer-success'), undefined);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('A'), QUERY_KEYS.tradingAccount.portfolioAll('A')]);
});

for (const cross of [false, true]) test(`${cross ? 'cross' : 'USD'} duplicate confirm keeps one pending command and its loading state`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  if (cross) await h.press('wallet-transfer-source-securities-KRW');
  await h.amount(cross ? '1400' : '25'); await h.press('wallet-transfer-review'); await h.flush();
  h.gate = deferred(); await h.press('wallet-transfer-confirm'); await h.flush();
  await h.press('wallet-transfer-confirm'); await h.flush();
  assert.equal(h.requests.length, cross ? 2 : 1); assert.equal(h.node('wallet-transfer-confirm').props.state, 'loading');
  assert.equal(h.node('wallet-transfer-amount').props.editable, false);
  h.gate.resolve(); await h.flush();
  assert.ok(h.node('wallet-transfer-success')); assert.equal(h.requests.length, cross ? 2 : 1);
});
