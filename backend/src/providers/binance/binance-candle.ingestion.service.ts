import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { BinancePublicClient } from './binance-public.client';
import {
  BINANCE_CANDLE_INTERVAL_MS,
  BINANCE_KLINES_MAX_LIMIT,
  BinanceCandleInputError,
  type BinanceCandleInterval,
  type BinanceCandlePageInput,
  type BinanceCandlePageResult,
  type CanonicalBinanceCandle,
} from './binance-candle.types';

// Binance weekly klines open on Monday 00:00 UTC; the epoch (1970-01-01) was
// a Thursday, so the weekly grid is offset by four days.
const WEEK_GRID_OFFSET_MS = 4 * 24 * 60 * 60_000;
const SYMBOL_PATTERN = /^[A-Z0-9]{1,32}$/u;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/**
 * Page-level Binance Spot /api/v3/klines ingestion (5m/1d/1w).
 *
 * One call fetches at most 1000 klines with a forward startTime cursor;
 * multi-page iteration is owned by the sync orchestrator so the persistent
 * checkpoint advances only after each page is written. This path talks only
 * to the public Binance REST API through BinancePublicClient and never
 * touches the KIS rate limiter.
 *
 * Strict normalization: rows must sit on the interval grid with a consistent
 * Binance close time, prices must be positive and OHLC-consistent, volume and
 * quote-asset volume (stored as `amount`) must be non-negative. Malformed
 * rows are rejected, never repaired; future klines are rejected; the
 * currently-open kline is kept with isClosed=false based on the
 * provider-reported close time.
 */
@Injectable()
export class BinanceCandleIngestionService {
  constructor(private readonly publicClient: BinancePublicClient) {}

  async fetchKlinesPage(
    input: BinanceCandlePageInput,
  ): Promise<BinanceCandlePageResult> {
    const symbol = this.requireSymbol(input.symbol);
    const intervalMs = this.requireIntervalMs(input.interval);
    const now = input.now ?? new Date();
    const fromMs = this.requireInstant(input.from, 'from');
    const toMs = this.requireInstant(input.to, 'to');
    if (fromMs >= toMs) {
      throw new BinanceCandleInputError(
        'Candle range must be half-open [from, to) with from earlier than to.',
      );
    }
    const limit = this.resolveLimit(input.limit);
    const startTime = input.cursor?.startTime ?? fromMs;
    if (!Number.isSafeInteger(startTime) || startTime < fromMs) {
      throw new BinanceCandleInputError(
        'cursor.startTime must be a safe integer inside the target range.',
      );
    }
    if (startTime >= toMs) {
      return emptyResult('target_reached', true);
    }

    const fetched = await this.publicClient.fetchKlines({
      symbol,
      interval: input.interval,
      limit,
      startTime,
      endTime: toMs - 1,
    });
    if (!Array.isArray(fetched.response)) {
      return emptyResult('malformed_response', false);
    }
    const providerReturnedRows = fetched.response.length;
    if (providerReturnedRows === 0) {
      return {
        ...emptyResult(
          startTime === fromMs ? 'empty_page' : 'provider_exhausted',
          false,
        ),
        providerReturnedRows,
      };
    }

    const byOpenTime = new Map<number, CanonicalBinanceCandle>();
    let rejectedRows = 0;
    let duplicateRows = 0;
    let maxOpenMs: number | null = null;
    for (const row of fetched.response) {
      const parsed = this.parseKlineRow(
        row,
        intervalMs,
        input.interval,
        fromMs,
        toMs,
        now,
        fetched.receivedAt,
      );
      if (!parsed) {
        rejectedRows += 1;
        continue;
      }
      const key = parsed.openTime.getTime();
      maxOpenMs = maxOpenMs === null ? key : Math.max(maxOpenMs, key);
      if (byOpenTime.has(key)) {
        duplicateRows += 1;
      }
      byOpenTime.set(key, parsed);
    }
    const candles = [...byOpenTime.values()].sort(
      (left, right) => left.openTime.getTime() - right.openTime.getTime(),
    );

    if (candles.length === 0 || maxOpenMs === null) {
      // The provider responded but not a single row survived strict
      // validation; never treat that as success.
      return {
        candles: [],
        providerReturnedRows,
        acceptedRows: 0,
        rejectedRows,
        duplicateRows,
        nextCursor: null,
        stopReason: 'malformed_response',
        complete: false,
      };
    }

    const nextStart = maxOpenMs + intervalMs;
    let nextCursor: { startTime: number } | null = null;
    let stopReason: BinanceCandlePageResult['stopReason'] = null;
    let complete = false;
    if (nextStart >= toMs) {
      stopReason = 'target_reached';
      complete = true;
    } else if (providerReturnedRows < limit) {
      // Fewer rows than requested: the provider has no more klines before
      // `to` right now. The sweep ends but the range was not fully covered.
      stopReason = 'provider_exhausted';
    } else if (nextStart <= startTime) {
      stopReason = 'cursor_not_advanced';
    } else {
      nextCursor = { startTime: nextStart };
    }

    return {
      candles,
      providerReturnedRows,
      acceptedRows: candles.length,
      rejectedRows,
      duplicateRows,
      nextCursor,
      stopReason,
      complete,
    };
  }

