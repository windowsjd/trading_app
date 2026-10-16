import { Injectable, Optional } from '@nestjs/common';
import type { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  TiingoQuoteService,
  type TiingoDisplayPrice,
} from './tiingo/tiingo-quote.service';
import { TIINGO_REFERENCE_PRICE_SOURCE } from './tiingo/tiingo.config';

export type DisplayPriceAsset = {
  id: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  priceCurrency?: CurrencyCode | null;
  currencyCode?: CurrencyCode | null;
};

/** A price that exists only in process memory (no `asset_price_snapshots` row). */
export type EphemeralDisplayPrice = TiingoDisplayPrice;

const EPHEMERAL_DISPLAY_SOURCE_NAMES: ReadonlySet<string> = new Set([
  TIINGO_REFERENCE_PRICE_SOURCE,
]);

/**
 * Display-only price routing for assets served by an ephemeral provider
 * (the Tiingo US-equity trial; Tiingo's official mode stores snapshots and
 * uses the ordinary stored path). It answers only the asset read and
 * realtime ticker paths; orders, valuation, ranking, settlement and snapshot
 * health keep the stored-snapshot policy and never call it. For every other
 * asset it returns null and nothing changes.
 */
@Injectable()
export class MarketDisplayPriceService {
  constructor(@Optional() private readonly tiingo?: TiingoQuoteService) {}

  /** Null = not ephemeral-managed: the stored snapshot selection applies. */
  async resolve(
    asset: DisplayPriceAsset,
    now: Date,
  ): Promise<EphemeralDisplayPrice | null> {
    if (!this.tiingo?.isTrialDisplayEnabled()) return null;
    return this.tiingo.resolveDisplayPrice(asset, now);
  }

  /**
   * Realtime display sources for this asset, or null for the default
   * eligibility. A managed asset accepts only its ephemeral source, so a
   * stored-provider tick can never be shown in its place (and vice versa).
   */
  async displaySourceNames(
    asset: DisplayPriceAsset,
  ): Promise<readonly string[] | null> {
    if (!this.tiingo?.isTrialDisplayEnabled()) return null;
    return (await this.tiingo.targetForAsset(asset))
      ? [TIINGO_REFERENCE_PRICE_SOURCE]
      : null;
  }

  /** Official-mode Tiingo prices are stored snapshots, not ephemeral. */
  isEphemeralSourceName(sourceName: string | null | undefined): boolean {
    return Boolean(
      this.tiingo?.isTrialDisplayEnabled() &&
      sourceName &&
      EPHEMERAL_DISPLAY_SOURCE_NAMES.has(sourceName),
    );
  }
}
