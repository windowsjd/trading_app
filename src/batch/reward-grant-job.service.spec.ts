jest.mock('../generated/prisma/client', () => ({
  BatchJobStatus: {
    pending: 'pending',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
  },
  Prisma: {
    JsonNull: null,
  },
  PrismaClient: class PrismaClient {},
  SeasonStatus: {
    upcoming: 'upcoming',
    active: 'active',
    ended: 'ended',
    settled: 'settled',
  },
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { SeasonStatus } from '../generated/prisma/client';
import { RewardGrantJobService } from './reward-grant-job.service';
import {
  REWARD_GRANT_JOB_NAME,
  RewardGrantJobResult,
} from './reward-grant-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type PrismaMock = ReturnType<typeof createPrismaMock>;

const BATCH_STARTED_AT = new Date('2026-05-22T01:02:03.000Z');

describe('RewardGrantJobService', () => {
  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [participant('sp-1', 'user-1', 1, 'master')]);

    await service.run({
      seasonId: 'season-1',
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: REWARD_GRANT_JOB_NAME,
        idempotencyKey: 'reward-grant:season-1',
        dryRun: true,
        requestedBy: 'operator',
        requestPayload: {
          seasonId: 'season-1',
          grantDate: null,
          dryRun: true,
          requestedBy: 'operator',
          idempotencyKey: 'reward-grant:season-1',
        },
      }),
    );
  });

  it('uses grantDate in the generated idempotencyKey when provided', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [participant('sp-1', 'user-1', 1, 'master')]);

    await service.run({
      seasonId: 'season-1',
      grantDate: '2026-05-22',
      dryRun: true,
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'reward-grant:season-1:2026-05-22',
        requestPayload: expect.objectContaining({
          grantDate: '2026-05-22',
          idempotencyKey: 'reward-grant:season-1:2026-05-22',
        }),
      }),
    );
  });

  it('keeps an explicit idempotencyKey when provided', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [participant('sp-1', 'user-1', 1, 'master')]);

    await service.run({
      seasonId: 'season-1',
      dryRun: true,
      idempotencyKey: 'manual-key',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-key',
      }),
    );
  });

  it('returns wouldGrant in dry-run without updating rewardGrantedAt', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled, { summary: 'tier only' });
    mockParticipants(prisma, [
      participant('sp-1', 'user-1', 1, 'master'),
      participant('sp-existing', 'user-2', 2, 'diamond', {
        rewardGrantedAt: new Date('2026-05-21T00:00:00.000Z'),
      }),
      participant('sp-no-rank', 'user-3', null, 'gold'),
      participant('sp-no-tier', 'user-4', 4, null),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      seasonId: 'season-1',
      dryRun: true,
      grantTimestamp: '2026-05-22T01:02:03.000Z',
      grantDate: null,
      policy: {
        source: 'reward_marker_mvp',
        rewardPolicyJsonAvailable: true,
      },
      participants: {
        total: 4,
        eligible: 1,
        wouldGrant: 1,
        granted: 0,
        existing: 1,
        ineligible: 2,
        skipped: 3,
      },
      grantedParticipantIds: [],
    });
    expect(result.topGranted).toEqual([
      {
        seasonParticipantId: 'sp-1',
        userId: 'user-1',
        finalRank: 1,
        finalTier: 'master',
        rewardGrantedAt: '2026-05-22T01:02:03.000Z',
      },
    ]);
  });

  it('updates eligible settled participants with one rewardGrantedAt timestamp in a transaction', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [
      participant('sp-2', 'user-2', 2, 'diamond'),
      participant('sp-1', 'user-1', 1, 'master'),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      grantDate: '2026-05-22',
    });

    const grantTimestamp = new Date('2026-05-22T00:00:00.000Z');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          id: 'sp-1',
          seasonId: 'season-1',
          finalRank: 1,
          finalTier: 'master',
          rewardGrantedAt: null,
        },
        data: {
          rewardGrantedAt: grantTimestamp,
        },
      },
    );
    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: {
          id: 'sp-2',
          seasonId: 'season-1',
          finalRank: 2,
          finalTier: 'diamond',
          rewardGrantedAt: null,
        },
        data: {
          rewardGrantedAt: grantTimestamp,
        },
      },
    );
    expect(result).toMatchObject({
      grantTimestamp: '2026-05-22T00:00:00.000Z',
      grantDate: '2026-05-22',
      participants: {
        eligible: 2,
        wouldGrant: 2,
        granted: 2,
      },
      grantedParticipantIds: ['sp-1', 'sp-2'],
    });
    expect(new Set(updateTimestamps(prisma))).toEqual(
      new Set(['2026-05-22T00:00:00.000Z']),
    );
  });

  it('classifies finalRank/finalTier missing participants as ineligible and skipped', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [
      participant('sp-final', 'user-1', 1, 'master'),
      participant('sp-no-rank', 'user-2', null, 'gold'),
      participant('sp-no-tier', 'user-3', 3, null),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      dryRun: true,
    });

    expect(result.participants).toMatchObject({
      total: 3,
      eligible: 1,
      existing: 0,
      ineligible: 2,
      skipped: 2,
    });
  });

  it('treats existing rewardGrantedAt as existing/skipped and does not overwrite it', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [
      participant('sp-existing', 'user-1', 1, 'master', {
        rewardGrantedAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      participant('sp-new', 'user-2', 2, 'diamond'),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
    });

    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'sp-new',
        }),
      }),
    );
    expect(result.participants).toEqual({
      total: 2,
      eligible: 1,
      wouldGrant: 1,
      granted: 1,
      existing: 1,
      ineligible: 0,
      skipped: 1,
    });
    expect(result.grantedParticipantIds).toEqual(['sp-new']);
  });

  it('succeeds when all final-assigned participants are already granted', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [
      participant('sp-1', 'user-1', 1, 'master', {
        rewardGrantedAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      participant('sp-2', 'user-2', 2, 'diamond', {
        rewardGrantedAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result.participants).toEqual({
      total: 2,
      eligible: 0,
      wouldGrant: 0,
      granted: 0,
      existing: 2,
      ineligible: 0,
      skipped: 2,
    });
    expect(result.grantedParticipantIds).toEqual([]);
    expect(result.topGranted).toEqual([]);
  });

  it('fails when no participant has both finalRank and finalTier', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [
      participant('sp-no-rank', 'user-1', null, 'gold'),
      participant('sp-no-tier', 'user-2', 2, null),
    ]);

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
      }),
    );

    expect(response.error.code).toBe('FINAL_TIER_ASSIGNMENT_REQUIRED');
    expect(response.data.resultPayloadJson).toMatchObject({
      reason: 'FINAL_TIER_ASSIGNMENT_REQUIRED',
      participants: {
        total: 2,
        eligible: 0,
        ineligible: 2,
        skipped: 2,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('treats missing season as a job-level error inside the batch envelope', async () => {
    const { service, batchService, prisma } = createService();
    prisma.season.findUnique.mockResolvedValue(null);

    await expect(
      service.run({
        seasonId: 'missing-season',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(batchService.runJob).toHaveBeenCalled();
  });

  it.each([
    [SeasonStatus.active, 'SEASON_STATUS_NOT_ALLOWED'],
    [SeasonStatus.upcoming, 'SEASON_STATUS_NOT_ALLOWED'],
    [SeasonStatus.ended, 'SETTLEMENT_REQUIRED'],
  ])('rejects %s seasons at job level', async (status, code) => {
    const { service, prisma } = createService();
    mockSeason(prisma, status);

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
      }),
    );

    expect(response.error.code).toBe(code);
    expect(prisma.seasonParticipant.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid grantDate as BAD_REQUEST', async () => {
    const { service } = createService();

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        grantDate: '2026-02-31',
      }),
    );

    expect(response.error.code).toBe('BAD_REQUEST');
  });

  it('does not create payment/badge/trophy/reward rows or unrelated business rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [participant('sp-1', 'user-1', 1, 'master')]);

    await service.run({
      seasonId: 'season-1',
    });

    expect(prisma.season.update).not.toHaveBeenCalled();
    expect(prisma.season.updateMany).not.toHaveBeenCalled();
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.upsert).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.deleteMany).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.update).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.upsert).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.reward.create).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.badge.create).not.toHaveBeenCalled();
    expect(prisma.trophy.create).not.toHaveBeenCalled();
  });

  it('updates only rewardGrantedAt and never updates finalRank/finalTier', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [participant('sp-1', 'user-1', 1, 'master')]);

    await service.run({
      seasonId: 'season-1',
    });

    expect(
      prisma.__tx.seasonParticipant.updateMany.mock.calls[0][0].data,
    ).toEqual({
      rewardGrantedAt: BATCH_STARTED_AT,
    });
    expect(
      prisma.__tx.seasonParticipant.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty('finalRank');
    expect(
      prisma.__tx.seasonParticipant.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty('finalTier');
  });

  it('caps topGranted at 10 rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(
      prisma,
      Array.from({ length: 12 }, (_, index) =>
        participant(
          `sp-${index + 1}`,
          `user-${index + 1}`,
          index + 1,
          'bronze',
        ),
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      dryRun: true,
    });

    expect(result.topGranted).toHaveLength(10);
  });
});

