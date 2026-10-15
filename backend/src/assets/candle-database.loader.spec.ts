jest.mock('../generated/prisma/client', () => ({
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
  Prisma: {
    Decimal: jest.requireActual<{ Decimal: unknown }>(
      '@prisma/client/runtime/client',
    ).Decimal,
  },
  PrismaClient: class PrismaClient {},
}));

import {
  AssetType,
  CurrencyCode,
  MarketCandleSyncStatus,
  Prisma,
} from '../generated/prisma/client';
import { CandleDatabaseLoader } from './candle-database.loader';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';

describe('CandleDatabaseLoader', () => {
  const now = new Date('2026-07-13T00:20:00.000Z');
  const asset = {
    id: 'asset-1',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    market: 'BINANCE',
    assetType: AssetType.crypto,
    currencyCode: CurrencyCode.USD,
    priceCurrency: CurrencyCode.USD,
    settlementCurrency: CurrencyCode.USD,
    isActive: true,
  };
  const query: ParsedAssetCandlesQuery = {
    range: '1d',
    rangeProvided: true,
    rangeStartAt: new Date('2026-07-12T00:20:00.000Z'),
    rangeEndAt: now,
    interval: '5m',
    intervalMinutes: 5,
    limit: 2,
    requestedDate: '2026-07-13',
    toHHmmss: '002000',
    toInstant: now,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock: now,
  };
  const plan = {
    assetId: asset.id,
    assetType: asset.assetType,
    market: asset.market,
    targetInterval: '5m' as const,
    sourceInterval: '5m' as const,
    requestedRange: { from: query.rangeStartAt!, to: now },
    sourceRange: { from: query.rangeStartAt!, to: now },
    limit: 2,
    explicitTo: false,
    latestRequest: true,
    requiresAggregation: false,
    managedByPersistence: true,
    outOfPolicyReason: null,
  };
  const candle = (minute: number, closed = true) => ({
    openTime: new Date(
      `2026-07-13T00:${String(minute).padStart(2, '0')}:00.000Z`,
    ),
    closeTime: new Date(
      `2026-07-13T00:${String(minute + 5).padStart(2, '0')}:00.000Z`,
    ),
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(102),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(101),
    volume: new Prisma.Decimal(10),
    amount: null,
    isClosed: closed,
    sourceUpdatedAt: new Date('2026-07-13T00:19:30.000Z'),
    sourceProvider: 'binance_klines',
  });

  const create = () => {
    const plans = { build: jest.fn().mockReturnValue(plan) };
    const repository = { findRange: jest.fn().mockResolvedValue([]) };
    const states = {
      findCandleCoverage: jest.fn().mockResolvedValue({
        startsAtRequestedFrom: true,
        contiguousCoveredTo: now,
        newestCompletedAt: new Date('2026-07-13T00:19:30Z'),
        hasInteriorGap: false,
      }),
      findLatestOverlapping: jest
        .fn()
        .mockResolvedValue({ status: MarketCandleSyncStatus.completed }),
    };
    const aggregation = { aggregateCandles: jest.fn() };
    const responses = {
      buildPersisted: jest.fn(
        (_asset: unknown, _query: unknown, rows: { openTime: Date }[]) => ({
          success: true,
          data: { state: rows.length ? 'available' : 'empty', candles: rows },
        }),
      ),
    };
    const loader = new CandleDatabaseLoader(
      plans as never,
      repository as never,
      states as never,
      aggregation as never,
      responses as never,
      {
        mode: 'database',
        currentFreshnessMs: 60_000,
        onDemandRefreshEnabled: true,
        onDemandRefreshMaxDurationMs: 1000,
        onDemandRefreshMaxPages: 10,
        onDemandRefreshMaxRows: 5000,
        staleWaiterMaxWaitMs: 100,
        maxManagedFiveMinuteRangeMs: 35 * 86_400_000,
        maxManagedPeriodRangeMs: 365 * 86_400_000,
        maxManagedKrxDailyRangeMs: 875 * 86_400_000,
        maxOnDemandRepairRangeMs: 2 * 86_400_000,
        coverageTailToleranceMs: 86_400_000,
      },
    );
    return { loader, repository, states, aggregation, responses };
  };

  it('loads direct stored candles, selects latest N, and keeps ascending order', async () => {
    const { loader, repository, responses } = create();
    repository.findRange.mockResolvedValue([candle(0), candle(5), candle(10)]);
    const result = await loader.load(asset, query, plan);
    expect(result).toMatchObject({
      state: 'available',
      fresh: true,
      completedCoverage: true,
    });
    const persistedCalls = responses.buildPersisted.mock.calls as unknown[][];
    expect(
      (persistedCalls[0][2] as { openTime: Date }[]).map((row) =>
        row.openTime.toISOString(),
      ),
    ).toEqual(['2026-07-13T00:05:00.000Z', '2026-07-13T00:10:00.000Z']);
  });

  it('distinguishes confirmed empty from unsynced missing', async () => {
    const { loader, states } = create();
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'confirmed_empty',
    });
    states.findCandleCoverage.mockResolvedValue({
      startsAtRequestedFrom: false,
      contiguousCoveredTo: null,
      newestCompletedAt: null,
      hasInteriorGap: false,
    });
    states.findLatestOverlapping.mockResolvedValue(null);
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'missing',
    });
  });

  it('does not call completed coverage available while a failed checkpoint remains', async () => {
    const { loader, repository, states } = create();
    repository.findRange.mockResolvedValue([candle(0)]);
    states.findLatestOverlapping.mockResolvedValue({
      status: MarketCandleSyncStatus.failed,
    });
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'incomplete',
      completedCoverage: true,
      hasBlockingCheckpoint: true,
    });
  });

  it('clamps the coverage requirement at the query clock for ranges past now', async () => {
    const { loader, states } = create();
    const futureTo = new Date(now.getTime() + 60 * 60_000);
    const futurePlan = {
      ...plan,
      requestedRange: { from: plan.requestedRange.from, to: futureTo },
      sourceRange: { from: plan.sourceRange.from, to: futureTo },
    };
    await loader.load(asset, query, futurePlan);
    // A checkpoint can only confirm candles that exist; requiring coverage
    // beyond `now` would make current-day requests permanently uncoverable.
    expect(states.findCandleCoverage).toHaveBeenCalledWith(
      asset.id,
      '5m',
      futurePlan.sourceRange.from,
      now,
    );
  });

  it('treats stored rows without coverage-complete evidence as incomplete, never available', async () => {
    const { loader, repository, states } = create();
    repository.findRange.mockResolvedValue([candle(0), candle(5)]);
    // A legacy `completed` checkpoint without coverage audit no longer
    // matches the coverage union, so it reports covered=false.
    states.findCandleCoverage.mockResolvedValue({
      startsAtRequestedFrom: false,
      contiguousCoveredTo: null,
      newestCompletedAt: null,
      hasInteriorGap: false,
    });
    states.findLatestOverlapping.mockResolvedValue({
      status: MarketCandleSyncStatus.completed,
    });
    const result = await loader.load(asset, query, plan);
    expect(result).toMatchObject({
      state: 'incomplete',
      completedCoverage: false,
      hasBlockingCheckpoint: false,
    });
  });

  it('never serves a data_incomplete KIS checkpoint as completed coverage', async () => {
    // A KIS 5m run whose provider sweep reached the target but whose stored
    // data is incomplete terminates as status=completed with
    // coverageComplete=false and completionReason=data_incomplete. Such a
    // row never matches the coverage union (its SQL requires
    // coverageComplete=true), so coverage resolves to covered=false and rows
    // with holes must surface as incomplete — never available.
    const { loader, repository, states } = create();
    repository.findRange.mockResolvedValue([candle(0), candle(10)]);
    states.findCandleCoverage.mockResolvedValue({
      startsAtRequestedFrom: false,
      contiguousCoveredTo: null,
      newestCompletedAt: null,
      hasInteriorGap: false,
    });
    states.findLatestOverlapping.mockResolvedValue({
      status: MarketCandleSyncStatus.completed,
      coverageComplete: false,
      completionReason: 'data_incomplete',
    });
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'incomplete',
      completedCoverage: false,
      hasBlockingCheckpoint: false,
    });
    // And an empty store backed only by that checkpoint is missing, never
    // confirmed_empty.
    repository.findRange.mockResolvedValue([]);
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'missing',
      completedCoverage: false,
    });
  });

  it('never reports confirmed_empty without coverage-complete evidence', async () => {
    const { loader, states } = create();
    states.findCandleCoverage.mockResolvedValue({
      startsAtRequestedFrom: false,
      contiguousCoveredTo: null,
      newestCompletedAt: null,
      hasInteriorGap: false,
    });
    states.findLatestOverlapping.mockResolvedValue({
      status: MarketCandleSyncStatus.completed,
    });
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'missing',
      completedCoverage: false,
    });
  });

  describe('coverage classification', () => {
    const coverage = (
      overrides: Partial<{
        startsAtRequestedFrom: boolean;
        contiguousCoveredTo: Date | null;
        newestCompletedAt: Date | null;
        hasInteriorGap: boolean;
      }> = {},
    ) => ({
      startsAtRequestedFrom: true,
      contiguousCoveredTo: now,
      newestCompletedAt: new Date('2026-07-13T00:19:30Z'),
      hasInteriorGap: false,
      ...overrides,
    });

    it('is complete when confirmed coverage reaches the clock', async () => {
      const { loader, repository } = create();
      repository.findRange.mockResolvedValue([candle(0)]);
      await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
        coverageStatus: 'complete',
        completedCoverage: true,
        state: 'available',
      });
    });

    it('serves a stale TAIL: history confirmed, last minutes not re-synced', async () => {
      // The everyday case between incremental syncs. It must stay servable —
      // demanding coverage exactly to the request clock made every long
      // window fail one minute after a sync.
      const { loader, repository, states } = create();
      repository.findRange.mockResolvedValue([candle(0), candle(5)]);
      states.findCandleCoverage.mockResolvedValue(
        coverage({ contiguousCoveredTo: new Date(now.getTime() - 60_000) }),
      );
      await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
        coverageStatus: 'stale_tail',
        completedCoverage: false,
        state: 'available',
        storedCandleCount: 2,
      });
    });

    it('is insufficient when the tail lags beyond the tolerance', async () => {
      const { loader, repository, states } = create();
      repository.findRange.mockResolvedValue([candle(0)]);
      states.findCandleCoverage.mockResolvedValue(
        coverage({
          contiguousCoveredTo: new Date(now.getTime() - 3 * 86_400_000),
        }),
      );
      await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
        coverageStatus: 'insufficient',
        state: 'incomplete',
      });
    });

    it('never tolerates an interior hole, however recent', async () => {
      const { loader, repository, states } = create();
      repository.findRange.mockResolvedValue([candle(0)]);
      states.findCandleCoverage.mockResolvedValue(
        coverage({
          contiguousCoveredTo: new Date(now.getTime() - 60_000),
          hasInteriorGap: true,
        }),
      );
      await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
        coverageStatus: 'insufficient',
        hasCoverageInteriorGap: true,
        state: 'incomplete',
      });
    });

    it('reports how many usable candles the store produced', async () => {
      const { loader, repository, states } = create();
      repository.findRange.mockResolvedValue([
        candle(0),
        candle(5),
        candle(10),
      ]);
      states.findCandleCoverage.mockResolvedValue(
        coverage({ startsAtRequestedFrom: false, contiguousCoveredTo: null }),
      );
      // limit is 2 in this fixture, so the newest two survive.
      await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
        coverageStatus: 'insufficient',
        storedCandleCount: 2,
        state: 'incomplete',
      });
    });
  });

  it.each(['15m', '30m', '1h', '4h'] as const)(
    'uses the existing aggregation service for %s and removes historical gaps',
    async (interval) => {
      const { loader, aggregation, responses } = create();
      const aggregatePlan = {
        ...plan,
        targetInterval: interval,
        requiresAggregation: true,
      };
      aggregation.aggregateCandles.mockReturnValue({
        ignoredSourceRows: 0,
        candles: [
          { ...candle(0), complete: false, isCurrent: false },
          { ...candle(5), complete: true, isCurrent: false, isClosed: true },
        ],
      });
      const result = await loader.load(
        asset,
        { ...query, interval },
        aggregatePlan,
      );
      expect(aggregation.aggregateCandles).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        state: 'incomplete',
        droppedIncompleteBuckets: 1,
      });
      expect(responses.buildPersisted.mock.calls[0][2]).toHaveLength(1);
    },
  );

  describe('KRX central mode (design v2.1 §4.2 rules 7, 8, 10; §4.5)', () => {
    const A = new Date('2026-10-13T15:00:00.000Z'); // 2026-10-14 00:00 KST
    const krx = {
      ...asset,
      symbol: '005930',
      market: 'KRX',
      assetType: AssetType.domestic_stock,
      currencyCode: CurrencyCode.KRW,
      priceCurrency: CurrencyCode.KRW,
      settlementCurrency: CurrencyCode.KRW,
    };
    const clock = new Date('2026-10-15T01:21:00.000Z'); // 10:21 KST
    const krxQuery = { ...query, clock, rangeEndAt: clock, toInstant: clock };
    const covered = {
      startsAtRequestedFrom: true,
      contiguousCoveredTo: clock,
      newestCompletedAt: clock,
      hasInteriorGap: false,
    };
    const insufficient = {
      startsAtRequestedFrom: false,
      contiguousCoveredTo: null,
      newestCompletedAt: null,
      hasInteriorGap: false,
    };
    const createKrx = () => {
      const base = create();
      const loader = new CandleDatabaseLoader(
        { build: jest.fn() } as never,
        base.repository as never,
        base.states as never,
        base.aggregation as never,
        base.responses as never,
        {
          mode: 'database',
          currentFreshnessMs: 60_000,
          onDemandRefreshEnabled: true,
          onDemandRefreshMaxDurationMs: 1000,
          onDemandRefreshMaxPages: 10,
          onDemandRefreshMaxRows: 5000,
          staleWaiterMaxWaitMs: 100,
          maxManagedFiveMinuteRangeMs: 45 * 86_400_000,
          maxManagedPeriodRangeMs: 365 * 86_400_000,
          maxManagedKrxDailyRangeMs: 875 * 86_400_000,
          maxOnDemandRepairRangeMs: 2 * 86_400_000,
          coverageTailToleranceMs: 86_400_000,
        },
        {
          enabled: true,
          tickDelayMs: 70_000,
          weeklySyncEnabled: true,
          cohorts: [
            {
              id: 'cohort-1',
              obligationStart: A.toISOString(),
              symbols: ['005930'],
            },
          ],
        },
      );
      return { ...base, loader };
    };
    const fivePlan = (from: Date) => ({
      ...plan,
      assetType: krx.assetType,
      market: krx.market,
      requestedRange: { from, to: clock },
      sourceRange: { from, to: clock },
    });
    const dailyPlan = {
      ...plan,
      assetType: krx.assetType,
      market: krx.market,
      targetInterval: '1d' as const,
      sourceInterval: '1d' as const,
      requestedRange: { from: new Date('2026-09-01T00:00:00Z'), to: clock },
      sourceRange: { from: new Date('2026-09-01T00:00:00Z'), to: clock },
      limit: 600,
    };
    const fiveMinute = (local: string, closed = true) => {
      const open = new Date(`2026-10-15T${local}:00+09:00`);
      return {
        openTime: open,
        closeTime: new Date(open.getTime() + 5 * 60_000),
        open: new Prisma.Decimal(100),
        high: new Prisma.Decimal(local === '09:30' ? 110 : 101),
        low: new Prisma.Decimal(local === '10:00' ? 90 : 99),
        close: new Prisma.Decimal(local === '10:20' ? 105 : 100),
        volume: new Prisma.Decimal(10),
        amount: new Prisma.Decimal(1000),
        isClosed: closed,
        sourceUpdatedAt: new Date(open.getTime() + 6 * 60_000),
        sourceProvider: 'koscom_intraday',
      };
    };
    const morning = (skip?: string) => {
      const rows = [];
      for (let m = 9 * 60; m <= 10 * 60 + 15; m += 5) {
        const local = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
        if (local !== skip) rows.push(fiveMinute(local));
      }
      return [...rows, fiveMinute('10:20', false)];
    };

    it('reads 5m evidence with the holiday bridge and the obligation filter; fresh only when complete', async () => {
      const { loader, states, repository } = createKrx();
      repository.findRange.mockResolvedValue([candle(0)]);
      states.findCandleCoverage.mockResolvedValue(covered);
      const result = await loader.load(krx, krxQuery, fivePlan(A));
      const options = (
        states.findCandleCoverage.mock.calls[0] as unknown[]
      )[4] as {
        bridge?: unknown;
        createdAtOrAfter?: Date;
      };
      expect(typeof options.bridge).toBe('function');
      expect(options.createdAtOrAfter?.toISOString()).toBe(A.toISOString());
      expect(result.fresh).toBe(true);
      states.findCandleCoverage.mockResolvedValue({
        ...covered,
        contiguousCoveredTo: new Date(clock.getTime() - 70_000),
      });
      const stale = await loader.load(krx, krxQuery, fivePlan(A));
      expect(stale.coverageStatus).toBe('stale_tail');
      expect(stale.fresh).toBe(false);
    });

    it('classifies a window that starts before A as pre- or post-obligation (log only)', async () => {
      const { loader, states } = createKrx();
      const early = fivePlan(new Date(A.getTime() - 5 * 86_400_000));
      states.findCandleCoverage
        .mockResolvedValueOnce(insufficient)
        .mockResolvedValueOnce(covered);
      const pre = await loader.load(krx, krxQuery, early);
      expect(pre.obligation).toBe('pre_obligation');
      expect(pre.coverageStatus).toBe('insufficient');
      states.findCandleCoverage
        .mockResolvedValueOnce(insufficient)
        .mockResolvedValueOnce({ ...covered, hasInteriorGap: true });
      const post = await loader.load(krx, krxQuery, early);
      expect(post.obligation).toBe('post_obligation');
      const inside = await loader.load(krx, krxQuery, fivePlan(A));
      expect(inside.obligation).toBeNull();
    });

    it("builds today's in-progress daily bar only from a complete set of today's 5m candles", async () => {
      const { loader, repository, responses } = createKrx();
      repository.findRange.mockImplementation(
        ({ interval }: { interval: string }) =>
          Promise.resolve(interval === '5m' ? morning() : []),
      );
      await loader.load(krx, krxQuery, dailyPlan);
      const rows = (
        responses.buildPersisted.mock.calls.at(-1) as unknown[]
      )[2] as {
        openTime: Date;
        high: Prisma.Decimal;
        low: Prisma.Decimal;
        close: Prisma.Decimal;
        volume: Prisma.Decimal;
      }[];
      expect(rows.length).toBe(1);
      expect(rows[0].openTime.toISOString()).toBe('2026-10-14T15:00:00.000Z');
      expect(rows[0].high.toString()).toBe('110');
      expect(rows[0].low.toString()).toBe('90');
      expect(rows[0].close.toString()).toBe('105');
      expect(rows[0].volume.toString()).toBe('170'); // 16 closed + 1 current

      // One closed required slot missing: no in-progress bar at all.
      repository.findRange.mockImplementation(
        ({ interval }: { interval: string }) =>
          Promise.resolve(interval === '5m' ? morning('09:45') : []),
      );
      await loader.load(krx, krxQuery, dailyPlan);
      const holed = (
        responses.buildPersisted.mock.calls.at(-1) as unknown[]
      )[2] as unknown[];
      expect(holed.length).toBe(0);
    });
  });
});
