import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { createApiError } from '../common/api-error';
import type { FuturesMarketCandle } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FUTURES_DISPLAY_DECIMALS,
  isOfferedFuturesSymbol,
} from '../providers/binance/binance-product-catalog';
import { parseTickSizeDisplayDecimals } from '../providers/binance/binance-tick-size';
import { BINANCE_USDM_KLINES_PATH } from '../providers/binance/binance-kline-usdm.client';
import { FuturesMarketCandlesRepository } from './market-candle-futures.repository';
import {
  FUTURES_CANDLES_UNAVAILABLE_MESSAGE,
  FuturesCandleProviderService,
  type FuturesProviderCandle,
  type FuturesProviderInterval,
} from './market-candle-futures-provider.service';
import {
  FUTURES_CHART_WINDOWS,
  FUTURES_STORED_DEFAULT_LIMIT,
  futuresBucketStart,
  futuresProviderWindow,
  isFuturesChartInterval,
  type FuturesChartInterval,
  type FuturesChartRange,
  type FuturesChartWindow,
} from './market-candle-futures-windows';

// Reads of the stored 4h series are DB-only; a short per-instance cache
// absorbs many viewers of the same contract between the minute-cadenced sync
// runs. The on-demand intervals have their own shared cache underneath.
const CACHE_TTL_MS = 5_000;
const INVALID_QUERY_MESSAGE =
  'Futures chart supports 5m/2d, 15m/3d, 30m/14d, 1h/14d, 4h/96d and 1d/1y with a limit within the window.';

export type FuturesCandlesQuery = {
  interval?: string;
  range?: string;
  limit?: string;
};

export type FuturesCandlePayload = {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
  /** True only for the bucket containing "now" (not final yet). */
  provisional: boolean;
};

export type FuturesCandlesResponse = {
  success: true;
  data: {
    state: 'available' | 'empty';
    instrument: {
      id: string;
      symbol: string;
      name: string;
      productType: string;
      settlementCurrency: string;
      isActive: boolean;
      displayPriceDecimals: number;
    };
    /** Contract trade-price klines; never Mark, Index or Spot prices. */
    priceBasis: 'contract_last_trade';
    range: FuturesChartRange;
    interval: FuturesChartInterval;
    candles: FuturesCandlePayload[];
    source: {
      provider: 'binance_usdm';
      endpoint: typeof BINANCE_USDM_KLINES_PATH;
      symbol: string;
      contractType: 'PERPETUAL';
      requestedCount: number;
      returnedCount: number;
      /** Receipt time of the provisional bucket, when one is returned. */
      provisionalUpdatedAt: string | null;
      /**
       * stored = the collected 4h history; provider = the contract's native
       * klines read on demand through the shared server cache.
       */
      delivery: 'stored' | 'provider';
      /** Provider reads: when the served klines were received. */
      fetchedAt: string | null;
      /** Provider reads: a due refresh failed or was deferred. */
      stale: boolean;
    };
  };
};

type ChartInstrument = {
  id: string;
  isActive: boolean;
  productType: string;
  settlementCurrency: string;
  markContractJson: unknown;
  underlyingAsset: {
    symbol: string;
    name: string;
    market: string;
    assetType: string;
  };
};

/**
 * Futures chart reads for one FuturesInstrument, built only from the Binance
 * USDⓈ-M contract's own klines. Never falls back to the Spot candles of the
 * underlying asset. 4h reads the stored history collected by
 * `futures_candle_sync` (no provider call here); 5m/15m/30m/1h/1d read the
 * contract's native klines through FuturesCandleProviderService, whose shared
 * cache, single flight and call cap keep viewers from multiplying provider
 * calls. Market data, not account data: the response holds no position,
 * balance or permission and is shared across trading accounts.
 */
