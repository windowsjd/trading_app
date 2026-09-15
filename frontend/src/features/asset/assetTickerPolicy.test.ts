import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyTicker,
  applyTickerMarketState,
  canOverlayAssetTicker,
  getTickerAgeMs,
  getTickerTimestamp,
  isTickerStale,
  isTickerStaleAt,
  isUnavailableTicker,
  shouldAcceptTicker,
  toAssetTickerAcceptState,
  type AssetTickerMessage,
} from './assetTickerPolicy.ts';

function ticker(
  overrides: Partial<AssetTickerMessage> = {},
): AssetTickerMessage {
  return {
    type: 'asset_ticker',
    assetId: 'asset-btc',
    priceLocal: '100000.00000000',
    priceKrw: '140000000.00000000',
    priceKrwState: 'available',
    assetPriceSnapshotId: 'snap-1',
    priceCapturedAt: '2026-07-25T03:00:10.000Z',
    priceEffectiveAt: '2026-07-25T03:00:10.000Z',
    freshnessAgeSeconds: 1,
    ...overrides,
  };
}

describe('assetTickerPolicy', () => {
  it('reads the event time from capturedAt, then effectiveAt', () => {
    assert.equal(
      getTickerTimestamp(
        ticker({ priceCapturedAt: '2026-07-25T03:00:10.000Z' }),
      ),
      Date.parse('2026-07-25T03:00:10.000Z'),
    );
    assert.equal(
      getTickerTimestamp(
        ticker({
          priceCapturedAt: null,
          capturedAt: null,
          priceEffectiveAt: '2026-07-25T03:00:05.000Z',
        }),
      ),
      Date.parse('2026-07-25T03:00:05.000Z'),
    );
    assert.equal(
      getTickerTimestamp(
        ticker({
          priceCapturedAt: null,
          capturedAt: null,
          priceEffectiveAt: null,
        }),
      ),
      null,
    );
  });

  it('accepts the first ticker', () => {
    assert.equal(shouldAcceptTicker(null, ticker()), true);
  });

  it('rejects a repeat of the same snapshot id', () => {
    const current = toAssetTickerAcceptState(ticker());
    assert.equal(
      shouldAcceptTicker(current, ticker({ priceLocal: '100001.00000000' })),
      false,
    );
  });

  it('rejects an older timestamp and accepts a newer one', () => {
    const current = toAssetTickerAcceptState(ticker());

    assert.equal(
      shouldAcceptTicker(
        current,
        ticker({
          assetPriceSnapshotId: 'snap-0',
          priceCapturedAt: '2026-07-25T03:00:05.000Z',
        }),
      ),
      false,
    );
    assert.equal(
      shouldAcceptTicker(
        current,
        ticker({
          assetPriceSnapshotId: 'snap-2',
          priceCapturedAt: '2026-07-25T03:00:20.000Z',
        }),
      ),
      true,
    );
  });

  it('never lets a priced event with no timestamp overwrite a known price', () => {
    const current = toAssetTickerAcceptState(ticker());

    assert.equal(
      shouldAcceptTicker(
        current,
        ticker({
          assetPriceSnapshotId: 'snap-9',
          priceCapturedAt: null,
          capturedAt: null,
          priceEffectiveAt: null,
        }),
      ),
      false,
    );
  });

  it('still applies an unavailable event with no timestamp', () => {
    const current = toAssetTickerAcceptState(ticker());
    const unavailable = ticker({
      assetPriceSnapshotId: null,
      priceLocal: null,
      priceKrw: null,
      priceKrwState: 'unavailable',
      priceCapturedAt: null,
      capturedAt: null,
      priceEffectiveAt: null,
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });

    assert.equal(isUnavailableTicker(unavailable), true);
    assert.equal(shouldAcceptTicker(current, unavailable), true);
  });

  it('judges staleness from the server freshness age only', () => {
    assert.equal(isTickerStale(ticker({ freshnessAgeSeconds: 59 })), false);
    assert.equal(isTickerStale(ticker({ freshnessAgeSeconds: 61 })), true);
    assert.equal(isTickerStale(ticker({ freshnessAgeSeconds: null })), false);
    assert.equal(isTickerStale(null), false);
  });

  it('measures ticker age from its own event time', () => {
    const receivedAt = Date.parse('2026-07-25T03:00:10.000Z');

    assert.equal(getTickerAgeMs(ticker(), receivedAt + 5_000), 5_000);
    // Clock skew (event in the future) never yields a negative age.
    assert.equal(getTickerAgeMs(ticker(), receivedAt - 5_000), 0);
    assert.equal(getTickerAgeMs(null, receivedAt), null);
    assert.equal(
      getTickerAgeMs(
        ticker({
          priceCapturedAt: null,
          capturedAt: null,
          priceEffectiveAt: null,
        }),
        receivedAt,
      ),
      null,
    );
  });

  it('flips to stale purely by the clock advancing (no new ticker needed)', () => {
    const payload = ticker();
    const receivedAt = Date.parse('2026-07-25T03:00:10.000Z');

    assert.equal(isTickerStaleAt(payload, receivedAt + 59_000), false);
    assert.equal(isTickerStaleAt(payload, receivedAt + 61_000), true);
    assert.equal(isTickerStaleAt(null, receivedAt), false);
  });

  it('uses the SAME threshold as the freshness-age check (no second constant)', () => {
    const receivedAt = Date.parse('2026-07-25T03:00:10.000Z');
    const boundary = ticker({ freshnessAgeSeconds: 61 });

    assert.equal(isTickerStale(boundary), true);
    assert.equal(isTickerStaleAt(boundary, receivedAt + 61_000), true);
  });

  it('falls back to the server freshness age for timestamp-less tickers', () => {
    const payload = ticker({
      priceCapturedAt: null,
      capturedAt: null,
      priceEffectiveAt: null,
      freshnessAgeSeconds: 120,
    });

    assert.equal(
      isTickerStaleAt(payload, Date.parse('2030-01-01T00:00:00Z')),
      true,
    );
    assert.equal(
      isTickerStaleAt(
        { ...payload, freshnessAgeSeconds: 10 },
        Date.parse('2030-01-01T00:00:00Z'),
      ),
      false,
    );
  });

  it('applyTicker returns the SAME state object when the ticker is rejected', () => {
    const current = toAssetTickerAcceptState(ticker());
    const rejected = applyTicker(current, ticker());
    const accepted = applyTicker(
      current,
      ticker({
        assetPriceSnapshotId: 'snap-2',
        priceCapturedAt: '2026-07-25T03:00:20.000Z',
        priceLocal: '100500.00000000',
      }),
    );

    assert.equal(rejected, current);
    assert.notEqual(accepted, current);
    assert.equal(accepted?.ticker.priceLocal, '100500.00000000');
  });
});

