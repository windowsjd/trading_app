import type { AssetTickerMessage } from './assetTickerPolicy';

/**
 * Which price set the detail screen shows when it has BOTH a REST baseline and
 * a realtime ticker.
 *
 * Rule: the latest ticker is used AS A SET, or not at all.
 *  - no ticker            → REST local + REST KRW (when available)
 *  - ticker, KRW available → ticker local + ticker KRW
 *  - ticker, KRW unavailable → ticker local + KRW null (state unavailable)
 *
 * The forbidden combination is a NEW local price next to the OLD REST KRW
 * value: those are two different moments rendered as one quote.
 */

export type RestDisplayPrice = {
  priceKrwState?: string | null;
  priceKrw?: string | null;
  priceSource?: unknown;
};

export function selectDisplayPriceKrw(
  latestTicker: AssetTickerMessage | null | undefined,
  restPrice: RestDisplayPrice | null | undefined,
): string | null {
  if (latestTicker) {
    return latestTicker.priceKrwState === 'available'
      ? (latestTicker.priceKrw ?? null)
      : null;
  }
  return restPrice?.priceKrwState === 'available'
    ? (restPrice.priceKrw ?? null)
    : null;
}

export function selectDisplayPriceKrwState(
  latestTicker: AssetTickerMessage | null | undefined,
  restPrice: RestDisplayPrice | null | undefined,
): string | undefined {
  if (latestTicker) return latestTicker.priceKrwState;
  return restPrice?.priceKrwState ?? undefined;
}

/**
 * Source metadata for the price actually on screen: the ticker's own source
 * while a realtime price is displayed, the REST source otherwise. Prevents a
 * realtime `binance_spot_ws_ticker` price being captioned with a stale REST
 * snapshot's source row.
 */
export function selectDisplayPriceSource(
  latestTicker: AssetTickerMessage | null | undefined,
  restPrice: RestDisplayPrice | null | undefined,
): unknown {
  if (latestTicker) return latestTicker.priceSource ?? null;
  return restPrice?.priceSource ?? null;
}
