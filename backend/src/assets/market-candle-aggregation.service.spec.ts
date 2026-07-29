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
import { resolveMarketSession } from '../orders/market-calendar.policy';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../orders/market-calendar/market-session-override.store';
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
      // Every bucket expects 6 except the last (15:00–15:30), whose 15:20 and
      // 15:25 slots fall in the closing single-price auction.
      expect(
        thirty.candles
          .slice(0, 12)
          .every((bucket) => bucket.expectedConstituentCount === 6),
      ).toBe(true);
      expect(thirty.candles[12].expectedConstituentCount).toBe(4);
    });

    it('anchors 1h/4h buckets at a CUSTOM delayed open and rejects pre-open rows', () => {
      try {
        // Operator override: 2026-07-10 KRX opens at 10:30 KST (01:30Z).
        applyMarketSessionOverrideSnapshot(
          [
            {
              market: 'KRX',
              localDate: '2026-07-10',
              overrideType: 'custom',
              openTime: '103000',
              closeTime: '153000',
              reason: 'delayed open',
            },
          ],
          new Date(),
        );
        // 10:30–15:30 KST = 60 five-minute candles.
        const delayedSession = run('2026-07-10T01:30:00.000Z', 60);

        const hourly = service.aggregateCandles({
          assetType: AssetType.domestic_stock,
          interval: '1h',
          candles: delayedSession,
          from: dayFrom,
          to: dayTo,
          now,
        });
        expect(hourly.candles).toHaveLength(5);
        expect(hourly.candles[0].openTime.toISOString()).toBe(
          '2026-07-10T01:30:00.000Z',
        );
        // 14:30–15:30 is the only bucket touching the closing auction.
        expect(
          hourly.candles
            .slice(0, 4)
            .every((bucket) => bucket.expectedConstituentCount === 12),
        ).toBe(true);
        expect(hourly.candles[4].expectedConstituentCount).toBe(10);

        const fourHour = service.aggregateCandles({
          assetType: AssetType.domestic_stock,
          interval: '4h',
          candles: delayedSession,
          from: dayFrom,
          to: dayTo,
          now,
        });
        expect(fourHour.candles).toHaveLength(2);
        expect(fourHour.candles[0].openTime.toISOString()).toBe(
          '2026-07-10T01:30:00.000Z',
        );
        // Final bucket is capped at the session close (05:30–06:30Z).
        expect(fourHour.candles[1].closeTime.toISOString()).toBe(
          '2026-07-10T06:30:00.000Z',
        );

        // Rows stamped before the delayed open (09:00 KST anchor rows) do not
        // create synthetic pre-open buckets — they are rejected.
        const withPreOpenRows = service.aggregateCandles({
          assetType: AssetType.domestic_stock,
          interval: '1h',
          candles: [...run('2026-07-10T00:00:00.000Z', 6), ...delayedSession],
          from: dayFrom,
          to: dayTo,
          now,
        });
        expect(withPreOpenRows.candles).toHaveLength(5);
        expect(withPreOpenRows.candles[0].openTime.toISOString()).toBe(
          '2026-07-10T01:30:00.000Z',
        );
        expect(withPreOpenRows.ignoredSourceRows).toBe(6);
      } finally {
        resetMarketSessionOverrideStoreForTest();
      }
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
      // Spans 6 grid slots but expects 4: 15:20/15:25 are auction slots.
      expect(last.expectedConstituentCount).toBe(4);
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
      // 13:00–15:30 spans 30 grid slots and expects 28 (13:00 … 15:15).
      expect(second.expectedConstituentCount).toBe(28);
      // This fixture is synthetic and does carry 15:20/15:25 rows: they are
      // still aggregated (30 constituents * 10 volume, * 1010 amount) even
      // though completeness never required them.
      expect(second.actualConstituentCount).toBe(30);
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

    it('anchors the delayed open and preserves the 16:30 close session', () => {
      const session = run('2026-11-19T01:00:00.000Z', 78);
      const fourHour = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '4h',
        candles: [candle('2026-11-19T00:00:00.000Z'), ...session],
        from: new Date('2026-11-18T15:00:00.000Z'),
        to: new Date('2026-11-19T15:00:00.000Z'),
        now: new Date('2026-11-20T00:00:00.000Z'),
      });
      expect(fourHour.ignoredSourceRows).toBe(1);
      expect(fourHour.candles).toHaveLength(2);
      expect(fourHour.candles[0].openTime.toISOString()).toBe(
        '2026-11-19T01:00:00.000Z',
      );
      expect(fourHour.candles[1].closeTime.toISOString()).toBe(
        '2026-11-19T07:30:00.000Z',
      );
      // The auction window follows the overridden 16:30 close, so 16:20 and
      // 16:25 are the excluded slots here — not 15:20/15:25.
      expect(fourHour.candles[1].expectedConstituentCount).toBe(28);
    });

    // Regression: what KIS actually delivers. The KRX closing single-price
    // auction (15:20–15:30) has no continuous-trading minutes, so the domestic
    // minute feed jumps from 15:19 straight to a single 15:30 auction print
    // and the 5m builder's last candle of every day opens at 15:15. Requiring
    // the 15:20/15:25 slots made every bucket touching the close incomplete,
    // and the read path then dropped the whole afternoon bucket — including
    // the fully formed 13:00–15:20 data.
    const realSession = run('2026-07-10T00:00:00.000Z', 76); // 09:00–15:15 KST

    it('completes every KRX bucket when the day ends at the 15:15 slot', () => {
      for (const interval of ['15m', '30m', '1h', '4h'] as const) {
        const result = service.aggregateCandles({
          assetType: AssetType.domestic_stock,
          interval,
          candles: realSession,
          from: dayFrom,
          to: dayTo,
          now,
        });
        expect(result.candles.length).toBeGreaterThan(0);
        const gapped = result.candles.filter((bucket) => !bucket.complete);
        expect(gapped.map((bucket) => bucket.openTime.toISOString())).toEqual(
          [],
        );
        expect(
          result.candles.every(
            (bucket) => bucket.isClosed && bucket.gapCount === 0,
          ),
        ).toBe(true);
      }
    });

    it('keeps the 13:00–15:30 four-hour bucket without the auction slots', () => {
      const fourHour = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '4h',
        candles: realSession,
        from: dayFrom,
        to: dayTo,
        now,
      });
      const afternoon = fourHour.candles[1];
      expect(afternoon.openTime.toISOString()).toBe('2026-07-10T04:00:00.000Z');
      expect(afternoon.closeTime.toISOString()).toBe(
        '2026-07-10T06:30:00.000Z',
      );
      expect(afternoon.expectedConstituentCount).toBe(28);
      expect(afternoon.actualConstituentCount).toBe(28);
      expect(afternoon.gapCount).toBe(0);
      expect(afternoon.complete).toBe(true);
      expect(afternoon.isClosed).toBe(true);
    });

    it('still reports a real hole next to the auction window', () => {
      // Drop 15:15 (the last REQUIRED slot) but keep everything else: the
      // exclusion must not become a blanket amnesty for the session tail.
      const holed = realSession.filter(
        (row) => row.openTime.toISOString() !== '2026-07-10T06:15:00.000Z',
      );
      const hourly = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: holed,
        from: dayFrom,
        to: dayTo,
        now,
      });
      const last = hourly.candles[hourly.candles.length - 1];
      expect(last.openTime.toISOString()).toBe('2026-07-10T06:00:00.000Z');
      expect(last.expectedConstituentCount).toBe(4);
      expect(last.actualConstituentCount).toBe(3);
      expect(last.gapCount).toBe(1);
      expect(last.complete).toBe(false);
      expect(last.isClosed).toBe(false);
    });

    it('does not let an auction-slot row mask a missing required slot', () => {
      // 15:15 missing, 15:20 present: the totals match (4 rows in the bucket)
      // but the required slot is still absent, so the bucket stays incomplete.
      const swapped = [
        ...realSession.filter(
          (row) => row.openTime.toISOString() !== '2026-07-10T06:15:00.000Z',
        ),
        candle('2026-07-10T06:20:00.000Z'),
      ];
      const hourly = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: swapped,
        from: dayFrom,
        to: dayTo,
        now,
      });
      const last = hourly.candles[hourly.candles.length - 1];
      expect(last.expectedConstituentCount).toBe(4);
      expect(last.actualConstituentCount).toBe(4);
      expect(last.gapCount).toBe(1);
      expect(last.complete).toBe(false);
    });

    it('does not aggregate a KRX full-day holiday', () => {
      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '1h',
        candles: run('2026-07-17T00:00:00.000Z', 12),
        from: new Date('2026-07-16T15:00:00.000Z'),
        to: new Date('2026-07-17T15:00:00.000Z'),
        now,
      });
      expect(result.candles).toEqual([]);
      expect(result.ignoredSourceRows).toBe(12);
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

    it('caps the Thanksgiving Friday bucket at the 13:00 early close', () => {
      const session = run('2026-11-27T14:30:00.000Z', 42);
      const fourHour = service.aggregateCandles({
        assetType: AssetType.us_stock,
        interval: '4h',
        candles: session,
        from: new Date('2026-11-27T05:00:00.000Z'),
        to: new Date('2026-11-28T05:00:00.000Z'),
        now: new Date('2026-11-28T06:00:00.000Z'),
      });
      expect(fourHour.candles).toHaveLength(1);
      expect(fourHour.candles[0].closeTime.toISOString()).toBe(
        '2026-11-27T18:00:00.000Z',
      );
      expect(fourHour.candles[0].expectedConstituentCount).toBe(42);
      expect(fourHour.candles[0].complete).toBe(true);
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

  // The chart windows this aggregation actually serves: 30m/1h over 14 days
  // and 4h over 30 days, all built from stored 5m candles. Sessions come from
  // the same market calendar the service uses, so days the calendar has no
  // session for (weekends, holidays) simply contribute no 5m rows — exactly
  // what the store looks like.
  describe('multi-day chart windows (14d / 30d)', () => {
    const sessionFiveMinutes = (
      market: 'KRX' | 'US',
      localDate: string,
    ): FiveMinuteSourceCandle[] => {
      const session = resolveMarketSession(market, localDate);
      if (!session) return [];
      const rows: FiveMinuteSourceCandle[] = [];
      for (
        let openMs = session.openTime.getTime();
        openMs < session.closeTime.getTime();
        openMs += FIVE_MIN
      ) {
        rows.push(candle(new Date(openMs).toISOString()));
      }
      return rows;
    };

    const localDatesBack = (
      timeZone: string,
      endIso: string,
      days: number,
    ): string[] => {
      const dates: string[] = [];
      const end = new Date(endIso).getTime();
      for (let index = days - 1; index >= 0; index -= 1) {
        const day = new Date(end - index * 24 * 60 * 60_000);
        dates.push(
          new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
            .format(day)
            .replace(/-/gu, ''),
        );
      }
      return [...new Set(dates)];
    };

    it('returns KRX 4h candles across many trading days for a 30-day window', () => {
      const nowUtc = new Date('2026-07-10T07:00:00.000Z'); // after the KRX close
      const from = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60_000);
      const dates = localDatesBack('Asia/Seoul', nowUtc.toISOString(), 31);
      const candles = dates.flatMap((date) => sessionFiveMinutes('KRX', date));

      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '4h',
        candles,
        from,
        to: nowUtc,
        now: nowUtc,
      });

      const tradingDays = new Set(
        result.candles.map((bucket) =>
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Seoul',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(bucket.openTime),
        ),
      );
      // The bug this replaces returned ONE truncated candle for the whole
      // 30-day window.
      expect(tradingDays.size).toBeGreaterThanOrEqual(15);
      expect(result.candles.length).toBeGreaterThanOrEqual(30);
      expect(result.candles.length).toBe(tradingDays.size * 2); // 09:00 + 13:00
      expect(result.candles.every((bucket) => bucket.complete)).toBe(true);
      expect(result.candles.every((bucket) => bucket.isClosed)).toBe(true);
      // Weekends and holidays are absent, never synthesized.
      expect(tradingDays.size).toBeLessThan(dates.length);
      expect(result.candles[0].openTime.getTime()).toBeGreaterThanOrEqual(
        from.getTime(),
      );
    });

    it('returns US 4h candles across many trading days for a 30-day window (through a DST-free month)', () => {
      const nowUtc = new Date('2026-07-10T21:00:00.000Z'); // after the US close
      const from = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60_000);
      const dates = localDatesBack(
        'America/New_York',
        nowUtc.toISOString(),
        31,
      );
      const candles = dates.flatMap((date) => sessionFiveMinutes('US', date));

      const result = service.aggregateCandles({
        assetType: AssetType.us_stock,
        interval: '4h',
        candles,
        from,
        to: nowUtc,
        now: nowUtc,
      });

      const tradingDays = new Set(
        result.candles.map((bucket) =>
          new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(bucket.openTime),
        ),
      );
      expect(tradingDays.size).toBeGreaterThanOrEqual(15);
      expect(result.candles.length).toBeGreaterThanOrEqual(30);
      expect(result.candles.every((bucket) => bucket.complete)).toBe(true);
    });

    it('spans a US DST transition inside one 30-day window', () => {
      // 2026-03-08 is the spring-forward date; the window covers both sides.
      const nowUtc = new Date('2026-03-20T20:00:00.000Z');
      const from = new Date(nowUtc.getTime() - 30 * 24 * 60 * 60_000);
      const dates = localDatesBack(
        'America/New_York',
        nowUtc.toISOString(),
        31,
      );
      const candles = dates.flatMap((date) => sessionFiveMinutes('US', date));

      const result = service.aggregateCandles({
        assetType: AssetType.us_stock,
        interval: '4h',
        candles,
        from,
        to: nowUtc,
        now: nowUtc,
      });

      const opensBeforeDst = result.candles
        .filter((bucket) => bucket.openTime < new Date('2026-03-08T00:00:00Z'))
        .map((bucket) => bucket.openTime.toISOString().slice(11, 16));
      const opensAfterDst = result.candles
        .filter((bucket) => bucket.openTime > new Date('2026-03-09T00:00:00Z'))
        .map((bucket) => bucket.openTime.toISOString().slice(11, 16));
      // 09:30 EST = 14:30Z before the switch, 09:30 EDT = 13:30Z after it —
      // the session anchor follows the IANA zone, not a fixed UTC offset.
      expect(opensBeforeDst).toContain('14:30');
      expect(opensAfterDst).toContain('13:30');
      expect(opensAfterDst).not.toContain('14:30');
      expect(result.candles.every((bucket) => bucket.complete)).toBe(true);
    });

    it('caps a 14-day crypto window at 672 30m and 336 1h candles', () => {
      const to = new Date('2026-07-10T00:00:00.000Z');
      const from = new Date(to.getTime() - 14 * 24 * 60 * 60_000);
      const candles = run(from.toISOString(), (14 * 24 * 60) / 5);

      const halfHour = service.aggregateCandles({
        assetType: AssetType.crypto,
        interval: '30m',
        candles,
        from,
        to,
        now: to,
      });
      const hourly = service.aggregateCandles({
        assetType: AssetType.crypto,
        interval: '1h',
        candles,
        from,
        to,
        now: to,
      });

      expect(halfHour.candles).toHaveLength(672);
      expect(hourly.candles).toHaveLength(336);
      expect(halfHour.candles[0].openTime.getTime()).toBe(from.getTime());
      expect(halfHour.candles.every((bucket) => bucket.complete)).toBe(true);
      expect(hourly.candles.every((bucket) => bucket.complete)).toBe(true);
    });

    it('keeps the oldest 14-day stock candles ~14 days back and drops a gapped bucket', () => {
      const nowUtc = new Date('2026-07-10T07:00:00.000Z');
      const from = new Date(nowUtc.getTime() - 14 * 24 * 60 * 60_000);
      const dates = localDatesBack('Asia/Seoul', nowUtc.toISOString(), 15);
      const candles = dates.flatMap((date) => sessionFiveMinutes('KRX', date));
      // Remove one 5m row from the newest session's first 30m bucket.
      const lastDayRows = sessionFiveMinutes('KRX', dates[dates.length - 1]);
      const gapped = lastDayRows.length
        ? candles.filter(
            (row) =>
              row.openTime.getTime() !== lastDayRows[1].openTime.getTime(),
          )
        : candles;

      const result = service.aggregateCandles({
        assetType: AssetType.domestic_stock,
        interval: '30m',
        candles: gapped,
        from,
        to: nowUtc,
        now: nowUtc,
      });

      const oldest = result.candles[0];
      expect(oldest.openTime.getTime()).toBeGreaterThanOrEqual(from.getTime());
      // Within the first three days of the window (weekend at the edge).
      expect(oldest.openTime.getTime()).toBeLessThan(
        from.getTime() + 4 * 24 * 60 * 60_000,
      );
      const holed = result.candles.find(
        (bucket) =>
          bucket.openTime.getTime() === lastDayRows[0].openTime.getTime(),
      );
      // The bucket missing a constituent is reported incomplete and open, so
      // the serving loader drops it instead of drawing a partial candle.
      expect(holed?.complete).toBe(false);
      expect(holed?.isClosed).toBe(false);
      expect(holed?.gapCount).toBe(1);
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
