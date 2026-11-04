import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');
const bridge = require('../../features/quest/questGuideBridge.ts');
const wallets = (currency: string, balance = '100', reserved = '30') => ({
  tradingAccountId: 'account-1', wallets: ['KRW', 'USD'].map(currencyCode => ({
    currencyCode, walletScope: 'securities', balanceAmount: currencyCode === currency ? balance : '999999',
    reservedAmount: currencyCode === currency ? reserved : '0',
  })),
});
// Types into one wallet's field: the paying wallet's unless a test types the other.
const field = (currency: string) => currency === 'USD' ? TEST_IDS.walletFx.usdAmountInput : TEST_IDS.walletFx.krwAmountInput;
const input = (h: any, value: string, currency = 'KRW') => {
  h.control(h.render(), field(currency)).props.onChangeText(value);
  return h.render();
};
const disabled = (h: any, tree = h.render()) => h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled;
const press = (h: any) => h.control(h.render(), TEST_IDS.walletFx.executeSubmit).props.onPress();

for (const mode of ['general', 'season', 'beginner']) for (const currency of ['KRW', 'USD']) {
  test(`${mode} ${currency}: spendable cash excludes reservations; exact balance is allowed`, () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    h.account.mode = mode;
    if (mode === 'season') h.account.season = { seasonId: 's', seasonStatus: 'active', participantStatus: 'active',
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 60000).toISOString() };
    h.walletQuery = { data: wallets(currency) };
    if (currency === 'USD') h.control(h.render(), TEST_IDS.walletFx.directionUsdKrw).props.onPress();
    let tree = input(h, '70.00000001', currency);
    assert.match(textContent(tree), /잔액이 부족합니다\./); assert.equal(disabled(h, tree), true);
    press(h); assert.equal(h.requests.length, 0);
    tree = input(h, '70', currency); assert.equal(disabled(h, tree), false);
    assert.doesNotMatch(textContent(tree), /잔액이 부족/);
    h.walletQuery.data = wallets(currency, '30', '30');
    tree = input(h, '0.00000001', currency); assert.equal(disabled(h, tree), true);
    assert.match(textContent(tree), /잔액이 부족합니다\./);
  });
}

test('FX never reports insufficient funds for malformed input or unknown/fetching/error balances', () => {
  for (const value of ['-1', '1e3', 'NaN', '0', '1,000', '1.000000001']) {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    const tree = input(h, value); assert.equal(disabled(h, tree), true);
    assert.doesNotMatch(textContent(tree), /잔액이 부족/);
  }
  for (const state of [
    { isFetching: true }, { isError: true }, { data: undefined },
    { data: wallets('KRW', 'NaN') }, { data: wallets('KRW', '10', '11') },
    { data: { tradingAccountId: 'account-1', wallets: [] } },
  ]) {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    input(h, '1'); h.walletQuery = state;
    const tree = h.render(); assert.doesNotMatch(textContent(tree), /잔액이 부족/);
    const button = elements(tree).find((node: any) => node.props.testID === TEST_IDS.walletFx.executeSubmit);
    assert.equal(!button || h.renderCta(button).props.disabled, true);
    assert.equal(h.requests.length, 0);
  }
});

test('FX rechecks before a new quote, and a fresh rejection sends no financial command', async () => {
  for (const state of [
    { data: wallets('KRW', '40', '0'), isError: false },
    { data: wallets('KRW'), isError: true },
  ]) {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    input(h, '50'); h.walletRefetch = async () => state;
    const submit = h.control(h.render(), TEST_IDS.walletFx.executeSubmit).props.onPress;
    submit(); submit(); await h.flush();
    assert.equal(h.requests.length, 0, 'no quote or execute on preflight failure');
    assert.match(textContent(h.render()), state.isError ? /사용 가능한 잔액을 확인하지 못/ : /잔액이 부족합니다\./);
  }
});

