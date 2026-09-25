import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { AdminDiagnosticDto } from '../../models/dto/common.ts';

const { inlineTradingHarness, deferred } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const visibleText = (h: any) => JSON.stringify(h.renderer.toJSON());
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
      /현재 화면 시세가 없어 비율 수량 계산은 제한됩니다/,
    );
    await h.press('order-ratio-25');
    assert.match(
      visibleText(h),
      /현재가가 없어 비율 수량을 계산할 수 없습니다/,
    );
  });

  it('shows an FX conversion partial failure with a valid local price on the standalone order screen', async (t) => {
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
    assert.ok(h.node('admin-diagnostic-toggle'));
    await h.press('admin-diagnostic-toggle');
    assert.match(visibleText(h), /ASSET_PRICE_KRW_CONVERSION/);
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
      /현재 화면 시세가 없어 비율 수량 계산은 제한됩니다/,
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
    };
    h.priceErrors = [];
    await h.update();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
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
      assert.doesNotMatch(visibleText(h), /ASSET_PRICE_UNAVAILABLE/);
    });
  }

  it('fails closed when /me fails or has not resolved', async (t) => {
    const failed = inlineTradingHarness();
    failed.role = 'admin';
    failed.priceErrors = [priceError];
    failed.meError = new Error('/me failed');
    await failed.mount();
    t.after(failed.close);
    await failed.flush();
    assert.equal(failed.node('admin-diagnostic-toggle'), undefined);

    const pending = inlineTradingHarness();
    pending.role = 'admin';
    pending.priceErrors = [priceError];
    pending.meGate = deferred();
    await pending.mount();
    t.after(pending.close);
    assert.equal(pending.node('admin-diagnostic-toggle'), undefined);
  });
});