function createService() {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new RewardGrantJobService(
    batchService as never,
    prisma as never,
  );

  return {
    service,
    prisma,
    batchService,
  };
}

function createPrismaMock() {
  const tx = {
    seasonParticipant: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return {
    __tx: tx,
    $transaction: jest.fn(async (callback) => callback(tx)),
    season: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    seasonParticipant: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    seasonRanking: {
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    asset: {
      create: jest.fn(),
      update: jest.fn(),
    },
    assetPriceSnapshot: {
      create: jest.fn(),
      update: jest.fn(),
    },
    fxRateSnapshot: {
      create: jest.fn(),
      update: jest.fn(),
    },
    cashWallet: {
      create: jest.fn(),
      update: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
      update: jest.fn(),
    },
    order: {
      create: jest.fn(),
      update: jest.fn(),
    },
    position: {
      create: jest.fn(),
      update: jest.fn(),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    reward: {
      create: jest.fn(),
    },
    payment: {
      create: jest.fn(),
    },
    badge: {
      create: jest.fn(),
    },
    trophy: {
      create: jest.fn(),
    },
  };
}

function createBatchServiceMock(startedAt: Date): BatchServiceMock {
  return {
    runJob: jest.fn(async (params) => {
      const result = await params.handler({
        runId: 'run-1',
        jobName: params.jobName,
        idempotencyKey: params.idempotencyKey,
        dryRun: params.dryRun === true,
        startedAt,
      });

      return {
        success: true,
        data: {
          run: {
            id: 'run-1',
            jobName: params.jobName,
            idempotencyKey: params.idempotencyKey,
            status: 'succeeded',
            dryRun: params.dryRun === true,
            startedAt: startedAt.toISOString(),
            finishedAt: startedAt.toISOString(),
            requestedBy: params.requestedBy ?? null,
            requestPayloadJson: params.requestPayload ?? null,
            resultPayloadJson: result,
            errorCode: null,
            errorMessage: null,
            createdAt: startedAt.toISOString(),
            updatedAt: startedAt.toISOString(),
          },
          deduplicated: false,
          skipped: false,
        },
      };
    }),
  };
}

async function runAndGetResult(
  service: RewardGrantJobService,
  input: Parameters<RewardGrantJobService['run']>[0],
): Promise<RewardGrantJobResult> {
  const response = await service.run(input);

  return response.data.run.resultPayloadJson as unknown as RewardGrantJobResult;
}

async function captureHttpExceptionResponse(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getResponse() as {
        error: {
          code: string;
          message: string;
        };
        data: {
          resultPayloadJson: RewardGrantJobResult;
        };
      };
    }

    throw error;
  }

  throw new Error('Expected HttpException.');
}

function mockSeason(
  prisma: PrismaMock,
  status: SeasonStatus,
  rewardPolicyJson: unknown = null,
) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
    rewardPolicyJson,
  });
}

function mockParticipants(
  prisma: PrismaMock,
  participants: ReturnType<typeof participant>[],
) {
  prisma.seasonParticipant.findMany.mockResolvedValue(participants);
}

function participant(
  id: string,
  userId: string,
  finalRank: number | null,
  finalTier: string | null,
  options: {
    rewardGrantedAt?: Date | null;
  } = {},
) {
  return {
    id,
    userId,
    finalRank,
    finalTier,
    rewardGrantedAt: options.rewardGrantedAt ?? null,
  };
}

function updateTimestamps(prisma: PrismaMock) {
  return prisma.__tx.seasonParticipant.updateMany.mock.calls.map(([input]) =>
    input.data.rewardGrantedAt.toISOString(),
  );
}
