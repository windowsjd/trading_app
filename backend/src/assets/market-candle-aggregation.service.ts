import { Injectable } from '@nestjs/common';
import { AssetType, Prisma } from '../generated/prisma/client';
import { resolveMarketSession } from '../orders/market-calendar.policy';
import { getZonedParts } from '../providers/kis/candles/kis-candle-time';
import { MarketCandlesRepository } from './market-candles.repository';

export const MARKET_CANDLE_AGGREGATION_INTERVALS = [
  '15m',
  '30m',
  '1h',
  '4h',
] as const;

export type MarketCandleAggregationInterval =
  (typeof MARKET_CANDLE_AGGREGATION_INTERVALS)[number];

const AGGREGATION_INTERVAL_MINUTES: Record<
  MarketCandleAggregationInterval,
  number
> = {
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
};

const FIVE_MINUTES_MS = 5 * 60_000;
const MAX_BUCKET_SPAN_MS = 4 * 60 * 60_000;

const MARKET_TIME_ZONES: Partial<Record<AssetType, string>> = {
  [AssetType.domestic_stock]: 'Asia/Seoul',
  [AssetType.us_stock]: 'America/New_York',
};

export type FiveMinuteSourceCandle = {
  openTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount: Prisma.Decimal | string | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

export type AggregatedMarketCandle = {
  interval: MarketCandleAggregationInterval;
  openTime: Date;
  // Session-capped bucket end: e.g. the domestic 13:00 "4h" bucket closes at
  // 15:30 and the US 15:30 hourly bucket closes at 16:00.
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
  expectedConstituentCount: number;
  actualConstituentCount: number;
  gapCount: number;
  complete: boolean;
  isCurrent: boolean;
};

export type MarketCandleAggregationResult = {
  candles: AggregatedMarketCandle[];
  // Stored 5m rows that could not be attributed to any bucket (off the 5m
  // grid or outside the market's regular session). They are never merged
  // into neighboring buckets.
  ignoredSourceRows: number;
};

export class MarketCandleAggregationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCandleAggregationInputError';
  }
}

/**
 * Builds 15m/30m/1h/4h candles from stored 5m candles at read time; nothing
 * here is persisted.
 *
 * Aggregation: open = first constituent, close = last, high = max, low = min,
 * volume = sum, amount = sum only when every constituent has one (otherwise
 * null), sourceUpdatedAt = max. Buckets never span different local trading
 * days: stock buckets exist only inside one calendar-resolved session, and
 * every crypto interval divides the 24h UTC day.
 *
 * Completeness policy (fixed): missing 5m candles are NEVER interpolated.
 * Each bucket reports expected/actual constituent counts; an incomplete
 * historical bucket is returned explicitly with complete=false and
 * isClosed=false rather than being promoted to a normal closed candle, and
 * the in-progress current bucket (isCurrent=true) is likewise open. Full-day
 * holidays have no bucket, so absence is preserved instead of synthesized.
 */
@Injectable()
export class MarketCandleAggregationService {
  constructor(private readonly repository: MarketCandlesRepository) {}

  async aggregateStoredCandles(input: {
    assetId: string;
    assetType: AssetType;
    interval: MarketCandleAggregationInterval;
    from: Date;
    to: Date;
    limit?: number;
    now?: Date;
  }): Promise<MarketCandleAggregationResult> {
    this.validateWindow(input.from, input.to, input.limit);
    // Read past both edges so buckets that straddle the requested window are
    // aggregated from all of their constituents before filtering.
    const stored = await this.repository.findRange({
      assetId: input.assetId,
      interval: '5m',
      from: new Date(input.from.getTime() - MAX_BUCKET_SPAN_MS),
      to: new Date(input.to.getTime() + MAX_BUCKET_SPAN_MS),
    });
    return this.aggregateCandles({ ...input, candles: stored });
  }

  aggregateCandles(input: {
    assetType: AssetType;
    interval: MarketCandleAggregationInterval;
    candles: readonly FiveMinuteSourceCandle[];
    from: Date;
    to: Date;
    limit?: number;
    now?: Date;
  }): MarketCandleAggregationResult {
    this.validateWindow(input.from, input.to, input.limit);
    const bucketMinutes = AGGREGATION_INTERVAL_MINUTES[input.interval];
    if (!bucketMinutes) {
      throw new MarketCandleAggregationInputError(
        `interval must be one of ${MARKET_CANDLE_AGGREGATION_INTERVALS.join(', ')}.`,
      );
    }
    const now = input.now ?? new Date();

    const constituentsByBucket = new Map<
      number,
      { window: BucketWindow; rows: Map<number, FiveMinuteSourceCandle> }
    >();
    let ignoredSourceRows = 0;
    for (const candle of input.candles) {
      const window = this.resolveBucketWindow(
        candle.openTime,
        input.assetType,
        input.interval,
      );
      if (!window) {
        ignoredSourceRows += 1;
        continue;
      }
      let bucket = constituentsByBucket.get(window.startMs);
      if (!bucket) {
        bucket = { window, rows: new Map() };
        constituentsByBucket.set(window.startMs, bucket);
      }
      const slot = candle.openTime.getTime();
      const existing = bucket.rows.get(slot);
      if (
        !existing ||
        candle.sourceUpdatedAt.getTime() >= existing.sourceUpdatedAt.getTime()
      ) {
        bucket.rows.set(slot, candle);
      }
    }

    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    let buckets = [...constituentsByBucket.values()]
      .filter(({ window }) => window.startMs >= fromMs && window.startMs < toMs)
      .sort((left, right) => left.window.startMs - right.window.startMs)
      .map(({ window, rows }) =>
        this.buildAggregate(window, rows, input.interval, now),
      );
    if (input.limit !== undefined && buckets.length > input.limit) {
      buckets = buckets.slice(buckets.length - input.limit);
    }
    return { candles: buckets, ignoredSourceRows };
  }

