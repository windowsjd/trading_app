import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { MarketCandle } from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT } from './market-candle-retention.constants';
export { MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT } from './market-candle-retention.constants';

// Storage-supported intervals for this phase. Aggregated intervals
// (15m/30m/1h/4h) are derived from 5m in a later phase and are not
// persisted here; extending this list also requires replacing the
// market_candles_interval_check DB constraint in a new migration.
export const MARKET_CANDLE_INTERVALS = ['5m', '1d', '1w'] as const;

export type MarketCandleInterval = (typeof MARKET_CANDLE_INTERVALS)[number];

// 15 bind parameters per row; 500 rows = 7,500 parameters per statement,
// well under PostgreSQL's 65,535 bind-parameter limit.
export const MARKET_CANDLE_UPSERT_CHUNK_SIZE = 500;
export const ASSET_LOOKUP_CHUNK_SIZE = 1_000;

const MARKET_CANDLE_DECIMAL_SCALE = 8;
const MARKET_CANDLE_DECIMAL_ABSOLUTE_LIMIT = new Prisma.Decimal(
  '10000000000000000',
);

export type MarketCandleUpsertInput = {
  assetId: string;
  interval: MarketCandleInterval;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount?: Prisma.Decimal | string | null;
  isClosed: boolean;
  sourceProvider: string;
  sourceUpdatedAt: Date;
};

export type MarketCandleFindRangeParams = {
  assetId: string;
  interval: MarketCandleInterval;
  from: Date;
  to: Date;
  limit?: number;
};

export type MarketCandleFindLatestParams = {
  assetId: string;
  interval: MarketCandleInterval;
  closedOnly?: boolean;
};

export type MarketCandleDeleteClosedBeforeParams = {
  cutoff: Date;
  intervals?: readonly MarketCandleInterval[];
  assetId?: string;
};

export type MarketCandleDeleteClosedBeforeBatchParams = {
  cutoff: Date;
  interval: '5m';
  limit: number;
};

export type MarketCandleCoverage = {
  earliestOpenTime: Date | null;
  latestOpenTime: Date | null;
  count: number;
};

export class MarketCandleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleValidationError';
  }
}

type ValidatedCandleRow = {
  assetId: string;
  interval: MarketCandleInterval;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
  isClosed: boolean;
  sourceProvider: string;
  sourceUpdatedAt: Date;
};

