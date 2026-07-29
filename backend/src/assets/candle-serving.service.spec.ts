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
  MarketCandleSyncMode,
} from '../generated/prisma/client';
import type {
  AssetCandlesResponse,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import {
  CandleOperationalRefreshError,
  CandleServingService,
} from './candle-serving.service';
import type { CandleReadPlan } from './candle-read-plan.builder';
import type { CandleDatabaseLoadResult } from './candle-database.loader';

describe('CandleServingService', () => {
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
  const clock = new Date('2026-07-13T00:00:00.000Z');
  const query: ParsedAssetCandlesQuery = {
    range: '1d',
    rangeProvided: false,
    rangeStartAt: new Date('2026-07-12T00:00:00.000Z'),
    rangeEndAt: clock,
    interval: '5m',
    intervalMinutes: 5,
    limit: 100,
    requestedDate: '2026-07-13',
    toHHmmss: '000000',
    toInstant: clock,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock,
  };
  const plan: CandleReadPlan = {
    assetId: asset.id,
    assetType: asset.assetType,
    market: asset.market,
    targetInterval: '5m',
    sourceInterval: '5m',
    requestedRange: { from: query.rangeStartAt!, to: clock },
    sourceRange: { from: query.rangeStartAt!, to: clock },
    limit: 100,
    explicitTo: false,
    latestRequest: true,
    requiresAggregation: false,
    managedByPersistence: true,
    outOfPolicyReason: null,
  };
  const response = (marker: string): AssetCandlesResponse => ({
    success: true,
    data: {
      state: 'available',
      asset: {
        id: asset.id,
        symbol: asset.symbol,
        name: asset.name,
        assetType: asset.assetType,
        market: asset.market,
        priceCurrency: asset.priceCurrency,
      },
      range: '1d',
      interval: '5m',
      requestedDate: '2026-07-13',
      candles: [
        {
          time: clock.toISOString(),
          open: marker,
          high: marker,
          low: marker,
          close: marker,
          volume: '1',
          amount: '1',
          sourceDate: '20260713',
          sourceTime: '000000',
        },
      ],
      source: {
        provider: 'binance',
        endpoint: '/api/v3/klines',
        symbol: asset.symbol,
        interval: '5m',
        requestedCount: 100,
        returnedCount: 1,
      },
    },
  });

  const load = (
    state: CandleDatabaseLoadResult['state'],
    value: AssetCandlesResponse | null,
    overrides: Partial<CandleDatabaseLoadResult> = {},
  ): CandleDatabaseLoadResult => ({
    plan,
    state,
    fresh: true,
    completedCoverage: true,
    hasBlockingCheckpoint: false,
    droppedIncompleteBuckets: 0,
    response: value,
    ...overrides,
  });

  const create = (mode: 'legacy' | 'database' = 'database') => {
    const plans = { build: jest.fn().mockReturnValue(plan) };
    const database = { load: jest.fn() };
    const cache = { get: jest.fn().mockResolvedValue({ status: 'miss' }) };
    const singleFlight = {
      getOrLoad: jest.fn(
        ({ loader }: { loader: () => Promise<AssetCandlesResponse> }) =>
          loader(),
      ),
    };
    const sync = { syncAsset: jest.fn() };
    const service = new CandleServingService(
      plans as never,
      database as never,
      cache as never,
      singleFlight as never,
      sync as never,
      {
        mode,
        currentFreshnessMs: 60_000,
        onDemandRefreshEnabled: true,
        onDemandRefreshMaxDurationMs: 1_000,
        onDemandRefreshMaxPages: 10,
        onDemandRefreshMaxRows: 5000,
        staleWaiterMaxWaitMs: 50,
        maxManagedFiveMinuteRangeMs: 35 * 86_400_000,
        maxManagedPeriodRangeMs: 365 * 86_400_000,
        maxOnDemandRepairRangeMs: 2 * 86_400_000,
      },
    );
    return { service, plans, database, cache, singleFlight, sync };
  };

  it('preserves provider-direct behavior in legacy mode', async () => {
    const { service, database, cache } = create('legacy');
    const legacy = jest.fn().mockResolvedValue(response('legacy'));
    await expect(service.serve(asset, query, legacy)).resolves.toEqual(
      response('legacy'),
    );
    expect(database.load).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('returns a fresh cache hit without DB, sync, or legacy provider', async () => {
    const { service, database, cache, sync } = create();
    cache.get.mockResolvedValue({ status: 'fresh', value: response('cache') });
    const legacy = jest.fn();
    await expect(service.serve(asset, query, legacy)).resolves.toEqual(
      response('cache'),
    );
    expect(database.load).not.toHaveBeenCalled();
    expect(sync.syncAsset).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('serves fresh completed DB coverage without provider refresh', async () => {
    const { service, database, sync } = create();
    database.load.mockResolvedValue(load('available', response('db')));
    await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(
      response('db'),
    );
    expect(sync.syncAsset).not.toHaveBeenCalled();
  });

  it('refreshes stale current data and only returns the DB requery', async () => {
    const { service, database, sync } = create();
    database.load
      .mockResolvedValueOnce(
        load('available', response('old'), { fresh: false }),
      )
      .mockResolvedValueOnce(
        load('available', response('old'), { fresh: false }),
      )
      .mockResolvedValueOnce(load('available', response('requery')));
    sync.syncAsset.mockResolvedValue({
      assetId: asset.id,
      feeds: [{ status: 'completed', complete: true, writtenRows: 1 }],
    });
    await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(
      response('requery'),
    );
    expect(sync.syncAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: MarketCandleSyncMode.incremental,
        from: plan.sourceRange.from,
        to: plan.sourceRange.to,
      }),
    );
  });

  it('uses stale Redis on an operational refresh failure without a provider call', async () => {
    const { service, database, cache, singleFlight } = create();
    const stale = response('stale');
    cache.get.mockResolvedValue({ status: 'stale', value: stale });
    database.load.mockResolvedValue(
      load('missing', null, { completedCoverage: true }),
    );
    singleFlight.getOrLoad.mockRejectedValue(
      new CandleOperationalRefreshError('timeout'),
    );
    const legacy = jest.fn();
    await expect(service.serve(asset, query, legacy)).resolves.toBe(stale);
    expect(legacy).toHaveBeenCalledTimes(0);
  });

  it('uses strict DB last-known-good after a failed refresh without a provider call', async () => {
    const { service, database, sync } = create();
    const old = load('available', response('db-fallback'), { fresh: false });
    database.load.mockResolvedValue(old);
    sync.syncAsset.mockResolvedValue({
      assetId: asset.id,
      feeds: [
        {
          status: 'failed',
          complete: false,
          writtenRows: 0,
          errorCode: 'PROVIDER_CALL_FAILED',
        },
      ],
    });
    const legacy = jest.fn();
    await expect(service.serve(asset, query, legacy)).resolves.toEqual(
      response('db-fallback'),
    );
    expect(legacy).toHaveBeenCalledTimes(0);
  });

  it('does not hide programmer errors behind stale cache', async () => {
    const { service, database, cache, singleFlight } = create();
    cache.get.mockResolvedValue({ status: 'stale', value: response('stale') });
    database.load.mockResolvedValue(load('available', response('db')));
    singleFlight.getOrLoad.mockRejectedValue(new TypeError('invariant'));
    await expect(service.serve(asset, query, jest.fn())).rejects.toThrow(
      TypeError,
    );
  });

  it('keeps out-of-policy and large cold requests on legacy without initial sync', async () => {
    const { service, plans, database, sync } = create();
    plans.build.mockReturnValueOnce({
      ...plan,
      managedByPersistence: false,
      outOfPolicyReason: 'interval_not_persisted',
    });
    const legacy = jest.fn().mockResolvedValue(response('legacy'));
    await service.serve(asset, query, legacy);
    expect(database.load).not.toHaveBeenCalled();

    plans.build.mockReturnValueOnce({
      ...plan,
      sourceRange: {
        from: new Date(clock.getTime() - 3 * 86_400_000),
        to: clock,
      },
    });
    database.load.mockResolvedValue(
      load('missing', null, { completedCoverage: false }),
    );
    await service.serve(asset, query, legacy);
    expect(sync.syncAsset).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  describe('cold baseline for aggregated intervals (15m/30m/1h/4h)', () => {
    // 30m/1h ask for 14 days and 4h for 30 days, all aggregated from the
    // stored 5m feed. KIS caps a minute page at 120 rows, so the legacy path
    // would bucket one truncated page into "candles" — the `candles=1 ·
    // req=120 · ret=1 · 30d/4h` bug. Those requests must fail loudly instead.
    const aggregatedPlan = (
      targetInterval: '15m' | '30m' | '1h' | '4h',
      days: number,
    ): CandleReadPlan => ({
      ...plan,
      targetInterval,
      requiresAggregation: true,
      requestedRange: {
        from: new Date(clock.getTime() - days * 86_400_000),
        to: clock,
      },
      sourceRange: {
        from: new Date(clock.getTime() - days * 86_400_000 - 4 * 60 * 60_000),
        to: clock,
      },
    });

    it.each([
      ['30m', 14],
      ['1h', 14],
      ['4h', 30],
      ['15m', 7],
    ] as const)(
      'answers %s over %s days with BASELINE_NOT_READY instead of truncated provider candles',
      async (interval, days) => {
        const { service, plans, database, sync } = create();
        plans.build.mockReturnValue(aggregatedPlan(interval, days));
        database.load.mockResolvedValue(
          load('missing', null, { completedCoverage: false }),
        );
        const legacy = jest.fn().mockResolvedValue(response('legacy'));

        await expect(
          service.serve(asset, { ...query, interval }, legacy),
        ).rejects.toMatchObject({
          response: {
            success: false,
            error: { code: 'ASSET_CANDLES_BASELINE_NOT_READY' },
          },
          status: 503,
        });
        expect(legacy).not.toHaveBeenCalled();
        expect(sync.syncAsset).not.toHaveBeenCalled();
      },
    );

    it('keeps NON-aggregated cold ranges (1d/1w/5m) on the documented legacy path', async () => {
      const { service, plans, database } = create();
      plans.build.mockReturnValue({
        ...plan,
        targetInterval: '1d',
        sourceInterval: '1d',
        requiresAggregation: false,
        sourceRange: {
          from: new Date(clock.getTime() - 365 * 86_400_000),
          to: clock,
        },
      });
      database.load.mockResolvedValue(
        load('missing', null, { completedCoverage: false }),
      );
      const legacy = jest.fn().mockResolvedValue(response('legacy'));
      await expect(
        service.serve(asset, { ...query, interval: '1d' }, legacy),
      ).resolves.toEqual(response('legacy'));
      expect(legacy).toHaveBeenCalledTimes(1);
    });

    it('serves an aggregated request from the database once baseline coverage exists', async () => {
      const { service, plans, database, sync } = create();
      plans.build.mockReturnValue(aggregatedPlan('4h', 30));
      database.load.mockResolvedValue(
        load('available', response('db-4h'), { completedCoverage: true }),
      );
      const legacy = jest.fn();
      await expect(
        service.serve(asset, { ...query, interval: '4h' }, legacy),
      ).resolves.toEqual(response('db-4h'));
      expect(legacy).not.toHaveBeenCalled();
      expect(sync.syncAsset).not.toHaveBeenCalled();
    });

    it('still allows the explicit legacy rollback mode for aggregated intervals', async () => {
      const { service, database } = create('legacy');
      const legacy = jest.fn().mockResolvedValue(response('legacy'));
      await expect(
        service.serve(asset, { ...query, interval: '4h' }, legacy),
      ).resolves.toEqual(response('legacy'));
      expect(legacy).toHaveBeenCalledTimes(1);
      expect(database.load).not.toHaveBeenCalled();
    });

    it('serves the complete buckets when coverage is confirmed but a historical bucket has a hole', async () => {
      // Dropping the gapped bucket is the completeness policy; failing the
      // whole 30-day chart over one missing 5m row is not.
      const { service, plans, database, sync } = create();
      plans.build.mockReturnValue(aggregatedPlan('4h', 30));
      database.load.mockResolvedValue(
        load('incomplete', response('db-partial'), {
          completedCoverage: true,
          droppedIncompleteBuckets: 2,
          fresh: false,
        }),
      );
      sync.syncAsset.mockResolvedValue({
        assetId: asset.id,
        feeds: [{ status: 'completed', complete: false, writtenRows: 0 }],
      });
      const legacy = jest.fn();
      await expect(
        service.serve(asset, { ...query, interval: '4h' }, legacy),
      ).resolves.toEqual(response('db-partial'));
      expect(legacy).not.toHaveBeenCalled();
    });
  });

  it('fails with the provider-compatible error when a managed refresh fails without any fallback, never provider-direct', async () => {
    // No stale Redis, no strict last-known-good: the request fails with the
    // existing crypto provider error contract. The legacy loader must not be
    // consulted — a managed request never bypasses the durable store.
    const { service, database, singleFlight } = create();
    database.load.mockResolvedValue(
      load('missing', null, { completedCoverage: true }),
    );
    singleFlight.getOrLoad.mockRejectedValue(
      new CandleOperationalRefreshError('coverage'),
    );
    const legacy = jest.fn().mockResolvedValue(response('legacy'));
    await expect(service.serve(asset, query, legacy)).rejects.toMatchObject({
      status: 502,
    });
    await expect(service.serve(asset, query, legacy)).rejects.toMatchObject({
      response: {
        success: false,
        error: expect.objectContaining({
          code: 'ASSET_CANDLES_PROVIDER_ERROR',
        }) as unknown,
      },
    });
    expect(legacy).toHaveBeenCalledTimes(0);
  });

  it('keeps the stock provider error contract on an unresolved managed refresh without a provider call', async () => {
    const { service, plans, database, singleFlight } = create();
    const stockAsset = {
      ...asset,
      id: 'asset-2',
      symbol: '005930',
      market: 'KOSPI',
      assetType: AssetType.domestic_stock,
    };
    plans.build.mockReturnValue({
      ...plan,
      assetId: stockAsset.id,
      assetType: stockAsset.assetType,
      market: stockAsset.market,
    });
    database.load.mockResolvedValue(
      load('missing', null, { completedCoverage: true }),
    );
    singleFlight.getOrLoad.mockRejectedValue(
      new CandleOperationalRefreshError('provider'),
    );
    const legacy = jest.fn().mockResolvedValue(response('legacy'));
    await expect(
      service.serve(stockAsset, query, legacy),
    ).rejects.toMatchObject({
      status: 503,
      response: {
        success: false,
        error: expect.objectContaining({
          code: 'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
        }) as unknown,
      },
    });
    expect(legacy).toHaveBeenCalledTimes(0);
  });

  describe('stale Redis fallback on database outages', () => {
    const databaseDown = () => {
      const error = new Error("Can't reach database server at localhost:5432");
      error.name = 'PrismaClientInitializationError';
      return error;
    };
    const prismaPoolTimeout = () => {
      const error = new Error(
        'Timed out fetching a new connection from the pool.',
      ) as Error & { code: string };
      error.name = 'PrismaClientKnownRequestError';
      error.code = 'P2024';
      return error;
    };

    it('returns stale Redis when the initial database load fails operationally', async () => {
      const { service, database, cache } = create();
      const stale = response('stale');
      cache.get.mockResolvedValue({ status: 'stale', value: stale });
      database.load.mockRejectedValue(databaseDown());
      await expect(service.serve(asset, query, jest.fn())).resolves.toBe(stale);
    });

    it('returns stale Redis on a Prisma pool/connection timeout', async () => {
      const { service, database, cache } = create();
      const stale = response('stale');
      cache.get.mockResolvedValue({ status: 'stale', value: stale });
      database.load.mockRejectedValue(prismaPoolTimeout());
      await expect(service.serve(asset, query, jest.fn())).resolves.toBe(stale);
    });

    it('serves a fresh cache hit without touching the failed database', async () => {
      const { service, database, cache } = create();
      cache.get.mockResolvedValue({
        status: 'fresh',
        value: response('cache'),
      });
      database.load.mockRejectedValue(databaseDown());
      await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(
        response('cache'),
      );
      expect(database.load).not.toHaveBeenCalled();
    });

    it('rethrows the database error when no stale value exists', async () => {
      const { service, database, cache } = create();
      cache.get.mockResolvedValue({ status: 'miss' });
      database.load.mockRejectedValue(databaseDown());
      await expect(
        service.serve(asset, query, jest.fn()),
      ).rejects.toMatchObject({
        name: 'PrismaClientInitializationError',
      });
    });

    it('never hides validation errors behind stale Redis', async () => {
      const { service, database, cache } = create();
      cache.get.mockResolvedValue({
        status: 'stale',
        value: response('stale'),
      });
      const validation = new Error('interval must be 5m, 1d, or 1w.');
      validation.name = 'MarketCandleSyncInputError';
      database.load.mockRejectedValue(validation);
      await expect(service.serve(asset, query, jest.fn())).rejects.toBe(
        validation,
      );
    });

    it('never hides configuration errors behind stale Redis', async () => {
      const { service, database, cache, singleFlight } = create();
      cache.get.mockResolvedValue({
        status: 'stale',
        value: response('stale'),
      });
      database.load.mockResolvedValue(
        load('missing', null, { completedCoverage: true }),
      );
      const config = new Error('KIS_APP_KEY is missing.');
      config.name = 'ProviderConfigError';
      singleFlight.getOrLoad.mockRejectedValue(config);
      await expect(service.serve(asset, query, jest.fn())).rejects.toBe(config);
    });

    it('never hides schema invariant errors behind stale Redis', async () => {
      const { service, database, cache } = create();
      cache.get.mockResolvedValue({
        status: 'stale',
        value: response('stale'),
      });
      const invariant = new Error(
        'Validated candle request could not be converted to UTC.',
      );
      database.load.mockRejectedValue(invariant);
      await expect(service.serve(asset, query, jest.fn())).rejects.toBe(
        invariant,
      );
    });

    it('resumes normal serving once the database recovers', async () => {
      const { service, database, cache } = create();
      cache.get.mockResolvedValue({
        status: 'stale',
        value: response('stale'),
      });
      database.load.mockRejectedValueOnce(databaseDown());
      await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(
        response('stale'),
      );
      database.load.mockResolvedValue(load('available', response('recovered')));
      await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(
        response('recovered'),
      );
    });
  });
});