  private buildAggregate(
    window: BucketWindow,
    rows: Map<number, FiveMinuteSourceCandle>,
    interval: MarketCandleAggregationInterval,
    now: Date,
  ): AggregatedMarketCandle {
    const ordered = [...rows.values()].sort(
      (left, right) => left.openTime.getTime() - right.openTime.getTime(),
    );
    const open = toDecimal(ordered[0].open);
    const close = toDecimal(ordered[ordered.length - 1].close);
    let high = toDecimal(ordered[0].high);
    let low = toDecimal(ordered[0].low);
    let volume = new Prisma.Decimal(0);
    let amount: Prisma.Decimal | null = new Prisma.Decimal(0);
    let sourceUpdatedAt = ordered[0].sourceUpdatedAt;
    let allClosed = true;
    for (const row of ordered) {
      const rowHigh = toDecimal(row.high);
      const rowLow = toDecimal(row.low);
      if (rowHigh.gt(high)) high = rowHigh;
      if (rowLow.lt(low)) low = rowLow;
      volume = volume.add(toDecimal(row.volume));
      amount =
        amount === null || row.amount === null
          ? null
          : amount.add(toDecimal(row.amount));
      if (row.sourceUpdatedAt.getTime() > sourceUpdatedAt.getTime()) {
        sourceUpdatedAt = row.sourceUpdatedAt;
      }
      if (!row.isClosed) allClosed = false;
    }

    const expected = window.expectedConstituentCount;
    const actual = ordered.length;
    const complete = actual >= expected;
    const nowMs = now.getTime();
    const isCurrent = nowMs >= window.startMs && nowMs < window.endMs;
    return {
      interval,
      openTime: new Date(window.startMs),
      closeTime: new Date(window.endMs),
      open,
      high,
      low,
      close,
      volume,
      amount,
      // Only a fully populated historical bucket becomes a closed candle;
      // gapped or in-progress buckets stay explicitly open.
      isClosed: complete && allClosed && window.endMs <= nowMs,
      sourceUpdatedAt,
      expectedConstituentCount: expected,
      actualConstituentCount: actual,
      gapCount: Math.max(0, expected - actual),
      complete,
      isCurrent,
    };
  }

  private resolveBucketWindow(
    openTime: Date,
    assetType: AssetType,
    interval: MarketCandleAggregationInterval,
  ): BucketWindow | null {
    const openMs = openTime.getTime();
    if (Number.isNaN(openMs)) return null;
    const bucketMinutes = AGGREGATION_INTERVAL_MINUTES[interval];

    if (assetType === AssetType.crypto) {
      if (openMs % FIVE_MINUTES_MS !== 0) return null;
      const sizeMs = bucketMinutes * 60_000;
      const startMs = Math.floor(openMs / sizeMs) * sizeMs;
      return {
        startMs,
        endMs: startMs + sizeMs,
        expectedConstituentCount: bucketMinutes / 5,
      };
    }

    const timeZone = MARKET_TIME_ZONES[assetType];
    const market =
      assetType === AssetType.domestic_stock
        ? 'KRX'
        : assetType === AssetType.us_stock
          ? 'US'
          : null;
    if (!timeZone || !market) return null;
    const parts = getZonedParts(openTime, timeZone);
    const dateText = formatYmd(parts.year, parts.month, parts.day);
    const session = resolveMarketSession(market, dateText);
    if (!session) return null;
    const sessionOpenMs = session.openTime.getTime();
    const sessionCloseMs = session.closeTime.getTime();
    if (
      parts.second !== 0 ||
      openMs < sessionOpenMs ||
      openMs >= sessionCloseMs ||
      (openMs - sessionOpenMs) % FIVE_MINUTES_MS !== 0
    ) {
      return null;
    }
    const bucketSizeMs = bucketMinutes * 60_000;
    const startMs =
      sessionOpenMs +
      Math.floor((openMs - sessionOpenMs) / bucketSizeMs) * bucketSizeMs;
    const endMs = Math.min(startMs + bucketSizeMs, sessionCloseMs);
    return {
      startMs,
      endMs,
      expectedConstituentCount: (endMs - startMs) / FIVE_MINUTES_MS,
    };
  }

  private validateWindow(from: Date, to: Date, limit: number | undefined) {
    if (
      !(from instanceof Date) ||
      !(to instanceof Date) ||
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from.getTime() >= to.getTime()
    ) {
      throw new MarketCandleAggregationInputError(
        'Aggregation range must be valid and half-open [from, to).',
      );
    }
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new MarketCandleAggregationInputError(
        'limit must be a positive integer.',
      );
    }
  }
}

type BucketWindow = {
  startMs: number;
  endMs: number;
  expectedConstituentCount: number;
};

function toDecimal(value: Prisma.Decimal | string): Prisma.Decimal {
  return typeof value === 'string' ? new Prisma.Decimal(value) : value;
}

function formatYmd(year: number, month: number, day: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${year}${pad(month)}${pad(day)}`;
}
