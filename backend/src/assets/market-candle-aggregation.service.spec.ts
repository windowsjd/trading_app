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
  };
});

import { AssetType } from '../generated/prisma/client';
import {
  MarketCandleAggregationInputError,
  MarketCandleAggregationService,
  type FiveMinuteSourceCandle,
} from './market-candle-aggregation.service';

const FIVE_MIN = 5 * 60_000;

function candle(
  openIso: string,
  overrides: Partial<FiveMinuteSourceCandle> = {},
): FiveMinuteSourceCandle {
  return {
    openTime: new Date(openIso),
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '10',
    amount: '1010',
    isClosed: true,
    sourceUpdatedAt: new Date('2026-07-10T09:00:00Z'),
    ...overrides,
  };
}

function run(startIso: string, count: number): FiveMinuteSourceCandle[] {
  const start = new Date(startIso).getTime();
  return Array.from({ length: count }, (_, index) =>
    candle(new Date(start + index * FIVE_MIN).toISOString()),
  );
}

describe('MarketCandleAggregationService', () => {
  const service = new MarketCandleAggregationService({
    findRange: jest.fn(),
  } as never);
  const dayFrom = new Date('2026-07-09T15:00:00Z'); // 2026-07-10 00:00 KST
  const dayTo = new Date('2026-07-10T15:00:00Z');
  const now = new Date('2026-07-11T00:00:00Z');

  describe('domestic anchors (09:00 Asia/Seoul)', () => {
    // Full regular session 09:00–15:30 KST = 78 five-minute candles.
    const fullSession = run('2026-07-10T00:00:00.000Z', 78);

    it('builds 09:00-anchored 15m/30m buckets covering the session exactly', () => {
      const fifteen = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '15m',
        candles: fullSession,
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(fifteen.candles).toHaveLength(26);
      expect(fifteen.candles[0].openTime.toISOString()).toBe(
        '2026-07-10T00:00:00.000Z',
      );
      expect(fifteen.candles.every((bucket) => bucket.complete)).toBe(true);
      expect(fifteen.candles.every((bucket) => bucket.isClosed)).toBe(true);

      const thirty = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '30m',
        candles: fullSession,
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(thirty.candles).toHaveLength(13);
      expect(
        thirty.candles.every((bucket) => bucket.expectedConstituentCount === 6),
      ).toBe(true);
    });

    it('caps the final 1h bucket at the 15:30 session end (partial session bucket)', () => {
      const hourly = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: fullSession,
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(hourly.candles).toHaveLength(7);
      const last = hourly.candles[6];
      // 15:00–15:30 KST bucket: expected 6, closeTime capped at 15:30 KST.
      expect(last.openTime.toISOString()).toBe('2026-07-10T06:00:00.000Z');
      expect(last.closeTime.toISOString()).toBe('2026-07-10T06:30:00.000Z');
      expect(last.expectedConstituentCount).toBe(6);
      expect(last.complete).toBe(true);
      expect(last.isClosed).toBe(true);
    });

    it('builds the domestic 4h buckets 09:00–13:00 and 13:00–15:30', () => {
      const fourHour = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '4h',
        candles: fullSession,
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(fourHour.candles).toHaveLength(2);
      const [first, second] = fourHour.candles;
      expect(first.openTime.toISOString()).toBe('2026-07-10T00:00:00.000Z');
      expect(first.closeTime.toISOString()).toBe('2026-07-10T04:00:00.000Z');
      expect(first.expectedConstituentCount).toBe(48);
      expect(second.openTime.toISOString()).toBe('2026-07-10T04:00:00.000Z');
      expect(second.closeTime.toISOString()).toBe('2026-07-10T06:30:00.000Z');
      expect(second.expectedConstituentCount).toBe(30);
      // volume: 30 constituents * 10; amount: 30 * 1010.
      expect(second.volume.toFixed()).toBe('300');
      expect(second.amount?.toFixed()).toBe('30300');
    });

    it('never merges different trading days into one bucket', () => {
      const twoDays = [
        ...run('2026-07-09T00:00:00.000Z', 78),
        ...run('2026-07-10T00:00:00.000Z', 78),
      ];
      const fourHour = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '4h',
        candles: twoDays,
        from: new Date('2026-07-08T15:00:00Z'),
        to: dayTo,
        now,
      });
      expect(fourHour.candles).toHaveLength(4);
    });

    it('ignores out-of-session rows instead of merging them into buckets', () => {
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: [
          candle('2026-07-09T23:55:00.000Z'), // 08:55 KST, pre-open
          candle('2026-07-10T06:30:00.000Z'), // 15:30 KST, post-close
          candle('2026-07-10T00:00:00.000Z'),
        ],
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(result.ignoredSourceRows).toBe(2);
      expect(result.candles).toHaveLength(1);
    });
  });

  describe('US anchors (09:30 America/New_York, DST-aware)', () => {
    it('anchors hourly buckets at 09:30 EDT in summer', () => {
      // 2026-07-09 09:30 EDT = 13:30 UTC.
      const session = run('2026-07-09T13:30:00.000Z', 78);
      const hourly = service.aggregateCandles({
        assetType: AssetType.us_stock,
        interval: '1h',
        candles: session,
        from: new Date('2026-07-09T04:00:00Z'),
        to: new Date('2026-07-10T04:00:00Z'),
        now,
      });
      expect(hourly.candles[0].openTime.toISOString()).toBe(
        '2026-07-09T13:30:00.000Z',
      );
      const last = hourly.candles[hourly.candles.length - 1];
      // 15:30–16:00 EDT partial bucket.
      expect(last.openTime.toISOString()).toBe('2026-07-09T19:30:00.000Z');
      expect(last.closeTime.toISOString()).toBe('2026-07-09T20:00:00.000Z');
      expect(last.expectedConstituentCount).toBe(6);
    });

    it('anchors at 09:30 EST in winter without a fixed UTC offset', () => {
      // 2026-01-15 09:30 EST = 14:30 UTC.
      const session = run('2026-01-15T14:30:00.000Z', 78);
      const fourHour = service.aggregateCandles({
        assetType: AssetType.us_stock,
        interval: '4h',
        candles: session,
        from: new Date('2026-01-15T05:00:00Z'),
        to: new Date('2026-01-16T05:00:00Z'),
        now,
      });
      expect(fourHour.candles).toHaveLength(2);
      // 09:30–13:30 and 13:30–16:00 EST.
      expect(fourHour.candles[0].openTime.toISOString()).toBe(
        '2026-01-15T14:30:00.000Z',
      );
      expect(fourHour.candles[1].openTime.toISOString()).toBe(
        '2026-01-15T18:30:00.000Z',
      );
      expect(fourHour.candles[1].closeTime.toISOString()).toBe(
        '2026-01-15T21:00:00.000Z',
      );
      expect(fourHour.candles[1].expectedConstituentCount).toBe(30);
    });
  });

  describe('crypto anchors (UTC, 24h continuous)', () => {
    it('builds 4h buckets on 00/04/08/12/16/20 UTC with 48 constituents', () => {
      const day = run('2026-07-10T00:00:00.000Z', 288);
      const fourHour = service.aggregateCandles({
        assetType: AssetType.crypto,
        interval: '4h',
        candles: day,
        from: new Date('2026-07-10T00:00:00Z'),
        to: new Date('2026-07-11T00:00:00Z'),
        now,
      });
      expect(fourHour.candles).toHaveLength(6);
      expect(
        fourHour.candles.map((bucket) => bucket.openTime.toISOString()),
      ).toEqual([
        '2026-07-10T00:00:00.000Z',
        '2026-07-10T04:00:00.000Z',
        '2026-07-10T08:00:00.000Z',
        '2026-07-10T12:00:00.000Z',
        '2026-07-10T16:00:00.000Z',
        '2026-07-10T20:00:00.000Z',
      ]);
      expect(
        fourHour.candles.every(
          (bucket) => bucket.expectedConstituentCount === 48 && bucket.complete,
        ),
      ).toBe(true);
    });
  });

  describe('aggregation semantics', () => {
    it('aggregates OHLCV correctly and propagates a null amount', () => {
      const constituents = [
        candle('2026-07-10T00:00:00.000Z', {
          open: '100',
          high: '105',
          low: '98',
          close: '104',
          volume: '10',
          amount: '1000',
          sourceUpdatedAt: new Date('2026-07-10T00:05:00Z'),
        }),
        candle('2026-07-10T00:05:00.000Z', {
          open: '104',
          high: '110',
          low: '103',
          close: '109',
          volume: '20',
          amount: null,
          sourceUpdatedAt: new Date('2026-07-10T00:10:00Z'),
        }),
        candle('2026-07-10T00:10:00.000Z', {
          open: '109',
          high: '109',
          low: '101',
          close: '102',
          volume: '30',
          amount: '3000',
          sourceUpdatedAt: new Date('2026-07-10T00:20:00Z'),
        }),
      ];
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '15m',
        candles: constituents,
        from: dayFrom,
        to: dayTo,
        now,
      });
      const bucket = result.candles[0];
      expect(bucket.open.toFixed()).toBe('100');
      expect(bucket.high.toFixed()).toBe('110');
      expect(bucket.low.toFixed()).toBe('98');
      expect(bucket.close.toFixed()).toBe('102');
      expect(bucket.volume.toFixed()).toBe('60');
      // One constituent has no amount → the bucket amount is null.
      expect(bucket.amount).toBeNull();
      expect(bucket.sourceUpdatedAt.toISOString()).toBe(
        '2026-07-10T00:20:00.000Z',
      );
    });

    it('returns incomplete historical buckets explicitly instead of promoting them to closed', () => {
      // 11 of 12 five-minute candles: one interior gap, never interpolated.
      const partial = run('2026-07-10T00:00:00.000Z', 12).filter(
        (_, index) => index !== 5,
      );
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: partial,
        from: dayFrom,
        to: dayTo,
        now,
      });
      const bucket = result.candles[0];
      expect(bucket.actualConstituentCount).toBe(11);
      expect(bucket.expectedConstituentCount).toBe(12);
      expect(bucket.gapCount).toBe(1);
      expect(bucket.complete).toBe(false);
      expect(bucket.isClosed).toBe(false);
      expect(bucket.isCurrent).toBe(false);
    });

    it('keeps the in-progress current bucket open', () => {
      const partial = run('2026-07-10T00:00:00.000Z', 6); // 09:00–09:30 KST
      const during = new Date('2026-07-10T00:31:00Z'); // 09:31 KST
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: partial,
        from: dayFrom,
        to: dayTo,
        now: during,
      });
      const bucket = result.candles[0];
      expect(bucket.isCurrent).toBe(true);
      expect(bucket.isClosed).toBe(false);
      expect(bucket.complete).toBe(false);
    });

    it('does not close a complete bucket built from an unclosed constituent', () => {
      const constituents = run('2026-07-10T00:00:00.000Z', 12);
      constituents[11] = candle('2026-07-10T00:55:00.000Z', {
        isClosed: false,
      });
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: constituents,
        from: dayFrom,
        to: dayTo,
        now,
      });
      expect(result.candles[0].complete).toBe(true);
      expect(result.candles[0].isClosed).toBe(false);
    });

    it('selects the latest N buckets and returns them ascending', () => {
      const session = run('2026-07-10T00:00:00.000Z', 78);
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: session,
        from: dayFrom,
        to: dayTo,
        limit: 3,
        now,
      });
      expect(result.candles).toHaveLength(3);
      expect(
        result.candles.map((bucket) => bucket.openTime.toISOString()),
      ).toEqual([
        '2026-07-10T04:00:00.000Z',
        '2026-07-10T05:00:00.000Z',
        '2026-07-10T06:00:00.000Z',
      ]);
    });

    it('validates the aggregation window and limit', () => {
      expect(() =>
        service.aggregateCandles({
          assetType: AssetType.crypto,
          interval: '1h',
          candles: [],
          from: dayTo,
          to: dayFrom,
          now,
        }),
      ).toThrow(MarketCandleAggregationInputError);
      expect(() =>
        service.aggregateCandles({
          assetType: AssetType.crypto,
          interval: '1h',
          candles: [],
          from: dayFrom,
          to: dayTo,
          limit: 0,
          now,
        }),
      ).toThrow(MarketCandleAggregationInputError);
    });
  });

  describe('aggregateStoredCandles', () => {
    it('reads an expanded 5m window and filters buckets to [from, to)', async () => {
      const findRange = jest
        .fn()
        .mockResolvedValue(run('2026-07-10T00:00:00.000Z', 78));
      const stored = new MarketCandleAggregationService({
        findRange,
      } as never);
      const result = await stored.aggregateStoredCandles({
        assetId: 'asset-1',
        assetType: AssetType.domestic_stock,
        interval: '4h',
        from: new Date('2026-07-10T04:00:00Z'),
        to: dayTo,
        now,
      });
      expect(findRange).toHaveBeenCalledWith({
        assetId: 'asset-1',
        interval: '5m',
        from: new Date('2026-07-10T00:00:00Z'),
        to: new Date('2026-07-10T19:00:00Z'),
      });
      // Only the 13:00–15:30 KST bucket starts inside [from, to).
      expect(result.candles).toHaveLength(1);
      expect(result.candles[0].openTime.toISOString()).toBe(
        '2026-07-10T04:00:00.000Z',
      );
      // Its constituents were read from before `from`, so it is complete.
      expect(result.candles[0].complete).toBe(true);
    });
  });
});
