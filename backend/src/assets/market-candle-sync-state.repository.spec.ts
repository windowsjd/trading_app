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
  MarketCandleSyncStateInvariantError,
  MarketCandleSyncStateRepository,
} from './market-candle-sync-state.repository';

// Typed accessor for jest mock call arguments: jest.fn() exposes `any`
// call tuples, so reads go through unknown before asserting the shape the
// test actually inspects.
const callArg = <T>(fn: jest.Mock, callIndex = 0): T => {
  const calls = fn.mock.calls as unknown[][];
  return calls[callIndex][0] as T;
};

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
      }) as unknown,
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
      coveredFrom: null,
      coveredTo: null,
      lastSuccessfulPageAt: new Date('2026-07-10T00:00:00Z'),
    });
    expect(recorded).toBe(true);
    const call = callArg<{ where: unknown; data: Record<string, unknown> }>(
      delegate.updateMany,
    );
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
      coveredFrom: null,
      coveredTo: null,
      lastSuccessfulPageAt: new Date(),
    });
    expect(
      callArg<{ data: Record<string, unknown> }>(delegate.updateMany).data
        .cursorJson,
    ).toBe(Prisma.DbNull);
    await expect(
      repository.recordPageSuccess('sync-1', {
        cursorJson: null,
        pagesFetched: -1,
        providerRowsReceived: 0,
        rowsAccepted: 0,
        rowsRejected: 0,
        rowsDuplicated: 0,
        rowsWritten: 0,
        coveredFrom: null,
        coveredTo: null,
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
        coveredFrom: null,
        coveredTo: null,
        lastSuccessfulPageAt: new Date(),
      }),
    ).resolves.toBe(false);
  });

  it('completes only running rows and never regresses completed rows', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    delegate.findUnique.mockResolvedValue({
      targetFrom: new Date('2026-06-01T00:00:00Z'),
      targetTo: new Date('2026-07-01T00:00:00Z'),
    });
    await repository.markCompleted('sync-1', new Date(), {
      coverageComplete: false,
      completionReason: 'provider_exhausted_before_target',
      coveredFrom: null,
      coveredTo: null,
      requiredCoveredTo: new Date('2026-07-01T00:00:00Z'),
    });
    expect(callArg<{ where: unknown }>(delegate.updateMany).where).toEqual({
      id: 'sync-1',
      status: 'running',
    });

    // markFailed / markCanceled exclude completed rows in their guards.
    await repository.markFailed('sync-1', {
      errorCode: 'X',
      errorMessage: null,
    });
    expect(
      callArg<{ where: { status: { in: string[] } } }>(delegate.updateMany, 1)
        .where.status.in,
    ).toEqual(['running', 'pending']);
    await repository.markCanceled('sync-1', {
      errorCode: 'CANCELED',
      errorMessage: null,
    });
    expect(
      callArg<{ where: { status: { in: string[] } } }>(delegate.updateMany, 2)
        .where.status.in,
    ).toEqual(['running', 'pending']);
  });

  it('resumes pending/running/failed/canceled rows but never completed ones', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    delegate.findUnique.mockResolvedValue({ id: 'sync-1', status: 'running' });
    const resumed = await repository.resumeRun('sync-1');
    expect(resumed).toEqual({ id: 'sync-1', status: 'running' });
    expect(
      callArg<{ where: { status: { in: string[] } } }>(delegate.updateMany)
        .where.status.in,
    ).toEqual(['pending', 'running', 'failed', 'canceled']);

    delegate.updateMany.mockResolvedValue({ count: 0 });
    await expect(repository.resumeRun('sync-done')).resolves.toBeNull();
  });

  it('finds resumable rows while skipping superseded ones', async () => {
    const { repository, delegate } = createRepository();
    delegate.findFirst.mockResolvedValue(null);
    await repository.findResumable('asset-1', '1d');
    const { where } = callArg<{
      where: { NOT: unknown; status: { in: string[] } };
    }>(delegate.findFirst);
    expect(where.NOT).toEqual({ errorCode: 'SUPERSEDED' });
    expect(where.status.in).toContain('failed');
  });

  it('cancels stale active runs with a SUPERSEDED marker', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 2 });
    const count = await repository.cancelActiveRuns('asset-1', '5m', 'reset');
    expect(count).toBe(2);
    const call = callArg<{
      where: { status: { in: string[] } };
      data: unknown;
    }>(delegate.updateMany);
    expect(call.where.status.in).toEqual(['pending', 'running']);
    expect(call.data).toMatchObject({
      status: 'canceled',
      errorCode: 'SUPERSEDED',
    });
  });

  describe('markCompleted coverage invariant', () => {
    const targetFrom = new Date('2026-06-01T00:00:00Z');
    const targetTo = new Date('2026-07-01T00:00:00Z');
    const setup = () => {
      const { repository, delegate } = createRepository();
      delegate.updateMany.mockResolvedValue({ count: 1 });
      delegate.findUnique.mockResolvedValue({ targetFrom, targetTo });
      return { repository, delegate };
    };

    it('persists a spanning coverageComplete claim (target_reached)', async () => {
      const { repository, delegate } = setup();
      await repository.markCompleted('sync-1', new Date(), {
        coverageComplete: true,
        completionReason: 'target_reached',
        coveredFrom: targetFrom,
        coveredTo: targetTo,
        requiredCoveredTo: targetTo,
      });
      expect(
        callArg<{ data: unknown }>(delegate.updateMany).data,
      ).toMatchObject({
        status: 'completed',
        coverageComplete: true,
        completionReason: 'target_reached',
      });
    });

    it('persists a confirmed_empty claim spanning the required range', async () => {
      const { repository, delegate } = setup();
      await repository.markCompleted('sync-1', new Date(), {
        coverageComplete: true,
        completionReason: 'confirmed_empty',
        coveredFrom: targetFrom,
        coveredTo: targetTo,
        requiredCoveredTo: targetTo,
      });
      expect(
        callArg<{ data: unknown }>(delegate.updateMany).data,
      ).toMatchObject({
        coverageComplete: true,
        completionReason: 'confirmed_empty',
      });
    });

    it('rejects coveredFrom later than targetFrom', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: new Date('2026-06-15T00:00:00Z'),
          coveredTo: targetTo,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow(MarketCandleSyncStateInvariantError);
    });

    it('rejects coveredTo earlier than requiredCoveredTo', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: new Date('2026-06-20T00:00:00Z'),
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('coveredTo must reach requiredCoveredTo');
    });

    it('accepts coveredTo exactly equal to requiredCoveredTo', async () => {
      const { repository, delegate } = setup();
      const requiredCoveredTo = new Date('2026-06-20T00:00:00Z');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: requiredCoveredTo,
          requiredCoveredTo,
        }),
      ).resolves.toBe(true);
      expect(delegate.updateMany).toHaveBeenCalledTimes(1);
    });

    it('validates only up to now when targetTo lies in the future', async () => {
      // requiredCoveredTo = min(targetTo, now): a run whose target extends
      // past `now` is complete once everything up to now is confirmed.
      const { repository } = setup();
      const now = new Date('2026-06-25T00:00:00Z');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: now,
          requiredCoveredTo: now,
        }),
      ).resolves.toBe(true);
    });

    it('rejects a requiredCoveredTo outside [targetFrom, targetTo] or invalid', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: targetTo,
          requiredCoveredTo: new Date('2026-05-01T00:00:00Z'),
        }),
      ).rejects.toThrow('must not precede targetFrom');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: new Date('2026-08-01T00:00:00Z'),
          requiredCoveredTo: new Date('2026-08-01T00:00:00Z'),
        }),
      ).rejects.toThrow('must not exceed targetTo');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'target_reached',
          coveredFrom: targetFrom,
          coveredTo: targetTo,
          requiredCoveredTo: new Date('invalid'),
        }),
      ).rejects.toThrow('valid requiredCoveredTo');
    });

    it('rejects a null covered range with coverageComplete=true', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'confirmed_empty',
          coveredFrom: null,
          coveredTo: null,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('covered range');
    });

    it('rejects reason/coverage mismatches in both directions', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'provider_exhausted_before_target',
          coveredFrom: targetFrom,
          coveredTo: targetTo,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('does not allow completionReason');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'target_reached',
          coveredFrom: null,
          coveredTo: null,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('does not allow completionReason');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'confirmed_empty',
          coveredFrom: null,
          coveredTo: null,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('does not allow completionReason');
    });

    it('rejects a one-sided or malformed covered range with coverageComplete=false', async () => {
      const { repository } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'provider_exhausted_before_target',
          coveredFrom: new Date('2026-06-10T00:00:00Z'),
          coveredTo: null,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('both coveredFrom and coveredTo');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'provider_exhausted_before_target',
          coveredFrom: null,
          coveredTo: new Date('2026-06-10T00:00:00Z'),
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('both coveredFrom and coveredTo');
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'provider_exhausted_before_target',
          coveredFrom: new Date('2026-06-11T00:00:00Z'),
          coveredTo: new Date('2026-06-10T00:00:00Z'),
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('coveredFrom < coveredTo');
    });

    it('accepts data_incomplete only as an incomplete-coverage reason', async () => {
      const { repository, delegate } = setup();
      // A sweep that reached its target with incomplete stored data is a
      // valid incomplete completion...
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'data_incomplete',
          coveredFrom: null,
          coveredTo: null,
          requiredCoveredTo: targetTo,
        }),
      ).resolves.toBe(true);
      const [updateInput] = delegate.updateMany.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(updateInput.data).toMatchObject({
        coverageComplete: false,
        completionReason: 'data_incomplete',
      });
      // ...and can never be persisted as coverage-complete.
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: true,
          completionReason: 'data_incomplete',
          coveredFrom: targetFrom,
          coveredTo: targetTo,
          requiredCoveredTo: targetTo,
        }),
      ).rejects.toThrow('does not allow completionReason');
    });

    it('accepts an incomplete run with a well-formed partial covered range', async () => {
      const { repository, delegate } = setup();
      await expect(
        repository.markCompleted('sync-1', new Date(), {
          coverageComplete: false,
          completionReason: 'provider_exhausted_before_target',
          coveredFrom: new Date('2026-06-15T00:00:00Z'),
          coveredTo: targetTo,
          requiredCoveredTo: targetTo,
        }),
      ).resolves.toBe(true);
      expect(
        callArg<{ data: unknown }>(delegate.updateMany).data,
      ).toMatchObject({
        coverageComplete: false,
        completionReason: 'provider_exhausted_before_target',
      });
    });
  });

  it('records accumulated covered range with page progress', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    await repository.recordPageSuccess('sync-1', {
      cursorJson: { startTime: 456 },
      pagesFetched: 1,
      providerRowsReceived: 10,
      rowsAccepted: 10,
      rowsRejected: 0,
      rowsDuplicated: 0,
      rowsWritten: 10,
      lastSuccessfulPageAt: new Date('2026-07-10T00:00:00Z'),
      coveredFrom: new Date('2026-07-01T00:00:00Z'),
      coveredTo: new Date('2026-07-05T00:00:00Z'),
    });
    expect(callArg<{ data: unknown }>(delegate.updateMany).data).toMatchObject({
      coveredFrom: new Date('2026-07-01T00:00:00Z'),
      coveredTo: new Date('2026-07-05T00:00:00Z'),
    });
  });

  it('only accepts coverage-complete checkpoints spanning the range as covering', async () => {
    const { repository, delegate } = createRepository();
    delegate.findFirst.mockResolvedValue(null);
    await repository.findCompletedCovering(
      'asset-1',
      '5m',
      new Date('2026-07-01T00:00:00Z'),
      new Date('2026-07-02T00:00:00Z'),
    );
    const { where } = callArg<{
      where: Record<string, unknown>;
    }>(delegate.findFirst);
    expect(where.status).toBe('completed');
    expect(where.coverageComplete).toBe(true);
    expect(where.coveredFrom).toEqual({
      not: null,
      lte: new Date('2026-07-01T00:00:00Z'),
    });
    expect(where.coveredTo).toEqual({
      not: null,
      gte: new Date('2026-07-02T00:00:00Z'),
    });
    expect(where.completedAt).toEqual({ not: null });
  });

  it('truncates long error messages', async () => {
    const { repository, delegate } = createRepository();
    delegate.updateMany.mockResolvedValue({ count: 1 });
    await repository.markFailed('sync-1', {
      errorCode: 'X',
      errorMessage: 'e'.repeat(600),
    });
    const stored = callArg<{ data: { errorMessage: string } }>(
      delegate.updateMany,
    ).data.errorMessage;
    expect(stored.length).toBeLessThanOrEqual(500);
  });
});