for (const code of ['INSUFFICIENT_BALANCE', 'INSUFFICIENT_AVAILABLE_BALANCE']) {
  test(`FX maps server ${code} to the requested message`, async () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    h.post = async () => { throw { response: { status: 409, data: { error: { code, message: 'private server detail' } } } }; };
    input(h, '50'); press(h); await h.flush();
    const tree = h.render(); assert.match(textContent(tree), /잔액이 부족합니다\./);
    assert.doesNotMatch(textContent(tree), /private server detail/);
  });
}

test('FX unknown execution retries its original quote and key despite a refreshed debit', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  const quote = { tradingAccountId: 'account-1', quoteId: 'quote', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '50' };
  let fail = true;
  h.post = async (path: string) => {
    if (path.endsWith('/quote')) return quote;
    if (fail) throw new Error('network');
    return { ...quote, exchangeId: 'fx', netTargetAmount: '0.037', wallets: { KRW: '0', USD: '100' } };
  };
  input(h, '50'); press(h); await h.flush();
  h.walletQuery = { data: wallets('KRW', '0', '0') };
  assert.equal(disabled(h), false, 'same command can reconcile its unknown outcome');
  assert.doesNotMatch(textContent(h.render()), /잔액이 부족/);
  fail = false; press(h); await h.flush();
  assert.equal(h.requests.length, 3); assert.deepEqual(h.requests[2], h.requests[1]);
  assert.equal(elements(h.render(), 'FxReceipt').length, 1);
});

test('FX pins a pending command to its submitting guide session', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  let session = 1; let claimed = 0;
  const dispose = bridge.setQuestGuideCommandSink(() => { claimed++; return true; }, () => session);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.walletRefetch = async () => { await gate; return { data: wallets('KRW'), isError: false }; };
  h.quote = { tradingAccountId: 'account-1', quoteId: 'q', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '50' };
  h.result = { ...h.quote, exchangeId: 'fx', netTargetAmount: '0.037', wallets: { KRW: '20', USD: '100' } };
  try {
    input(h, '50'); press(h); session = 2; release(); await h.flush();
    assert.equal(claimed, 0);
    assert.equal(elements(h.render(), 'FxReceipt').length, 1);
  } finally { dispose(); }
});

test('FX cannot complete a guide from an unidentifiable or different command receipt', async () => {
  for (const corrupt of [{ exchangeId: '' }, { quoteId: 'another-quote' }, { sourceAmount: '51' }, { fromCurrency: 'USD', toCurrency: 'KRW' }]) {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    h.quote = { tradingAccountId: 'account-1', quoteId: 'q', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '50' };
    h.result = { ...h.quote, exchangeId: 'fx', netTargetAmount: '0.037', wallets: { KRW: '20', USD: '100' }, ...corrupt };
    let claims = 0;
    const dispose = bridge.setQuestGuideCommandSink(() => { claims++; return true; }, () => 1);
    try { input(h, '50'); press(h); await h.flush(); assert.equal(claims, 0); }
    finally { dispose(); }
  }
});

test('FX clears an insufficient rejection after a newer wallet read proves enough funds', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  h.walletQuery = { data: wallets('KRW'), dataUpdatedAt: 1 };
  h.post = async () => { throw { response: { status: 409, data: { error: { code: 'INSUFFICIENT_BALANCE' } } } }; };
  input(h, '50'); press(h); await h.flush();
  assert.match(textContent(h.render()), /잔액이 부족합니다\./);
  h.walletQuery = { data: wallets('KRW', '200', '0'), dataUpdatedAt: 2 };
  h.render();
  assert.doesNotMatch(textContent(h.render()), /잔액이 부족/);
  assert.equal(disabled(h), false);
});

