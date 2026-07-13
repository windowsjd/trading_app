jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
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
    );
    return {
      calls,
      store,
      repository,
      cache,
      locks,
      publisher,
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

  it('does not close an incomplete bucket and leaves it for reconciliation', async () => {
    const fixture = setup();
    await finalize(
      fixture.service,
      { ...state(), complete: false, sourceContinuity: false },
      new Date('2026-07-13T00:05:06Z'),
    );
    expect(fixture.repository.upsertMany).not.toHaveBeenCalled();
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
