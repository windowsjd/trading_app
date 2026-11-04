import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { formatKstDateTime } from '../../utils/format.ts';

const flat = (style: unknown): Record<string, unknown> =>
  Array.isArray(style) ? Object.assign({}, ...style.map(flat)) : (style as Record<string, unknown>) ?? {};

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');

const receipt = load(resolve('src/screens/wallet/FxReceipt.tsx'), {
  'react-native': { View: 'View', Text: 'Text', StyleSheet: { create: (styles: unknown) => styles } },
  '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
}).default;

/** One KRW → USD exchange through the panel, to its receipt. */
async function exchange(h: any) {
  h.quote = { tradingAccountId: 'account-1', quoteId: 'quote-1', fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: '100000' };
  h.result = { ...h.quote, exchangeId: 'exchange-1', wallets: { KRW: '900000', USD: '173.82' } };
  h.control(h.render(), TEST_IDS.walletFx.krwAmountInput).props.onChangeText('100000');
  h.control(h.render(), TEST_IDS.walletFx.executeSubmit).props.onPress();
  await h.flush();
  return h.render();
}

// KRW on top and USD below, each card its name and spendable amount in one row
// (a long amount wraps, never clips), then the amount field; the arrows sit
// between them, and the rate is the estimate's first row. No title, account
// name, USD→KRW conversion, capture time or other side notes.
function assertCleanRateDisplay(h: any, tree: any, rate = '1350') {
  const scroll = elements(tree, 'ScrollView').find((node: any) => node.props.testID === TEST_IDS.walletFx.screen);
  const order = elements(scroll).map((node: any) => node.props.testID)
    .filter((id: string) => ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd', 'wallet-fx-ratio', 'fx-indicative-preview', TEST_IDS.walletFx.executeSubmit].includes(id));
  assert.deepEqual([...new Set(order)], ['fx-wallet-krw', 'wallet-fx-direction-row', 'fx-wallet-usd', 'wallet-fx-ratio', 'fx-indicative-preview', TEST_IDS.walletFx.executeSubmit]);
  const header = (id: string) => {
    const card = elements(tree, 'View').find((node: any) => node.props.testID === id);
    const row = elements(card, 'View').find((node: any) => flat(node.props.style).flexWrap === 'wrap');
    return { texts: elements(row, 'Text').map((text: any) => textContent(text)), style: flat(row.props.style) };
  };
  assert.deepEqual(header('fx-wallet-krw').texts, ['KRW Wallet', '사용 가능 1,000,000원']);
  assert.deepEqual(header('fx-wallet-usd').texts, ['USD Wallet', '사용 가능 $100']);
  const estimate = elements(tree).find((node: any) => node.props.testID === 'fx-indicative-preview');
  assert.deepEqual(elements(estimate, 'PreviewAmounts')[0].props.rows[0].value, rate);
  const text = textContent(tree);
  for (const hidden of ['지갑 요약', '일반모드', 'USD 환산', '수집 시각', formatKstDateTime(h.rateQuery.data.capturedAt),
    '대체 환율', '원장 보기', '기준 시각', '최신성', '최신 환율 기준', '2026-01-01']) {
    assert.ok(!text.includes(hidden), hidden);
  }
  assert.equal(elements(tree).some((node: any) => node.type === 'AccountSwitcher'), false, 'no account switcher on FX');
}

it('keeps the rate row in place from loading to arrival without a placeholder number', () => {
  const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
  const rate = h.rateQuery.data;
  h.rateQuery = { data: undefined, isLoading: true, isError: false };
  const rateRow = () => elements(elements(h.render()).find((node: any) => node.props.testID === 'fx-indicative-preview'), 'PreviewAmounts')[0].props.rows[0];
  assert.deepEqual([rateRow().label, rateRow().value], ['적용 환율 (USD/KRW)', '불러오는 중']);
  h.rateQuery = { data: rate, isLoading: false, isError: false };
  assert.deepEqual([rateRow().label, rateRow().value], ['적용 환율 (USD/KRW)', '1350']);
  assertCleanRateDisplay(h, h.render());
});

describe('FX screen information display', () => {
  it('the receipt offers 마켓으로 가기 only where its host has one (the Wallet, not an order screen)', async () => {
    for (const onGoMarket of [() => {}, undefined]) {
      const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
      h.screenProps = { onGoMarket };
      const success = elements(await exchange(h), 'FxReceipt');
      assert.equal(success.length, 1);
      assert.equal(success[0].props.onGoMarket, onGoMarket);
      assert.equal(success[0].props.onGoHome, undefined);
      assert.equal(h.navigation.length, 0, 'the panel itself navigates nowhere');
      const tree = receipt({ onDone() {}, onGoMarket, payload: h.result });
      // FX and transfer receipts share the pair 확인 / 마켓으로 가기.
      assert.deepEqual(elements(tree, 'CTAButton').map((node: any) => node.props.label), onGoMarket ? ['확인', '마켓으로 가기'] : ['확인']);
    }
  });

  it('a host continuing elsewhere takes the committed result; 확인 closes through the host', async () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    const taken: unknown[] = [];
    h.screenProps = { onExchanged: (result: unknown) => taken.push(result) };
    const tree = await exchange(h);
    assert.equal(taken.length, 1);
    assert.equal(taken[0] === h.result, true);
    assert.equal(elements(tree, 'FxReceipt').length, 0, 'the host shows what comes next, not this receipt');
    // Without one, 확인 on the receipt goes through onDone (the sheet closes).
    let done = 0;
    const host = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    host.screenProps = { onDone: () => { done++; } };
    elements(await exchange(host), 'FxReceipt')[0].props.onDone();
    assert.equal(done, 1);
  });

  it('keeps the current rate and captured timestamp with empty and filled inputs', () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    let tree = h.render();
    assertCleanRateDisplay(h, tree);
    h.control(tree, TEST_IDS.walletFx.krwAmountInput).props.onChangeText('100000');
    tree = h.render();
    assertCleanRateDisplay(h, tree);
    assert.match(textContent(tree), /예상 환전 견적/);
    const rows = elements(tree, 'PreviewAmounts')[0].props.rows;
    assert.deepEqual(rows.map((row: any) => row.label), ['적용 환율 (USD/KRW)', '예상 수수료', '예상 수령액']);
    assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, false);
    assert.equal(h.queries.find((query: any) => query.queryKey[1] === 'fx-rate').refetchInterval, 300000);
  });

  for (const status of ['suspended', 'closed']) {
    it(`removes the ledger CTA from the ${status} exchange branch and keeps the restriction`, () => {
      const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
      h.account.status = status;
      const tree = h.render();
      assert.match(textContent(tree), /환전이 제한된 계정입니다/);
      assert.doesNotMatch(textContent(tree), /원장 보기/);
      assert.equal(elements(tree, 'CTAButton').length, 0);
    });
  }

  it('retains unavailable-rate handling and disables execution without a ledger CTA', () => {
    const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
    h.rateQuery.isError = true;
    const tree = h.render();
    assert.match(textContent(tree), /현재 환율을 사용할 수 없어/);
    assert.ok(elements(tree, 'CTAButton').some((node: any) => node.props.label === '환율 다시 불러오기'));
    assert.ok(!elements(tree, 'CTAButton').some((node: any) => node.props.label === '원장 보기'));
    assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, true);
  });

  for (const fromCurrency of ['KRW', 'USD']) {
    it(`keeps ${fromCurrency} quote → execute data and shows the successful response`, async () => {
      const h = createTradingUiHarness('wallet/WalletFxSheet.tsx');
      const toCurrency = fromCurrency === 'KRW' ? 'USD' : 'KRW';
      const sourceAmount = fromCurrency === 'KRW' ? '100000' : '10.5';
      h.quote = { tradingAccountId: 'account-1', quoteId: 'quote-1', fromCurrency, toCurrency, sourceAmount };
      h.result = { ...h.quote, exchangeId: 'exchange-1', wallets: { KRW: '900000', USD: '173.82' } };
      let tree = h.render();
      if (fromCurrency === 'USD') {
        h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
        tree = h.render();
      }
      h.control(tree, fromCurrency === 'KRW' ? TEST_IDS.walletFx.krwAmountInput : TEST_IDS.walletFx.usdAmountInput).props.onChangeText(sourceAmount);
      tree = h.render();
      const execute = h.control(tree, TEST_IDS.walletFx.executeSubmit);
      assert.equal(h.renderCta(execute).props.disabled, false);
      execute.props.onPress();
      await h.flush();
      assert.equal(h.requests.length, 2);
      assert.deepEqual(h.requests[0], { url: '/trading-accounts/account-1/fx/quote',
        body: { fromCurrency, toCurrency, sourceAmount } });
      assert.equal(h.requests[1].url, '/trading-accounts/account-1/fx/execute');
      assert.deepEqual(h.requests[1].body, { quoteId: 'quote-1', fromCurrency, toCurrency, sourceAmount,
        idempotencyKey: h.requests[1].body.idempotencyKey });
      assert.ok(h.requests[1].body.idempotencyKey);
      tree = h.render();
      const success = elements(tree, 'FxReceipt');
      assert.equal(success.length, 1);
      assert.strictEqual(success[0].props.payload, h.result);
      // The receipt stands in for the form inside the sheet's scroll (a short
      // screen scrolls to every row): no second execute while it is shown.
      const scroll = elements(tree, 'ScrollView').find((node: any) => node.props.testID === TEST_IDS.walletFx.screen);
      assert.equal(elements(scroll, 'FxReceipt').length, 1);
      assert.equal(elements(tree).some((node: any) => node.props.testID === TEST_IDS.walletFx.executeSubmit), false);
      // 확인 (no host) returns to an empty form that cannot execute again.
      success[0].props.onDone();
      tree = h.render();
      assert.equal(elements(tree, 'FxReceipt').length, 0);
      for (const field of [TEST_IDS.walletFx.krwAmountInput, TEST_IDS.walletFx.usdAmountInput])
        assert.equal(h.control(tree, field).props.value, '', field);
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, true);
    });
  }
});