  private parseKlineRow(
    row: unknown,
    intervalMs: number,
    interval: BinanceCandleInterval,
    fromMs: number,
    toMs: number,
    now: Date,
    receivedAt: Date,
  ): CanonicalBinanceCandle | null {
    if (!Array.isArray(row) || row.length < 8) return null;
    const openMs = integerValue(row[0]);
    const closeMs = integerValue(row[6]);
    if (openMs === null || closeMs === null) return null;
    const gridOffset = interval === '1w' ? WEEK_GRID_OFFSET_MS : 0;
    if ((openMs - gridOffset) % intervalMs !== 0) return null;
    if (closeMs !== openMs + intervalMs - 1) return null;
    if (openMs < fromMs || openMs >= toMs) return null;
    if (openMs > now.getTime()) return null;

    const open = decimal(row[1]);
    const high = decimal(row[2]);
    const low = decimal(row[3]);
    const close = decimal(row[4]);
    const volume = decimal(row[5]);
    const amount = decimal(row[7]);
    if (
      !open ||
      !high ||
      !low ||
      !close ||
      !volume ||
      !amount ||
      !open.gt(0) ||
      !high.gt(0) ||
      !low.gt(0) ||
      !close.gt(0) ||
      volume.lt(0) ||
      amount.lt(0) ||
      high.lt(open) ||
      high.lt(close) ||
      high.lt(low) ||
      low.gt(open) ||
      low.gt(close)
    ) {
      return null;
    }

    return {
      openTime: new Date(openMs),
      closeTime: new Date(openMs + intervalMs),
      open,
      high,
      low,
      close,
      volume,
      amount,
      isClosed: closeMs < now.getTime(),
      sourceUpdatedAt: receivedAt,
    };
  }

  private requireSymbol(symbol: string): string {
    const normalized =
      typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
    if (!SYMBOL_PATTERN.test(normalized)) {
      throw new BinanceCandleInputError(
        'symbol must be a Binance-compatible uppercase symbol.',
      );
    }
    return normalized;
  }

  private requireIntervalMs(interval: BinanceCandleInterval): number {
    const intervalMs = BINANCE_CANDLE_INTERVAL_MS[interval];
    if (!intervalMs) {
      throw new BinanceCandleInputError('interval must be 5m, 1d, or 1w.');
    }
    return intervalMs;
  }

  private requireInstant(value: Date, field: string): number {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new BinanceCandleInputError(`${field} must be a valid Date.`);
    }
    return value.getTime();
  }

  private resolveLimit(limit: number | undefined): number {
    if (limit === undefined) return BINANCE_KLINES_MAX_LIMIT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > BINANCE_KLINES_MAX_LIMIT
    ) {
      throw new BinanceCandleInputError(
        `limit must be between 1 and ${BINANCE_KLINES_MAX_LIMIT}.`,
      );
    }
    return limit;
  }
}

function emptyResult(
  stopReason: BinanceCandlePageResult['stopReason'],
  complete: boolean,
): BinanceCandlePageResult {
  return {
    candles: [],
    providerReturnedRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    nextCursor: null,
    stopReason,
    complete,
  };
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function decimal(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  try {
    const parsed = new Prisma.Decimal(text);
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}
