import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const { walletTransferHarness, deferred } = createRequire(import.meta.url)('../../../test/walletTransferHarness.cjs');
const text = h => JSON.stringify(h.renderer.toJSON());
const wallets = ['securities', 'crypto_spot', 'crypto_futures'];

test('transfer uses the same insufficient message, accepts exact availability and updates input errors', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.amount('700.00000001'); assert.match(text(h), /잔액이 부족합니다\./);
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  await h.amount('700'); assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  assert.doesNotMatch(text(h), /잔액이 부족/);
  await h.amount('1e3'); assert.doesNotMatch(text(h), /잔액이 부족/);
  h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '1000';
  await h.update(); await h.amount('1'); assert.match(text(h), /잔액이 부족합니다\./);
  assert.equal(h.requests.length, 0);
});

test('transfer rejects a fresh debit before sending a new financial command', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.amount('600');
  // Snapshot was 700; a reservation changed before the user's final press.
  h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '500';
  await h.press('wallet-transfer-submit');
  assert.equal(h.requests.length, 0);
  assert.match(text(h), /잔액이 부족합니다\./);
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  const notices = h.renderer.root.findAll(node =>
    node.type.name === 'ErrorNotice' && node.props.error?.name === 'WalletBalanceCheckError');
  assert.equal(notices.length, 1);
  const original = notices[0].props.error;
  original.message = 'PROVIDER_INTERNAL_FAILURE secret';
  await h.update();
  assert.equal(h.node('wallet-transfer-error').props.children, '잔액이 부족합니다.');
  assert.doesNotMatch(text(h), /PROVIDER_INTERNAL|secret/);
  assert.equal(h.renderer.root.findAll(node =>
    node.type.name === 'ErrorNotice' && node.props.error === original).length, 1);
  assert.equal(h.requests.length, 0);
});

test('transfer preflight cannot execute after unmount or an account switch', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.walletGate = { A: deferred() }; await h.amount('1'); await h.press('wallet-transfer-submit');
  await h.switchAccount('B'); h.walletGate.A.resolve(); await h.flush();
  assert.equal(h.requests.length, 0);
  assert.equal(h.node('wallet-transfer-success') === undefined, true);
});

for (const account of ['A', 'B']) test(`${account}: compact USD form executes directly and shows its scoped receipt`, async t => {
  const h = walletTransferHarness(); h.accountId = account; await h.start(); t.after(h.close);
  assert.match(text(h), /700/);
  assert.doesNotMatch(text(h), /KRW|AccountSwitcher|테스트 시즌|견적|환율|환전|이체 내용 확인|자금 보관/);
  assert.equal(h.node('wallet-transfer-source-options') === undefined, true);
  assert.equal(h.node('wallet-transfer-destination-options') === undefined, true);
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
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.quests(account), QUERY_KEYS.tradingAccount.walletsAll(account)]);
  assert.match(text(h), /보낸 금액|보내는 지갑 잔액|받는 지갑 잔액|다른 이체하기/);
  assert.doesNotMatch(text(h), /crypto_spot|crypto_futures|securities/);
});

test('dropdowns are mutually exclusive, exclude opposite wallet and close on selection', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  await h.press('wallet-transfer-source-selector');
  assert.equal(h.node('wallet-transfer-source-selector').props.accessibilityState.expanded, true);
  assert.ok(h.node('wallet-transfer-source-securities')); assert.ok(h.node('wallet-transfer-source-crypto_futures'));
  assert.equal(h.node('wallet-transfer-source-crypto_spot') === undefined, true);
  await h.press('wallet-transfer-destination-selector'); assert.equal(h.node('wallet-transfer-source-options') === undefined, true);
  assert.equal(h.node('wallet-transfer-destination-securities') === undefined, true);
  await h.press('wallet-transfer-destination-crypto_futures'); assert.equal(h.node('wallet-transfer-destination-options') === undefined, true);
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
  // A Futures side also refreshes the Futures screen's wallet balance and free collateral (its positions read).
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.quests('A'), QUERY_KEYS.tradingAccount.walletsAll('A'), ...(source === 'crypto_futures' || destination === 'crypto_futures'
    ? [QUERY_KEYS.tradingAccount.futuresCollateral('A'), QUERY_KEYS.tradingAccount.futures.positions('A')] : [])]);
});