describe('FX receipt rows', () => {
  for (const fromCurrency of ['KRW', 'USD']) {
    it(`renders exactly the eight requested rows for ${fromCurrency}`, () => {
      const toCurrency = fromCurrency === 'KRW' ? 'USD' : 'KRW';
      const tree = receipt({ onDone: () => {}, onGoMarket: () => {},
        payload: { fromCurrency, toCurrency,
          sourceAmount: fromCurrency === 'KRW' ? '100000' : '10.5',
          netTargetAmount: toCurrency === 'USD' ? '73.82' : '14029.70625',
          appliedRate: '1350.00000000', feeAmount: '14.04375', feeCurrency: toCurrency,
          executedAt: '2026-08-25T03:44:48.000Z', wallets: { KRW: '900000', USD: '173.82' },
          exchangeId: 'hidden-exchange', quotedRate: '1349', executeRate: '1351', rateChangeBps: '15',
          sourceWalletBalanceAfter: '999999', targetWalletBalanceAfter: '888888' },
      });
      const rows = elements(tree).filter((node: any) => typeof node.type === 'function' && node.props.label);
      assert.deepEqual(rows.map((node: any) => node.props.label), [
        '환전 방향', '환전 금액', '수령 금액', '적용 환율', '수수료', '실행 시각', 'KRW 지갑 잔액', 'USD 지갑 잔액',
      ]);
      const values = Object.fromEntries(rows.map((node: any) => [node.props.label, node.props.value]));
      assert.equal(values['환전 금액'], fromCurrency === 'KRW' ? 'KRW 100,000' : 'USD 10.5');
      assert.equal(values['수령 금액'], toCurrency === 'USD' ? 'USD 73.82' : 'KRW 14,030');
      assert.equal(values['적용 환율'], '1350');
      assert.equal(values['실행 시각'], '2026-08-25 12:44');
      assert.equal(values['KRW 지갑 잔액'], '900,000');
      assert.equal(values['USD 지갑 잔액'], '173.82');
      assert.equal(values['수수료'], toCurrency === 'USD' ? '$14.04' : '14원');
      // Inside the 환전 sheet: no scroll or modal of its own (the sheet's scroll holds it).
      assert.equal(elements(tree, 'ScrollView').length, 0);
      assert.equal(tree.props.testID, 'fx-success');
      const renderedRow = rows[6].type(rows[6].props);
      assert.equal(elements(renderedRow, 'Text')[0].props.numberOfLines, undefined);
      assert.equal(elements(renderedRow, 'Text')[1].props.numberOfLines, undefined);
    });
  }
});
