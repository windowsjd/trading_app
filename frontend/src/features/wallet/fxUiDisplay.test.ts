import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { formatKstDateTime } from '../../utils/format.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');

const sheet = load(resolve('src/screens/wallet/FxSuccessBottomSheet.tsx'), {
  'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    StyleSheet: { create: (styles: unknown) => styles }, useWindowDimensions: () => ({ height: 480 }) },
  '../../components/common/BottomSheetBackdrop': { default: 'BottomSheetBackdrop', __esModule: true },
  '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
}).default;

function assertCleanRateDisplay(h: any, tree: any) {
  const text = textContent(tree);
  assert.match(text, /환율 1350/);
  assert.ok(text.includes(`수집 시각 ${formatKstDateTime(h.rateQuery.data.capturedAt)}`));
  for (const hidden of ['원장 보기', '기준 시각', '최신성', '최신 환율 기준', '2026-01-01']) {
    assert.ok(!text.includes(hidden), hidden);
  }
}

describe('FX screen information display', () => {
  it('keeps the current rate and captured timestamp with empty and filled inputs', () => {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    let tree = h.render();
    assertCleanRateDisplay(h, tree);
    h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText('100000');
    tree = h.render();
    assertCleanRateDisplay(h, tree);
    assert.match(textContent(tree), /예상 환전 견적/);
    const rows = elements(tree, 'PreviewAmounts')[0].props.rows;
    assert.deepEqual(rows.map((row: any) => row.label), ['적용 환율 (USD/KRW)', '예상 수수료', '예상 수령액']);
    assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, false);
    assert.equal(h.queries.find((query: any) => query.queryKey[1] === 'fx-rate').refetchInterval, 60000);
  });

  for (const status of ['suspended', 'closed']) {
    it(`removes the ledger CTA from the ${status} exchange branch and keeps the restriction`, () => {
      const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
      h.account.status = status;
      const tree = h.render();
      assert.match(textContent(tree), /환전이 제한된 계정입니다/);
      assert.doesNotMatch(textContent(tree), /원장 보기/);
      assert.equal(elements(tree, 'CTAButton').length, 0);
    });
  }

  it('retains unavailable-rate handling and disables execution without a ledger CTA', () => {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    h.rateQuery.isError = true;
    const tree = h.render();
    assert.match(textContent(tree), /현재 환율을 사용할 수 없어/);
    assert.ok(elements(tree, 'CTAButton').some((node: any) => node.props.label === '환율 다시 불러오기'));
    assert.ok(!elements(tree, 'CTAButton').some((node: any) => node.props.label === '원장 보기'));
    assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, true);
  });

  for (const fromCurrency of ['KRW', 'USD']) {
    it(`keeps ${fromCurrency} quote → execute data and shows the successful response`, async () => {
      const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
      const toCurrency = fromCurrency === 'KRW' ? 'USD' : 'KRW';
      const sourceAmount = fromCurrency === 'KRW' ? '100000' : '10.5';
      h.quote = { tradingAccountId: 'account-1', quoteId: 'quote-1', fromCurrency, toCurrency, sourceAmount };
      h.result = { ...h.quote, exchangeId: 'exchange-1', wallets: { KRW: '900000', USD: '173.82' } };
      let tree = h.render();
      if (fromCurrency === 'USD') {
        h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
        tree = h.render();
      }
      h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText(sourceAmount);
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
      const success = elements(tree, 'FxSuccessBottomSheet')[0];
      assert.equal(success.props.visible, true);
      assert.strictEqual(success.props.payload, h.result);
      assert.equal(h.control(tree, TEST_IDS.walletFx.amountInput).props.value, '');
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.walletFx.executeSubmit)).props.disabled, true);
    });
  }
});

describe('FX completion sheet rows', () => {
  for (const fromCurrency of ['KRW', 'USD']) {
    it(`renders exactly the eight requested rows for ${fromCurrency} on a short viewport`, () => {
      const toCurrency = fromCurrency === 'KRW' ? 'USD' : 'KRW';
      const tree = sheet({ visible: true, onClose: () => {}, onGoWallet: () => {}, onGoHome: () => {},
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
      const scroll = elements(tree, 'ScrollView')[0];
      assert.equal(scroll.props.style.maxHeight, 384);
      const renderedRow = rows[6].type(rows[6].props);
      assert.equal(elements(renderedRow, 'Text')[0].props.numberOfLines, undefined);
      assert.equal(elements(renderedRow, 'Text')[1].props.numberOfLines, undefined);
    });
  }
});
