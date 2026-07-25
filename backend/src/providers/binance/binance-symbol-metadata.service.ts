import { Injectable, Logger } from '@nestjs/common';
import { BinancePublicClient } from './binance-public.client';
import {
  BINANCE_ASSET_MARKET,
  BINANCE_FIXED_ASSET_UNIVERSE,
  BINANCE_FIXED_SYMBOLS,
} from './binance-fixed-asset-universe';
import { readBinanceSymbolPricePrecision } from './binance-tick-size';

export type BinanceSymbolDisplayPrecision = {
  symbol: string;
  priceTickSize: string;
  displayPriceDecimals: number;
  /** `exchange_info` = live provider value, `fixed_universe` = reviewed fallback. */
  source: 'exchange_info' | 'fixed_universe';
};

export type BinanceSymbolMetadataStatus = {
  cachedSymbolCount: number;
  lastRefreshAt: string | null;
  lastRefreshOk: boolean | null;
  lastErrorCode: string | null;
};

/** exchangeInfo trading rules change rarely; one refresh per 6h is plenty. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** After a failure, do not hammer the endpoint from the request path. */
const FAILURE_RETRY_MS = 5 * 60 * 1000;

/**
 * Per-symbol Binance Spot price display precision, derived from
 * `PRICE_FILTER.tickSize` on the public `GET /api/v3/exchangeInfo` endpoint the
 * project already uses (no new vendor, no API key, no DB table).
 *
 * Reads are synchronous and never block a request: `getDisplayPriceDecimals`
 * answers from memory (live cache → reviewed fixed-universe fallback) and only
 * schedules a background refresh when the cache is stale. A failed refresh keeps
 * the last successful values; only the error code is logged, never the payload.
 */
@Injectable()
export class BinanceSymbolMetadataService {
  private readonly logger = new Logger(BinanceSymbolMetadataService.name);
  private readonly cache = new Map<string, BinanceSymbolDisplayPrecision>();
  private readonly fallback = new Map<string, BinanceSymbolDisplayPrecision>();
  private lastRefreshAt: number | null = null;
  private lastRefreshOk: boolean | null = null;
  private lastErrorCode: string | null = null;
  private nextRefreshAllowedAt = 0;
  private inFlight: Promise<boolean> | null = null;

  constructor(private readonly client: BinancePublicClient) {
    for (const entry of BINANCE_FIXED_ASSET_UNIVERSE) {
      this.fallback.set(entry.symbol, {
        symbol: entry.symbol,
        priceTickSize: entry.priceTickSize,
        displayPriceDecimals: entry.displayPriceDecimals,
        source: 'fixed_universe',
      });
    }
  }

  /**
   * Display decimals for an asset row, or null for non-Binance assets (whose
   * precision policy is unchanged). Safe to call on every API request.
   */
  getDisplayPriceDecimals(input: {
    market: string;
    symbol: string;
  }): number | null {
    return this.getPrecision(input)?.displayPriceDecimals ?? null;
  }

  getPrecision(input: {
    market: string;
    symbol: string;
  }): BinanceSymbolDisplayPrecision | null {
    if (input.market.trim().toUpperCase() !== BINANCE_ASSET_MARKET) return null;

    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) return null;

    this.scheduleRefreshIfStale();
    return this.cache.get(symbol) ?? this.fallback.get(symbol) ?? null;
  }

  /** Forces a refresh (used by tests and the smoke script); never throws. */
  async refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;

    const symbols = [
      ...new Set([...BINANCE_FIXED_SYMBOLS, ...this.cache.keys()]),
    ];
    this.inFlight = this.loadExchangeInfo(symbols).finally(() => {
      this.inFlight = null;
    });

    return this.inFlight;
  }

  getStatus(): BinanceSymbolMetadataStatus {
    return {
      cachedSymbolCount: this.cache.size,
      lastRefreshAt:
        this.lastRefreshAt === null
          ? null
          : new Date(this.lastRefreshAt).toISOString(),
      lastRefreshOk: this.lastRefreshOk,
      lastErrorCode: this.lastErrorCode,
    };
  }

  private scheduleRefreshIfStale(): void {
    const now = Date.now();
    if (this.inFlight) return;
    if (now < this.nextRefreshAllowedAt) return;
    if (
      this.lastRefreshAt !== null &&
      now - this.lastRefreshAt < CACHE_TTL_MS
    ) {
      return;
    }

    // Block re-entry immediately: refresh() is async, so without this the same
    // tick could queue one refresh per asset in a list response.
    this.nextRefreshAllowedAt = now + FAILURE_RETRY_MS;
    void this.refresh();
  }

  private async loadExchangeInfo(symbols: readonly string[]): Promise<boolean> {
    try {
      const { response } = await this.client.fetchExchangeInfo(symbols);
      const precisions = readBinanceSymbolPricePrecision(response);
      if (precisions.length === 0) {
        this.recordFailure('BINANCE_EXCHANGE_INFO_EMPTY');
        return false;
      }

      for (const precision of precisions) {
        this.cache.set(precision.symbol, {
          ...precision,
          source: 'exchange_info',
        });
      }
      this.lastRefreshAt = Date.now();
      this.lastRefreshOk = true;
      this.lastErrorCode = null;
      this.nextRefreshAllowedAt = this.lastRefreshAt + CACHE_TTL_MS;
      return true;
    } catch (error) {
      this.recordFailure(readErrorCode(error));
      return false;
    }
  }

  private recordFailure(code: string): void {
    // The last successful cache is intentionally kept.
    this.lastRefreshOk = false;
    this.lastErrorCode = code;
    this.nextRefreshAllowedAt = Date.now() + FAILURE_RETRY_MS;
    this.logger.warn(
      `Binance exchangeInfo precision refresh failed (${code}); serving ${
        this.cache.size > 0 ? 'last cached' : 'fixed-universe fallback'
      } display decimals.`,
    );
  }
}

function readErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.trim()) return code;
  }
  if (error instanceof Error && error.name) return error.name;
  return 'BINANCE_EXCHANGE_INFO_ERROR';
}
