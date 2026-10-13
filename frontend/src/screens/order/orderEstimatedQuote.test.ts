import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TRIAL_ORDER_NOTICE } from '../../features/asset/trialDataSource.ts';

const { inlineTradingHarness } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);

function usHarness() {
  const h = inlineTradingHarness();
  h.Screen = h.OrderScreen;
  h.assetId = 'samsung';
  Object.assign(h.assets.samsung, {
    assetType: 'us_stock',
    market: 'NAS',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
    marketStatus: 'open',
    tradable: true,
    tradeBlockedReason: null,
  });
  return h;
}

const estimate = {
  assetId: 'samsung',
  kind: 'estimated_liquidity',
  provider: 'tiingo',
  priceCurrency: 'USD',
  quantityUnit: 'share',
  bid: { price: '247.45', size: '300' },
  ask: { price: null, size: null },
  spread: null,
  referencePrice: '247.5',
  effectiveAt: '2026-10-13T14:29:59.000Z',
  capturedAt: '2026-10-13T14:29:59.500Z',
};

describe('order screen estimated quote (US equities)', () => {
  it('shows the estimate card beside the current price once the server accepts it', async (t) => {
    const h = usHarness();
    h.estimatedQuoteState = {
      latestEstimate: estimate,
      supported: true,
      statusMessage: null,
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.estimatedQuoteOptions.enabled, true);
    assert.equal(h.estimatedQuoteOptions.assetId, 'samsung');
    const card = h.renderer.root.findByType('AssetEstimatedQuoteCard');
    assert.equal(card.props.estimate.assetId, 'samsung');
    assert.equal(card.props.marketOpen, true);
    // The estimate is never presented through the order-book ladder.
    assert.equal(h.renderer.root.findAll((node: any) => node.props?.testID === 'asset-order-book').length, 0);
    assert.equal(h.bookOptions.enabled, false);
  });

  it('renders nothing for a US equity without an estimate source', async (t) => {
    const h = usHarness();
    h.estimatedQuoteState = { latestEstimate: null, supported: false, statusMessage: null };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.renderer.root.findAllByType('AssetEstimatedQuoteCard').length, 0);
  });

  it('does not subscribe estimates for crypto or domestic stocks', async (t) => {
    const crypto = inlineTradingHarness();
    crypto.Screen = crypto.OrderScreen;
    await crypto.mount();
    t.after(crypto.close);
    await crypto.flush();
    assert.equal(crypto.estimatedQuoteOptions.enabled, false);
  });

  it('labels a Tiingo trial display price and keeps other sources unlabeled', async (t) => {
    const h = usHarness();
    h.assets.samsung.price.priceSource = {
      sourceType: 'provider_api',
      sourceName: 'tiingo_equity_reference_price',
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    const notice = h.node('asset-trial-price-notice');
    assert.ok(notice);
    assert.equal(notice.props.children, TRIAL_ORDER_NOTICE);

    const kis = usHarness();
    kis.assets.samsung.price.priceSource = {
      sourceType: 'provider_api',
      sourceName: 'kis_us_delayed_trade',
    };
    await kis.mount();
    t.after(kis.close);
    await kis.flush();
    assert.equal(
      kis.renderer.root.findAll((node: any) => node.props?.testID === 'asset-trial-price-notice').length,
      0,
    );
  });
});
