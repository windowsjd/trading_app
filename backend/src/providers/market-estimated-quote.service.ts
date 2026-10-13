import { Injectable, Optional } from '@nestjs/common';
import { AssetType, CurrencyCode } from '../generated/prisma/client';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import {
  TIINGO_ESTIMATED_QUOTE_MAX_AGE_MS,
  TiingoQuoteService,
  type TiingoEstimatedQuote,
} from './tiingo/tiingo-quote.service';

/**
 * App-facing estimated best bid/ask for a US equity.
 *
 * This is Tiingo's statistical liquidity estimate (thresholdLevel 4), NOT an
 * exchange order book: one level per side, sizes in shares, any side may be
 * absent. It is display data only — never an execution, fill, slippage,
 * valuation or persistence input — and it is kept apart from the
 * `asset_order_book` ladder contract.
 */
export type AssetEstimatedQuoteEvent = {
  type: 'asset_estimated_quote';
  assetId: string;
  kind: 'estimated_liquidity';
  provider: 'tiingo';
  priceCurrency: 'USD';
  quantityUnit: 'share';
  bid: { price: string | null; size: string | null };
  ask: { price: string | null; size: string | null };
  /** Relative spread as a decimal fraction (0.0011 = 0.11%). */
  spread: string | null;
  referencePrice: string | null;
  effectiveAt: string;
  capturedAt: string;
};

export type MarketEstimatedQuoteTarget = { assetId: string };

/** Provider mapping stays behind this boundary, like the order-book target. */
@Injectable()
export class MarketEstimatedQuoteService {
  constructor(@Optional() private readonly tiingo?: TiingoQuoteService) {}

  async loadTarget(
    assetId: string,
  ): Promise<MarketEstimatedQuoteTarget | null> {
    const target = await this.tiingo?.targetForAssetId(assetId);
    return target ? { assetId: target.assetId } : null;
  }

  /** The current in-session estimate, or null (closed, stale or absent). */
  async getCurrent(
    assetId: string,
    now: Date = new Date(),
  ): Promise<AssetEstimatedQuoteEvent | null> {
    if (!this.tiingo) return null;
    const target = await this.tiingo.targetForAssetId(assetId);
    if (!target) return null;
    const quote = await this.tiingo.getEstimatedQuote(
      {
        id: target.assetId,
        symbol: target.symbol,
        market: target.market,
        assetType: AssetType.us_stock,
        priceCurrency: CurrencyCode.USD,
      },
      now,
    );
    return quote ? toEstimatedQuoteEvent(quote) : null;
  }

  subscribe(listener: (event: AssetEstimatedQuoteEvent) => void): () => void {
    if (!this.tiingo) return () => undefined;
    return this.tiingo.onEstimatedQuote((quote) => {
      // Live delivery follows the regular-session display policy.
      if (!isInCurrentRegularSession(quote, new Date())) return;
      listener(toEstimatedQuoteEvent(quote));
    });
  }
}

export function isInCurrentRegularSession(
  quote: Pick<TiingoEstimatedQuote, 'effectiveAt' | 'capturedAt'>,
  now: Date,
): boolean {
  const state = resolveStockMarketSessionState(
    { assetType: AssetType.us_stock, market: 'NAS' },
    now,
  );
  return (
    state?.state === 'open' &&
    quote.effectiveAt.getTime() >= state.currentSession.openTime.getTime() &&
    quote.effectiveAt.getTime() <= now.getTime() &&
    now.getTime() - quote.capturedAt.getTime() <=
      TIINGO_ESTIMATED_QUOTE_MAX_AGE_MS
  );
}

function toEstimatedQuoteEvent(
  quote: TiingoEstimatedQuote,
): AssetEstimatedQuoteEvent {
  return {
    type: 'asset_estimated_quote',
    assetId: quote.assetId,
    kind: 'estimated_liquidity',
    provider: 'tiingo',
    priceCurrency: 'USD',
    quantityUnit: 'share',
    bid: { price: quote.bidPrice, size: quote.bidSize },
    ask: { price: quote.askPrice, size: quote.askSize },
    spread: quote.spread,
    referencePrice: quote.referencePrice,
    effectiveAt: quote.effectiveAt.toISOString(),
    capturedAt: quote.capturedAt.toISOString(),
  };
}
