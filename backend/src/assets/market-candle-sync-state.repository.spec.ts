jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { DbNull: Symbol('Prisma.DbNull') },
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
}));

import { Prisma } from '../generated/prisma/client';
import {
  ActiveMarketCandleSyncExistsError,
  MarketCandleSyncStateRepository,
} from './market-candle-sync-state.repository';

describe('MarketCandleSyncStateRepository', () => {
  const createRepository = () => {
    const delegate = {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    };
    const repository = new MarketCandleSyncStateRepository({
      marketCandleSyncState: delegate,
    } as never);
    return { repository, delegate };
  };

  const runInput = {
    assetId: 'asset-1',
    feed: '5m' as const,
    sourceProvider: 'binance_klines',
    mode: 'initial' as never,
    targetFrom: new Date('2026-06-01T00:00:00Z'),
    targetTo: new Date('2026-07-01T00:00:00Z'),
  };

  it('creates a running checkpoint row', async () => {
    const { repository, delegate } = createRepository();
    delegate.create.mockResolvedValue({ id: 'sync-1' });
    await repository.createRunning(runInput);
    expect(delegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        assetId: 'asset-1',
        feed: '5m',
        status: 'running',
      }),
    });
  });

  it('maps the partial-unique violation to ActiveMarketCandleSyncExistsError', async () => {
    const { repository, delegate } = createRepository();
    delegate.create.mockRejectedValue({ code: 'P2002' });
    await expect(repository.createRunning(runInput)).rejects.toBeInstanceOf(
      ActiveMarketCandleSyncExistsError,
    );
  });

  it('records page progress only while running, with additive counters', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    const recorded = await repository.recordPageSuccess('sync-1', {
      cursorJson: { startTime: 123 },
      pagesFetched: 1,
      providerRowsReceived: 100,
      rowsAccepted: 90,
      rowsRejected: 5,
      rowsDuplicated: 5,
      rowsWritten: 90,
      lastSuccessfulPageAt: new Date('2026-07-10T00:00:00Z'),
    });
    expect(recorded).toBe(true);
    const call = delegate.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'sync-1', status: 'running' });
    expect(call.data.cursorJson).toEqual({ startTime: 123 });
    expect(call.data.pagesFetched).toEqual({ increment: 1 });
    expect(call.data.rowsWritten).toEqual({ increment: 90 });
  });

  it('stores a null cursor as DbNull and refuses negative counters', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    await repository.recordPageSuccess('sync-1', {
      cursorJson: null,
      pagesFetched: 0,
      providerRowsReceived: 0,
      rowsAccepted: 0,
      rowsRejected: 0,
      rowsDuplicated: 0,
      rowsWritten: 0,
      lastSuccessfulPageAt: new Date(),
    });
    expect(delegate.updateMany.mock.calls[0][0].data.cursorJson).toBe(
      Prisma.DbNull,
    );
    await expect(
      repository.recordPageSuccess('sync-1', {
        cursorJson: null,
        pagesFetched: -1,
        providerRowsReceived: 0,
        rowsAccepted: 0,
        rowsRejected: 0,
        rowsDuplicated: 0,
        rowsWritten: 0,
        lastSuccessfulPageAt: new Date(),
      }),
    ).rejects.toThrow('non-negative');
  });

  it('reports a checkpoint conflict when the row is no longer running', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.recordPageSuccess('sync-1', {
        cursorJson: null,
        pagesFetched: 1,
        providerRowsReceived: 0,
        rowsAccepted: 0,
        rowsRejected: 0,
        rowsDuplicated: 0,
        rowsWritten: 0,
        lastSuccessfulPageAt: new Date(),
      }),
    ).resolves.toBe(false);
  });

  it('completes only running rows and never regresses completed rows', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    await repository.markCompleted('sync-1', new Date());
    expect(delegate.updateMany.mock.calls[0][0].where).toEqual({
      id: 'sync-1',
      status: 'running',
    });

    // markFailed / markCanceled exclude completed rows in their guards.
    await repository.markFailed('sync-1', {
      errorCode: 'X',
      errorMessage: null,
    });
    expect(delegate.updateMany.mock.calls[1][0].where.status.in).toEqual([
      'running',
      'pending',
    ]);
    await repository.markCanceled('sync-1', {
      errorCode: 'CANCELED',
      errorMessage: null,
    });
    expect(delegate.updateMany.mock.calls[2][0].where.status.in).toEqual([
      'running',
      'pending',
    ]);
  });

  it('resumes pending/running/failed/canceled rows but never completed ones', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    delegate.findUnique.mockResolvedValue({ id: 'sync-1', status: 'running' });
    const resumed = await repository.resumeRun('sync-1');
    expect(resumed).toEqual({ id: 'sync-1', status: 'running' });
    expect(delegate.updateMany.mock.calls[0][0].where.status.in).toEqual([
      'pending',
      'running',
      'failed',
      'canceled',
    ]);

    delegate.updateMany.mockResolvedValue({ count: 0 });
    await expect(repository.resumeRun('sync-done')).resolves.toBeNull();
  });

  it('finds resumable rows while skipping superseded ones', async () => {
    const { repository, delegate } = createRepository();
    delegate.findFirst.mockResolvedValue(null);
    await repository.findResumable('asset-1', '1d');
    const where = delegate.findFirst.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ errorCode: 'SUPERSEDED' });
    expect(where.status.in).toContain('failed');
  });

  it('cancels stale active runs with a SUPERSEDED marker', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 2 });
    const count = await repository.cancelActiveRuns('asset-1', '5m', 'reset');
    expect(count).toBe(2);
    const call = delegate.updateMany.mock.calls[0][0];
    expect(call.where.status.in).toEqual(['pending', 'running']);
    expect(call.data).toMatchObject({
      status: 'canceled',
      errorCode: 'SUPERSEDED',
    });
  });

  it('truncates long error messages', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    await repository.markFailed('sync-1', {
      errorCode: 'X',
      errorMessage: 'e'.repeat(600),
    });
    const stored = delegate.updateMany.mock.calls[0][0].data.errorMessage;
    expect(stored.length).toBeLessThanOrEqual(500);
  });
});
