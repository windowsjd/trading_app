import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  mergeMarketAssetTicker,
  mergeMarketAssetTickers,
} from './mergeMarketAssetTicker.ts';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy.ts';
import type { MarketAssetItemDto } from './api.ts';

function restItem(
  overrides: Partial<MarketAssetItemDto> = {},
): MarketAssetItemDto {
  return {
    id: 'asset-doge',
    assetType: 'crypto',
    symbol: 'DOGEUSDT',
    name: 'Dogecoin',
    market: 'BINANCE',
    priceCurrency: 'USD',
    displayPriceDecimals: 5,
    settlementCurrency: 'USD',
    isActive: true,
    marketStatus: 'always_open',
    tradable: true,
    price: {
      state: 'available',
      currentPrice: '0.24500000',
      priceCurrency: 'USD',
      priceKrwState: 'available',
      priceKrw: '343.00000000',
      changeRate: '1.00000000',
      assetPriceSnapshotId: 'snap-rest',
      priceCapturedAt: '2026-07-25T03:00:00.000Z',
      priceEffectiveAt: '2026-07-25T03:00:00.000Z',
      priceSource: { sourceType: 'provider_api', sourceName: 'binance_spot_ws_ticker' },
    },
    ...overrides,
  };
}

function liveTicker(
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
    assetPriceSnapshotId: 'snap-live',
    priceCapturedAt: '2026-07-25T03:00:29.000Z',
    priceEffectiveAt: '2026-07-25T03:00:29.000Z',
    freshnessAgeSeconds: 1,
    priceSource: { sourceType: 'provider_api', sourceName: 'binance_spot_ws_ticker' },
    ...overrides,
  };
}

describe('mergeMarketAssetTicker', () => {
  it('uses the ticker price when the ticker is newer than REST', () => {
    const merged = mergeMarketAssetTicker(restItem(), liveTicker());

    assert.equal(merged.price?.currentPrice, '0.24560000');
    assert.equal(merged.price?.priceKrw, '343.84000000');
    assert.equal(merged.price?.priceKrwState, 'available');
    assert.equal(merged.price?.assetPriceSnapshotId, 'snap-live');
    assert.equal(merged.price?.priceCapturedAt, '2026-07-25T03:00:29.000Z');
    assert.equal(merged.price?.changeRate, '1.75000000');
  });

  it('keeps the REST price when it is newer than the ticker', () => {
    const item = restItem();
    const merged = mergeMarketAssetTicker(
      item,
      liveTicker({
        priceCapturedAt: '2026-07-25T02:59:00.000Z',
        priceEffectiveAt: '2026-07-25T02:59:00.000Z',
      }),
    );

    assert.equal(merged, item);
  });

  it('returns the REST row untouched when there is no ticker', () => {
    const item = restItem();

    assert.equal(mergeMarketAssetTicker(item, undefined), item);
    assert.equal(
      mergeMarketAssetTicker(item, liveTicker({ assetId: 'other' })),
      item,
    );
  });

  it('never combines a new local price with the previous KRW value', () => {
    const merged = mergeMarketAssetTicker(
      restItem(),
      liveTicker({ priceKrw: null, priceKrwState: 'unavailable' }),
    );

    // Local price updates; KRW is reported unavailable rather than reusing the
    // REST KRW that belongs to the OLD local price.
    assert.equal(merged.price?.currentPrice, '0.24560000');
    assert.equal(merged.price?.priceKrw, null);
    assert.equal(merged.price?.priceKrwState, 'unavailable');
  });

  it('shows the server-computed realtime KRW when FX is available', () => {
    const merged = mergeMarketAssetTicker(
      restItem(),
      liveTicker({ priceKrw: '350.00000000' }),
    );

    assert.equal(merged.price?.priceKrw, '350.00000000');
    assert.equal(merged.price?.priceKrwState, 'available');
  });

  it('ignores a price-less unavailable ticker so the REST price stays visible', () => {
    const item = restItem();
    const merged = mergeMarketAssetTicker(
      item,
      liveTicker({
        priceLocal: null,
        priceKrw: null,
        priceKrwState: 'unavailable',
        assetPriceSnapshotId: null,
      }),
    );

    assert.equal(merged, item);
    assert.equal(merged.price?.currentPrice, '0.24500000');
  });

  it('overlays a stale ticker but leaves staleness signalling to the caller', () => {
    const merged = mergeMarketAssetTicker(
      restItem(),
      liveTicker({ freshnessAgeSeconds: 300 }),
    );

    assert.equal(merged.price?.currentPrice, '0.24560000');
  });
});

