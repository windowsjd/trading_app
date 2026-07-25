import {
  getTickerTimestamp,
  parseTickerTimestamp,
  type AssetTickerMessage,
} from '../asset/assetTickerPolicy.ts';
import type { MarketAssetItemDto } from './api';

/**
 * REST baseline + realtime overlay for one market row.
 *
 * Rules (mirrored by mergeMarketAssetTicker.test.ts):
 *  1. only a ticker with a usable `priceLocal` replaces the displayed price,
 *  2. no ticker (or a rejected one) → the REST row is returned unchanged,
 *  3. an older ticker never overwrites a newer REST price,
 *  4. the local price and its KRW value must come from the SAME moment: the
 *     server sends the realtime KRW alongside the realtime local price, so a
 *     ticker without an available KRW conversion shows the local price and
 *     marks KRW unavailable instead of reusing the REST KRW value,
 *  5. price source/captured-at travel with the price that is actually shown.
 */
export function mergeMarketAssetTicker(
  item: MarketAssetItemDto,
  ticker: AssetTickerMessage | undefined,
): MarketAssetItemDto {
  if (!ticker || ticker.assetId !== item.id) return item;
  if (!ticker.priceLocal) return item;

  const tickerTimestamp = getTickerTimestamp(ticker);
  const restTimestamp =
    parseTickerTimestamp(item.price?.priceCapturedAt) ??
    parseTickerTimestamp(item.price?.priceEffectiveAt);
  if (
    tickerTimestamp !== null &&
    restTimestamp !== null &&
    tickerTimestamp < restTimestamp
  ) {
    return item;
  }

  const krwAvailable =
    ticker.priceKrwState === 'available' && !!ticker.priceKrw;

  return {
    ...item,
    // Provider-declared unit-price precision travels with the ticker, so a
    // backend precision refresh reaches already-rendered rows. A ticker with
    // no declared value never wipes the REST one.
    displayPriceDecimals:
      typeof ticker.displayPriceDecimals === 'number'
        ? ticker.displayPriceDecimals
        : item.displayPriceDecimals,
    changeRate:
      typeof ticker.changeRate === 'string' ? ticker.changeRate : item.changeRate,
    price: {
      ...item.price,
      state: 'available',
      currentPrice: ticker.priceLocal,
      priceCurrency: ticker.priceCurrency ?? item.priceCurrency,
      // Never pair this new local price with the previous snapshot's KRW.
      priceKrw: krwAvailable ? ticker.priceKrw : null,
      priceKrwState: krwAvailable ? 'available' : 'unavailable',
      changeRate:
        typeof ticker.changeRate === 'string'
          ? ticker.changeRate
          : (item.price?.changeRate ?? null),
      assetPriceSnapshotId: ticker.assetPriceSnapshotId ?? null,
      priceCapturedAt: ticker.priceCapturedAt ?? ticker.capturedAt ?? null,
      priceEffectiveAt: ticker.priceEffectiveAt ?? null,
      priceSource: ticker.priceSource ?? item.price?.priceSource,
    },
  };
}

/** Applies the overlay to a whole page of rows. */
export function mergeMarketAssetTickers(
  items: readonly MarketAssetItemDto[],
  tickersByAssetId: ReadonlyMap<string, AssetTickerMessage>,
): MarketAssetItemDto[] {
  if (tickersByAssetId.size === 0) return items as MarketAssetItemDto[];
  return items.map((item) =>
    mergeMarketAssetTicker(item, tickersByAssetId.get(item.id)),
  );
}
