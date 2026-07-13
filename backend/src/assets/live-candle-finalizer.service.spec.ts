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
      pending: 'pending',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    },
    Prisma: { Decimal },
  };
});

import { AssetType } from '../generated/prisma/client';
import { readLiveCandleConfig } from './live-candle.config';
import { LiveCandleFinalizerService } from './live-candle-finalizer.service';
import { LiveCandleHealthService } from './live-candle-health.service';
import type { LiveFiveMinuteCandleState } from './live-candle.types';

describe('LiveCandleFinalizerService', () => {
  const setup = () => {
    const calls: string[] = [];
    const store = {
      getDueStateKeys: jest.fn().mockResolvedValue([]),
      removeFromFinalizeIndex: jest.fn(async () => calls.push('remove')),
      markFinalized: jest.fn(async ({ revision }) => {
        calls.push('mark');
        return { ...state(), revision: revision + 1, finalized: true };
      }),
      markFinalizedTakeover: jest.fn(async ({ revision }) => {
        calls.push('takeover');
        return { ...state(), revision: revision + 1, finalized: true };
      }),
      enqueueReconcilePending: jest.fn(async () => calls.push('enqueue')),
      getDueReconcilePending: jest.fn().mockResolvedValue([]),
      resolveReconcilePending: jest.fn(async () => calls.push('resolve')),
      deferReconcilePending: jest.fn(async () => calls.push('defer')),
      discardReconciledCurrent: jest.fn(async () => {
        calls.push('discard');
        return true;
      }),
    };
    const repository = {
      upsertMany: jest.fn(async () => {
        calls.push('db');
        return { writtenCount: 1 };
      }),
      findRange: jest.fn().mockResolvedValue([]),
    };
    const cache = {
      invalidateAsset: jest.fn(async () => {
        calls.push('invalidate');
        return { status: 'invalidated' };
      }),
    };
    const redis = { get: jest.fn().mockResolvedValue('owner-1') };
    const locks = {
      acquire: jest.fn().mockResolvedValue({
        status: 'acquired',
        lock: { key: 'finalizer', token: 'finalizer-1', ttlMs: 30_000 },
      }),
      extend: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(true),
    };
    const publisher = {
      publishState: jest.fn(async () => {
        calls.push('publish');
        return [];
      }),
    };
    const sync = { syncAsset: jest.fn(async () => ({ feeds: [] })) };
    const health = new LiveCandleHealthService();
    const service = new LiveCandleFinalizerService(
      store as never,
      repository as never,
      cache as never,
      redis as never,
      locks as never,
      publisher as never,
      health,
      readLiveCandleConfig({}),
      sync as never,
    );
    return {
      calls,
      store,
      repository,
      cache,
      redis,
      locks,
      publisher,
      sync,
      health,
      service,
    };
  };

  it('allows only the distributed finalizer lease owner to scan due buckets', async () => {
    const fixture = setup();
    await fixture.service.runOnce(new Date('2026-07-13T00:05:06Z'));
    expect(fixture.locks.acquire).toHaveBeenCalledWith(
      'candles:live:v1:finalizer-owner',
      30_000,
    );
    expect(fixture.locks.release).toHaveBeenCalledTimes(1);

    fixture.locks.acquire.mockResolvedValueOnce({ status: 'busy' });
    await fixture.service.runOnce(new Date('2026-07-13T00:05:07Z'));
    expect(fixture.store.getDueStateKeys).toHaveBeenCalledTimes(1);
  });

  it('commits DB before cache invalidation and final event publication', async () => {
    const fixture = setup();
    await finalize(fixture.service, state(), new Date('2026-07-13T00:05:06Z'));
    expect(fixture.repository.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({ interval: '5m', isClosed: true }),
    ]);
    expect(fixture.calls).toEqual(['db', 'invalidate', 'mark', 'publish']);
    expect(fixture.health.snapshot().liveCandle.finalizeSuccess).toBe(1);
  });

  it('queues an incomplete bucket for REST repair instead of closing it', async () => {
    const fixture = setup();
    await finalize(
      fixture.service,
      { ...state(), complete: false, sourceContinuity: false },
      new Date('2026-07-13T00:05:06Z'),
    );
    expect(fixture.repository.upsertMany).not.toHaveBeenCalled();
    expect(fixture.store.enqueueReconcilePending).toHaveBeenCalledWith(
      'asset-1',
      new Date('2026-07-13T00:00:00.000Z'),
      new Date('2026-07-13T00:05:06Z'),
    );
    expect(fixture.store.removeFromFinalizeIndex).toHaveBeenCalledWith(
      'state-key',
    );
  });

  it('rejects malformed OHLCV state before any database write', async () => {
    const fixture = setup();
    await finalize(
      fixture.service,
      { ...state(), high: '80.00000000' },
      new Date('2026-07-13T00:05:06Z'),
    );
    expect(fixture.repository.upsertMany).not.toHaveBeenCalled();
    expect(fixture.store.removeFromFinalizeIndex).toHaveBeenCalledWith(
      'state-key',
    );
  });

  it('retains Redis state/index for retry when the DB write fails', async () => {
    const fixture = setup();
    fixture.repository.upsertMany.mockRejectedValueOnce(new Error('db down'));
    await finalize(fixture.service, state(), new Date('2026-07-13T00:05:06Z'));
    expect(fixture.store.removeFromFinalizeIndex).not.toHaveBeenCalled();
    expect(fixture.store.markFinalized).not.toHaveBeenCalled();
    expect(fixture.health.snapshot().liveCandle.finalizeFailure).toBe(1);
  });

  describe('old-generation recovery', () => {
    it('finalizes a provider-final bucket after the owner generation is gone', async () => {
      const fixture = setup();
      fixture.redis.get.mockResolvedValue('owner-2'); // lease taken over
      await finalize(fixture.service, state(), new Date('2026-07-13T00:05:06Z'));
      expect(fixture.calls).toEqual(['db', 'invalidate', 'takeover', 'publish']);
      expect(fixture.store.markFinalizedTakeover).toHaveBeenCalledWith({
        stateKey: 'state-key',
        providerLeaseKey: 'candles:live:v1:owner:binance:0',
        revision: 5,
      });
      expect(fixture.store.markFinalized).not.toHaveBeenCalled();
    });

    it('finalizes a provider-final bucket when no lease exists at all', async () => {
      const fixture = setup();
      fixture.redis.get.mockResolvedValue(null);
      await finalize(fixture.service, state(), new Date('2026-07-13T00:05:06Z'));
      expect(fixture.store.markFinalizedTakeover).toHaveBeenCalled();
      expect(fixture.health.snapshot().liveCandle.finalizeSuccess).toBe(1);
    });

    it('never directly closes an old-generation KIS delta bucket; it goes to repair', async () => {
      const fixture = setup();
      fixture.redis.get.mockResolvedValue('owner-2');
      await finalize(
        fixture.service,
        {
          ...state(),
          providerFinal: false,
          sourceProvider: 'kis_domestic_ws_trade',
        },
        new Date('2026-07-13T00:05:06Z'),
      );
      expect(fixture.repository.upsertMany).not.toHaveBeenCalled();
      expect(fixture.store.enqueueReconcilePending).toHaveBeenCalled();
      expect(fixture.store.removeFromFinalizeIndex).toHaveBeenCalledWith(
        'state-key',
      );
    });

    it('only cleans up when a canonical closed row already exists', async () => {
      const fixture = setup();
      fixture.redis.get.mockResolvedValue('owner-2');
      fixture.repository.findRange.mockResolvedValue([
        {
          openTime: new Date('2026-07-13T00:00:00.000Z'),
          isClosed: true,
        },
      ]);
      await finalize(
        fixture.service,
        { ...state(), providerFinal: false },
        new Date('2026-07-13T00:05:06Z'),
      );
      expect(fixture.store.enqueueReconcilePending).not.toHaveBeenCalled();
      expect(fixture.store.removeFromFinalizeIndex).toHaveBeenCalled();
      expect(fixture.store.discardReconciledCurrent).toHaveBeenCalledWith(
        'asset-1',
        new Date('2026-07-13T00:00:00.000Z'),
      );
    });

    it('repairs due queued buckets through bounded REST sync and resolves them', async () => {
      const fixture = setup();
      fixture.store.getDueReconcilePending.mockResolvedValue([
        {
          member: 'asset-1|1783987200000',
          assetId: 'asset-1',
          openTime: new Date('2026-07-13T00:00:00.000Z'),
        },
      ]);
      fixture.repository.findRange.mockResolvedValue([
        { openTime: new Date('2026-07-13T00:00:00.000Z'), isClosed: true },
      ]);
      await fixture.service.runOnce(new Date('2026-07-13T00:06:00Z'));
      expect(fixture.sync.syncAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: 'asset-1',
          targets: ['5m'],
          mode: 'repair',
          from: new Date('2026-07-13T00:00:00.000Z'),
          to: new Date('2026-07-13T00:05:00.000Z'),
        }),
      );
      expect(fixture.store.resolveReconcilePending).toHaveBeenCalledWith(
        'asset-1|1783987200000',
      );
      expect(fixture.store.discardReconciledCurrent).toHaveBeenCalled();
      expect(
        fixture.health.snapshot().liveCandle.recoveryRepairSuccess,
      ).toBe(1);
    });

    it('re-schedules a failed repair with backoff and keeps the queue entry', async () => {
      const fixture = setup();
      fixture.store.getDueReconcilePending.mockResolvedValue([
        {
          member: 'asset-1|1783987200000',
          assetId: 'asset-1',
          openTime: new Date('2026-07-13T00:00:00.000Z'),
        },
      ]);
      fixture.sync.syncAsset.mockRejectedValue(new Error('provider down'));
      await fixture.service.runOnce(new Date('2026-07-13T00:06:00Z'));
      expect(fixture.store.resolveReconcilePending).not.toHaveBeenCalled();
      expect(fixture.store.deferReconcilePending).toHaveBeenCalled();
      expect(
        fixture.health.snapshot().liveCandle.recoveryRepairFailure,
      ).toBe(1);
    });

    it('drops queue entries whose repair can never succeed (validation errors)', async () => {
      const fixture = setup();
      fixture.store.getDueReconcilePending.mockResolvedValue([
        {
          member: 'gone-asset|1783987200000',
          assetId: 'gone-asset',
          openTime: new Date('2026-07-13T00:00:00.000Z'),
        },
      ]);
      const missing = new Error('Asset gone-asset does not exist.');
      missing.name = 'MarketCandleSyncInputError';
      fixture.sync.syncAsset.mockRejectedValue(missing);
      await fixture.service.runOnce(new Date('2026-07-13T00:06:00Z'));
      expect(fixture.store.deferReconcilePending).not.toHaveBeenCalled();
      expect(fixture.store.resolveReconcilePending).toHaveBeenCalledWith(
        'gone-asset|1783987200000',
      );
    });
  });
});

