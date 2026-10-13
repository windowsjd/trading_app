jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    MarketCandleSyncStatus: {
      pending: 'pending',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    },
  };
});

import { Prisma } from '../generated/prisma/client';
import { findPreviousMarketSession } from '../orders/market-calendar.policy';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';
import { CandleDatabaseLoader } from './candle-database.loader';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import { CandleResponseBuilder } from './candle-response.builder';
import { readCandleServingConfig } from './candle-serving.config';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';

const DAY = 86_400_000;
const H4 = 4 * 3600_000;
const M5 = 300_000;

type StoredRow = {
  assetId: string;
  interval: string;
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

function row(
  interval: string,
  openMs: number,
  spanMs: number,
  price: number,
  sourceProvider: string,
  updatedAt: Date,
): StoredRow {
  return {
    assetId: 'asset-1',
    interval,
    openTime: new Date(openMs),
    closeTime: new Date(openMs + spanMs),
    open: new Prisma.Decimal(price),
    high: new Prisma.Decimal(price + 2),
    low: new Prisma.Decimal(price - 2),
    close: new Prisma.Decimal(price + 1),
    volume: new Prisma.Decimal(1),
    amount: new Prisma.Decimal(price),
    isClosed: true,
    sourceProvider,
    sourceUpdatedAt: updatedAt,
  };
}

function query(
  overrides: Partial<ParsedAssetCandlesQuery>,
): ParsedAssetCandlesQuery {
  return {
    range: '96d',
    rangeProvided: true,
    rangeStartAt: null,
    rangeEndAt: null,
    interval: '4h',
    intervalMinutes: 240,
    limit: 600,
    requestedDate: '2026-10-13',
    toHHmmss: '000000',
    toInstant: null,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock: new Date(),
    ...overrides,
  };
}

function harness(stored: StoredRow[], now: Date) {
  const config = readCandleServingConfig({});
  const plans = new CandleReadPlanBuilder(config);
  const repository = {
    findRange: jest.fn((params: { interval: string; from: Date; to: Date }) =>
      Promise.resolve(
        stored
          .filter(
            (r) =>
              r.interval === params.interval &&
              r.openTime >= params.from &&
              r.openTime < params.to,
          )
          .sort((a, b) => a.openTime.getTime() - b.openTime.getTime()),
      ),
    ),
  };
  const states = {
    findCandleCoverage: jest.fn().mockResolvedValue({
      startsAtRequestedFrom: true,
      contiguousCoveredTo: now,
      newestCompletedAt: now,
      hasInteriorGap: false,
    }),
    findLatestOverlapping: jest.fn().mockResolvedValue({ status: 'completed' }),
  };
  const loader = new CandleDatabaseLoader(
    plans,
    repository as never,
    states as never,
    new MarketCandleAggregationService(repository as never),
    new CandleResponseBuilder(),
    config,
  );
  return { plans, loader, repository };
}

describe('long-range 4h serving (range=96d)', () => {
  it('reads stored completed 4h for the whole window and aggregates 5m only over the recent 30 days', () => {
    const now = new Date('2026-10-13T10:30:00.000Z');
    const { plans } = harness([], now);
    const plan = plans.build(
      {
        id: 'asset-1',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
        isActive: true,
      },
      query({
        clock: now,
        rangeStartAt: new Date(now.getTime() - 96 * DAY),
        rangeEndAt: now,
      }),
    );
    expect(plan.managedByPersistence).toBe(true);
    expect(plan.sourceInterval).toBe('5m');
    expect(plan.history?.recentRange.from.toISOString()).toBe(
      new Date(now.getTime() - 30 * DAY).toISOString(),
    );
    expect(plan.sourceRange.from.getTime()).toBe(now.getTime() - 30 * DAY - H4);
    expect(plan.requestedRange.from.getTime()).toBe(now.getTime() - 96 * DAY);
  });

  it('serves ~576 crypto candles: stored rows win, gaps fall back to complete 5m buckets, the current bucket is live, nothing duplicates', async () => {
    const now = new Date('2026-10-13T10:30:00.000Z');
    const from = now.getTime() - 96 * DAY;
    const firstBucket = Math.ceil(from / H4) * H4;
    const currentBucket = Math.floor(now.getTime() / H4) * H4;
    const lagged = [currentBucket - 2 * H4, currentBucket - H4];
    const stored: StoredRow[] = [];
    for (let t = firstBucket; t < currentBucket; t += H4) {
      if (lagged.includes(t)) continue; // incremental sync has not stored these yet
      stored.push(
        row('4h', t, H4, 100, 'binance_klines', new Date(t + H4 + 60_000)),
      );
    }
    // Complete 5m constituents for the first lagged bucket → fallback.
    for (let t = lagged[0]; t < lagged[0] + H4; t += M5) {
      stored.push(row('5m', t, M5, 200, 'binance_klines', new Date(t + M5)));
    }
    // Only 10 of 48 constituents for the second lagged bucket → dropped.
    for (let t = lagged[1]; t < lagged[1] + 10 * M5; t += M5) {
      stored.push(row('5m', t, M5, 300, 'binance_klines', new Date(t + M5)));
    }
    // Live current bucket constituents.
    for (let t = currentBucket; t < now.getTime() - M5; t += M5) {
      stored.push(row('5m', t, M5, 400, 'binance_klines', new Date(t + M5)));
    }
    // A bucket that has BOTH a stored row and complete 5m data: stored wins.
    const overlap = currentBucket - 3 * H4;
    for (let t = overlap; t < overlap + H4; t += M5) {
      stored.push(row('5m', t, M5, 999, 'binance_klines', new Date(t + M5)));
    }

    const { loader } = harness(stored, now);
    const result = await loader.load(
      {
        id: 'asset-1',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
        isActive: true,
      },
      query({ clock: now, rangeStartAt: new Date(from), rangeEndAt: now }),
    );
    const candles = result.response?.data.candles ?? [];
    const times = candles.map((c) => Date.parse(c.time));
    const expectedClosed = (currentBucket - firstBucket) / H4;
    expect(expectedClosed).toBe(575);
    // 575 closed buckets − 2 lagged + 1 fallback + 1 current = 575 + ... :
    expect(candles.length).toBe(expectedClosed - 2 + 1 + 1);
    expect(new Set(times).size).toBe(times.length);
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    expect(times[0]).toBe(firstBucket);
    expect(times.at(-1)).toBe(currentBucket);
    const byTime = new Map(candles.map((c) => [Date.parse(c.time), c]));
    expect(byTime.get(lagged[0])?.open).toBe('200.00000000');
    expect(byTime.has(lagged[1])).toBe(false);
    expect(byTime.get(overlap)?.open).toBe('100.00000000');
    expect(byTime.get(currentBucket)?.open).toBe('400.00000000');
    expect(result.droppedIncompleteBuckets).toBe(1);
  });

  it('serves KRX completed sessions from verified 10-minute history plus the live current bucket', async () => {
    const now = new Date('2026-10-13T03:00:00.000Z'); // 12:00 KST, session open
    const asset = {
      id: 'asset-1',
      symbol: '005930',
      name: 'Samsung Electronics',
      market: 'KRX',
      assetType: 'domestic_stock' as const,
      currencyCode: 'KRW' as const,
      priceCurrency: 'KRW' as const,
      settlementCurrency: 'KRW' as const,
      isActive: true,
    };
    const first = findPreviousMarketSession(asset, now, 96);
    expect(first?.localDate).toBe('2026-05-20');
    const stored: StoredRow[] = [];
    for (let back = 1; back <= 96; back += 1) {
      const s = findPreviousMarketSession(asset, now, back);
      if (!s) throw new Error('calendar');
      const open = s.openTime.getTime();
      stored.push(
        row('4h', open, H4, 70000, 'koscom_history_10m', s.closeTime),
      );
      stored.push({
        ...row(
          '4h',
          open + H4,
          s.closeTime.getTime() - open - H4,
          70100,
          'koscom_history_10m',
          s.closeTime,
        ),
      });
    }
    const todayOpen = Date.parse('2026-10-13T00:00:00.000Z');
    for (let t = todayOpen; t < now.getTime(); t += M5) {
      stored.push(row('5m', t, M5, 71000, 'koscom_intraday', new Date(t + M5)));
    }
    const { loader } = harness(stored, now);
    const result = await loader.load(
      asset,
      query({ clock: now, rangeStartAt: first!.openTime, rangeEndAt: now }),
    );
    const data = result.response?.data;
    expect(data?.candles.length).toBe(96 * 2 + 1);
    expect(data?.candles.at(-1)?.time).toBe('2026-10-13T00:00:00.000Z');
    expect(data?.candles.at(-2)?.time).toBe('2026-10-12T04:00:00.000Z');
    const source = data?.source as {
      provider: string;
      sourceProviders: string[];
    };
    expect(source.provider).toBe('koscom');
    expect(source.sourceProviders.sort()).toEqual([
      'koscom_history_10m',
      'koscom_intraday',
    ]);
  });
});