for (const switches of [['B'], ['B', 'A']]) for (const failure of [false, true]) test(`late A ${failure ? 'failure' : 'success'} after ${switches.join('→')} cannot affect current form`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.gate = deferred(); await h.amount('100'); await h.press('wallet-transfer-submit');
  for (const account of switches) await h.switchAccount(account);
  if (failure) h.gate.reject(new Error('network')); else h.gate.resolve(); await h.flush();
  assert.equal(h.node('wallet-transfer-success') === undefined, true); assert.equal(h.node('wallet-transfer-error') === undefined, true);
  assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.quests('A'), QUERY_KEYS.tradingAccount.walletsAll('A')]);
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].path, '/trading-accounts/A/wallet-transfers');
  assert.equal(h.node('wallet-transfer-amount').props.value, '');
});

test('uncertain retry reuses the exact command even when refreshed cash reflects its debit', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = new Error('network'); await h.amount('500');
  await h.press('wallet-transfer-submit'); const first = h.requests[0];
  h.wallets.A.wallets.find(w => w.id === 'A:securities').balanceAmount = '600';
  await h.update();
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
  assert.equal(h.node('wallet-transfer-source-options') === undefined, true);
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
  else assert.equal(h.node('wallet-transfer-submit') === undefined, true);
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

for (const refreshedCollateral of ['10.00000000', null]) test(`Futures background refresh keeps its display but pauses new transfers until the new ${refreshedCollateral} result`, async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures'); await h.amount('20');
  const available = h.node('wallet-transfer-available').props.children;
  assert.equal(available, '이체 가능 금액: USD 25');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');

  const key = QUERY_KEYS.tradingAccount.futuresCollateral('A');
  const { act } = createRequire(import.meta.url)('react-test-renderer');
  h.riskGate = { A: deferred() };
  let refresh;
  await act(async () => { refresh = h.client.refetchQueries({ queryKey: key }); }); await h.flush();
  assert.equal(h.client.getQueryState(key).fetchStatus, 'fetching');
  assert.equal(h.node('wallet-transfer-available').props.children, available);
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  assert.doesNotMatch(text(h), /이체 가능 금액을 확인하고 있습니다/);

  h.risk.A = { ...h.risk.A, collateral: { ...h.risk.A.collateral, freeCollateral: refreshedCollateral } };
  h.riskGate.A.resolve(); await act(async () => { await refresh; }); await h.flush();
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  if (refreshedCollateral === null) {
    assert.doesNotMatch(h.node('wallet-transfer-available').props.children, /이체 가능 금액: USD/);
  } else {
    assert.equal(h.node('wallet-transfer-available').props.children, '이체 가능 금액: USD 10');
    await h.amount('10'); assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  }
});

test('Futures background refresh error blocks outgoing transfer even with cached valid collateral', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close); await h.choose('source', 'crypto_futures'); await h.amount('1');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
  const key = QUERY_KEYS.tradingAccount.futuresCollateral('A');
  const { act } = createRequire(import.meta.url)('react-test-renderer');
  h.riskFailure = new Error('PROVIDER_INTERNAL_FAILURE secret');
  await act(async () => { await h.client.refetchQueries({ queryKey: key }); }); await h.flush();
  assert.equal(h.client.getQueryState(key).status, 'error');
  assert.equal(h.client.getQueryData(key).collateral.freeCollateral, '25.00000000');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  assert.doesNotMatch(text(h), /PROVIDER_INTERNAL|secret|이체 가능 금액: USD/);
  await h.press('wallet-transfer-submit'); assert.equal(h.requests.length, 0);
  await h.choose('source', 'securities'); await h.choose('destination', 'crypto_futures');
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
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
  if (state === 'loading') assert.equal(h.node('wallet-transfer-available').props.children, '이체 가능 금액을 확인하고 있습니다.');
  await h.press('wallet-transfer-submit'); assert.equal(h.requests.length, 0);
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
  h.walletGate.A.resolve(); await h.flush(); assert.equal(h.node('wallet-transfer-submit') === undefined, true);
  h.walletGate.B.resolve(); await h.flush(); await h.amount('1'); await h.press('wallet-transfer-submit');
  assert.equal(h.requests[0].body.sourceWalletId, 'B:securities'); assert.deepEqual(h.invalidations, [QUERY_KEYS.tradingAccount.quests('B'), QUERY_KEYS.tradingAccount.walletsAll('B')]);
});

test('unverifiable response retries with the original key and never shows a false receipt', async t => {
  const h = walletTransferHarness(); h.response = {}; await h.start(); t.after(h.close);
  await h.amount('10'); await h.press('wallet-transfer-submit');
  assert.equal(h.node('wallet-transfer-success') === undefined, true);
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
  h.beforePost = () => { h.risk.A.collateral.freeCollateral = '0.00000000'; };
  await h.amount('10'); await h.press('wallet-transfer-submit');
  assert.match(text(h), /잔액이 부족합니다\./); assert.doesNotMatch(text(h), /SQL internal|http:\/\/secret|TOKEN/);
});

