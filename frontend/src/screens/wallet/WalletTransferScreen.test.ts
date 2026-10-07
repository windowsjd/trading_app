import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const { walletTransferHarness, deferred } = createRequire(import.meta.url)('../../../test/walletTransferHarness.cjs');
const text = h => JSON.stringify(h.renderer.toJSON());
const wallets = ['securities', 'crypto_spot', 'crypto_futures'];

for (const account of ['A', 'B']) test(`${account}: compact USD form executes directly and shows its scoped receipt`, async t => {
  const h = walletTransferHarness(); h.accountId = account; await h.start(); t.after(h.close);
  assert.match(text(h), /700/);
  assert.doesNotMatch(text(h), /KRW|AccountSwitcher|테스트 시즌|견적|환율|환전|이체 내용 확인|자금 보관/);
  assert.equal(h.node('wallet-transfer-source-options'), undefined);
  assert.equal(h.node('wallet-transfer-destination-options'), undefined);
  assert.equal(h.node('wallet-transfer-source-selector').props.accessibilityState.expanded, false);
  assert.match(h.node('wallet-transfer-source-selector').props.accessibilityLabel, /증권 USD/);
  assert.equal(h.gets.some(path => path.endsWith('/futures/positions')), false);
  await h.amount('700.00000001'); assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  await h.amount('500'); await h.press('wallet-transfer-submit');
  assert.ok(h.node('wallet-transfer-success')); assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].path, `/trading-accounts/${account}/wallet-transfers`);
  assert.equal(h.requests[0].body.sourceWalletId, `${account}:securities`);
  assert.equal(h.requests[0].body.destinationWalletId, `${account}:crypto_spot`);
  assert.equal(h.requests[0].body.amount, '500.00000000');
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll(account)]);
  assert.match(text(h), /보낸 금액|보내는 지갑 잔액|받는 지갑 잔액|다른 이체하기/);
  assert.doesNotMatch(text(h), /crypto_spot|crypto_futures|securities/);
});

test('dropdowns are mutually exclusive, exclude opposite wallet and close on selection', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-selector');
  assert.equal(h.node('wallet-transfer-source-selector').props.accessibilityState.expanded, true);
  assert.ok(h.node('wallet-transfer-source-securities')); assert.ok(h.node('wallet-transfer-source-crypto_futures'));
  assert.equal(h.node('wallet-transfer-source-crypto_spot'), undefined);
  await h.press('wallet-transfer-destination-selector'); assert.equal(h.node('wallet-transfer-source-options'), undefined);
  assert.equal(h.node('wallet-transfer-destination-securities'), undefined);
  await h.press('wallet-transfer-destination-crypto_futures'); assert.equal(h.node('wallet-transfer-destination-options'), undefined);
  assert.match(h.node('wallet-transfer-destination-selector').props.accessibilityLabel, /선물 USD/);
  await h.choose('source', 'crypto_spot'); assert.match(text(h), /150/);
  assert.equal(h.gets.some(path => path.endsWith('/futures/positions')), false);
});

for (const source of wallets) for (const destination of wallets.filter(value => value !== source)) test(`${source} → ${destination} uses only exact USD wallet IDs`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  if (source === 'crypto_spot') await h.choose('destination', 'crypto_futures');
  if (source !== 'securities') await h.choose('source', source);
  const defaultDestination = source === 'crypto_spot' ? 'crypto_futures' : 'crypto_spot';
  if (destination !== defaultDestination) await h.choose('destination', destination);
  await h.amount('20'); await h.press('wallet-transfer-submit'); assert.ok(h.node('wallet-transfer-success'));
  assert.equal(h.requests[0].body.sourceWalletId, 'A:' + source); assert.equal(h.requests[0].body.destinationWalletId, 'A:' + destination);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('A'), ...(source === 'crypto_futures' || destination === 'crypto_futures' ? [QUERY_KEYS.tradingAccount.futuresCollateral('A')] : [])]);
});

