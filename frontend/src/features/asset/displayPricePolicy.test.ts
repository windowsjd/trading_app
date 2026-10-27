import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { selectDisplayPrice, wonChartDisplay } from './displayPricePolicy.ts';
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

  it('never fills a missing ticker change rate from the REST snapshot', () => {
    // A realtime price beside an OLD change rate describes two moments at once.
    // The detail screen renders `displayPrice.changeRate` directly, so this is
    // the whole rule: no change rate rather than a stale one.
    for (const changeRate of [null, undefined]) {
      const display = selectDisplayPrice({
        latestTicker: ticker({ changeRate }),
        restPrice,
        ...assetInput,
      });

      assert.equal(display.basis, 'realtime');
      assert.equal(display.priceLocal, '0.24560000');
      assert.equal(display.changeRate, null);
      assert.notEqual(display.changeRate, restPrice.changeRate);
    }
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
    // Without a ticker the REST change rate IS the current basis.
    assert.equal(display.changeRate, '1.00000000');
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

describe('detail completed-session display', () => {
  it('uses the completed snapshot as one basis without labeling it realtime', () => {
    const display = selectDisplayPrice({
      ...assetInput,
      assetType: 'domestic_stock',
      marketStatus: 'closed',
      restPrice,
      latestTicker: ticker({
        realtime: false,
        marketStatus: 'closed',
        marketEvaluatedAt: '2026-07-10T06:30:02Z',
        priceLocal: '248500',
        priceKrw: '248500',
        priceCurrency: 'KRW',
      }),
    });
    assert.equal(display.basis, 'snapshot');
    assert.equal(display.isRealtime, false);
    assert.equal(display.priceLocal, '248500');
    assert.equal(display.priceKrw, '248500');
  });
  it('keeps a closed unavailable snapshot empty instead of reviving REST', () => {
    const display = selectDisplayPrice({
      ...assetInput,
      assetType: 'domestic_stock',
      marketStatus: 'closed',
      restPrice,
      latestTicker: ticker({
        realtime: false,
        marketStatus: 'closed',
        marketEvaluatedAt: '2026-07-10T06:30:02Z',
        priceLocal: null,
        priceKrw: null,
        priceKrwState: 'unavailable',
      }),
    });
    assert.equal(display.priceLocal, null);
    assert.equal(display.priceKrw, null);
    assert.equal(display.isRealtime, false);
  });
});

describe('wonChartDisplay (the chart in the header\'s won)', () => {
  const won = (priceLocal: string | null, priceKrw: string | null, displayPriceDecimals: number | null, priceKrwState = 'available') =>
    wonChartDisplay({ priceLocal, priceKrw, priceKrwState, displayPriceDecimals });

  it('uses the rate the server applied to the shown price, so the chart\'s current price is the header\'s', () => {
    const view = won('189.50000000', '262353.27500000', null);
    assert.equal(view?.rate, 1384.45);
    assert.equal(view?.displayPriceDecimals, null, 'US stock: whole won, the app policy');
    assert.equal(Math.abs(189.5 * (view?.rate ?? 0) - 262353.275) < 1e-6, true);
  });

  it('keeps the dollar precision in won, whole won when none is left', () => {
    assert.equal(won('100000.00', '138445000.00', 2)?.displayPriceDecimals, 0, 'BTC');
    assert.equal(won('0.24561', '340.0347045', 5)?.displayPriceDecimals, 2, 'DOGE');
    assert.equal(won('0.00001000', '0.01384450', 8)?.displayPriceDecimals, 5, 'PEPE');
  });

  it('never invents a rate: unavailable, missing or non-positive won keeps the chart in dollars', () => {
    for (const view of [won('189.5', '262353.275', null, 'unavailable'), won('189.5', null, null), won(null, '262353.275', null),
      won('0', '0', null), won('189.5', '-1', null), won('abc', '262353.275', null)]) assert.equal(view, null);
  });
});
