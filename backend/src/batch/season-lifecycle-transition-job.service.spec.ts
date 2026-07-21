jest.mock('../generated/prisma/client', () => ({
  BatchJobStatus: {
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
  },
  Prisma: {},
  PrismaClient: class PrismaClient {},
  SeasonStatus: {
    upcoming: 'upcoming',
    active: 'active',
    ended: 'ended',
    settled: 'settled',
  },
}));

import { HttpException } from '@nestjs/common';
import { SeasonStatus } from '../generated/prisma/client';
import { SeasonLifecycleTransitionJobService } from './season-lifecycle-transition-job.service';
import { SEASON_LIFECYCLE_TRANSITION_JOB_NAME } from './season-lifecycle-transition-job.types';

describe('SeasonLifecycleTransitionJobService', () => {
  const now = new Date('2026-06-08T00:00:00.000Z');

  const createService = () => {
    const prisma = {
      season: {
        findMany: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    const batchService = {
      runJob: jest.fn(async (params) => ({
        success: true,
        data: {
          run: {
            id: 'run-1',
            resultPayloadJson: await params.handler({
              runId: 'run-1',
              jobName: params.jobName,
              idempotencyKey: params.idempotencyKey,
              dryRun: params.dryRun === true,
              startedAt: now,
            }),
          },
          deduplicated: false,
          skipped: false,
        },
      })),
    };
    const service = new SeasonLifecycleTransitionJobService(
      batchService as never,
      prisma as never,
    );

    return { batchService, prisma, service };
  };

  it('dry-runs upcoming to active transition', async () => {
    const { batchService, prisma, service } = createService();
    prisma.season.findMany.mockResolvedValueOnce([
      season('season-upcoming', SeasonStatus.upcoming, {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-06-14T14:59:00.000Z',
      }),
    ]);

    const response = await service.run({
      now: now.toISOString(),
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: SEASON_LIFECYCLE_TRANSITION_JOB_NAME,
        idempotencyKey: `${SEASON_LIFECYCLE_TRANSITION_JOB_NAME}:${now.toISOString()}`,
        dryRun: true,
        requestedBy: 'operator',
      }),
    );
    expect(response.data.run.resultPayloadJson).toMatchObject({
      dryRun: true,
      summary: {
        scanned: 1,
        wouldActivate: 1,
        activated: 0,
      },
      activatedSeasonIds: ['season-upcoming'],
    });
    expect(prisma.season.updateMany).not.toHaveBeenCalled();
  });

  it('activates a due upcoming season and ends expired active seasons', async () => {
    const { prisma, service } = createService();
    prisma.season.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      season('season-ended', SeasonStatus.active, {
        startAt: '2026-05-18T00:00:00.000Z',
        endAt: '2026-06-01T00:00:00.000Z',
      }),
      season('season-upcoming', SeasonStatus.upcoming, {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-06-14T14:59:00.000Z',
      }),
    ]);
    prisma.season.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    const response = await service.run({
      now: now.toISOString(),
      idempotencyKey: 'manual-key',
    });

    expect(response.data.run.resultPayloadJson).toMatchObject({
      summary: {
        ended: 1,
        activated: 1,
      },
      endedSeasonIds: ['season-ended'],
      activatedSeasonIds: ['season-upcoming'],
    });
    expect(prisma.season.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: {
          status: SeasonStatus.ended,
        },
      }),
    );
    expect(prisma.season.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: {
          status: SeasonStatus.active,
        },
      }),
    );
  });

  it('runs the limit-order season-end cleanup after the transition and reports the count', async () => {
    const { batchService, prisma } = createService();
    const limitOrderCancelService = {
      cleanupEndedSeasonLimitReservations: jest.fn().mockResolvedValue({
        canceledOrderCount: 3,
        releasedReservationCount: 3,
      }),
    };
    const service = new SeasonLifecycleTransitionJobService(
      batchService as never,
      prisma as never,
      limitOrderCancelService as never,
    );
    prisma.season.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      season('season-ended', SeasonStatus.active, {
        startAt: '2026-05-18T00:00:00.000Z',
        endAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    prisma.season.updateMany.mockResolvedValueOnce({ count: 1 });

    const response = await service.run({
      now: now.toISOString(),
      idempotencyKey: 'cleanup-key',
    });

    expect(
      limitOrderCancelService.cleanupEndedSeasonLimitReservations,
    ).toHaveBeenCalledWith({ now });
    expect(response.data.run.resultPayloadJson).toMatchObject({
      summary: {
        ended: 1,
        limitOrdersCanceled: 3,
      },
    });
  });

  it('runs the cleanup even when no transition happened (self-healing)', async () => {
    const { batchService, prisma } = createService();
    const limitOrderCancelService = {
      cleanupEndedSeasonLimitReservations: jest.fn().mockResolvedValue({
        canceledOrderCount: 1,
        releasedReservationCount: 1,
      }),
    };
    const service = new SeasonLifecycleTransitionJobService(
      batchService as never,
      prisma as never,
      limitOrderCancelService as never,
    );
    prisma.season.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const response = await service.run({
      now: now.toISOString(),
      idempotencyKey: 'cleanup-key-2',
    });

    expect(
      limitOrderCancelService.cleanupEndedSeasonLimitReservations,
    ).toHaveBeenCalledTimes(1);
    expect(response.data.run.resultPayloadJson).toMatchObject({
      summary: {
        ended: 0,
        limitOrdersCanceled: 1,
      },
    });
  });

  it('blocks duplicate active seasons', async () => {
    const { prisma, service } = createService();
    prisma.season.findMany.mockResolvedValueOnce([
      season('active-1', SeasonStatus.active),
      season('active-2', SeasonStatus.active),
    ]);

    await expect(
      service.run({
        now: now.toISOString(),
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('blocks activating due upcoming season when a future active season already exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findMany.mockResolvedValueOnce([
      season('future-active', SeasonStatus.active, {
        startAt: '2026-06-15T00:00:00.000Z',
        endAt: '2026-06-30T00:00:00.000Z',
      }),
      season('due-upcoming', SeasonStatus.upcoming),
    ]);

    await expect(
      service.run({
        now: now.toISOString(),
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.season.updateMany).not.toHaveBeenCalled();
  });
});

function season(
  id: string,
  status: SeasonStatus,
  overrides: Partial<{
    startAt: string;
    endAt: string;
  }> = {},
) {
  return {
    id,
    status,
    startAt: new Date(overrides.startAt ?? '2026-06-01T00:00:00.000Z'),
    endAt: new Date(overrides.endAt ?? '2026-06-14T14:59:00.000Z'),
  };
}