describe('mergeMarketAssetTicker displayPriceDecimals', () => {
  it('applies the ticker-declared decimals to the row', () => {
    const merged = mergeMarketAssetTicker(
      restItem({ displayPriceDecimals: 2 }),
      liveTicker({ displayPriceDecimals: 5 }),
    );

    assert.equal(merged.displayPriceDecimals, 5);
  });

  it('keeps the REST decimals when the ticker declares none', () => {
    const merged = mergeMarketAssetTicker(
      restItem({ displayPriceDecimals: 4 }),
      liveTicker({ displayPriceDecimals: null }),
    );

    assert.equal(merged.displayPriceDecimals, 4);
  });
});

describe('market row inputs (props passed to MarketAssetRow)', () => {
  // The screen passes `item` and `ticker` separately and the row merges them,
  // so a tick must change ONLY that asset's props identity.
  const rowProps = (
    items: MarketAssetItemDto[],
    tickers: Map<string, AssetTickerMessage>,
  ) =>
    items.map((item) => ({
      item,
      ticker: tickers.get(item.id) ?? null,
    }));

  it('changes only the ticking asset\'s ticker prop identity', () => {
    const rows = [restItem(), restItem({ id: 'asset-btc', symbol: 'BTCUSDT' })];
    const dogeTicker = liveTicker();
    const btcTicker = liveTicker({
      assetId: 'asset-btc',
      assetPriceSnapshotId: 'snap-live-btc',
    });
    const before = rowProps(
      rows,
      new Map([
        ['asset-doge', dogeTicker],
        ['asset-btc', btcTicker],
      ]),
    );

    // Only DOGE ticks; the store keeps handing out the SAME BTC ticker object.
    const dogeTicker2 = liveTicker({
      assetPriceSnapshotId: 'snap-live-2',
      priceLocal: '0.24990000',
      priceCapturedAt: '2026-07-25T03:00:35.000Z',
    });
    const after = rowProps(
      rows,
      new Map([
        ['asset-doge', dogeTicker2],
        ['asset-btc', btcTicker],
      ]),
    );

    assert.notEqual(after[0].ticker, before[0].ticker);
    assert.equal(after[0].item, before[0].item);
    // BTC row props are unchanged by identity → React.memo skips it.
    assert.equal(after[1].ticker, before[1].ticker);
    assert.equal(after[1].item, before[1].item);
  });

  it('merges inside the row without mutating the REST baseline', () => {
    const item = restItem();
    const merged = mergeMarketAssetTicker(item, liveTicker());

    assert.equal(item.price?.currentPrice, '0.24500000');
    assert.equal(merged.price?.currentPrice, '0.24560000');
  });
});

describe('mergeMarketAssetTickers', () => {
  it('returns identical row objects for assets without a ticker', () => {
    const rows = [
      restItem(),
      restItem({ id: 'asset-btc', symbol: 'BTCUSDT' }),
    ];
    const merged = mergeMarketAssetTickers(
      rows,
      new Map([['asset-doge', liveTicker()]]),
    );

    assert.notEqual(merged[0], rows[0]);
    // Identity preserved → React.memo skips this row's re-render.
    assert.equal(merged[1], rows[1]);
  });

  it('returns the original list when nothing is subscribed yet', () => {
    const rows = [restItem()];

    assert.equal(mergeMarketAssetTickers(rows, new Map()), rows);
  });
});
