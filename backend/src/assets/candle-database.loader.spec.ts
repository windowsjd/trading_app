jest.mock('../generated/prisma/client', () => ({
  AssetType: { domestic_stock: 'domestic_stock', us_stock: 'us_stock', crypto: 'crypto' },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  MarketCandleSyncMode: { initial: 'initial', incremental: 'incremental', repair: 'repair' },
  MarketCandleSyncStatus: { pending: 'pending', running: 'running', completed: 'completed', failed: 'failed', canceled: 'canceled' },
  Prisma: { Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal },
  PrismaClient: class PrismaClient {},
}));

import { AssetType, CurrencyCode, MarketCandleSyncStatus, Prisma } from '../generated/prisma/client';
import { CandleDatabaseLoader } from './candle-database.loader';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';

describe('CandleDatabaseLoader', () => {
  const now = new Date('2026-07-13T00:20:00.000Z');
  const asset = {
    id: 'asset-1', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE',
    assetType: AssetType.crypto, currencyCode: CurrencyCode.USD,
    priceCurrency: CurrencyCode.USD, settlementCurrency: CurrencyCode.USD, isActive: true,
  };
  const query: ParsedAssetCandlesQuery = {
    range: '1d', rangeProvided: true,
    rangeStartAt: new Date('2026-07-12T00:20:00.000Z'), rangeEndAt: now,
    interval: '5m', intervalMinutes: 5, limit: 2,
    requestedDate: '2026-07-13', toHHmmss: '002000', toInstant: now,
    dateProvided: true, toProvided: true, includePrevious: true,
    explicitDate: false, explicitTo: false, clock: now,
  };
  const plan = {
    assetId: asset.id, assetType: asset.assetType, market: asset.market,
    targetInterval: '5m' as const, sourceInterval: '5m' as const,
    requestedRange: { from: query.rangeStartAt!, to: now },
    sourceRange: { from: query.rangeStartAt!, to: now }, limit: 2,
    explicitTo: false, latestRequest: true, requiresAggregation: false,
    managedByPersistence: true, outOfPolicyReason: null,
  };
  const candle = (minute: number, closed = true) => ({
    openTime: new Date(`2026-07-13T00:${String(minute).padStart(2, '0')}:00.000Z`),
    closeTime: new Date(`2026-07-13T00:${String(minute + 5).padStart(2, '0')}:00.000Z`),
    open: new Prisma.Decimal(100), high: new Prisma.Decimal(102), low: new Prisma.Decimal(99), close: new Prisma.Decimal(101),
    volume: new Prisma.Decimal(10), amount: null, isClosed: closed,
    sourceUpdatedAt: new Date('2026-07-13T00:19:30.000Z'), sourceProvider: 'binance_klines',
  });

  const create = () => {
    const plans = { build: jest.fn().mockReturnValue(plan) };
    const repository = { findRange: jest.fn().mockResolvedValue([]) };
    const states = {
      findCompletedCovering: jest.fn().mockResolvedValue({ completedAt: new Date('2026-07-13T00:19:30Z') }),
      findLatestOverlapping: jest.fn().mockResolvedValue({ status: MarketCandleSyncStatus.completed }),
    };
    const aggregation = { aggregateCandles: jest.fn() };
    const responses = {
      buildPersisted: jest.fn((_asset, _query, rows) => ({
        success: true,
        data: { state: rows.length ? 'available' : 'empty', candles: rows },
      })),
    };
    const loader = new CandleDatabaseLoader(
      plans as never, repository as never, states as never,
      aggregation as never, responses as never,
      {
        mode: 'database', currentFreshnessMs: 60_000, onDemandRefreshEnabled: true,
        onDemandRefreshMaxDurationMs: 1000, onDemandRefreshMaxPages: 10,
        onDemandRefreshMaxRows: 5000, staleWaiterMaxWaitMs: 100,
        maxManagedFiveMinuteRangeMs: 35 * 86_400_000,
        maxManagedPeriodRangeMs: 365 * 86_400_000,
        maxOnDemandRepairRangeMs: 2 * 86_400_000,
      },
    );
    return { loader, repository, states, aggregation, responses };
  };

  it('loads direct stored candles, selects latest N, and keeps ascending order', async () => {
    const { loader, repository, responses } = create();
    repository.findRange.mockResolvedValue([candle(0), candle(5), candle(10)]);
    const result = await loader.load(asset, query, plan);
    expect(result).toMatchObject({ state: 'available', fresh: true, completedCoverage: true });
    expect(responses.buildPersisted.mock.calls[0][2].map((row) => row.openTime.toISOString())).toEqual([
      '2026-07-13T00:05:00.000Z', '2026-07-13T00:10:00.000Z',
    ]);
  });

  it('distinguishes confirmed empty from unsynced missing', async () => {
    const { loader, states } = create();
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({ state: 'confirmed_empty' });
    states.findCompletedCovering.mockResolvedValue(null);
    states.findLatestOverlapping.mockResolvedValue(null);
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({ state: 'missing' });
  });

  it('does not call completed coverage available while a failed checkpoint remains', async () => {
    const { loader, repository, states } = create();
    repository.findRange.mockResolvedValue([candle(0)]);
    states.findLatestOverlapping.mockResolvedValue({ status: MarketCandleSyncStatus.failed });
    await expect(loader.load(asset, query, plan)).resolves.toMatchObject({
      state: 'incomplete', completedCoverage: true, hasBlockingCheckpoint: true,
    });
  });

  it.each(['15m', '30m', '1h', '4h'] as const)(
    'uses the existing aggregation service for %s and removes historical gaps',
    async (interval) => {
      const { loader, aggregation, responses } = create();
      const aggregatePlan = { ...plan, targetInterval: interval, requiresAggregation: true };
      aggregation.aggregateCandles.mockReturnValue({
        ignoredSourceRows: 0,
        candles: [
          { ...candle(0), complete: false, isCurrent: false },
          { ...candle(5), complete: true, isCurrent: false, isClosed: true },
        ],
      });
      const result = await loader.load(asset, { ...query, interval }, aggregatePlan);
      expect(aggregation.aggregateCandles).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ state: 'incomplete', droppedIncompleteBuckets: 1 });
      expect(responses.buildPersisted.mock.calls[0][2]).toHaveLength(1);
    },
  );
});
