import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, textContent, elements } = require('../../../test/tradingUiHarness.cjs');

const noHoldingsMessage = '보유 수량이 없어 매도할 수 없습니다.';
function setPosition(h: any, quantity: string) {
  h.positionQuery.data.positions = [{ assetId: h.asset.id, quantity, averageCost: '70000',
    currencyCode: 'KRW', valuation: { state: 'unavailable' } }];
}

describe('asset detail information and trading controls', () => {
  for (const assetType of ['domestic_stock', 'crypto']) {
    for (const [changeRate, expected] of [
      [null, '-'], [undefined, '-'], ['', '-'], ['NaN', '-'],
      ['1.23000000', '+1.23%'], ['-0.46000000', '-0.46%'], ['0.00000000', '0%'],
    ]) {
      it(`renders ${assetType} REST change rate ${changeRate} as ${expected}`, () => {
        const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
        h.asset.assetType = assetType;
        h.asset.price.changeRate = changeRate;
        const tree = h.render();
        const label = elements(tree, 'Text').find((node: any) => textContent(node) === (expected === '-' ? '등락률 -' : expected));
        assert.equal(textContent(label), expected === '-' ? '등락률 -' : expected);
      });
    }
  }

  for (const [changeRate, expected] of [[null, '-'], [undefined, '-'], ['-0.46000000', '-0.46%']]) {
    it(`renders ticker change rate ${changeRate} without borrowing the REST return`, () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      h.asset.marketStatus = 'open';
      h.asset.price.changeRate = '1.23000000';
      h.ticker = {
        type: 'asset_ticker', assetId: h.asset.id, priceLocal: '71000', priceCurrency: 'KRW',
        priceCapturedAt: h.asset.price.priceCapturedAt, changeRate,
      };
      const tree = h.render();
      const label = elements(tree, 'Text').find((node: any) => textContent(node) === (expected === '-' ? '등락률 -' : expected));
      assert.equal(textContent(label), expected === '-' ? '등락률 -' : expected);
      assert.doesNotMatch(textContent(tree), /등락률 -%|등락률 1\.23%/);
    });
  }

  it('keeps closed status and tradability while hiding duplicate market copy and KRW conversion', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    const text = textContent(h.render());
    assert.match(text, /장마감/);
    assert.doesNotMatch(text, /거래 상태:|시장 상태:/);
    assert.doesNotMatch(text, /현재 시장이 닫혀 있습니다\.|장 상태는 주문 견적에서 최종 확인됩니다\.|KRW 환산/);
    assert.equal(h.asset.marketStatus, 'closed');
    assert.equal(h.asset.tradable, false);
  });

  it('also hides the closed-status fallback with an older payload missing the reason', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.asset.tradable = true;
    h.asset.tradeBlockedReason = null;
    assert.doesNotMatch(textContent(h.render()), /장 상태는 주문 견적에서 최종 확인됩니다\./);
  });

  for (const [reason, copy] of [
    ['ASSET_INACTIVE', '비활성 자산입니다.'],
    ['PRICE_UNAVAILABLE', '현재 가격 데이터를 사용할 수 없습니다.'],
    ['PRICE_STALE', '가격 데이터의 최신성이 낮습니다.'],
    ['PROVIDER_UNAVAILABLE', '거래 제한 가능성이 있습니다.'],
  ]) {
    it(`preserves ${reason} warnings while the Korean market is closed`, () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      h.asset.tradeBlockedReason = reason;
      assert.ok(textContent(h.render()).includes(copy));
    });
  }

  it('still shows a stale ticker warning after hiding the duplicate closed notice', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.tickerStale = true;
    assert.match(textContent(h.render()), /실시간 시세 최신성이 낮습니다/);
  });

  for (const assetType of ['us_stock', 'crypto']) {
    it(`preserves USD asset conversion and unavailable conversion warnings for ${assetType}`, () => {
      const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
      Object.assign(h.asset, { assetType, priceCurrency: 'USD', settlementCurrency: 'USD',
        marketStatus: 'open', tradable: true, tradeBlockedReason: null });
      h.asset.price.priceCurrency = 'USD';
      let tree = h.render();
      h.control(tree, 'asset-krw-toggle').props.onPress();
      tree = h.render();
      assert.match(textContent(tree), /₩70,000/);
      h.asset.price.priceKrwState = 'unavailable';
      const text = textContent(h.render());
      assert.match(text, /환산 불가/);
      assert.doesNotMatch(text, /KRW 환산 시세를 사용할 수 없습니다/);
    });
  }

  it('does not change other asset classes market-closed warnings', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    h.asset.assetType = 'us_stock';
    assert.match(textContent(h.render()), /현재 시장이 닫혀 있습니다\./);
  });

  it('switches sides inline without adding Order routes', () => {
    const h = createTradingUiHarness('asset/AssetDetailScreen.tsx');
    const tree = h.render();
    for (const side of ['buy', 'sell']) {
      h.control(tree, TEST_IDS.assetDetail[`${side}Button`]).props.onPress();
    }
    assert.deepEqual(h.navigation, []);
  });
});

describe('sell order display without changing gates', () => {
  for (const quantity of ['0', '2']) {
    it(`keeps quote and ratio controls gated on quantity ${quantity}`, () => {
      const h = createTradingUiHarness('order/OrderScreen.tsx');
      setPosition(h, quantity);
      let tree = h.render();
      h.control(tree, TEST_IDS.order.quantityInput).props.onChangeText('1');
      tree = h.render();
      assert.equal(textContent(tree).includes(noHoldingsMessage), quantity === '0');
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.order.quoteSubmit)).props.disabled, quantity === '0');
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.order.executeSubmit)).props.disabled, true, 'execution still requires a quote');
      const ratios = elements(tree, 'Pressable').filter((node: any) => ['25%', '50%', '75%', '100%'].includes(textContent(node)));
      assert.equal(ratios.length, 4);
      assert.ok(ratios.every((node: any) => node.props.disabled === (quantity === '0')));
    });
  }

  it('preserves account restrictions even when the position is empty', () => {
    const h = createTradingUiHarness('order/OrderScreen.tsx');
    h.account.status = 'suspended';
    const tree = h.render();
    assert.match(textContent(tree), /일시정지된 계정입니다/);
    assert.equal(h.renderCta(h.control(tree, TEST_IDS.order.quoteSubmit)).props.disabled, true);
  });

  for (const state of ['isLoading', 'isError']) {
    it(`preserves holdings errors and ratio blocking for ${state}`, () => {
      const h = createTradingUiHarness('order/OrderScreen.tsx');
      h.positionQuery[state] = true;
      const tree = h.render();
      assert.match(textContent(tree), /보유 수량을 확인/);
      assert.equal(h.renderCta(h.control(tree, TEST_IDS.order.quoteSubmit)).props.disabled, true);
    });
  }
});
