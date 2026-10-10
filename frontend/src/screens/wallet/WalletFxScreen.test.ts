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
const input = (h: any, value: string) => {
  h.control(h.render(), TEST_IDS.walletFx.amountInput).props.onChangeText(value);
  return h.render();
};
const disabled = (h: any, tree = h.render()) => h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled;
const press = (h: any) => h.control(h.render(), TEST_IDS.walletFx.executeSubmit).props.onPress();

for (const mode of ['general', 'season', 'beginner']) for (const currency of ['KRW', 'USD']) {
  test(`${mode} ${currency}: spendable cash excludes reservations; exact balance is allowed`, () => {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    h.account.mode = mode;
    if (mode === 'season') h.account.season = { seasonId: 's', seasonStatus: 'active', participantStatus: 'active',
      startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 60000).toISOString() };
    h.walletQuery = { data: wallets(currency) };
    if (currency === 'USD') h.control(h.render(), TEST_IDS.walletFx.directionUsdKrw).props.onPress();
    let tree = input(h, '70.00000001');
    assert.match(textContent(tree), /잔액이 부족합니다\./); assert.equal(disabled(h, tree), true);
    press(h); assert.equal(h.requests.length, 0);
    tree = input(h, '70'); assert.equal(disabled(h, tree), false);
    assert.doesNotMatch(textContent(tree), /잔액이 부족/);
    h.walletQuery.data = wallets(currency, '30', '30');
    tree = input(h, '0.00000001'); assert.equal(disabled(h, tree), true);
    assert.match(textContent(tree), /잔액이 부족합니다\./);
  });
}

test('FX never reports insufficient funds for malformed input or unknown/fetching/error balances', () => {
  for (const value of ['-1', '1e3', 'NaN', '0', '1,000', '1.000000001']) {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    const tree = input(h, value); assert.equal(disabled(h, tree), true);
    assert.doesNotMatch(textContent(tree), /잔액이 부족/);
  }
  for (const state of [
    { isFetching: true }, { isError: true }, { data: undefined },
    { data: wallets('KRW', 'NaN') }, { data: wallets('KRW', '10', '11') },
    { data: { tradingAccountId: 'account-1', wallets: [] } },
  ]) {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
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
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    input(h, '50'); h.walletRefetch = async () => state;
    const submit = h.control(h.render(), TEST_IDS.walletFx.executeSubmit).props.onPress;
    submit(); submit(); await h.flush();
    assert.equal(h.requests.length, 0, 'no quote or execute on preflight failure');
    assert.match(textContent(h.render()), state.isError ? /사용 가능한 잔액을 확인하지 못/ : /잔액이 부족합니다\./);
  }
});

for (const code of ['INSUFFICIENT_BALANCE', 'INSUFFICIENT_AVAILABLE_BALANCE']) {
  test(`FX maps server ${code} to the requested message`, async () => {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    h.post = async () => { throw { response: { status: 409, data: { error: { code, message: 'private server detail' } } } }; };
    input(h, '50'); press(h); await h.flush();
    const tree = h.render(); assert.match(textContent(tree), /잔액이 부족합니다\./);
    assert.doesNotMatch(textContent(tree), /private server detail/);
  });
}

test('FX unknown execution retries its original quote and key despite a refreshed debit', async () => {
  const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
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
  assert.equal(elements(h.render(), 'FxSuccessBottomSheet')[0].props.visible, true);
});

test('FX pins a pending command to its submitting guide session', async () => {
  const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
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
    assert.equal(elements(h.render(), 'FxSuccessBottomSheet')[0].props.visible, true);
  } finally { dispose(); }
});

test('FX cannot complete a guide from an unidentifiable or different command receipt', async () => {
  for (const corrupt of [{ exchangeId: '' }, { quoteId: 'another-quote' }, { sourceAmount: '51' }, { fromCurrency: 'USD', toCurrency: 'KRW' }]) {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    h.quote = { tradingAccountId: 'account-1', quoteId: 'q', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '50' };
    h.result = { ...h.quote, exchangeId: 'fx', netTargetAmount: '0.037', wallets: { KRW: '20', USD: '100' }, ...corrupt };
    let claims = 0;
    const dispose = bridge.setQuestGuideCommandSink(() => { claims++; return true; }, () => 1);
    try { input(h, '50'); press(h); await h.flush(); assert.equal(claims, 0); }
    finally { dispose(); }
  }
});

test('FX clears an insufficient rejection after a newer wallet read proves enough funds', async () => {
  const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
  h.walletQuery = { data: wallets('KRW'), dataUpdatedAt: 1 };
  h.post = async () => { throw { response: { status: 409, data: { error: { code: 'INSUFFICIENT_BALANCE' } } } }; };
  input(h, '50'); press(h); await h.flush();
  assert.match(textContent(h.render()), /잔액이 부족합니다\./);
  h.walletQuery = { data: wallets('KRW', '200', '0'), dataUpdatedAt: 2 };
  h.render();
  assert.doesNotMatch(textContent(h.render()), /잔액이 부족/);
  assert.equal(disabled(h), false);
});
