import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const { inlineTradingHarness } = (() => {
  const require = createRequire(import.meta.url);
  return require('../../../test/inlineTradingHarness.cjs');
})();

const lastCloseSource = {
  sourceType: 'provider_api',
  sourceName: 'tiingo_eod',
  snapshotId: null,
  fallbackUsed: true,
  fallbackReason: 'market_closed_last_close',
};

function closedUsStock(screen: 'Chart' | 'OrderScreen', lastClose: boolean) {
  const h = inlineTradingHarness();
  h.Screen = h[screen];
  h.assetId = 'samsung';
  Object.assign(h.assets.samsung, {
    assetType: 'us_stock',
    market: 'NAS',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
    marketStatus: 'closed',
    tradable: false,
    tradeBlockedReason: 'MARKET_CLOSED',
  });
  Object.assign(h.assets.samsung.price, {
    currentPrice: '250.00000000',
    priceCurrency: 'USD',
    assetPriceSnapshotId: null,
    // Friday 2026-10-16 16:00 EDT (Saturday in Seoul).
    priceEffectiveAt: '2026-10-16T20:00:00.000Z',
    priceSource: lastClose
      ? lastCloseSource
      : { sourceType: 'provider_api', sourceName: 'tiingo_us_reference_price' },
  });
  return h;
}

const count = (h: any, id: string) =>
  h.renderer.root.findAll((node: any) => node.props?.testID === id).length;
const text = (h: any, id: string) =>
  [h.node(id).props.children].flat().join('');

describe('closed US market: last confirmed close is labeled 종가 without its date', () => {
  it('the detail chart says it is the close, not a live price, without the 10/16 date', async (t) => {
    const h = closedUsStock('Chart', true);
    await h.mount();
    t.after(h.close);
    assert.equal(
      text(h, 'asset-last-close-notice'),
      '미국 정규장 마감 · 종가 (실시간 시세 아님)',
    );
  });

  it('the order card labels the price 종가 (no date) instead of 현재가', async (t) => {
    const h = closedUsStock('OrderScreen', true);
    await h.mount();
    t.after(h.close);
    assert.equal(text(h, 'order-price-label'), '종가 · USD');
  });

  it('a stored price keeps 현재가 and no close notice', async (t) => {
    const chart = closedUsStock('Chart', false);
    await chart.mount();
    t.after(chart.close);
    assert.equal(count(chart, 'asset-last-close-notice'), 0);
    const order = closedUsStock('OrderScreen', false);
    await order.mount();
    t.after(order.close);
    assert.equal(text(order, 'order-price-label'), '현재가 · USD');
  });
});
