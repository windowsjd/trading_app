import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { AdminDiagnosticDto } from '../../models/dto/common.ts';
import { applyTicker, toAssetTickerAcceptState } from '../../features/asset/assetTickerPolicy.ts';

const { inlineTradingHarness, deferred } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const visibleText = (h: any) => JSON.stringify(h.renderer.toJSON());
const nodeText = (node: any): string =>
  typeof node === 'string' ? node : (node?.children ?? []).map(nodeText).join('');
const statusText = (h: any) => nodeText(h.node('admin-asset-price-status'));
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
    assert.ok(h.node('admin-asset-price-status'));
    assert.match(statusText(h), /KRW 환산: 사용 불가/);
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
      priceCapturedAt: new Date().toISOString(),
    };
    h.priceErrors = [];
    await h.update();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.equal(h.node('admin-asset-price-status'), undefined);
  });

  it('keeps a REST failure visible when a newer ticker restores the displayed price', async (t) => {
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
    assert.ok(h.node('admin-diagnostic-toggle'));
    assert.ok(h.node('admin-asset-price-status'));
    assert.match(statusText(h), /화면 시세 기준: WebSocket 실시간/);
    assert.match(statusText(h), /REST 가격 상태: unavailable/);
    assert.match(statusText(h), /시장가 참고 시세: 사용 가능/);
  });

  it('explains REST display availability versus the 60-second preview limit without a backend diagnostic', async (t) => {
    const h = inlineTradingHarness();
    h.role = 'admin';
    h.assets.bnb.price.priceCapturedAt = new Date(Date.now() - 90_000).toISOString();
    h.priceErrors = [];
    await h.mount();
    t.after(h.close);
    await h.flush();
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.ok(h.node('admin-asset-price-status'));
    assert.match(statusText(h), /화면 시세 기준: REST/);
    assert.match(statusText(h), /REST 가격 상태: available/);
    assert.match(statusText(h), /REST 가격 오류: 없음/);
    assert.match(statusText(h), /preview 기준 60초를 초과/);
    assert.match(visibleText(h), /현재 화면 시세가 없어 비율 수량 계산은 제한됩니다/);
    await h.press('order-ratio-25');
    assert.match(visibleText(h), /현재가가 없어 비율 수량을 계산할 수 없습니다/);
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
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
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.ok(h.node('admin-asset-price-status'));
    assert.match(statusText(h), /화면 시세 기준: WebSocket 실시간/);
    assert.match(statusText(h), /REST 가격 상태: available/);
    assert.match(statusText(h), /REST 가격 오류: 없음/);
    assert.match(statusText(h), /WebSocket 현재가: 없음/);
    assert.match(visibleText(h), /ASSET_PRICE_UNAVAILABLE/);
    assert.match(visibleText(h), /현재 화면 시세가 없어 비율 수량 계산은 제한됩니다/);
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
    assert.ok(h.node('admin-asset-price-status'));
    assert.match(statusText(h), /KRW 환산: 사용 불가 · FX_RATE_UNAVAILABLE/);
    assert.match(statusText(h), /화면 시세 기준: WebSocket 실시간/);
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
    assert.ok(h.node('admin-asset-price-status'));
    assert.equal(h.node('admin-diagnostic-toggle'), undefined);
    assert.match(statusText(h), /preview 기준 60초를 초과/);
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