@Injectable()
export class MarketCandlesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Idempotently writes candles keyed by (assetId, interval, openTime).
   * An existing row is updated in place (close_time/OHLC/volume/amount/
   * is_closed/source_provider/source_updated_at/updated_at); id and
   * created_at are preserved, so re-running the same input never grows
   * the table.
   *
   * Duplicate composite keys inside one batch: the LAST input wins.
   * (Pre-deduping is also required because a single INSERT .. ON CONFLICT
   * statement cannot update the same row twice.)
   * Every referenced asset is verified before the first write chunk; the DB
   * foreign key remains the fallback for validation/write races.
   *
   * Large batches are executed in chunks of MARKET_CANDLE_UPSERT_CHUNK_SIZE
   * rows to stay under PostgreSQL's bind-parameter limit. Each chunk is one
   * atomic statement; if a later chunk fails, earlier chunks stay committed —
   * retrying the whole batch is safe because the write is idempotent.
   */
  async upsertMany(
    candles: readonly MarketCandleUpsertInput[],
  ): Promise<{ writtenCount: number }> {
    if (candles.length === 0) {
      return { writtenCount: 0 };
    }

    const validated = candles.map((candle, index) =>
      this.validateCandle(candle, index),
    );
    const deduped = this.dedupeLastWins(validated);
    await this.assertAssetsExist(deduped);
    let writtenCount = 0;

    for (
      let offset = 0;
      offset < deduped.length;
      offset += MARKET_CANDLE_UPSERT_CHUNK_SIZE
    ) {
      writtenCount += await this.executeUpsertChunk(
        deduped.slice(offset, offset + MARKET_CANDLE_UPSERT_CHUNK_SIZE),
      );
    }

    return { writtenCount };
  }

  /**
   * Returns candles in the half-open range `from <= openTime < to`,
   * ordered by openTime ascending. In-progress (isClosed=false) candles are
   * included. When `limit` is given, the LATEST `limit` candles inside the
   * range are selected and still returned in ascending order.
   */
  async findRange(
    params: MarketCandleFindRangeParams,
  ): Promise<MarketCandle[]> {
    const assetId = this.requireNonEmptyString(params.assetId, 'assetId');
    const interval = this.requireInterval(params.interval);
    const from = this.requireValidDate(params.from, 'from');
    const to = this.requireValidDate(params.to, 'to');

    if (from.getTime() >= to.getTime()) {
      throw new MarketCandleValidationError(
        'findRange requires from to be earlier than to (half-open range [from, to)).',
      );
    }

    const limit = this.parseOptionalLimit(params.limit);
    const where = {
      assetId,
      interval,
      openTime: {
        gte: from,
        lt: to,
      },
    };

    if (limit === undefined) {
      return this.prisma.marketCandle.findMany({
        where,
        orderBy: {
          openTime: 'asc',
        },
      });
    }

    const latestFirst = await this.prisma.marketCandle.findMany({
      where,
      orderBy: {
        openTime: 'desc',
      },
      take: limit,
    });

    return latestFirst.reverse();
  }

  /**
   * Returns the candle with the most recent openTime for the asset/interval,
   * or null when none exists. With closedOnly=true, in-progress
   * (isClosed=false) candles are skipped.
   */
  async findLatest(
    params: MarketCandleFindLatestParams,
  ): Promise<MarketCandle | null> {
    const assetId = this.requireNonEmptyString(params.assetId, 'assetId');
    const interval = this.requireInterval(params.interval);

    return this.prisma.marketCandle.findFirst({
      where: {
        assetId,
        interval,
        ...(params.closedOnly ? { isClosed: true } : {}),
      },
      orderBy: {
        openTime: 'desc',
      },
    });
  }

  /**
   * Retention primitive (not wired to any scheduler yet): deletes candles
   * with openTime strictly before `cutoff`, but ONLY rows with isClosed=true.
   * In-progress candles are never deleted regardless of age. Optional
   * `intervals`/`assetId` narrow the deletion scope; an explicitly empty
   * `intervals` array selects nothing and deletes nothing.
   */
  async deleteClosedBefore(
    params: MarketCandleDeleteClosedBeforeParams,
  ): Promise<{ deletedCount: number }> {
    const cutoff = this.requireValidDate(params.cutoff, 'cutoff');
    const intervals = params.intervals?.map((interval) =>
      this.requireInterval(interval),
    );
    const assetId =
      params.assetId === undefined
        ? undefined
        : this.requireNonEmptyString(params.assetId, 'assetId');

    if (intervals !== undefined && intervals.length === 0) {
      return { deletedCount: 0 };
    }

    const result = await this.prisma.marketCandle.deleteMany({
      where: {
        isClosed: true,
        openTime: {
          lt: cutoff,
        },
        ...(intervals ? { interval: { in: intervals } } : {}),
        ...(assetId ? { assetId } : {}),
      },
    });

    return { deletedCount: result.count };
  }

  /**
   * Deletes at most `limit` oldest closed 5m rows. The CTE selection is
   * deterministic and uses row locks with SKIP LOCKED so concurrent workers
   * cannot select the same rows. Retention callers still use the Ops DB lock
   * to keep one logical owner across batches.
   */
  async deleteClosedBeforeBatch(
    params: MarketCandleDeleteClosedBeforeBatchParams,
  ): Promise<number> {
    const cutoff = this.requireValidDate(params.cutoff, 'cutoff');
    if (params.interval !== '5m') {
      throw new MarketCandleValidationError(
        'deleteClosedBeforeBatch only supports the 5m interval.',
      );
    }
    if (
      !Number.isSafeInteger(params.limit) ||
      params.limit <= 0 ||
      params.limit > MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT
    ) {
      throw new MarketCandleValidationError(
        `deleteClosedBeforeBatch limit must be between 1 and ${MARKET_CANDLE_DELETE_BATCH_MAX_LIMIT}.`,
      );
    }

    return this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT "id"
        FROM "market_candles"
        WHERE "interval" = ${params.interval}
          AND "is_closed" = TRUE
          AND "open_time" < ${cutoff}
        ORDER BY "open_time" ASC, "id" ASC
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM "market_candles" AS target
      USING candidates
      WHERE target."id" = candidates."id"
    `);
  }

  /**
   * Stored coverage for an asset/interval, for later backfill and
   * aggregation planning: earliest/latest openTime and total row count.
   */
  async getCoverage(
    assetId: string,
    interval: MarketCandleInterval,
  ): Promise<MarketCandleCoverage> {
    const validAssetId = this.requireNonEmptyString(assetId, 'assetId');
    const validInterval = this.requireInterval(interval);

    const result = await this.prisma.marketCandle.aggregate({
      where: {
        assetId: validAssetId,
        interval: validInterval,
      },
      _min: {
        openTime: true,
      },
      _max: {
        openTime: true,
      },
      _count: {
        _all: true,
      },
    });

    return {
      earliestOpenTime: result._min.openTime ?? null,
      latestOpenTime: result._max.openTime ?? null,
      count: result._count._all,
    };
  }

  /**
   * Bulk idempotent write as a single INSERT .. ON CONFLICT DO UPDATE
   * statement. Raw SQL is used because Prisma has no bulk upsert; per-row
   * prisma.upsert calls would cost one round trip per candle, which backfill
   * batches cannot afford. Every dynamic value is passed as a bind parameter
   * through Prisma.sql/Prisma.join (never interpolated into the SQL text),
   * and all identifiers are static literals.
   */
  private async executeUpsertChunk(
    rows: readonly ValidatedCandleRow[],
  ): Promise<number> {
    const updatedAt = new Date();
    const values = Prisma.join(
      rows.map(
        (row) =>
          Prisma.sql`(${randomUUID()}, ${row.assetId}, ${row.interval}, ${row.openTime}, ${row.closeTime}, ${row.open.toFixed()}, ${row.high.toFixed()}, ${row.low.toFixed()}, ${row.close.toFixed()}, ${row.volume.toFixed()}, ${row.amount === null ? null : row.amount.toFixed()}, ${row.isClosed}, ${row.sourceProvider}, ${row.sourceUpdatedAt}, ${updatedAt})`,
      ),
    );
    const query = Prisma.sql`
      INSERT INTO "market_candles" (
        "id", "asset_id", "interval", "open_time", "close_time",
        "open", "high", "low", "close", "volume", "amount",
        "is_closed", "source_provider", "source_updated_at", "updated_at"
      )
      VALUES ${values}
      ON CONFLICT ("asset_id", "interval", "open_time") DO UPDATE SET
        "close_time" = EXCLUDED."close_time",
        "open" = EXCLUDED."open",
        "high" = EXCLUDED."high",
        "low" = EXCLUDED."low",
        "close" = EXCLUDED."close",
        "volume" = EXCLUDED."volume",
        "amount" = EXCLUDED."amount",
        "is_closed" = EXCLUDED."is_closed",
        "source_provider" = EXCLUDED."source_provider",
        "source_updated_at" = EXCLUDED."source_updated_at",
        "updated_at" = EXCLUDED."updated_at"
    `;

    try {
      return await this.prisma.$executeRaw(query);
    } catch (error) {
      if (this.isForeignKeyViolation(error)) {
        throw new MarketCandleValidationError(
          'upsertMany refers to an assetId that does not exist in assets.',
        );
      }

      throw error;
    }
  }

  private validateCandle(
    input: MarketCandleUpsertInput,
    index: number,
  ): ValidatedCandleRow {
    const label = `candles[${index}]`;
    const assetId = this.requireNonEmptyString(
      input.assetId,
      `${label}.assetId`,
    );
    const interval = this.requireInterval(input.interval, label);
    const openTime = this.requireValidDate(input.openTime, `${label}.openTime`);
    const closeTime = this.requireValidDate(
      input.closeTime,
      `${label}.closeTime`,
    );

    if (openTime.getTime() >= closeTime.getTime()) {
      throw new MarketCandleValidationError(
        `${label}: openTime must be earlier than closeTime.`,
      );
    }

    const open = this.requirePositiveDecimal(input.open, `${label}.open`);
    const high = this.requirePositiveDecimal(input.high, `${label}.high`);
    const low = this.requirePositiveDecimal(input.low, `${label}.low`);
    const close = this.requirePositiveDecimal(input.close, `${label}.close`);
    const volume = this.requireNonNegativeDecimal(
      input.volume,
      `${label}.volume`,
    );
    const amount =
      input.amount === undefined || input.amount === null
        ? null
        : this.requireNonNegativeDecimal(input.amount, `${label}.amount`);

    if (high.lt(open) || high.lt(close) || high.lt(low)) {
      throw new MarketCandleValidationError(
        `${label}: high must be >= open, close, and low.`,
      );
    }

    if (low.gt(open) || low.gt(close)) {
      throw new MarketCandleValidationError(
        `${label}: low must be <= open and close.`,
      );
    }

    if (typeof input.isClosed !== 'boolean') {
      throw new MarketCandleValidationError(
        `${label}.isClosed must be a boolean.`,
      );
    }

    return {
      assetId,
      interval,
      openTime,
      closeTime,
      open,
      high,
      low,
      close,
      volume,
      amount,
      isClosed: input.isClosed,
      sourceProvider: this.requireNonEmptyString(
        input.sourceProvider,
        `${label}.sourceProvider`,
      ),
      sourceUpdatedAt: this.requireValidDate(
        input.sourceUpdatedAt,
        `${label}.sourceUpdatedAt`,
      ),
    };
  }

  private dedupeLastWins(
    rows: readonly ValidatedCandleRow[],
  ): ValidatedCandleRow[] {
    const byCompositeKey = new Map<string, ValidatedCandleRow>();

    for (const row of rows) {
      byCompositeKey.set(
        JSON.stringify([row.assetId, row.interval, row.openTime.getTime()]),
        row,
      );
    }

    return [...byCompositeKey.values()];
  }

  private requireInterval(value: string, label?: string): MarketCandleInterval {
    if ((MARKET_CANDLE_INTERVALS as readonly string[]).includes(value)) {
      return value as MarketCandleInterval;
    }

    throw new MarketCandleValidationError(
      `${label ? `${label}: ` : ''}interval must be one of ${MARKET_CANDLE_INTERVALS.join(
        ', ',
      )}.`,
    );
  }

  private parseOptionalLimit(value: number | undefined): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MarketCandleValidationError(
        'limit must be a positive integer.',
      );
    }

    return value;
  }

  private requireNonEmptyString(value: string, field: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new MarketCandleValidationError(
        `${field} must be a non-empty string.`,
      );
    }

    return value.trim();
  }

  private requireValidDate(value: Date, field: string): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new MarketCandleValidationError(`${field} must be a valid Date.`);
    }

    return value;
  }

  private requirePositiveDecimal(
    value: Prisma.Decimal | string,
    field: string,
  ): Prisma.Decimal {
    const decimal = this.parseDecimal(value, field);

    if (!decimal.gt(0)) {
      throw new MarketCandleValidationError(`${field} must be greater than 0.`);
    }

    return decimal;
  }

  private requireNonNegativeDecimal(
    value: Prisma.Decimal | string,
    field: string,
  ): Prisma.Decimal {
    const decimal = this.parseDecimal(value, field);

    if (decimal.lt(0)) {
      throw new MarketCandleValidationError(`${field} must be >= 0.`);
    }

    return decimal;
  }

  private parseDecimal(
    value: Prisma.Decimal | string,
    field: string,
  ): Prisma.Decimal {
    if (typeof value !== 'string' && !Prisma.Decimal.isDecimal(value)) {
      throw new MarketCandleValidationError(
        `${field} must be a decimal string or Prisma.Decimal.`,
      );
    }

    try {
      const decimal = new Prisma.Decimal(
        typeof value === 'string' ? value.trim() : value,
      );

      if (!decimal.isFinite()) {
        throw new MarketCandleValidationError(
          `${field} must be a finite decimal.`,
        );
      }

      if (decimal.decimalPlaces() > MARKET_CANDLE_DECIMAL_SCALE) {
        throw new MarketCandleValidationError(
          `${field} must have at most 8 decimal places.`,
        );
      }

      if (decimal.abs().gte(MARKET_CANDLE_DECIMAL_ABSOLUTE_LIMIT)) {
        throw new MarketCandleValidationError(
          `${field} exceeds Decimal(24,8) capacity.`,
        );
      }

      return decimal;
    } catch (error) {
      if (error instanceof MarketCandleValidationError) {
        throw error;
      }

      throw new MarketCandleValidationError(
        `${field} must be a valid decimal value.`,
      );
    }
  }

  private async assertAssetsExist(
    rows: readonly ValidatedCandleRow[],
  ): Promise<void> {
    const assetIds = [...new Set(rows.map((row) => row.assetId))];
    const existingAssetIds = new Set<string>();

    for (
      let offset = 0;
      offset < assetIds.length;
      offset += ASSET_LOOKUP_CHUNK_SIZE
    ) {
      const assets = await this.prisma.asset.findMany({
        where: {
          id: {
            in: assetIds.slice(offset, offset + ASSET_LOOKUP_CHUNK_SIZE),
          },
        },
        select: {
          id: true,
        },
      });

      for (const asset of assets) {
        existingAssetIds.add(asset.id);
      }
    }

    const missingAssetIds = assetIds.filter(
      (assetId) => !existingAssetIds.has(assetId),
    );
    if (missingAssetIds.length > 0) {
      throw new MarketCandleValidationError(
        `assetId does not reference an existing asset: ${missingAssetIds.join(', ')}`,
      );
    }
  }

  // Recognizes a PostgreSQL foreign key violation (sqlstate 23503) across the
  // shapes Prisma surfaces it in: P2003 for query-engine mapped errors, and
  // P2010 with a nested driver adapter cause for raw queries on Prisma 7
  // driver adapters.
  private isForeignKeyViolation(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const code = (error as { code?: unknown }).code;
    if (code === 'P2003' || code === '23503') {
      return true;
    }

    const meta = (error as { meta?: Record<string, unknown> }).meta;
    if (!meta) {
      return false;
    }

    if (meta.code === '23503') {
      return true;
    }

    const cause = (
      meta.driverAdapterError as { cause?: Record<string, unknown> } | undefined
    )?.cause;

    return (
      cause?.kind === 'ForeignKeyConstraintViolation' ||
      cause?.originalCode === '23503'
    );
  }
}