// ── 2026-11-04: KRW/USD wallets with arrows, either amount typed, ratio bar ──
const { fxSourceForTarget } = require('../../features/tradingAccount/indicativePreview.ts');
const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {};
const value = (h: any, currency: string, tree = h.render()) => h.control(tree, field(currency)).props.value;
const arrows = (tree: any, h: any) => [TEST_IDS.walletFx.directionKrwUsd, TEST_IDS.walletFx.directionUsdKrw].map((id) => h.control(tree, id));
const slider = (tree: any) => elements(tree, 'input').find((node: any) => node.props['data-testid'] === 'wallet-fx-ratio-slider');
const twoWallets = (krw: [string, string], usd: [string, string]) => ({ tradingAccountId: 'account-1', wallets: [
  { currencyCode: 'KRW', walletScope: 'securities', balanceAmount: krw[0], reservedAmount: krw[1] },
  { currencyCode: 'USD', walletScope: 'securities', balanceAmount: usd[0], reservedAmount: usd[1] },
] });
const quoteOf = (body: any) => ({ tradingAccountId: 'account-1', quoteId: `quote-${body.fromCurrency}-${body.sourceAmount}`, ...body });
const rejected = (code: string) => ({ response: { status: 409, data: { error: { code } } } });
const needed = (target: string, fromCurrency: string, rate = '1350') => fxSourceForTarget({ target, fromCurrency, feeRate: '0.001', now: Date.now(),
  rate: { state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate, validUntil: new Date(Date.now() + 60000).toISOString() } }).replace(/\.?0+$/u, '');