describe('stock market state transitions', () => {
  const live = ticker({
    assetId: 'samsung',
    realtime: true,
    marketStatus: 'open',
    marketEvaluatedAt: '2026-07-10T06:29:59Z',
    priceLocal: '248500',
    assetPriceSnapshotId: 'same',
  });
  const closed = ticker({
    assetId: 'samsung',
    realtime: false,
    marketStatus: 'closed',
    marketEvaluatedAt: '2026-07-10T06:30:02Z',
    priceLocal: '248500',
    assetPriceSnapshotId: 'same',
    priceCapturedAt: '2026-07-10T06:29:58Z',
    freshnessAgeSeconds: 99999,
  });
  it('accepts close with the same snapshot and an older price time, without stale styling', () => {
    const next = applyTicker(toAssetTickerAcceptState(live), closed);
    assert.equal(next?.ticker, closed);
    assert.equal(
      isTickerStaleAt(closed, Date.parse('2026-07-12T06:30:02Z')),
      false,
    );
    assert.deepEqual(
      applyTickerMarketState(
        { assetType: 'domestic_stock', marketStatus: 'open', tradable: true },
        closed,
      ),
      {
        assetType: 'domestic_stock',
        marketStatus: 'closed',
        tradable: false,
        tradeBlockedReason: 'MARKET_CLOSED',
      },
    );
  });
  it('rejects a delayed open event and legacy live events after close', () => {
    const state = toAssetTickerAcceptState(closed);
    assert.equal(
      applyTicker(state, { ...live, assetPriceSnapshotId: null }),
      state,
    );
    assert.equal(
      applyTicker(
        state,
        ticker({ priceLocal: '999999', assetPriceSnapshotId: null }),
      ),
      state,
    );
  });
  it('clears live price for an unavailable closed snapshot and cannot resurrect it', () => {
    const unavailable = {
      ...closed,
      priceLocal: null,
      priceKrw: null,
      priceKrwState: 'unavailable',
      assetPriceSnapshotId: null,
    };
    const state = applyTicker(toAssetTickerAcceptState(live), unavailable);
    assert.equal(state?.ticker.priceLocal, null);
    assert.equal(applyTicker(state, live), state);
  });
  it('reopens using a server snapshot without REST polling', () => {
    const open = {
      ...live,
      realtime: false,
      marketEvaluatedAt: '2026-07-13T00:00:01Z',
      tradable: true,
      tradeBlockedReason: null,
    };
    const state = applyTicker(toAssetTickerAcceptState(closed), open);
    assert.equal(state?.ticker, open);
    const asset = {
      assetType: 'domestic_stock',
      marketStatus: 'closed',
      tradable: false,
    };
    assert.equal(canOverlayAssetTicker(asset, open), true);
    assert.equal(applyTickerMarketState(asset, open).tradable, true);
  });
  it('keeps crypto and an independently open US stock eligible', () => {
    assert.equal(
      canOverlayAssetTicker(
        { assetType: 'crypto', marketStatus: 'always_open' },
        ticker(),
      ),
      true,
    );
    assert.equal(
      canOverlayAssetTicker(
        { assetType: 'us_stock', marketStatus: 'open' },
        { ...live, assetId: 'nys-stock' },
      ),
      true,
    );
  });
});
