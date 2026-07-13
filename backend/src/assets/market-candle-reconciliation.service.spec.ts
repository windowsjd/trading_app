jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    MarketCandleSyncMode: {
      initial: 'initial',
      incremental: 'incremental',
      repair: 'repair',
    },
    MarketCandleSyncStatus: {
      running: 'running',
      completed: 'completed',
      failed: 'failed',
    },
    Prisma: { Decimal },
  };
});

import {
  AssetType,
  MarketCandleSyncStatus,
  Prisma,
  type MarketCandle,
} from '../generated/prisma/client';
import { readMarketCandleReconciliationConfig } from './market-candle-reconciliation.config';
import { MarketCandleReconciliationService } from './market-candle-reconciliation.service';

describe('MarketCandleReconciliationService', () => {
  const setup = () => {
    const prisma = {
      asset: { findMany: jest.fn() },
      marketCandle: { findMany: jest.fn() },
    };
    const repository = { findRange: jest.fn() };
    const sync = { syncAsset: jest.fn() };
    const liveStore = {
      getCurrent: jest.fn().mockResolvedValue(null),
      discardReconciledCurrent: jest.fn(),
    };
    const publisher = { publishState: jest.fn() };
    const service = new MarketCandleReconciliationService(
      prisma as never,
      repository as never,
      sync as never,
      liveStore as never,
      publisher as never,
      readMarketCandleReconciliationConfig({}),
    );
    return { prisma, repository, sync, liveStore, publisher, service };
  };

  it('dryRun plans assets without provider calls or DB writes', async () => {
    const fixture = setup();
    fixture.prisma.asset.findMany.mockResolvedValue([cryptoAsset()]);
    const result = await fixture.service.reconcile({
      market: 'CRYPTO',
      dryRun: true,
      now: new Date('2026-07-13T00:10:00.000Z'),
    });
    expect(result).toMatchObject({
      dryRun: true,
      assetsChecked: 1,
      failedAssets: 0,
    });
    expect(fixture.sync.syncAsset).not.toHaveBeenCalled();
    expect(fixture.repository.findRange).not.toHaveBeenCalled();
  });

  it('records missing and OHLCV/source drift after bounded repair sync', async () => {
    const fixture = setup();
    fixture.prisma.asset.findMany.mockResolvedValue([cryptoAsset()]);
    const original = candle({ close: '100', sourceUpdatedAt: '00:04:00' });
    const corrected = candle({ close: '101', sourceUpdatedAt: '00:04:30' });
    const inserted = candle({ openMinute: 5, close: '102' });
    fixture.repository.findRange
      .mockResolvedValueOnce([original])
      .mockResolvedValueOnce([corrected, inserted]);
    fixture.sync.syncAsset.mockResolvedValue({
      feeds: [{ status: MarketCandleSyncStatus.completed }],
    });

    const result = await fixture.service.reconcile({
      market: 'CRYPTO',
      targets: ['5m'],
      now: new Date('2026-07-13T00:10:00.000Z'),
    });

    expect(fixture.sync.syncAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'repair',
        targets: ['5m'],
        resume: false,
        budget: expect.objectContaining({ maxPages: 10 }),
      }),
    );
    expect(result).toMatchObject({
      assetsChecked: 1,
      missingRows: 1,
      correctedRows: 1,
      unchangedRows: 0,
      failedAssets: 0,
    });
    expect(result.results[0].correctionReasons).toEqual({
      ohlc: 1,
      source_updated_at: 1,
      missing_bucket: 1,
    });
  });

  it('continues after an asset failure and reports the failure structurally', async () => {
    const fixture = setup();
    fixture.prisma.asset.findMany.mockResolvedValue([
      cryptoAsset('asset-1'),
      cryptoAsset('asset-2'),
    ]);
    fixture.repository.findRange.mockResolvedValue([]);
    fixture.sync.syncAsset
      .mockRejectedValueOnce(
        Object.assign(new Error('provider'), { name: 'ProviderError' }),
      )
      .mockResolvedValueOnce({
        feeds: [{ status: MarketCandleSyncStatus.completed }],
      });
    const result = await fixture.service.reconcile({
      market: 'CRYPTO',
      now: new Date('2026-07-13T00:10:00.000Z'),
    });
    expect(result.failedAssets).toBe(1);
    expect(result.results[0]).toMatchObject({
      failed: true,
      errorCode: 'ProviderError',
    });
    expect(fixture.sync.syncAsset).toHaveBeenCalledTimes(2);
  });

  it('checks recent canonical coverage for every active asset', async () => {
    const fixture = setup();
    fixture.prisma.asset.findMany.mockResolvedValue([
      cryptoAsset('asset-1'),
      cryptoAsset('asset-2'),
    ]);
    fixture.prisma.marketCandle.findMany.mockResolvedValue([
      { assetId: 'asset-1' },
      { assetId: 'asset-2' },
    ]);
    await expect(
      fixture.service.hasRecentCanonicalCoverage(
        'CRYPTO',
        new Date('2026-07-13T00:10:00.000Z'),
      ),
    ).resolves.toBe(true);
    expect(fixture.prisma.marketCandle.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          interval: '5m',
          isClosed: true,
          openTime: {
            gte: new Date('2026-07-13T00:05:00.000Z'),
            lt: new Date('2026-07-13T00:10:00.000Z'),
          },
        }),
      }),
    );
  });
});

function cryptoAsset(id = 'asset-1') {
  return {
    id,
    symbol: id === 'asset-1' ? 'BTC' : 'ETH',
    assetType: AssetType.crypto,
    market: 'BINANCE',
  };
}

function candle(
  input: {
    openMinute?: number;
    close?: string;
    sourceUpdatedAt?: string;
  } = {},
): MarketCandle {
  const minute = input.openMinute ?? 0;
  const openTime = new Date(
    `2026-07-13T00:${String(minute).padStart(2, '0')}:00.000Z`,
  );
  return {
    id: `candle-${minute}`,
    assetId: 'asset-1',
    interval: '5m',
    openTime,
    closeTime: new Date(openTime.getTime() + 300_000),
    open: new Prisma.Decimal('100'),
    high: new Prisma.Decimal('110'),
    low: new Prisma.Decimal('90'),
    close: new Prisma.Decimal(input.close ?? '100'),
    volume: new Prisma.Decimal('10'),
    amount: new Prisma.Decimal('1000'),
    isClosed: true,
    sourceProvider: 'binance_rest',
    sourceUpdatedAt: new Date(
      `2026-07-13T${input.sourceUpdatedAt ?? '00:04:00'}.000Z`,
    ),
    createdAt: openTime,
    updatedAt: openTime,
  };
}
