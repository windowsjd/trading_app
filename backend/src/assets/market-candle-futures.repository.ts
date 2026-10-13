import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { FuturesMarketCandle } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT } from './market-candle-retention.constants';

/** Binance USDⓈ-M `/fapi/v1/klines` — contract trade price, never Mark/Index. */
export const FUTURES_MARKET_CANDLE_SOURCE = 'binance_usdm_klines';
export const FUTURES_MARKET_CANDLE_INTERVALS = ['4h'] as const;
export type FuturesMarketCandleInterval =
  (typeof FUTURES_MARKET_CANDLE_INTERVALS)[number];

// 16 bind parameters per row; 500 rows stay far below PostgreSQL's limit.
export const FUTURES_MARKET_CANDLE_UPSERT_CHUNK_SIZE = 500;

const DECIMAL_SCALE = 8;
const DECIMAL_ABSOLUTE_LIMIT = new Prisma.Decimal('10000000000000000');
const CONTRACT_SYMBOL = /^[A-Z0-9]+USDT$/u;

export type FuturesMarketCandleUpsertInput = {
  futuresInstrumentId: string;
  interval: FuturesMarketCandleInterval;
  contractSymbol: string;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount?: Prisma.Decimal | string | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

type ValidatedRow = Omit<
  FuturesMarketCandleUpsertInput,
  'open' | 'high' | 'low' | 'close' | 'volume' | 'amount'
> & {
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
};

export class FuturesMarketCandleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FuturesMarketCandleValidationError';
  }
}

/**
 * Storage for Binance USDⓈ-M contract klines keyed by FuturesInstrument.
 *
 * Deliberately separate from MarketCandlesRepository: an instrument shares its
 * Spot underlying Asset, so the Spot key (assetId, interval, openTime) cannot
 * hold a contract candle. Nothing here is read by Spot charts, order matching,
 * TP/SL, valuation or liquidation.
 */
