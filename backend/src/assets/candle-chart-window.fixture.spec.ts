jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    MarketCandleSyncMode: {
      initial: 'initial',
      incremental: 'incremental',
      repair: 'repair',
    },
    MarketCandleSyncStatus: {
      pending: 'pending',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    },
    Prisma: { Decimal: runtime.Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { AssetType, CurrencyCode, Prisma } from '../generated/prisma/client';
import { resolveMarketSession } from '../orders/market-calendar.policy';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';
import { CandleDatabaseLoader } from './candle-database.loader';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import { CandleResponseBuilder } from './candle-response.builder';
import { resolveRequiredFiveMinuteSlotEndMs } from './candle-expected-slots.policy';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import type { CandleServingConfig } from './candle-serving.config';

/**
 * Fixture-level check of the whole read path the charts actually use:
 * a store full of 5m rows → read plan → aggregation → response.
 *
 * Only PostgreSQL and the checkpoint table are stubbed (the repository returns
 * the fixture rows, the checkpoint reports confirmed coverage); the read plan,
 * the aggregation and the response builder are the real ones. This is what
 * proves a 30-day 4h request comes back as many session candles across many
 * trading days instead of the single truncated provider candle the legacy
 * path produced.
 */
describe('chart windows over a stored 5m fixture', () => {
  const FIVE_MIN = 5 * 60_000;
  const DAY_MS = 24 * 60 * 60_000;

  const config: CandleServingConfig = {
    mode: 'database',
    currentFreshnessMs: 60_000,
    onDemandRefreshEnabled: true,
    onDemandRefreshMaxDurationMs: 15_000,
    onDemandRefreshMaxPages: 10,
    onDemandRefreshMaxRows: 5000,
    staleWaiterMaxWaitMs: 500,
    maxManagedFiveMinuteRangeMs: 35 * DAY_MS,
    maxManagedPeriodRangeMs: 365 * DAY_MS,
    maxOnDemandRepairRangeMs: 2 * DAY_MS,
    coverageTailToleranceMs: DAY_MS,
  };

  const asset = (assetType: AssetType) => ({
    id: 'asset-1',
    symbol:
      assetType === AssetType.crypto
        ? 'BTCUSDT'
        : assetType === AssetType.domestic_stock
          ? '005930'
          : 'AAPL',
    name: 'Fixture',
    market:
      assetType === AssetType.crypto
        ? 'BINANCE'
        : assetType === AssetType.domestic_stock
          ? 'KOSPI'
          : 'NASDAQ',
    assetType,
    currencyCode:
      assetType === AssetType.domestic_stock
        ? CurrencyCode.KRW
        : CurrencyCode.USD,
    priceCurrency:
      assetType === AssetType.domestic_stock
        ? CurrencyCode.KRW
        : CurrencyCode.USD,
    settlementCurrency:
      assetType === AssetType.domestic_stock
        ? CurrencyCode.KRW
        : CurrencyCode.USD,
    isActive: true,
  });

  const query = (
    range: ParsedAssetCandlesQuery['range'],
    interval: ParsedAssetCandlesQuery['interval'],
    limit: number,
    now: Date,
    days: number,
  ): ParsedAssetCandlesQuery => ({
    range,
    rangeProvided: true,
    rangeStartAt: new Date(now.getTime() - days * DAY_MS),
    rangeEndAt: now,
    interval,
    intervalMinutes: 5,
    limit,
    requestedDate: now.toISOString().slice(0, 10),
    toHHmmss: '000000',
    toInstant: now,
    dateProvided: false,
    toProvided: false,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock: now,
  });

  const storedRow = (openTime: Date) => ({
    openTime,
    closeTime: new Date(openTime.getTime() + FIVE_MIN),
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(102),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(101),
    volume: new Prisma.Decimal(10),
    amount: new Prisma.Decimal(1010),
    isClosed: true,
    sourceUpdatedAt: openTime,
  });

  type StoredRow = ReturnType<typeof storedRow>;

  /**
   * The rows a market really stores for one session. KRX stops at the last
   * continuous-trading slot (15:15): 15:20–15:30 is the closing single-price
   * auction, which produces no 5m candle at all, so fabricating those two
   * rows would hide the very regression these fixtures guard.
   */
  const sessionRows = (
    market: 'KRX' | 'US',
    localDate: string,
  ): StoredRow[] => {
    const session = resolveMarketSession(market, localDate);
    if (!session) return [];
    const endMs = resolveRequiredFiveMinuteSlotEndMs(session);
    const rows: StoredRow[] = [];
    for (
      let openMs = session.openTime.getTime();
      openMs < endMs;
      openMs += FIVE_MIN
    ) {
      rows.push(storedRow(new Date(openMs)));
    }
    return rows;
  };

  const localDates = (timeZone: string, end: Date, days: number) => {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const dates: string[] = [];
    for (let index = days; index >= 0; index -= 1) {
      dates.push(
        format
          .format(new Date(end.getTime() - index * DAY_MS))
          .replace(/-/gu, ''),
      );
    }
    return [...new Set(dates)];
  };

  const createLoader = (rows: ReturnType<typeof storedRow>[]) => {
    const findRange = jest.fn(({ from, to }: { from: Date; to: Date }) =>
      Promise.resolve(
        rows.filter(
          (row) =>
            row.openTime.getTime() >= from.getTime() &&
            row.openTime.getTime() < to.getTime(),
        ),
      ),
    );
    const repository = { findRange } as never;
    const plans = new CandleReadPlanBuilder(config);
    const syncStates = {
      // A seeded baseline plus its incremental tails: the union covers the
      // requested window up to the request clock.
      findCandleCoverage: jest.fn().mockResolvedValue({
        startsAtRequestedFrom: true,
        contiguousCoveredTo: new Date('2100-01-01T00:00:00.000Z'),
        newestCompletedAt: new Date(),
        hasInteriorGap: false,
      }),
      findLatestOverlapping: jest.fn().mockResolvedValue({
        status: 'completed',
      }),
    } as never;
    const loader = new CandleDatabaseLoader(
      plans,
      repository,
      syncStates,
      new MarketCandleAggregationService(repository),
      new CandleResponseBuilder(),
      config,
    );
    return { loader, plans, findRange };
  };

  const tradingDays = (
    candles: { time: string }[],
    timeZone: string,
  ): Set<string> => {
    const format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return new Set(
      candles.map((candle) => format.format(new Date(candle.time))),
    );
  };

  it('serves a KRX 30d/4h chart as many session candles across many trading days', async () => {
    const now = new Date('2026-07-10T07:00:00.000Z'); // after the KRX close
    const rows = localDates('Asia/Seoul', now, 31).flatMap((date) =>
      sessionRows('KRX', date),
    );
    const { loader, plans } = createLoader(rows);
    const request = query('30d', '4h', 200, now, 30);
    const stockAsset = asset(AssetType.domestic_stock);

    const plan = plans.build(stockAsset, request);
    expect(plan).toMatchObject({
      sourceInterval: '5m',
      requiresAggregation: true,
      managedByPersistence: true,
    });

    const result = await loader.load(stockAsset, request, plan);
    expect(result.state).toBe('available');
    const candles = result.response!.data.candles;
    const days = tradingDays(candles, 'Asia/Seoul');

    // The legacy provider path answered this exact request with ONE candle.
    expect(candles.length).toBeGreaterThanOrEqual(30);
    expect(days.size).toBeGreaterThanOrEqual(15);
    expect(candles.length).toBe(days.size * 2); // 09:00 + 13:00 buckets
    expect(result.response!.data.source.requestedCount).toBe(200);
    expect(result.response!.data.source.returnedCount).toBe(candles.length);
    // Ascending, de-duplicated, inside the requested window.
    const times = candles.map((candle) => Date.parse(candle.time));
    expect([...times].sort((left, right) => left - right)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(
      request.rangeStartAt!.getTime(),
    );
  });

  it('keeps the KRX afternoon 4h bucket that ends in the closing auction', async () => {
    const now = new Date('2026-07-10T07:00:00.000Z'); // after the KRX close
    const rows = localDates('Asia/Seoul', now, 31).flatMap((date) =>
      sessionRows('KRX', date),
    );
    const { loader } = createLoader(rows);
    const request = query('30d', '4h', 200, now, 30);

    const result = await loader.load(asset(AssetType.domestic_stock), request);
    const candles = result.response!.data.candles;

    // Regression: the 13:00–15:30 bucket used to demand 30 constituents
    // (13:00 … 15:25). The 15:20/15:25 auction slots never exist, so every
    // afternoon bucket was judged incomplete and dropped — taking the fully
    // formed 13:00–15:20 data off the chart with it.
    expect(result.droppedIncompleteBuckets).toBe(0);
    expect(result.state).toBe('available');

    const afternoon = candles.filter(
      (candle) => Date.parse(candle.time) % DAY_MS === 4 * 60 * 60_000,
    );
    expect(afternoon.length).toBe(candles.length / 2);
    expect(
      candles.some(
        (candle) => candle.time === '2026-07-09T04:00:00.000Z', // 13:00 KST
      ),
    ).toBe(true);
  });

  it('serves the KRX 3d/15m chart down to the 15:15 closing slot', async () => {
    const now = new Date('2026-07-10T07:00:00.000Z');
    const rows = localDates('Asia/Seoul', now, 4).flatMap((date) =>
      sessionRows('KRX', date),
    );
    const { loader, plans } = createLoader(rows);
    const request = query('3d', '15m', 288, now, 3);
    const stockAsset = asset(AssetType.domestic_stock);

    const plan = plans.build(stockAsset, request);
    expect(plan).toMatchObject({
      sourceInterval: '5m',
      requiresAggregation: true,
      managedByPersistence: true,
    });

    const result = await loader.load(stockAsset, request, plan);
    const candles = result.response!.data.candles;

    expect(result.state).toBe('available');
    expect(result.droppedIncompleteBuckets).toBe(0);
    // Three calendar days back from a Friday covers Wed/Thu/Fri sessions.
    expect(tradingDays(candles, 'Asia/Seoul').size).toBe(3);
    // 26 fifteen-minute buckets per session; the last opens at 15:15 KST and
    // needs only its single 15:15 constituent.
    expect(candles.length).toBe(3 * 26);
    expect(
      candles.some((candle) => candle.time === '2026-07-10T06:15:00.000Z'),
    ).toBe(true);
    expect(result.response!.data.source.requestedCount).toBe(288);
  });

  it('serves a US 30d/4h chart across many trading days', async () => {
    const now = new Date('2026-07-10T21:00:00.000Z'); // after the US close
    const rows = localDates('America/New_York', now, 31).flatMap((date) =>
      sessionRows('US', date),
    );
    const { loader } = createLoader(rows);
    const request = query('30d', '4h', 200, now, 30);
    const usAsset = asset(AssetType.us_stock);

    const result = await loader.load(usAsset, request);
    const candles = result.response!.data.candles;
    const days = tradingDays(candles, 'America/New_York');

    expect(result.state).toBe('available');
    expect(candles.length).toBeGreaterThanOrEqual(30);
    expect(days.size).toBeGreaterThanOrEqual(15);
    expect(result.response!.data.source.requestedCount).toBe(200);
  });

  it.each([['30m', 672, 48] as const, ['1h', 336, 24] as const])(
    'keeps the oldest KRX %s candle inside the 14-day window and returns fewer than the crypto bound',
    async (interval, limit, perCryptoDay) => {
      const now = new Date('2026-07-10T07:00:00.000Z');
      const rows = localDates('Asia/Seoul', now, 15).flatMap((date) =>
        sessionRows('KRX', date),
      );
      const { loader } = createLoader(rows);
      const request = query('14d', interval, limit, now, 14);

      const result = await loader.load(
        asset(AssetType.domestic_stock),
        request,
      );
      const candles = result.response!.data.candles;
      const oldest = Date.parse(candles[0].time);

      expect(result.state).toBe('available');
      expect(oldest).toBeGreaterThanOrEqual(request.rangeStartAt!.getTime());
      // Within the first few days of the window (the edge may be a weekend).
      expect(oldest).toBeLessThan(request.rangeStartAt!.getTime() + 4 * DAY_MS);
      // Stocks only trade during the regular session, so fewer than the 24/7
      // crypto upper bound is CORRECT, not truncation.
      expect(candles.length).toBeLessThan(14 * perCryptoDay);
      expect(candles.length).toBeGreaterThan(14 * 2);
      expect(result.response!.data.source.requestedCount).toBe(limit);
    },
  );

  it.each([['30m', 672] as const, ['1h', 336] as const])(
    'returns the full 14-day crypto %s window up to its limit',
    async (interval, limit) => {
      const now = new Date('2026-07-10T00:00:00.000Z');
      const from = new Date(now.getTime() - 14 * DAY_MS - 4 * 60 * 60_000);
      const rows = [];
      for (
        let openMs = from.getTime();
        openMs < now.getTime();
        openMs += FIVE_MIN
      ) {
        rows.push(storedRow(new Date(openMs)));
      }
      const { loader } = createLoader(rows);
      const request = query('14d', interval, limit, now, 14);

      const result = await loader.load(asset(AssetType.crypto), request);
      const candles = result.response!.data.candles;

      expect(result.state).toBe('available');
      expect(candles.length).toBe(limit);
      expect(result.response!.data.source.requestedCount).toBe(limit);
    },
  );

  it('drops a gapped historical bucket instead of drawing a partial candle', async () => {
    const now = new Date('2026-07-10T07:00:00.000Z');
    const dates = localDates('Asia/Seoul', now, 15);
    const rows = dates.flatMap((date) => sessionRows('KRX', date));
    const victim = rows[rows.length - 3];
    const { loader } = createLoader(
      rows.filter(
        (row) => row.openTime.getTime() !== victim.openTime.getTime(),
      ),
    );

    const result = await loader.load(
      asset(AssetType.domestic_stock),
      query('14d', '30m', 672, now, 14),
    );

    expect(result.droppedIncompleteBuckets).toBeGreaterThan(0);
    expect(result.state).toBe('incomplete');
    // The remaining candles are all complete buckets; none covers the hole.
    const removed = result.response!.data.candles.some(
      (candle) =>
        Date.parse(candle.time) <= victim.openTime.getTime() &&
        Date.parse(candle.time) + 30 * 60_000 > victim.openTime.getTime(),
    );
    expect(removed).toBe(false);
  });
});