test('KRW stays on top and USD below; two arrows with no words pick the direction', () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  let tree = h.render();
  const order = () => [...new Set(elements(tree).map((node: any) => node.props.testID)
    .filter((id: string) => ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd'].includes(id)))];
  const roles = () => [field('KRW'), field('USD')].map((id) => h.control(tree, id).props.accessibilityLabel);
  assert.deepEqual(order(), ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd']);
  for (const arrow of arrows(tree, h)) {
    assert.equal(textContent(arrow), '', 'an arrow only');
    assert.equal(elements(arrow, 'Svg').length, 1);
    assert.equal(arrow.props.accessibilityRole, 'radio');
  }
  assert.deepEqual(arrows(tree, h).map((arrow: any) => arrow.props.accessibilityLabel), ['KRW에서 USD로 환전', 'USD에서 KRW로 환전']);
  assert.deepEqual(arrows(tree, h).map((arrow: any) => [arrow.props['aria-checked'], arrow.props.accessibilityState.checked]), [[true, true], [false, false]]);
  const [down, up] = arrows(tree, h).map((arrow: any) => flat(arrow.props.style));
  assert.notEqual(down.backgroundColor, up.backgroundColor, 'the selected arrow is filled');
  assert.notEqual(down.borderColor, up.borderColor, 'and outlined');
  assert.deepEqual(roles(), ['KRW 보낼 금액', 'USD 받을 금액 (예상)']);
  h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
  tree = h.render();
  assert.deepEqual(order(), ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd'], 'the wallets never move');
  assert.deepEqual(arrows(tree, h).map((arrow: any) => arrow.props['aria-checked']), [false, true]);
  assert.deepEqual(roles(), ['KRW 받을 금액 (예상)', 'USD 보낼 금액']);
  // The quest's amount target is the paying wallet's field.
  assert.equal(h.control(tree, field('USD')).props.ref, bridge.questGuideTarget('fx-amount'));
  assert.equal(h.control(tree, field('KRW')).props.ref, undefined);
});

for (const from of ['KRW', 'USD']) {
  test(`${from} pays: an amount typed to receive computes the amount to pay, which is what the quote sends`, async () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    const to = from === 'KRW' ? 'USD' : 'KRW';
    if (from === 'USD') h.control(h.render(), TEST_IDS.walletFx.directionUsdKrw).props.onPress();
    const typed = from === 'KRW' ? '50' : '100000';
    let tree = input(h, typed, to);
    const paid = value(h, from, tree);
    assert.equal(paid, needed(typed, from));
    assert.equal(value(h, to, tree), typed, 'the typed field stays as typed');
    assert.match(textContent(tree), /받을 금액에 맞춰 보낼 금액을 계산했습니다\./);
    assert.equal(disabled(h, tree), false);
    h.post = async (url: string, body: any) => url.endsWith('/quote') ? quoteOf(body)
      : { ...quoteOf(body), exchangeId: 'fx', netTargetAmount: typed, wallets: { KRW: '1', USD: '1' } };
    press(h); await h.flush();
    assert.deepEqual(h.requests[0], { url: '/trading-accounts/account-1/fx/quote', body: { fromCurrency: from, toCurrency: to, sourceAmount: paid } });
    assert.deepEqual(h.requests[1].body, { quoteId: `quote-${from}-${paid}`, fromCurrency: from, toCurrency: to, sourceAmount: paid,
      idempotencyKey: h.requests[1].body.idempotencyKey });
    tree = h.render();
    assert.equal(elements(tree, 'FxReceipt').length, 1);
  });
}

test('a direction change recomputes the typed amount for the new direction and never resends the old command', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  h.post = async (url: string, body: any) => { if (url.endsWith('/quote')) return quoteOf(body); throw rejected('INSUFFICIENT_BALANCE'); };
  input(h, '100000');
  press(h); await h.flush();
  assert.deepEqual(h.requests.map((request: any) => request.url.split('/').pop()), ['quote', 'execute']);
  h.control(h.render(), TEST_IDS.walletFx.directionUsdKrw).props.onPress();
  let tree = h.render();
  // The same 100,000 is now the amount to receive; USD pays what it costs.
  assert.equal(value(h, 'KRW', tree), '100000');
  assert.equal(value(h, 'USD', tree), needed('100000', 'USD'));
  assert.doesNotMatch(textContent(tree), /잔액이 부족/, 'the old direction\'s rejection is gone');
  press(h); await h.flush();
  assert.deepEqual(h.requests[2], { url: '/trading-accounts/account-1/fx/quote',
    body: { fromCurrency: 'USD', toCurrency: 'KRW', sourceAmount: needed('100000', 'USD') } });
  assert.equal(h.requests[3].body.quoteId, `quote-USD-${needed('100000', 'USD')}`);
  assert.notEqual(h.requests[3].body.idempotencyKey, h.requests[1].body.idempotencyKey);
  tree = h.render();
  assert.equal(value(h, 'KRW', tree), '100000', 'still the amount to receive');
});

test('an amount to receive is converted again at a new rate: a kept command for the old amount is replaced, never resent', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  h.post = async (url: string, body: any) => { if (url.endsWith('/quote')) return quoteOf(body); throw rejected('INSUFFICIENT_BALANCE'); };
  input(h, '50', 'USD');
  press(h); await h.flush();
  const first = h.requests[0].body.sourceAmount;
  h.rateQuery.data = { ...h.rateQuery.data, rate: '1400' };
  const tree = h.render();
  assert.equal(value(h, 'USD', tree), '50');
  assert.equal(value(h, 'KRW', tree), needed('50', 'KRW', '1400'));
  assert.notEqual(value(h, 'KRW', tree), first);
  press(h); await h.flush();
  assert.equal(h.requests[2].url, '/trading-accounts/account-1/fx/quote');
  assert.equal(h.requests[2].body.sourceAmount, needed('50', 'KRW', '1400'));
  assert.notEqual(h.requests[3].body.idempotencyKey, h.requests[1].body.idempotencyKey, 'a new intent, a new key');
});

test('an unknown outcome keeps its command: the form shows what it pays and retries exactly it', async () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  let fail = true;
  h.post = async (url: string, body: any) => {
    if (url.endsWith('/quote')) return quoteOf(body);
    if (fail) throw new Error('network');
    return { ...body, tradingAccountId: 'account-1', exchangeId: 'fx', netTargetAmount: '50', wallets: { KRW: '1', USD: '1' } };
  };
  input(h, '50', 'USD');
  press(h); await h.flush();
  const paid = h.requests[0].body.sourceAmount;
  h.rateQuery.data = { ...h.rateQuery.data, rate: '1400' };
  let tree = h.render();
  // The amount to pay is the command's own now; only the estimate moves.
  assert.equal(value(h, 'KRW', tree), paid);
  assert.notEqual(value(h, 'USD', tree), '50');
  assert.equal(disabled(h, tree), false, 'the same command can reconcile its outcome');
  fail = false;
  press(h); await h.flush();
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests[2], h.requests[1]);
  tree = h.render();
  assert.equal(elements(tree, 'FxReceipt').length, 1);
});

