import type { AssetTickerMessage } from './assetTickerPolicy';

/**
 * ONE basis for every price value and metadata selected for the detail screen.
 *
 * A realtime ticker and the REST snapshot describe two different moments, so
 * the screen picks a basis and takes the WHOLE set from it, even though its
 * user-facing card renders only a subset of the returned metadata:
 *   - a latest ticker exists  → local price, KRW state/value/reason, price
 *     source, FX source, captured/effective time and freshness all come from
 *     that ticker (a ticker whose KRW is unavailable shows KRW unavailable —
 *     the REST KRW never fills in beside a newer local price),
 *   - no ticker              → the REST price payload, unchanged.
 *
 * `displayPriceDecimals` is asset metadata (not a moment), so the ticker value
 * is preferred only when it declares one; otherwise the asset's REST value.
 */

export type RestDisplayPrice = {
  state?: string | null;
  currentPrice?: string | null;
  priceCurrency?: 'KRW' | 'USD' | null;
  priceKrwState?: string | null;
  priceKrw?: string | null;
  priceKrwReason?: string | null;
  priceKrwMessage?: string | null;
  changeRate?: string | null;
  priceCapturedAt?: string | null;
  priceEffectiveAt?: string | null;
  priceSource?: unknown;
  fxRateSource?: unknown;
};

export type DisplayPriceBasis = 'realtime' | 'rest' | 'none';

export type DisplayPrice = {
  /** Which side of the data the whole set came from. */
  basis: DisplayPriceBasis;
  priceLocal: string | null;
  priceCurrency: 'KRW' | 'USD' | null;
  priceKrw: string | null;
  priceKrwState: string | undefined;
  priceKrwReason: string | undefined;
  priceKrwMessage: string | undefined;
  changeRate: string | null;
  priceCapturedAt: string | null;
  priceEffectiveAt: string | null;
  freshnessAgeSeconds: number | null;
  priceSource: unknown;
  fxRateSource: unknown;
  displayPriceDecimals: number | null;
  /** True while a realtime ticker price is on screen. */
  isRealtime: boolean;
};

function isRestPriceAvailable(price?: RestDisplayPrice | null): boolean {
  return price?.state === 'available' && !!price.currentPrice;
}

export function selectDisplayPrice(input: {
  latestTicker?: AssetTickerMessage | null;
  restPrice?: RestDisplayPrice | null;
  assetPriceCurrency?: 'KRW' | 'USD' | null;
  assetDisplayPriceDecimals?: number | null;
}): DisplayPrice {
  const { latestTicker, restPrice } = input;
  const decimalsFallback = input.assetDisplayPriceDecimals ?? null;

  if (latestTicker) {
    const krwAvailable = latestTicker.priceKrwState === 'available';
    return {
      basis: 'realtime',
      priceLocal: latestTicker.priceLocal ?? null,
      priceCurrency: latestTicker.priceCurrency ?? input.assetPriceCurrency ?? null,
      priceKrw: krwAvailable ? (latestTicker.priceKrw ?? null) : null,
      priceKrwState: latestTicker.priceKrwState,
      priceKrwReason: krwAvailable ? undefined : latestTicker.priceKrwReason,
      priceKrwMessage: krwAvailable ? undefined : latestTicker.priceKrwMessage,
      changeRate: latestTicker.changeRate ?? null,
      priceCapturedAt:
        latestTicker.priceCapturedAt ?? latestTicker.capturedAt ?? null,
      priceEffectiveAt: latestTicker.priceEffectiveAt ?? null,
      freshnessAgeSeconds: latestTicker.freshnessAgeSeconds ?? null,
      // Realtime payloads normally carry their own source; keep the REST source
      // as a last resort so the selected metadata remains complete.
      priceSource: latestTicker.priceSource ?? restPrice?.priceSource ?? null,
      // FX source belongs to the ticker's own conversion attempt (present for
      // both available and unavailable outcomes), never the REST snapshot's.
      fxRateSource: latestTicker.fxRateSource ?? null,
      displayPriceDecimals:
        typeof latestTicker.displayPriceDecimals === 'number'
          ? latestTicker.displayPriceDecimals
          : decimalsFallback,
      isRealtime: true,
    };
  }

  if (isRestPriceAvailable(restPrice)) {
    const krwAvailable = restPrice?.priceKrwState === 'available';
    return {
      basis: 'rest',
      priceLocal: restPrice?.currentPrice ?? null,
      priceCurrency: restPrice?.priceCurrency ?? input.assetPriceCurrency ?? null,
      priceKrw: krwAvailable ? (restPrice?.priceKrw ?? null) : null,
      priceKrwState: restPrice?.priceKrwState ?? undefined,
      priceKrwReason: krwAvailable
        ? undefined
        : (restPrice?.priceKrwReason ?? undefined),
      priceKrwMessage: krwAvailable
        ? undefined
        : (restPrice?.priceKrwMessage ?? undefined),
      changeRate: restPrice?.changeRate ?? null,
      priceCapturedAt: restPrice?.priceCapturedAt ?? null,
      priceEffectiveAt: restPrice?.priceEffectiveAt ?? null,
      freshnessAgeSeconds: null,
      priceSource: restPrice?.priceSource ?? null,
      fxRateSource: restPrice?.fxRateSource ?? null,
      displayPriceDecimals: decimalsFallback,
      isRealtime: false,
    };
  }

  return {
    basis: 'none',
    priceLocal: null,
    priceCurrency: input.assetPriceCurrency ?? null,
    priceKrw: null,
    priceKrwState: restPrice?.priceKrwState ?? undefined,
    priceKrwReason: restPrice?.priceKrwReason ?? undefined,
    priceKrwMessage: restPrice?.priceKrwMessage ?? undefined,
    changeRate: null,
    priceCapturedAt: null,
    priceEffectiveAt: null,
    freshnessAgeSeconds: null,
    priceSource: null,
    fxRateSource: null,
    displayPriceDecimals: decimalsFallback,
    isRealtime: false,
  };
}