for (const switches of [['B'], ['B', 'A']]) for (const failure of [false, true]) test(`late A ${failure ? 'failure' : 'success'} after ${switches.join('→')} cannot affect current form`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.gate = deferred(); await h.amount('100'); await h.press('wallet-transfer-submit');
  for (const account of switches) await h.switchAccount(account);
  if (failure) h.gate.reject(new Error('network')); else h.gate.resolve(); await h.flush();
  assert.equal(h.node('wallet-transfer-success'), undefined); assert.equal(h.node('wallet-transfer-error'), undefined);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('A')]);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/trading-accounts/A/wallet-transfers');
  assert.equal(h.node('wallet-transfer-amount').props.value, '');
});

test('uncertain retry reuses the exact command even when refreshed cash reflects its debit', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = new Error('network'); await h.amount('500');
  h.wallets.A.wallets.find(w => w.id === 'A:securities').balanceAmount = '600';
  await h.press('wallet-transfer-submit'); const first = h.requests[0];
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  await h.amount('500.00000000'); assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  h.failure = null; await h.press('wallet-transfer-submit'); assert.deepEqual(h.requests[1], first); assert.ok(h.node('wallet-transfer-success'));
});

for (const change of ['amount', 'source', 'destination', 'account']) test(`${change} intent changed away and back gets a fresh key`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = new Error('network'); await h.amount('10'); await h.press('wallet-transfer-submit'); const first = h.requests[0];
  if (change === 'amount') { await h.amount('11'); await h.amount('10'); }
  if (change === 'source') { await h.choose('source', 'crypto_futures'); await h.choose('source', 'securities'); }
  if (change === 'destination') { await h.choose('destination', 'crypto_futures'); await h.choose('destination', 'crypto_spot'); }
  if (change === 'account') { await h.switchAccount('B'); await h.switchAccount('A'); await h.amount('10'); }
  h.failure = null; await h.press('wallet-transfer-submit'); assert.notEqual(h.requests[1].body.idempotencyKey, first.body.idempotencyKey);
});

test('canonical-equivalent formatting retains the retry key', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = new Error('network'); await h.amount('10'); await h.press('wallet-transfer-submit');
  await h.amount('10.00000000'); h.failure = null; await h.press('wallet-transfer-submit');
  assert.equal(h.requests[1].body.idempotencyKey, h.requests[0].body.idempotencyKey);
});

test('rapid duplicate and stale input/dropdown handlers cannot replace a pending command', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.amount('25'); h.gate = deferred();
  const press = h.node('wallet-transfer-submit').props.onPress, change = h.node('wallet-transfer-amount').props.onChangeText, select = h.node('wallet-transfer-source-selector').props.onPress;
  const { act } = createRequire(import.meta.url)('react-test-renderer');
  await act(async () => { press(); press(); change('99'); select(); }); await h.flush();
  assert.equal(h.requests.length, 1); assert.equal(h.node('wallet-transfer-submit').props.state, 'loading');
  assert.equal(h.node('wallet-transfer-amount').props.editable, false); assert.equal(h.node('wallet-transfer-amount').props.value, '25');
  assert.equal(h.node('wallet-transfer-source-selector').props.disabled, true); assert.equal(h.node('wallet-transfer-destination-selector').props.disabled, true);
  assert.equal(h.node('wallet-transfer-source-options'), undefined);
  h.gate.resolve(); await h.flush(); assert.ok(h.node('wallet-transfer-success'));
});