async function finalize(
  service: LiveCandleFinalizerService,
  candle: LiveFiveMinuteCandleState,
  now: Date,
) {
  await (
    service as unknown as {
      finalizeOne(
        key: string,
        state: LiveFiveMinuteCandleState,
        now: Date,
      ): Promise<void>;
    }
  ).finalizeOne('state-key', candle, now);
}

function state(): LiveFiveMinuteCandleState {
  return {
    schemaVersion: 1,
    assetId: 'asset-1',
    assetType: AssetType.crypto,
    market: 'BINANCE',
    symbol: 'BTC',
    interval: '5m',
    openTime: '2026-07-13T00:00:00.000Z',
    closeTime: '2026-07-13T00:05:00.000Z',
    open: '100.00000000',
    high: '110.00000000',
    low: '90.00000000',
    close: '105.00000000',
    volume: '10.00000000',
    amount: '1050.00000000',
    firstEventAt: '2026-07-13T00:00:01.000Z',
    lastEventAt: '2026-07-13T00:04:59.000Z',
    sourceUpdatedAt: '2026-07-13T00:04:59.000Z',
    baselineEventTime: null,
    eventCount: 12,
    revision: 5,
    provisional: true,
    complete: true,
    finalized: false,
    providerFinal: true,
    sourceContinuity: true,
    sourceProvider: 'binance_spot_ws_5m_kline',
    delayed: false,
    ownerGeneration: 'owner-1',
    lastSequence: '5',
  };
}
