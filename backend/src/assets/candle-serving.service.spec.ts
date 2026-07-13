jest.mock('../generated/prisma/client', () => ({
  AssetType: { domestic_stock: 'domestic_stock', us_stock: 'us_stock', crypto: 'crypto' },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  MarketCandleSyncMode: { initial: 'initial', incremental: 'incremental', repair: 'repair' },
  MarketCandleSyncStatus: { pending: 'pending', running: 'running', completed: 'completed', failed: 'failed', canceled: 'canceled' },
  Prisma: { Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal },
  PrismaClient: class PrismaClient {},
}));

import { HttpException } from '@nestjs/common';
import { AssetType, CurrencyCode, MarketCandleSyncMode } from '../generated/prisma/client';
import type { AssetCandlesResponse, ParsedAssetCandlesQuery } from './asset-candles.service';
import { CandleOperationalRefreshError, CandleServingService } from './candle-serving.service';
import type { CandleReadPlan } from './candle-read-plan.builder';
import type { CandleDatabaseLoadResult } from './candle-database.loader';

describe('CandleServingService', () => {
  const asset = {
    id: 'asset-1', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE',
    assetType: AssetType.crypto, currencyCode: CurrencyCode.USD,
    priceCurrency: CurrencyCode.USD, settlementCurrency: CurrencyCode.USD, isActive: true,
  };
  const clock = new Date('2026-07-13T00:00:00.000Z');
  const query: ParsedAssetCandlesQuery = {
    range: '1d', rangeProvided: false,
    rangeStartAt: new Date('2026-07-12T00:00:00.000Z'), rangeEndAt: clock,
    interval: '5m', intervalMinutes: 5, limit: 100,
    requestedDate: '2026-07-13', toHHmmss: '000000', toInstant: clock,
    dateProvided: true, toProvided: true, includePrevious: true,
    explicitDate: false, explicitTo: false, clock,
  };
  const plan: CandleReadPlan = {
    assetId: asset.id, assetType: asset.assetType, market: asset.market,
    targetInterval: '5m', sourceInterval: '5m',
    requestedRange: { from: query.rangeStartAt!, to: clock },
    sourceRange: { from: query.rangeStartAt!, to: clock }, limit: 100,
    explicitTo: false, latestRequest: true, requiresAggregation: false,
    managedByPersistence: true, outOfPolicyReason: null,
  };
  const response = (marker: string): AssetCandlesResponse => ({
    success: true,
    data: {
      state: 'available',
      asset: { id: asset.id, symbol: asset.symbol, name: asset.name, assetType: asset.assetType, market: asset.market, priceCurrency: asset.priceCurrency },
      range: '1d', interval: '5m', requestedDate: '2026-07-13',
      candles: [{ time: clock.toISOString(), open: marker, high: marker, low: marker, close: marker, volume: '1', amount: '1', sourceDate: '20260713', sourceTime: '000000' }],
      source: { provider: 'binance', endpoint: '/api/v3/klines', symbol: asset.symbol, interval: '5m', requestedCount: 100, returnedCount: 1 },
    },
  });

  const load = (
    state: CandleDatabaseLoadResult['state'],
    value: AssetCandlesResponse | null,
    overrides: Partial<CandleDatabaseLoadResult> = {},
  ): CandleDatabaseLoadResult => ({
    plan, state, fresh: true, completedCoverage: true,
    hasBlockingCheckpoint: false, droppedIncompleteBuckets: 0,
    response: value, ...overrides,
  });

  const create = (mode: 'legacy' | 'database' = 'database') => {
    const plans = { build: jest.fn().mockReturnValue(plan) };
    const database = { load: jest.fn() };
    const cache = { get: jest.fn().mockResolvedValue({ status: 'miss' }) };
    const singleFlight = {
      getOrLoad: jest.fn(async ({ loader }) => loader()),
    };
    const sync = { syncAsset: jest.fn() };
    const service = new CandleServingService(
      plans as never, database as never, cache as never, singleFlight as never,
      sync as never,
      {
        mode, currentFreshnessMs: 60_000, onDemandRefreshEnabled: true,
        onDemandRefreshMaxDurationMs: 1_000, onDemandRefreshMaxPages: 10,
        onDemandRefreshMaxRows: 5000, staleWaiterMaxWaitMs: 50,
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
    await expect(service.serve(asset, query, legacy)).resolves.toEqual(response('legacy'));
    expect(database.load).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('returns a fresh cache hit without DB, sync, or legacy provider', async () => {
    const { service, database, cache, sync } = create();
    cache.get.mockResolvedValue({ status: 'fresh', value: response('cache') });
    const legacy = jest.fn();
    await expect(service.serve(asset, query, legacy)).resolves.toEqual(response('cache'));
    expect(database.load).not.toHaveBeenCalled();
    expect(sync.syncAsset).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it('serves fresh completed DB coverage without provider refresh', async () => {
    const { service, database, sync } = create();
    database.load.mockResolvedValue(load('available', response('db')));
    await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(response('db'));
    expect(sync.syncAsset).not.toHaveBeenCalled();
  });

  it('refreshes stale current data and only returns the DB requery', async () => {
    const { service, database, sync } = create();
    database.load
      .mockResolvedValueOnce(load('available', response('old'), { fresh: false }))
      .mockResolvedValueOnce(load('available', response('old'), { fresh: false }))
      .mockResolvedValueOnce(load('available', response('requery')));
    sync.syncAsset.mockResolvedValue({
      assetId: asset.id,
      feeds: [{ status: 'completed', complete: true, writtenRows: 1 }],
    });
    await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(response('requery'));
    expect(sync.syncAsset).toHaveBeenCalledWith(expect.objectContaining({
      mode: MarketCandleSyncMode.incremental,
      from: plan.sourceRange.from,
      to: plan.sourceRange.to,
    }));
  });

  it('uses stale Redis on an operational refresh failure', async () => {
    const { service, database, cache, singleFlight } = create();
    const stale = response('stale');
    cache.get.mockResolvedValue({ status: 'stale', value: stale });
    database.load.mockResolvedValue(load('missing', null, { completedCoverage: true }));
    singleFlight.getOrLoad.mockRejectedValue(new CandleOperationalRefreshError('timeout'));
    await expect(service.serve(asset, query, jest.fn())).resolves.toBe(stale);
  });

  it('uses strict DB last-known-good after a failed refresh', async () => {
    const { service, database, sync } = create();
    const old = load('available', response('db-fallback'), { fresh: false });
    database.load.mockResolvedValue(old);
    sync.syncAsset.mockResolvedValue({
      assetId: asset.id,
      feeds: [{ status: 'failed', complete: false, writtenRows: 0, errorCode: 'PROVIDER_CALL_FAILED' }],
    });
    await expect(service.serve(asset, query, jest.fn())).resolves.toEqual(response('db-fallback'));
  });

  it('does not hide programmer errors behind stale cache', async () => {
    const { service, database, cache, singleFlight } = create();
    cache.get.mockResolvedValue({ status: 'stale', value: response('stale') });
    database.load.mockResolvedValue(load('available', response('db')));
    singleFlight.getOrLoad.mockRejectedValue(new TypeError('invariant'));
    await expect(service.serve(asset, query, jest.fn())).rejects.toThrow(TypeError);
  });

  it('keeps out-of-policy and large cold requests on legacy without initial sync', async () => {
    const { service, plans, database, sync } = create();
    plans.build.mockReturnValueOnce({ ...plan, managedByPersistence: false, outOfPolicyReason: 'interval_not_persisted' });
    const legacy = jest.fn().mockResolvedValue(response('legacy'));
    await service.serve(asset, query, legacy);
    expect(database.load).not.toHaveBeenCalled();

    plans.build.mockReturnValueOnce({ ...plan, sourceRange: { from: new Date(clock.getTime() - 3 * 86_400_000), to: clock } });
    database.load.mockResolvedValue(load('missing', null, { completedCoverage: false }));
    await service.serve(asset, query, legacy);
    expect(sync.syncAsset).not.toHaveBeenCalled();
    expect(legacy).toHaveBeenCalledTimes(2);
  });

  it('preserves the existing provider error when no fallback exists', async () => {
    const { service, database, singleFlight } = create();
    database.load.mockResolvedValue(load('missing', null, { completedCoverage: true }));
    singleFlight.getOrLoad.mockRejectedValue(new CandleOperationalRefreshError('provider'));
    await expect(service.serve(asset, query, jest.fn())).rejects.toMatchObject({ status: 502 } satisfies Partial<HttpException>);
  });
});
