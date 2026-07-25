import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectDisplayPrice } from './displayPricePolicy.ts';
import type { AssetTickerMessage } from './assetTickerPolicy.ts';

const restPrice = {
  state: 'available',
  currentPrice: '0.24500000',
  priceCurrency: 'USD' as const,
  priceKrwState: 'available',
  priceKrw: '343.00000000',
  changeRate: '1.00000000',
  priceCapturedAt: '2026-07-25T03:00:00.000Z',
  priceEffectiveAt: '2026-07-25T03:00:00.000Z',
  priceSource: {
    sourceType: 'provider_api',
    sourceName: 'binance_public_rest_24hr_ticker',
  },
  fxRateSource: {
    sourceType: 'provider_api',
    sourceName: 'korea_exim_exchange_rate',
  },
};

function ticker(
  overrides: Partial<AssetTickerMessage> = {},
): AssetTickerMessage {
  return {
    type: 'asset_ticker',
    assetId: 'asset-doge',
    priceLocal: '0.24560000',
    priceCurrency: 'USD',
    priceKrw: '343.84000000',
    priceKrwState: 'available',
    changeRate: '1.75000000',
    displayPriceDecimals: 5,
    priceCapturedAt: '2026-07-25T03:00:29.000Z',
    priceEffectiveAt: '2026-07-25T03:00:29.000Z',
    freshnessAgeSeconds: 1,
    priceSource: {
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
    },
    fxRateSource: {
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
    },
    ...overrides,
  };
}

const assetInput = {
  assetPriceCurrency: 'USD' as const,
  assetDisplayPriceDecimals: 2,
};

describe('selectDisplayPrice — realtime basis', () => {
  it('takes the whole set from the ticker', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker(),
      restPrice,
      ...assetInput,
    });

    assert.equal(display.basis, 'realtime');
    assert.equal(display.isRealtime, true);
    assert.equal(display.priceLocal, '0.24560000');
    assert.equal(display.priceKrw, '343.84000000');
    assert.equal(display.priceKrwState, 'available');
    assert.equal(display.priceCapturedAt, '2026-07-25T03:00:29.000Z');
    assert.equal(display.priceEffectiveAt, '2026-07-25T03:00:29.000Z');
    assert.equal(display.freshnessAgeSeconds, 1);
    assert.equal(display.changeRate, '1.75000000');
    // decimals come from the ticker when it declares them
    assert.equal(display.displayPriceDecimals, 5);
  });

  it('shows the ticker source, never the REST snapshot source', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker(),
      restPrice,
      ...assetInput,
    });

    assert.equal(
      (display.priceSource as { sourceName?: string })?.sourceName,
      'binance_spot_ws_ticker',
    );
  });

  it('never fills a ticker-unavailable KRW from the REST snapshot', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker({
        priceKrw: null,
        priceKrwState: 'unavailable',
        priceKrwReason: 'FX_RATE_STALE',
        priceKrwMessage: 'USD/KRW FX rate snapshot is stale.',
        fxRateSource: null,
      }),
      restPrice,
      ...assetInput,
    });

    assert.equal(display.priceLocal, '0.24560000');
    assert.equal(display.priceKrw, null);
    assert.equal(display.priceKrwState, 'unavailable');
    assert.equal(display.priceKrwReason, 'FX_RATE_STALE');
    assert.equal(display.priceKrwMessage, 'USD/KRW FX rate snapshot is stale.');
    // The REST FX source belongs to the REST KRW value, so it is not shown.
    assert.equal(display.fxRateSource, null);
  });

  it('keeps the ticker FX source alongside the ticker KRW value', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker(),
      restPrice,
      ...assetInput,
    });

    assert.equal(
      (display.fxRateSource as { sourceName?: string })?.sourceName,
      'korea_exim_exchange_rate',
    );
  });

  it('falls back to asset decimals when the ticker declares none', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker({ displayPriceDecimals: null }),
      restPrice,
      ...assetInput,
    });

    assert.equal(display.displayPriceDecimals, 2);
  });

  it('reports a coherent set: every field comes from the same moment', () => {
    const display = selectDisplayPrice({
      latestTicker: ticker(),
      restPrice,
      ...assetInput,
    });

    // Nothing in the displayed set may originate from the REST payload.
    assert.notEqual(display.priceLocal, restPrice.currentPrice);
    assert.notEqual(display.priceKrw, restPrice.priceKrw);
    assert.notEqual(display.priceCapturedAt, restPrice.priceCapturedAt);
    assert.notEqual(
      (display.priceSource as { sourceName?: string })?.sourceName,
      restPrice.priceSource.sourceName,
    );
  });
});

describe('selectDisplayPrice — REST basis', () => {
  it('uses the REST pair only when there is no ticker', () => {
    const display = selectDisplayPrice({
      latestTicker: null,
      restPrice,
      ...assetInput,
    });

    assert.equal(display.basis, 'rest');
    assert.equal(display.isRealtime, false);
    assert.equal(display.priceLocal, '0.24500000');
    assert.equal(display.priceKrw, '343.00000000');
    assert.equal(
      (display.priceSource as { sourceName?: string })?.sourceName,
      'binance_public_rest_24hr_ticker',
    );
    assert.equal(display.displayPriceDecimals, 2);
  });

  it('reports REST KRW unavailability with its reason', () => {
    const display = selectDisplayPrice({
      latestTicker: null,
      restPrice: {
        ...restPrice,
        priceKrwState: 'unavailable',
        priceKrw: null,
        priceKrwReason: 'FX_RATE_UNAVAILABLE',
        priceKrwMessage: 'USD/KRW FX rate snapshot is unavailable.',
      },
      ...assetInput,
    });

    assert.equal(display.priceKrw, null);
    assert.equal(display.priceKrwReason, 'FX_RATE_UNAVAILABLE');
  });

  it('reports the empty basis when neither side has a price', () => {
    const display = selectDisplayPrice({
      latestTicker: null,
      restPrice: { state: 'unavailable', currentPrice: null },
      ...assetInput,
    });

    assert.equal(display.basis, 'none');
    assert.equal(display.priceLocal, null);
    assert.equal(display.priceKrw, null);
    assert.equal(display.priceSource, null);
    assert.equal(display.fxRateSource, null);
    assert.equal(display.displayPriceDecimals, 2);
  });
});
