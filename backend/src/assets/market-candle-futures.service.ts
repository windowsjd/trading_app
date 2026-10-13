import { HttpStatus, Injectable } from '@nestjs/common';
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

const DAY_MS = 24 * 60 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
const RANGE_DAYS = 96;
const DEFAULT_LIMIT = 600;
const MAX_LIMIT = 1000;
// Reads are DB-only; a short per-instance cache absorbs many viewers of the
// same contract between the minute-cadenced sync runs.
const CACHE_TTL_MS = 5_000;
const INVALID_QUERY_MESSAGE =
  'Futures chart supports interval 4h, range 96d and a limit from 1 to 1000.';

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
    range: '96d';
    interval: '4h';
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
    };
  };
};

/**
 * Futures chart reads for one FuturesInstrument: stored Binance USDⓈ-M
 * contract 4h klines only (futures_market_candles). Never falls back to the
 * Spot candles of the underlying asset, and never calls a provider — the
 * minute-cadenced `futures_candle_sync` job owns collection, so viewers cannot
 * multiply provider calls. Market data, not account data: the response holds
 * no position, balance or permission and is shared across trading accounts.
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
    const limit = parseQuery(query);
    const id = instrumentId?.trim() ?? '';
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(id)) throw notFound();
    const key = `${id}|${limit}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.load(id, limit, now)
      .then((value) => {
        this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
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
    limit: number,
    now: Date,
  ): Promise<FuturesCandlesResponse> {
    const instrument = await this.prisma.futuresInstrument.findUnique({
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
    const nowMs = now.getTime();
    const from = new Date(nowMs - RANGE_DAYS * DAY_MS);
    const currentStart = Math.floor(nowMs / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const rows = await this.repository.findRange({
      futuresInstrumentId: instrument.id,
      interval: '4h',
      from,
      to: new Date(currentStart + FOUR_HOURS_MS),
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
    const contract = instrument.markContractJson;
    const tickDecimals =
      contract && typeof contract === 'object' && !Array.isArray(contract)
        ? parseTickSizeDisplayDecimals(contract.priceTickSize)
        : null;
    return {
      success: true,
      data: {
        state: selected.length > 0 ? 'available' : 'empty',
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
        range: '96d',
        interval: '4h',
        candles: selected.map(toPayload),
        source: {
          provider: 'binance_usdm',
          endpoint: BINANCE_USDM_KLINES_PATH,
          symbol,
          contractType: 'PERPETUAL',
          requestedCount: limit,
          returnedCount: selected.length,
          provisionalUpdatedAt: provisional
            ? provisional.sourceUpdatedAt.toISOString()
            : null,
        },
      },
    };
  }
}

function toPayload(row: FuturesMarketCandle): FuturesCandlePayload {
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

function parseQuery(query: FuturesCandlesQuery): number {
  const interval = query.interval?.trim() || '4h';
  const range = query.range?.trim() || '96d';
  const limitText = query.limit?.trim();
  const limit =
    limitText === undefined || limitText === ''
      ? DEFAULT_LIMIT
      : Number(limitText);
  if (
    interval !== '4h' ||
    range !== '96d' ||
    (limitText !== undefined &&
      limitText !== '' &&
      !/^\d+$/u.test(limitText)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIMIT
  ) {
    throw createApiError(
      'FUTURES_CANDLES_INVALID_QUERY',
      INVALID_QUERY_MESSAGE,
      HttpStatus.BAD_REQUEST,
    );
  }
  return limit;
}

function notFound() {
  return createApiError(
    'FUTURES_INSTRUMENT_NOT_FOUND',
    'Futures instrument was not found.',
    HttpStatus.NOT_FOUND,
  );
}