@Injectable()
export class FuturesCandlesService {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: FuturesCandlesResponse }
  >();
  private readonly inFlight = new Map<
    string,
    Promise<FuturesCandlesResponse>
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: FuturesMarketCandlesRepository,
    @Optional()
    private readonly provider?: FuturesCandleProviderService,
  ) {}

  async getInstrumentCandles(
    userId: string | undefined,
    instrumentId: string | undefined,
    query: FuturesCandlesQuery = {},
    now: Date = new Date(),
  ): Promise<FuturesCandlesResponse> {
    if (!userId) {
      throw createApiError(
        'UNAUTHORIZED',
        'Unauthorized',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const { window, limit } = parseQuery(query);
    const id = instrumentId?.trim() ?? '';
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(id)) throw notFound();
    const key = `${id}|${window.interval}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.load(id, window, limit, now)
      .then((value) => {
        // Expired answers go first, so memory follows what is being viewed
        // (six intervals per contract no longer fit a never-swept cache).
        const wallMs = Date.now();
        for (const [cachedKey, entry] of this.cache) {
          if (entry.expiresAt <= wallMs) this.cache.delete(cachedKey);
        }
        this.cache.set(key, { expiresAt: wallMs + CACHE_TTL_MS, value });
        if (this.cache.size > 500) {
          const oldest = this.cache.keys().next();
          if (!oldest.done) this.cache.delete(oldest.value);
        }
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  private async load(
    id: string,
    window: FuturesChartWindow,
    limit: number,
    now: Date,
  ): Promise<FuturesCandlesResponse> {
    const instrument: ChartInstrument | null =
      await this.prisma.futuresInstrument.findUnique({
        where: { id },
        select: {
          id: true,
          isActive: true,
          productType: true,
          settlementCurrency: true,
          markContractJson: true,
          underlyingAsset: {
            select: { symbol: true, name: true, market: true, assetType: true },
          },
        },
      });
    const symbol = instrument?.underlyingAsset.symbol ?? '';
    if (
      !instrument ||
      !isOfferedFuturesSymbol(symbol) ||
      instrument.productType !== 'synthetic_perpetual' ||
      instrument.underlyingAsset.market !== 'BINANCE' ||
      instrument.underlyingAsset.assetType !== 'crypto'
    ) {
      throw notFound();
    }
    return window.delivery === 'stored'
      ? this.loadStored(instrument, symbol, window, limit, now)
      : this.loadFromProvider(instrument, symbol, window, limit, now);
  }

  private async loadStored(
    instrument: ChartInstrument,
    symbol: string,
    window: FuturesChartWindow,
    limit: number,
    now: Date,
  ): Promise<FuturesCandlesResponse> {
    const nowMs = now.getTime();
    const from = new Date(nowMs - window.rangeMs);
    const currentStart = futuresBucketStart(nowMs, window.intervalMs);
    const rows = await this.repository.findRange({
      futuresInstrumentId: instrument.id,
      interval: '4h',
      from,
      to: new Date(currentStart + window.intervalMs),
    });
    // Completed buckets are final rows whose window has ended; the only open
    // row shown is the one containing "now". An open row from a past window
    // (never finalized because collection stopped) is withheld rather than
    // presented as a completed or current candle.
    const usable = rows.filter((row) =>
      row.isClosed
        ? row.closeTime.getTime() <= nowMs
        : row.openTime.getTime() === currentStart,
    );
    const selected = usable.slice(Math.max(0, usable.length - limit));
    const provisional = selected.find((row) => !row.isClosed) ?? null;
    return this.respond(instrument, symbol, window, limit, {
      candles: selected.map(toStoredPayload),
      provisionalUpdatedAt: provisional
        ? provisional.sourceUpdatedAt.toISOString()
        : null,
      delivery: 'stored',
      fetchedAt: null,
      stale: false,
    });
  }

  private async loadFromProvider(
    instrument: ChartInstrument,
    symbol: string,
    window: FuturesChartWindow,
    limit: number,
    now: Date,
  ): Promise<FuturesCandlesResponse> {
    if (!this.provider) {
      throw createApiError(
        'FUTURES_CANDLES_UNAVAILABLE',
        FUTURES_CANDLES_UNAVAILABLE_MESSAGE,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const read = await this.provider.read({
      instrumentId: instrument.id,
      symbol,
      interval: window.interval as FuturesProviderInterval,
      now,
    });
    const nowMs = now.getTime();
    const bounds = futuresProviderWindow(window, nowMs);
    // The stored path's rule, applied to the served copy: closed buckets whose
    // window ended, plus the open bucket of "now" only. A kline that was open
    // when received but whose window has since ended (a stale read) is
    // withheld rather than shown as final or as current.
    // (A copy taken after this request's clock may already hold the current
    // bucket as closed; it is still this request's current bucket.)
    const usable = read.candles.filter(
      (candle) =>
        candle.openMs >= bounds.fromMs &&
        (candle.isClosed
          ? candle.closeMs <= nowMs || candle.openMs === bounds.currentStartMs
          : candle.openMs === bounds.currentStartMs),
    );
    const selected = usable.slice(Math.max(0, usable.length - limit));
    const fetchedAt = read.fetchedAt.toISOString();
    return this.respond(instrument, symbol, window, limit, {
      candles: selected.map(toProviderPayload),
      provisionalUpdatedAt: selected.some((candle) => !candle.isClosed)
        ? fetchedAt
        : null,
      delivery: 'provider',
      fetchedAt,
      stale: read.stale,
    });
  }

  private respond(
    instrument: ChartInstrument,
    symbol: string,
    window: FuturesChartWindow,
    limit: number,
    series: {
      candles: FuturesCandlePayload[];
      provisionalUpdatedAt: string | null;
      delivery: 'stored' | 'provider';
      fetchedAt: string | null;
      stale: boolean;
    },
  ): FuturesCandlesResponse {
    const contract = instrument.markContractJson;
    const tickDecimals =
      contract && typeof contract === 'object' && !Array.isArray(contract)
        ? parseTickSizeDisplayDecimals(
            (contract as { priceTickSize?: unknown }).priceTickSize,
          )
        : null;
    return {
      success: true,
      data: {
        state: series.candles.length > 0 ? 'available' : 'empty',
        instrument: {
          id: instrument.id,
          symbol,
          name: instrument.underlyingAsset.name,
          productType: instrument.productType,
          settlementCurrency: instrument.settlementCurrency,
          isActive: instrument.isActive,
          displayPriceDecimals:
            tickDecimals !== null && tickDecimals <= 8
              ? tickDecimals
              : (FUTURES_DISPLAY_DECIMALS[symbol] ?? 8),
        },
        priceBasis: 'contract_last_trade',
        range: window.range,
        interval: window.interval,
        candles: series.candles,
        source: {
          provider: 'binance_usdm',
          endpoint: BINANCE_USDM_KLINES_PATH,
          symbol,
          contractType: 'PERPETUAL',
          requestedCount: limit,
          returnedCount: series.candles.length,
          provisionalUpdatedAt: series.provisionalUpdatedAt,
          delivery: series.delivery,
          fetchedAt: series.fetchedAt,
          stale: series.stale,
        },
      },
    };
  }
}

function toStoredPayload(row: FuturesMarketCandle): FuturesCandlePayload {
  return {
    time: row.openTime.toISOString(),
    open: row.open.toFixed(8),
    high: row.high.toFixed(8),
    low: row.low.toFixed(8),
    close: row.close.toFixed(8),
    volume: row.volume.toFixed(8),
    amount: row.amount ? row.amount.toFixed(8) : '0.00000000',
    provisional: !row.isClosed,
  };
}

function toProviderPayload(
  candle: FuturesProviderCandle,
): FuturesCandlePayload {
  return {
    time: new Date(candle.openMs).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    amount: candle.amount,
    provisional: !candle.isClosed,
  };
}

/**
 * interval defaults to 4h; range defaults to the interval's own window and
 * must match it when given; limit defaults to the interval's maximum (600 for
 * the stored 4h series) and must stay inside 1..maximum.
 */
function parseQuery(query: FuturesCandlesQuery): {
  window: FuturesChartWindow;
  limit: number;
} {
  const intervalText = query.interval?.trim() || '4h';
  const window = isFuturesChartInterval(intervalText)
    ? FUTURES_CHART_WINDOWS[intervalText]
    : null;
  const range = query.range?.trim() || window?.range;
  const limitText = query.limit?.trim();
  const limit =
    limitText === undefined || limitText === ''
      ? window?.delivery === 'stored'
        ? FUTURES_STORED_DEFAULT_LIMIT
        : (window?.maxLimit ?? Number.NaN)
      : /^\d+$/u.test(limitText)
        ? Number(limitText)
        : Number.NaN;
  if (
    !window ||
    range !== window.range ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > window.maxLimit
  ) {
    throw createApiError(
      'FUTURES_CANDLES_INVALID_QUERY',
      INVALID_QUERY_MESSAGE,
      HttpStatus.BAD_REQUEST,
    );
  }
  return { window, limit };
}

function notFound() {
  return createApiError(
    'FUTURES_INSTRUMENT_NOT_FOUND',
    'Futures instrument was not found.',
    HttpStatus.NOT_FOUND,
  );
}
