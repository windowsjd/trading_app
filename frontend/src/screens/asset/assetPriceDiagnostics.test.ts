import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import type { AdminDiagnosticDto } from '../../models/dto/common.ts';
import { applyTicker, toAssetTickerAcceptState } from '../../features/asset/assetTickerPolicy.ts';

const { inlineTradingHarness, deferred, act } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const visibleText = (h: any) => JSON.stringify(h.renderer.toJSON()).replace(/\u200b/g, '');
const diagnostic: AdminDiagnosticDto = {
  version: 1,
  code: 'ASSET_PRICE_UNAVAILABLE',
  httpStatus: 200,
  timestamp: '2026-09-24T00:00:00.000Z',
  requestId: 'price-request',
  domain: 'MARKET_DATA',
  operation: 'ASSET_PRICE_READ',
  failureStage: 'asset_price_selection',
  exception: {
    type: 'Error',
    message: 'Asset price snapshot is unavailable.',
    applicationStack: [],
    stack: [],
    truncated: false,
  },
  diagnosticEvents: { events: [], truncated: false },
  serverLogs: { entries: [], truncated: false },
  truncated: false,
};
const priceError = { assetId: 'bnb', code: diagnostic.code, diagnostic };

const unavailable = (h: any) => {
  h.assets.bnb.price = { state: 'unavailable' };
};