for (const state of ['loading', 'offline', 'integrity', 'missing', 'duplicate', 'wrong-account', 'reserved', 'inactive']) test(`${state} fails closed`, async t => {
  const h = walletTransferHarness();
  if (state === 'loading') h.walletState = { isLoading: true, data: undefined };
  if (state === 'offline') h.walletState = { isError: true, error: new Error('offline'), data: undefined };
  if (state === 'integrity') h.walletState = { isError: true, error: { response: { status: 500, data: { error: { code: 'FINANCIAL_SCOPE_REPAIR_REQUIRED' } } } } };
  if (state === 'missing') h.wallets.A.wallets = h.wallets.A.wallets.filter(w => w.walletScope !== 'crypto_spot');
  if (state === 'duplicate') h.wallets.A.wallets.find(w => w.walletScope === 'crypto_spot').id = 'A:securities';
  if (state === 'wrong-account') h.walletState = { data: h.wallets.B };
  if (state === 'reserved') h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '1001';
  if (state === 'inactive') h.accounts.A.status = 'closed';
  await h.start(); t.after(h.close);
  if (state === 'inactive') { await h.amount('1'); assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled'); }
  else assert.equal(h.node('wallet-transfer-submit'), undefined);
  assert.equal(h.requests.length, 0);
});

test('missing KRW wallet does not block this USD-only screen', async t => {
  const h = walletTransferHarness(); h.wallets.A.wallets = h.wallets.A.wallets.filter(w => w.currencyCode === 'USD');
  await h.start(); t.after(h.close); await h.amount('1'); await h.press('wallet-transfer-submit'); assert.ok(h.node('wallet-transfer-success'));
});

test('Futures outgoing availability and validation use margin-aware free collateral, not cash', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures');
  assert.match(h.node('wallet-transfer-available').props.children, /25/); assert.doesNotMatch(h.node('wallet-transfer-available').props.children, /50/);
  assert.ok(h.gets.includes('/trading-accounts/A/futures/positions'));
  await h.amount('25.00000001'); assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  await h.amount('25'); assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
});

for (const state of ['null', 'stale-mark', 'error', 'loading', 'wrong-wallet', 'wrong-account', 'malformed', 'negative']) test(`Futures ${state} never falls back to cash; incoming remains available`, async t => {
  const h = walletTransferHarness();
  if (state === 'null' || state === 'stale-mark') { h.risk.A.collateral.freeCollateral = null; h.risk.A.cross = { markState: 'unavailable_or_stale' }; }
  if (state === 'error') h.riskFailure = new Error('PROVIDER_INTERNAL_FAILURE secret');
  if (state === 'loading') h.riskGate = { A: deferred() };
  if (state === 'wrong-wallet') h.risk.A.collateral.walletId = 'B:crypto_futures';
  if (state === 'wrong-account') h.riskState = { data: h.risk.B };
  if (state === 'malformed') h.risk.A.collateral.freeCollateral = 'NaN';
  if (state === 'negative') h.risk.A.collateral.freeCollateral = '-1.00000000';
  await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures'); await h.amount('1');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled'); assert.doesNotMatch(text(h), /PROVIDER_INTERNAL|secret|이체 가능 금액: USD/);
  await h.choose('source', 'securities'); await h.choose('destination', 'crypto_futures');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  if (h.riskGate) { h.riskGate.A.resolve(); await h.flush(); }
  await h.press('wallet-transfer-submit'); assert.ok(h.node('wallet-transfer-success'));
});

test('late Futures A read never supplies collateral to B', async t => {
  const h = walletTransferHarness(); h.riskGate = { A: deferred(), B: deferred() };
  await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures');
  await h.switchAccount('B'); await h.choose('source', 'crypto_futures'); await h.amount('1');
  h.riskGate.A.resolve(); await h.flush(); assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  h.risk.B.collateral.freeCollateral = '3.00000000'; h.riskGate.B.resolve(); await h.flush();
  assert.match(h.node('wallet-transfer-available').props.children, /3/); assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
});

for (const [positionState, freeCollateral] of [['none', '50.00000000'], ['isolated', '25.00000000'], ['cross', '10.00000000'], ['zero', '0.00000000']]) test(`Futures ${positionState} positions use the server collateral result`, async t => {
  const h = walletTransferHarness();
  h.risk.A.positions = positionState === 'none' ? [] : [{ marginMode: positionState === 'isolated' ? 'isolated' : 'cross', quantity: '1.00000000' }];
  h.risk.A.collateral.freeCollateral = freeCollateral;
  await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures'); await h.amount('1');
  assert.equal(h.node('wallet-transfer-submit').props.state, positionState === 'zero' ? 'disabled' : 'enabled');
  assert.equal(h.node('wallet-transfer-available').props.children, '이체 가능 금액: USD ' + freeCollateral.replace(/\.0+$/, ''));
});