@Injectable()
export class FuturesMarketCandlesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotent write keyed by (futuresInstrumentId, interval, openTime). A newer
   * provider receipt updates OHLCV in place; a closed row is never replaced by
   * an open (in-progress) version of the same bucket, and the identity columns
   * never change (also enforced by the DB identity trigger).
   */
  async upsertMany(
    candles: readonly FuturesMarketCandleUpsertInput[],
  ): Promise<{ writtenCount: number }> {
    if (candles.length === 0) return { writtenCount: 0 };
    const byKey = new Map<string, ValidatedRow>();
    candles.forEach((candle, index) => {
      const row = this.validate(candle, index);
      byKey.set(
        `${row.futuresInstrumentId}|${row.interval}|${row.openTime.getTime()}`,
        row,
      );
    });
    const rows = [...byKey.values()];
    let writtenCount = 0;
    for (
      let offset = 0;
      offset < rows.length;
      offset += FUTURES_MARKET_CANDLE_UPSERT_CHUNK_SIZE
    ) {
      writtenCount += await this.executeUpsertChunk(
        rows.slice(offset, offset + FUTURES_MARKET_CANDLE_UPSERT_CHUNK_SIZE),
      );
    }
    return { writtenCount };
  }

  /** Half-open [from, to) by openTime, ascending (latest `limit` when given). */
  async findRange(params: {
    futuresInstrumentId: string;
    interval: FuturesMarketCandleInterval;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<FuturesMarketCandle[]> {
    this.requireText(params.futuresInstrumentId, 'futuresInstrumentId');
    this.requireInterval(params.interval);
    if (
      !this.isValidDate(params.from) ||
      !this.isValidDate(params.to) ||
      params.from.getTime() >= params.to.getTime()
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        'findRange requires a valid half-open range [from, to).',
      );
    }
    const where = {
      futuresInstrumentId: params.futuresInstrumentId,
      interval: params.interval,
      openTime: { gte: params.from, lt: params.to },
    };
    if (params.limit === undefined) {
      return this.prisma.futuresMarketCandle.findMany({
        where,
        orderBy: { openTime: 'asc' },
      });
    }
    if (!Number.isSafeInteger(params.limit) || params.limit < 1) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        'limit must be a positive integer.',
      );
    }
    const latestFirst = await this.prisma.futuresMarketCandle.findMany({
      where,
      orderBy: { openTime: 'desc' },
      take: params.limit,
    });
    return latestFirst.reverse();
  }

  /** Deletes at most `limit` oldest CLOSED rows before `cutoff`. */
  async deleteClosedBeforeBatch(params: {
    cutoff: Date;
    interval: FuturesMarketCandleInterval;
    limit: number;
  }): Promise<number> {
    if (!this.isValidDate(params.cutoff)) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        'cutoff must be a valid Date.',
      );
    }
    this.requireInterval(params.interval);
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit <= 0 ||
      params.limit > MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `deleteClosedBeforeBatch limit must be between 1 and ${MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT}.`,
      );
    }
    return this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "futures_market_candles"
        WHERE "interval" = ${params.interval}
          AND "is_closed" = TRUE
          AND "open_time" < ${params.cutoff}
        ORDER BY "open_time" ASC, "id" ASC
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "futures_market_candles" AS target
      USING candidates
      WHERE target."id" = candidates."id"
    `);
  }

  private async executeUpsertChunk(rows: readonly ValidatedRow[]) {
    const updatedAt = new Date();
    const values = Prisma.join(
      rows.map(
        (row) =>
          Prisma.sql`(${randomUUID()}, ${row.futuresInstrumentId}, ${row.interval}, ${row.contractSymbol}, ${row.openTime}, ${row.closeTime}, ${row.open.toFixed()}, ${row.high.toFixed()}, ${row.low.toFixed()}, ${row.close.toFixed()}, ${row.volume.toFixed()}, ${row.amount === null ? null : row.amount.toFixed()}, ${row.isClosed}, ${FUTURES_MARKET_CANDLE_SOURCE}, ${row.sourceUpdatedAt}, ${updatedAt})`,
      ),
    );
    try {
      return await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "futures_market_candles" (
          "id", "futures_instrument_id", "interval", "contract_symbol",
          "open_time", "close_time", "open", "high", "low", "close",
          "volume", "amount", "is_closed", "source_provider",
          "source_updated_at", "updated_at"
        )
        VALUES ${values}
        ON CONFLICT ("futures_instrument_id", "interval", "open_time") DO UPDATE SET
          "close_time" = EXCLUDED."close_time",
          "open" = EXCLUDED."open",
          "high" = EXCLUDED."high",
          "low" = EXCLUDED."low",
          "close" = EXCLUDED."close",
          "volume" = EXCLUDED."volume",
          "amount" = EXCLUDED."amount",
          "is_closed" = "futures_market_candles"."is_closed" OR EXCLUDED."is_closed",
          "source_updated_at" = EXCLUDED."source_updated_at",
          "updated_at" = EXCLUDED."updated_at"
        WHERE EXCLUDED."source_updated_at" >= "futures_market_candles"."source_updated_at"
          AND NOT ("futures_market_candles"."is_closed" AND NOT EXCLUDED."is_closed")
      `);
    } catch (error) {
      const code = sqlState(error);
      if (code === '23503' || code === '23514') {
        // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
        throw new FuturesMarketCandleValidationError(
          'Futures candle rows must belong to an existing instrument whose underlying symbol matches the contract symbol.',
        );
      }
      throw error;
    }
  }

  private validate(
    input: FuturesMarketCandleUpsertInput,
    index: number,
  ): ValidatedRow {
    const label = `candles[${index}]`;
    this.requireText(input.futuresInstrumentId, `${label}.futuresInstrumentId`);
    this.requireInterval(input.interval);
    if (
      typeof input.contractSymbol !== 'string' ||
      !CONTRACT_SYMBOL.test(input.contractSymbol)
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${label}.contractSymbol must be an uppercase USDT contract symbol.`,
      );
    }
    if (
      !this.isValidDate(input.openTime) ||
      !this.isValidDate(input.closeTime) ||
      input.openTime.getTime() >= input.closeTime.getTime() ||
      !this.isValidDate(input.sourceUpdatedAt)
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${label}: openTime < closeTime and sourceUpdatedAt must be valid Dates.`,
      );
    }
    if (typeof input.isClosed !== 'boolean') {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${label}.isClosed must be a boolean.`,
      );
    }
    const open = this.decimal(input.open, `${label}.open`, true);
    const high = this.decimal(input.high, `${label}.high`, true);
    const low = this.decimal(input.low, `${label}.low`, true);
    const close = this.decimal(input.close, `${label}.close`, true);
    const volume = this.decimal(input.volume, `${label}.volume`, false);
    const amount =
      input.amount === undefined || input.amount === null
        ? null
        : this.decimal(input.amount, `${label}.amount`, false);
    if (
      high.lt(open) ||
      high.lt(close) ||
      high.lt(low) ||
      low.gt(open) ||
      low.gt(close)
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${label}: OHLC bounds are inconsistent.`,
      );
    }
    return {
      futuresInstrumentId: input.futuresInstrumentId.trim(),
      interval: input.interval,
      contractSymbol: input.contractSymbol,
      openTime: input.openTime,
      closeTime: input.closeTime,
      open,
      high,
      low,
      close,
      volume,
      amount,
      isClosed: input.isClosed,
      sourceUpdatedAt: input.sourceUpdatedAt,
    };
  }

  private decimal(
    value: Prisma.Decimal | string,
    field: string,
    positive: boolean,
  ): Prisma.Decimal {
    let parsed: Prisma.Decimal;
    try {
      parsed = new Prisma.Decimal(
        typeof value === 'string' ? value.trim() : value,
      );
    } catch {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${field} must be a valid decimal value.`,
      );
    }
    if (
      !parsed.isFinite() ||
      parsed.decimalPlaces() > DECIMAL_SCALE ||
      parsed.abs().gte(DECIMAL_ABSOLUTE_LIMIT) ||
      (positive ? !parsed.gt(0) : parsed.lt(0))
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${field} must be a ${positive ? 'positive' : 'non-negative'} Decimal(24,8) value.`,
      );
    }
    return parsed;
  }

  private requireInterval(value: string): void {
    if (
      !(FUTURES_MARKET_CANDLE_INTERVALS as readonly string[]).includes(value)
    ) {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `interval must be one of ${FUTURES_MARKET_CANDLE_INTERVALS.join(', ')}.`,
      );
    }
  }

  private requireText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim() === '') {
      // @diagnosticSurface internal: Fixed storage validation category; long-range sync records it as a fixed series code, never as public copy.
      throw new FuturesMarketCandleValidationError(
        `${field} must be a non-empty string.`,
      );
    }
  }

  private isValidDate(value: Date): boolean {
    return value instanceof Date && !Number.isNaN(value.getTime());
  }
}

// PostgreSQL sqlstate across the shapes Prisma 7 surfaces for raw queries
// (P2010 with a nested driver adapter cause) and mapped engine errors.
function sqlState(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const record = error as {
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
  };
  if (record.code === 'P2003') return '23503';
  const candidates = [
    record.meta?.driverAdapterError?.cause?.originalCode,
    record.meta?.code,
    record.code,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^\d{5}$/u.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
