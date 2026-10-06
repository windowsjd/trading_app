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