test('late wallet A read cannot populate B while B is loading', async t => {
  const h = walletTransferHarness(); h.walletGate = { A: deferred(), B: deferred() };
  await h.start(); t.after(h.close); await h.switchAccount('B');
  h.walletGate.A.resolve(); await h.flush(); assert.equal(h.node('wallet-transfer-submit'), undefined);
  h.walletGate.B.resolve(); await h.flush(); await h.amount('1'); await h.press('wallet-transfer-submit');
  assert.equal(h.requests[0].body.sourceWalletId, 'B:securities'); assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.walletsAll('B')]);
});

test('unverifiable response retries with the original key and never shows a false receipt', async t => {
  const h = walletTransferHarness(); h.response = {}; await h.start(); t.after(h.close);
  await h.amount('10'); await h.press('wallet-transfer-submit');
  assert.equal(h.node('wallet-transfer-success'), undefined);
  const integrity = h.renderer.root.findByType('ErrorState');
  assert.match(integrity.props.title, /안전하게 표시/);
  const { act } = createRequire(import.meta.url)('react-test-renderer');
  await act(async () => integrity.props.onRetry()); await h.flush();
  h.response = null; await h.press('wallet-transfer-submit'); assert.ok(h.node('wallet-transfer-success'));
  assert.deepEqual(h.requests[1], h.requests[0]);
});

test('Futures insufficient collateral rejection uses a safe actionable product message', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures');
  h.failure = { response: { status: 409, data: { error: { code: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', message: 'SQL internal http://secret env=TOKEN' } } } };
  await h.amount('10'); await h.press('wallet-transfer-submit');
  assert.match(text(h), /선물 지갑의 이체 가능 금액이 부족/); assert.doesNotMatch(text(h), /SQL internal|http:\/\/secret|TOKEN/);
});

for (const platform of ['web', 'android', 'ios']) test(`${platform}: focus hook measures input/CTA and dropdown blurs before dismiss`, async t => {
  const h = walletTransferHarness({ platform }); await h.start(); t.after(h.close);
  const scroll = h.node('wallet-transfer-screen');
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled'); assert.equal(scroll.props.keyboardDismissMode, 'none'); assert.equal(scroll.props.scrollEventThrottle, 16);
  const avoiding = h.renderer.root.findByType('KeyboardAvoidingView'); assert.equal(avoiding.props.keyboardVerticalOffset, platform === 'ios' ? 64 : 0);
  await h.focus(); h.keyboard('keyboardDidShow', 400); assert.deepEqual(h.scrolls.at(-1), { y: 214, animated: false });
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 20 } } });
  scroll.props.onLayout(); h.flushFrames(); assert.deepEqual(h.scrolls.at(-1), { y: 234, animated: false });
  scroll.props.onContentSizeChange(); h.flushFrames(); assert.deepEqual(h.scrolls.at(-1), { y: 234, animated: false });
  h.events.length = 0; await h.press('wallet-transfer-source-selector'); assert.deepEqual(h.events, ['blur', 'dismiss']); assert.ok(h.node('wallet-transfer-source-options'));
  const before = h.scrolls.length; h.keyboard('keyboardDidShow', 350); assert.equal(h.scrolls.length, before);
  await h.focus(); assert.equal(h.node('wallet-transfer-source-options'), undefined);
  await h.amount('1'); await h.press('wallet-transfer-submit'); assert.equal(h.requests.length, 1);
});

test('short keyboard viewport prioritizes input while CTA remains scrollable', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); h.bounds.input = [0, 420, 288, 90]; h.bounds.submit = [0, 650, 288, 90];
  await h.focus(); h.keyboard('keyboardDidShow', 200); assert.deepEqual(h.scrolls.at(-1), { y: 322, animated: false });
});

test('validated success remains visible if the subsequent wallet refresh fails', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.amount('1'); await h.press('wallet-transfer-submit');
  h.walletState = { isError: true, error: new Error('refresh failed') }; await h.update(); assert.ok(h.node('wallet-transfer-success'));
});