test('the ratio bar sizes the paying wallet\'s spendable amount; a typed amount moves it back', () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  // KRW spendable 800,000.5 (200,000 reserved); USD spendable 70.
  h.walletQuery = { data: twoWallets(['1000000.5', '200000'], ['100', '30']) };
  let tree = h.render();
  const pick = (percent: number) => { h.control(h.render(), `wallet-fx-ratio-${percent}`).props.onPress(); tree = h.render(); };
  const percent = () => textContent(h.control(tree, 'wallet-fx-ratio-percent'));
  assert.equal(textContent(h.control(tree, 'fx-wallet-krw-spendable')), '사용 가능 800,000원', 'balance − reserved, rounded down');
  for (const [ratio, amount] of [[25, '200000.125'], [50, '400000.25'], [75, '600000.375'], [100, '800000.5']] as const) {
    pick(ratio);
    assert.deepEqual([value(h, 'KRW', tree), percent(), h.control(tree, `wallet-fx-ratio-${ratio}`).props['aria-pressed']], [amount, `${ratio}%`, true], String(ratio));
    assert.notEqual(value(h, 'USD', tree), '', 'the amount to receive follows');
  }
  assert.equal(disabled(h, tree), false, '100% is exactly spendable, never more');
  assert.doesNotMatch(textContent(tree), /잔액이 부족/);
  slider(tree).props.onChange({ currentTarget: { valueAsNumber: 0 } });
  tree = h.render();
  assert.deepEqual([value(h, 'KRW', tree), value(h, 'USD', tree), percent(), disabled(h, tree)], ['', '', '0%', true]);
  slider(tree).props.onChange({ currentTarget: { valueAsNumber: 37 } });
  tree = h.render();
  assert.equal(value(h, 'KRW', tree), '296000.185');
  // Typing moves the thumb; an amount to receive moves it by what it costs.
  tree = input(h, '400000.25');
  assert.deepEqual([slider(tree).props.value, percent()], [50, '50%']);
  tree = input(h, '1', 'USD');
  assert.equal(slider(tree).props.value, Math.round(Number(needed('1', 'KRW')) / 800000.5 * 100));
  // USD pays: the bar is the USD wallet's 70.
  h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
  pick(50);
  assert.equal(value(h, 'USD', tree), '35');
  h.walletQuery = { data: twoWallets(['1000000.5', '200000'], ['30', '30']) };
  tree = h.render();
  assert.equal(slider(tree).props.disabled, true);
  assert.equal(textContent(h.control(tree, 'wallet-fx-ratio-reason')), '보내는 지갑에 사용 가능한 금액이 없습니다.');
  assert.equal(h.control(tree, 'wallet-fx-ratio-100').props.disabled, true);
  assert.equal(h.requests.length, 0, 'sizing never sends anything');
});

test('an amount to receive that would pay more than the wallet holds is insufficient and sends nothing', () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  h.control(h.render(), TEST_IDS.walletFx.directionUsdKrw).props.onPress();
  const tree = input(h, '200000', 'KRW');
  assert.ok(Number(value(h, 'USD', tree)) > 100);
  assert.match(textContent(tree), /잔액이 부족합니다\./);
  assert.equal(disabled(h, tree), true);
  press(h);
  assert.equal(h.requests.length, 0);
});

test('a malformed amount to receive is explained and computes nothing', () => {
  for (const typed of ['1e3', '0', '1.000000001', '-5']) {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    const tree = input(h, typed, 'USD');
    assert.equal(value(h, 'USD', tree), typed);
    assert.equal(value(h, 'KRW', tree), '');
    assert.match(textContent(tree), /0보다 큰 금액을 소수점 이하 8자리까지 입력해주세요\./);
    assert.equal(disabled(h, tree), true);
  }
});