test('transfer clears the server insufficient error when a newer confirmed balance becomes sufficient', async t => {
  const h = walletTransferHarness(); await h.start(); t.after(h.close);
  h.failure = { response: { status: 409, data: { error: { code: 'INSUFFICIENT_AVAILABLE_BALANCE' } } } };
  h.beforePost = () => { h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '1000'; };
  await h.amount('10'); await h.press('wallet-transfer-submit');
  assert.match(text(h), /잔액이 부족합니다\./);
  assert.equal(h.node('wallet-transfer-submit').props.state, 'disabled');
  h.wallets.A.wallets.find(w => w.id === 'A:securities').reservedAmount = '0';
  const { act } = createRequire(import.meta.url)('react-test-renderer');
  await act(async () => { await h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.wallets('A') }); }); await h.flush();
  assert.doesNotMatch(text(h), /잔액이 부족/);
  assert.equal(h.node('wallet-transfer-submit').props.state, 'enabled');
});

for (const platform of ['web', 'android', 'ios']) test(`${platform}: focus hook measures input/CTA and dropdown blurs before dismiss`, async t => {
  const h = walletTransferHarness({ platform }); await h.start(); t.after(h.close);
  const scroll = h.node('wallet-transfer-screen');
  assert.equal(scroll.props.keyboardShouldPersistTaps, 'handled'); assert.equal(scroll.props.keyboardDismissMode, 'none'); assert.equal(scroll.props.scrollEventThrottle, 16);
  // The bottom sheet (InlineBottomSheet) owns keyboard room; a nested avoiding view would double it.
  assert.equal(h.renderer.root.findAllByType('KeyboardAvoidingView').length, 0);
  await h.focus(); h.keyboard('keyboardDidShow', 400); assert.deepEqual(h.scrolls.at(-1), { y: 214, animated: false });
  scroll.props.onScroll({ nativeEvent: { contentOffset: { y: 20 } } });
  scroll.props.onLayout(); h.flushFrames(); assert.deepEqual(h.scrolls.at(-1), { y: 234, animated: false });
  scroll.props.onContentSizeChange(); h.flushFrames(); assert.deepEqual(h.scrolls.at(-1), { y: 234, animated: false });
  h.events.length = 0; await h.press('wallet-transfer-source-selector'); assert.deepEqual(h.events, ['blur', 'dismiss']); assert.ok(h.node('wallet-transfer-source-options'));
  const before = h.scrolls.length; h.keyboard('keyboardDidShow', 350); assert.equal(h.scrolls.length, before);
  await h.focus(); assert.equal(h.node('wallet-transfer-source-options') === undefined, true);
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

test('the receipt offers 확인 and 마켓으로 가기; busy is reported while the command is in flight', async t => {
  const h = walletTransferHarness();
  const events: string[] = [];
  h.props = { onDone: () => events.push('done'), onGoMarket: () => events.push('market'), onBusyChange: (busy: boolean) => events.push(`busy:${busy}`) };
  h.gate = deferred();
  await h.start(); t.after(h.close);
  await h.amount('20'); await h.press('wallet-transfer-submit');
  assert.equal(events.includes('busy:true'), true, 'the sheet cannot be dismissed mid-command');
  assert.equal(h.node('wallet-transfer-success') === undefined, true, 'no receipt before the server answers');
  h.gate.resolve(); await h.flush();
  assert.equal(events.at(-1), 'busy:false');
  assert.ok(h.node('wallet-transfer-success'));
  const labels = h.renderer.root.findAll((n: any) => n.type === 'CTAButton').map((n: any) => n.props.label);
  assert.deepEqual(labels, ['확인', '마켓으로 가기']);
  await h.press('wallet-transfer-done'); await h.press('wallet-transfer-go-market');
  assert.deepEqual(events.slice(-2), ['done', 'market']);
  assert.equal(h.requests.length, 1, 'closing or leaving never re-executes');
});

// An order screen opens this sheet on its own wallet (2026-10-20 작업 2 · 3).
const selected = (h: any, kind: 'source' | 'destination') => h.node(`wallet-transfer-${kind}-selector`).props.accessibilityLabel as string;

test('an order screen picks the receiving wallet; the sending one is never the same wallet', async t => {
  for (const [initial, source, destination] of [
    [{ destination: 'crypto_futures' }, '증권 USD', '암호화폐 · 선물 USD'],
    [{ destination: 'securities' }, '암호화폐 · 현물 USD', '증권 USD'],
    [{ destination: 'crypto_spot', source: 'crypto_spot' }, '증권 USD', '암호화폐 · 현물 USD'],
    [{ source: 'crypto_futures', destination: 'securities', amount: '12.5' }, '암호화폐 · 선물 USD', '증권 USD'],
  ] as const) {
    const h = walletTransferHarness(); h.props = { initial }; await h.start(); t.after(h.close);
    assert.match(selected(h, 'source'), new RegExp(`: ${source}$`), JSON.stringify(initial));
    assert.match(selected(h, 'destination'), new RegExp(`: ${destination}$`), JSON.stringify(initial));
    assert.equal(h.node('wallet-transfer-amount').props.value, 'amount' in initial ? initial.amount : '');
    assert.equal(h.requests.length, 0, 'opening sends nothing');
  }
});

test('a host that returns on success gets the call after the server confirms; no 마켓으로 가기 without a host for it', async t => {
  let succeeded = 0;
  const h = walletTransferHarness(); h.props = { initial: { destination: 'crypto_futures' }, onSucceeded: () => { succeeded++; } };
  await h.start(); t.after(h.close);
  await h.amount('20');
  h.gate = deferred(); await h.press('wallet-transfer-submit');
  assert.equal(succeeded, 0, 'not before the answer');
  h.gate.resolve(); await h.flush();
  assert.equal(succeeded, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].body.destinationWalletId, 'A:crypto_futures');
  assert.equal(h.node('wallet-transfer-go-market') === undefined, true);
  // The Futures side refreshes the screen's own reads (collateral and positions).
  assert.ok(h.invalidations.some((key: unknown[]) => JSON.stringify(key) === JSON.stringify(QUERY_KEYS.tradingAccount.futures.positions('A'))));
});

test('환전하기 › appears while the sending 증권 USD wallet holds exactly nothing, and hands over the draft without sending', async t => {
  const drafts: unknown[] = [];
  const h = walletTransferHarness(); h.props = { onExchange: (draft: unknown) => drafts.push(draft) };
  h.wallets.A.wallets.find((w: any) => w.id === 'A:securities').balanceAmount = '0.00000000';
  h.wallets.A.wallets.find((w: any) => w.id === 'A:securities').reservedAmount = '0';
  await h.start(); t.after(h.close);
  assert.ok(h.node('wallet-transfer-exchange-row'));
  await h.amount('30');
  await h.press('wallet-transfer-exchange');
  assert.deepEqual(drafts, [{ source: 'securities', destination: 'crypto_spot', amount: '30' }]);
  assert.equal(h.requests.length, 0, 'the transfer is never sent by itself');
  // Another sending wallet, or money in 증권 USD (even if reserved), shows no link.
  await h.choose('source', 'crypto_futures');
  assert.equal(h.node('wallet-transfer-exchange-row') === undefined, true);
  const funded = walletTransferHarness(); funded.props = { onExchange: () => {} };
  funded.wallets.A.wallets.find((w: any) => w.id === 'A:securities').reservedAmount = '1000';
  await funded.start(); t.after(funded.close);
  assert.equal(funded.node('wallet-transfer-exchange-row') === undefined, true, 'reserved money is not an empty wallet');
});

test('the link needs a host that can open 환전, and a known balance', async t => {
  const plain = walletTransferHarness();
  plain.wallets.A.wallets.find((w: any) => w.id === 'A:securities').balanceAmount = '0';
  await plain.start(); t.after(plain.close);
  assert.equal(plain.node('wallet-transfer-exchange-row') === undefined, true);
  const failed = walletTransferHarness(); failed.props = { onExchange: () => {} };
  failed.wallets.A.wallets.find((w: any) => w.id === 'A:securities').balanceAmount = '0';
  failed.walletState = { isError: true, data: undefined, error: new Error('offline') };
  await failed.start(); t.after(failed.close);
  assert.equal(failed.node('wallet-transfer-exchange-row') === undefined, true);
});

test('back from 환전 the transfer says so above the form', async t => {
  const h = walletTransferHarness(); h.props = { notice: '환전이 완료되었습니다. 받은 금액을 확인한 뒤 이체하기를 다시 눌러주세요.' };
  await h.start(); t.after(h.close);
  assert.match(String(h.node('wallet-transfer-notice').props.children), /환전이 완료되었습니다/);
});