describe('asset detail HTTP 200 price diagnostics', () => {
  for (const role of ['user', 'operator', 'admin']) it(`keeps chart failure copy safe and diagnostics gated for ${role}`, async (t) => {
    const h = inlineTradingHarness(); h.Screen = h.Chart; h.role = role;
    h.candleFailure = { response: { status: 502, data: { error: {
      code: 'ASSET_CANDLES_PROVIDER_ERROR',
      message: 'JWT_ACCESS_SECRET https://provider.invalid/raw 184927.543281',
      diagnostic: { ...diagnostic, domain: 'CANDLE', operation: 'CANDLE_READ', failureStage: 'provider_candle_fetch' },
    } } } };
    await h.mount(); t.after(h.close); await h.flush();
    assert.match(visibleText(h), /차트를 불러오지 못했습니다/);
    assert.match(visibleText(h), /잠시 후 다시 시도/);
    assert.doesNotMatch(visibleText(h), /ASSET_CANDLES_PROVIDER_ERROR|502|JWT_ACCESS_SECRET|provider.invalid|184927|provider_candle_fetch/);
    if (role === 'admin') {
      await h.press('admin-diagnostic-toggle');
      for (const value of ['CANDLE_READ', 'provider_candle_fetch', 'price-request']) assert.ok(visibleText(h).includes(value));
    } else assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    const before = h.refetches;
    await h.press(TEST_IDS.assetDetail.chartRetry);
    assert.equal(h.refetches, before + 1);
  });

  for (const screen of ['Detail', 'OrderScreen']) it(`filters arbitrary ticker/conversion reasons in ${screen} runtime diagnostics`, async (t) => {
    const h = inlineTradingHarness(); h.Screen = h[screen]; h.role = 'admin';
    h.ticker = { type: 'asset_ticker', assetId: 'bnb', priceLocal: null,
      priceCurrency: 'USD', priceKrw: null, priceKrwState: 'unavailable',
      reason: 'https://provider.invalid/raw 184927.543281',
      priceKrwReason: 'JWT_ACCESS_SECRET private-provider-message',
      priceCapturedAt: new Date().toISOString() };
    await h.mount(); t.after(h.close); await h.flush();
    const toggles = h.renderer.root.findAllByProps({ testID: 'admin-diagnostic-toggle' });
    assert.ok(toggles.length > 0);
    for (const toggle of toggles) await act(async () => toggle.props.onPress());
    assert.doesNotMatch(visibleText(h), /provider.invalid|184927|JWT_ACCESS_SECRET|private-provider-message/);
    assert.match(visibleText(h), /not_observed/);
  });
  it('shows an actual HTTP quote failure beside the order error, collapsed', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    const quoteDiagnostic = {
      ...diagnostic,
      code: 'PRICE_STALE',
      httpStatus: 503,
      requestId: 'quote-request-123456789',
      domain: 'ORDER',
      operation: 'ORDER_QUOTE',
      evidence: { providerSnapshotId: 'snapshot-987654321' },
    };
    h.quoteFailure = {
      response: {
        status: 503,
        data: { error: { code: 'PRICE_STALE', diagnostic: quoteDiagnostic } },
      },
    };
    await h.mount();
    t.after(h.close);
    await h.input(TEST_IDS.order.quantityInput, '1');
    await h.press(TEST_IDS.order.executeSubmit);
    await h.flush();
    assert.ok(h.node('admin-diagnostic-toggle'));
    assert.equal(h.node('admin-diagnostic-content'), undefined);
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /quote-request-123456789/);
    assert.match(visibleText(h), /snapshot-987654321/);
    assert.match(visibleText(h), /ORDER_QUOTE/);
  });

  it('gives admin the backend diagnostic in the detail screen, once, alongside existing price warnings', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    unavailable(h);
    h.priceErrors = [priceError];
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(
      h.renderer.root.findAll(
        (n: any) => n.props.testID === 'admin-diagnostic-panel',
      ).length,
      1,
    );
    assert.ok(h.node('admin-diagnostic-toggle'));
    assert.equal(h.node('admin-diagnostic-content'), undefined);
    await h.press('admin-diagnostic-toggle');
    assert.ok(h.node('admin-diagnostic-content'));
    assert.match(visibleText(h), /ASSET_PRICE_UNAVAILABLE/);
    assert.match(
      visibleText(h),
      /현재 화면 시세가 없어 예상 수량을 표시할 수 없습니다/,
    );
    await h.press('order-ratio-25');
    assert.ok(Number(h.node(TEST_IDS.order.quantityInput).props.value) > 0);
  });

  it('does not show technical details when FX conversion has no consumer error on the standalone order screen', async (t) => {
    const h = inlineTradingHarness();
    h.Screen = h.OrderScreen;
    h.role = 'admin';
    h.assets.bnb.price.priceKrwState = 'unavailable';
    h.assets.bnb.price.priceKrw = null;
    h.priceErrors = [
      {
        ...priceError,
        code: 'FX_RATE_UNAVAILABLE',
        diagnostic: {
          ...diagnostic,
          code: 'FX_RATE_UNAVAILABLE',
          operation: 'ASSET_PRICE_KRW_CONVERSION',
        },
      },
    ];
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.equal(h.node('admin-asset-price-status'), undefined);
  });

  it('does not invent a diagnostic for missing price, unrelated price errors or normal price', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    unavailable(h);
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.match(
      visibleText(h),
      /현재 화면 시세가 없어 예상 수량을 표시할 수 없습니다/,
    );
    h.priceErrors = [{ ...priceError, diagnostic: undefined }];
    await h.update();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    h.priceErrors = [{ ...priceError, assetId: 'btc' }];
    await h.update();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    h.assets.bnb.price = {
      state: 'available',
      currentPrice: '763.79',
      priceCurrency: 'USD',
      priceCapturedAt: new Date().toISOString(),
    };
    h.priceErrors = [];
    await h.update();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.equal(h.node('admin-asset-price-status'), undefined);
  });

  it('keeps the normal display when a newer ticker resolves the visible REST failure', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    unavailable(h);
    h.priceErrors = [priceError];
    h.ticker = {
      type: 'asset_ticker', assetId: 'bnb', priceLocal: '763.79',
      priceKrw: '1054259', priceKrwState: 'available',
      priceCapturedAt: new Date().toISOString(),
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.equal(h.node('admin-asset-price-status'), undefined);
  });

  it('places a client runtime diagnosis inside the visible stale preview warning', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    h.assets.bnb.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
    h.priceErrors = [];
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.ok(h.node('admin-diagnostic-toggle'));
    assert.equal(h.node('admin-diagnostic-content'), undefined);
    assert.match(visibleText(h), /현재 화면 시세가 오래되어 예상 수량을 표시할 수 없습니다/);
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /Client runtime 상태/);
    assert.doesNotMatch(visibleText(h), /Backend Exception|Request ID|Application Stack/);
    await h.press('order-ratio-25');
    assert.ok(Number(h.node(TEST_IDS.order.quantityInput).props.value) > 0);
  });

  it('explains when an accepted unavailable WebSocket ticker replaces a valid REST display', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    h.priceErrors = [];
    const current = toAssetTickerAcceptState({
      type: 'asset_ticker', assetId: 'bnb', priceLocal: '763.79',
      priceKrw: '1054259', priceKrwState: 'available',
      assetPriceSnapshotId: 'previous', priceCapturedAt: new Date().toISOString(),
    });
    const accepted = applyTicker(current, {
      type: 'asset_ticker', assetId: 'bnb', priceLocal: null,
      priceKrw: null, priceKrwState: 'unavailable',
      assetPriceSnapshotId: null, priceCapturedAt: null, priceEffectiveAt: null,
      reason: 'ASSET_PRICE_UNAVAILABLE', message: 'Provider price not available.',
    });
    assert.equal(accepted?.ticker.priceLocal, null);
    h.ticker = accepted?.ticker;
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.ok(h.node('admin-diagnostic-toggle'));
    assert.equal(h.node('admin-diagnostic-content'), undefined);
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /Client runtime 상태/);
    assert.match(visibleText(h), /tickerPriceAvailable/);
    assert.doesNotMatch(visibleText(h), /Backend Exception|Request ID|Application Stack/);
    assert.match(visibleText(h), /ASSET_PRICE_UNAVAILABLE/);
    assert.match(visibleText(h), /현재 화면 시세가 없어 예상 수량을 표시할 수 없습니다/);
  });

  it('does not attach an older REST diagnosis to a newer ticker failure', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    unavailable(h);
    h.priceErrors = [priceError];
    h.ticker = {
      type: 'asset_ticker', assetId: 'bnb', priceLocal: null,
      priceKrw: null, priceKrwState: 'unavailable',
      priceCapturedAt: new Date().toISOString(),
      reason: 'ASSET_PRICE_UNAVAILABLE',
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.ok(h.node('admin-diagnostic-toggle'));
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /Client runtime 상태/);
    assert.doesNotMatch(visibleText(h), /price-request|Backend Exception|Request ID/);
  });

  it('explains a ticker-only FX conversion failure without inventing a REST diagnostic', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    h.priceErrors = [];
    h.ticker = {
      type: 'asset_ticker', assetId: 'bnb', priceLocal: '763.79',
      priceCurrency: 'USD', priceKrw: null, priceKrwState: 'unavailable',
      priceKrwReason: 'FX_RATE_UNAVAILABLE',
      priceKrwMessage: 'USD/KRW FX rate snapshot is unavailable.',
      priceCapturedAt: new Date().toISOString(),
    };
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.equal(h.node('admin-asset-price-status'), undefined);
    assert.equal(h.node('asset-krw-toggle').props.disabled, true);
  });

  it('shows the runtime cause on a standalone order screen without a REST diagnostic', async (t) => {
    const h = inlineTradingHarness();
    h.Screen = h.OrderScreen;
    h.role = 'admin';
    h.assets.bnb.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-asset-price-status'), undefined);
    assert.ok(h.node('admin-diagnostic-toggle'));
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /previewPriceAvailable/);
    assert.doesNotMatch(visibleText(h), /Backend Exception|Request ID/);
  });

  for (const role of ['user', 'operator'] as const) {
    it(`hides an injected backend diagnostic from ${role}`, async (t) => {
      const h = inlineTradingHarness();
      h.role = role;
      unavailable(h);
      h.priceErrors = [priceError];
      await h.mount();
      t.after(h.close);
      await h.flush();
      assert.equal(h.node('admin-diagnostic-toggle'), undefined);
      assert.equal(h.node('admin-asset-price-status'), undefined);
      assert.doesNotMatch(visibleText(h), /ASSET_PRICE_UNAVAILABLE/);
    });
  }

  it('fails closed when /me fails or has not resolved', async (t) => {
    const failed = inlineTradingHarness();
    failed.role = 'admin';
    failed.priceErrors = [priceError];
    unavailable(failed);
    failed.meError = new Error('/me failed');
    await failed.mount();
    t.after(failed.close);
    await failed.flush();
    assert.equal(failed.node('admin-diagnostic-toggle'), undefined);
    assert.equal(failed.node('admin-asset-price-status'), undefined);

    const pending = inlineTradingHarness();
    pending.role = 'admin';
    pending.priceErrors = [priceError];
    unavailable(pending);
    pending.meGate = deferred();
    await pending.mount();
    t.after(pending.close);
    assert.equal(pending.node('admin-diagnostic-toggle'), undefined);
    assert.equal(pending.node('admin-asset-price-status'), undefined);
  });
});
