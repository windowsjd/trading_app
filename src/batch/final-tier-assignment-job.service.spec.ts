jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    BatchJobStatus: {
      pending: 'pending',
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      skipped: 'skipped',
    },
    Prisma: {
      Decimal,
      JsonNull: null,
    },
    PrismaClient: class PrismaClient {},
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { FinalTierAssignmentJobService } from './final-tier-assignment-job.service';
import {
  FINAL_TIER_ASSIGNMENT_JOB_NAME,
  FinalTierAssignmentJobResult,
} from './final-tier-assignment-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type PrismaMock = ReturnType<typeof createPrismaMock>;

const BATCH_STARTED_AT = new Date('2026-05-21T00:00:30.000Z');

describe('FinalTierAssignmentJobService', () => {
  const rankingDate = '2026-05-21';
  const rankingDateValue = new Date('2026-05-21T00:00:00.000Z');

  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-1', 'user-1', 1)]);

    await service.run({
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: FINAL_TIER_ASSIGNMENT_JOB_NAME,
        idempotencyKey: 'final-tier-assignment:season-1:2026-05-21',
        dryRun: true,
        requestedBy: 'operator',
        requestPayload: {
          seasonId: 'season-1',
          rankingDate: '2026-05-21',
          dryRun: true,
          requestedBy: 'operator',
          idempotencyKey: 'final-tier-assignment:season-1:2026-05-21',
        },
      }),
    );
  });

  it('keeps an explicit idempotencyKey when provided', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-1', 'user-1', 1)]);

    await service.run({
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
      idempotencyKey: 'manual-key',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-key',
      }),
    );
  });

  it('returns wouldAssign in dry-run without updating season participants', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1),
      finalRanking('sp-2', 'user-2', 2, {
        finalRank: 2,
        finalTier: 'diamond',
      }),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
      policy: {
        source: 'default_mvp',
      },
      participants: {
        totalFinalRanked: 2,
        wouldAssign: 1,
        assigned: 0,
        existing: 1,
        skipped: 1,
      },
      assignedParticipantIds: [],
    });
    expect(result.topAssignments).toMatchObject([
      {
        seasonParticipantId: 'sp-1',
        finalRank: 1,
        finalTier: 'master',
      },
      {
        seasonParticipantId: 'sp-2',
        finalRank: 2,
        finalTier: 'diamond',
      },
    ]);
  });

  it('updates finalRank/finalTier for settled season final rankings in one transaction', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-7', 'user-7', 7)]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
    });

    expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        rankType: SeasonRankingType.final,
        rankingDate: rankingDateValue,
      },
      orderBy: [{ rank: 'asc' }, { seasonParticipantId: 'asc' }],
      select: expect.any(Object),
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'sp-7',
        seasonId: 'season-1',
        finalRank: null,
        finalTier: null,
      },
      data: {
        finalRank: 7,
        finalTier: 'platinum',
      },
    });
    expect(result.participants).toEqual({
      totalFinalRanked: 1,
      wouldAssign: 1,
      assigned: 1,
      existing: 0,
      skipped: 0,
    });
    expect(result.assignedParticipantIds).toEqual(['sp-7']);
  });

  it('reflects final ranking rank as finalRank and applies the default MVP tier policy', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(
      prisma,
      Array.from({ length: 40 }, (_, index) =>
        finalRanking(`sp-${index + 1}`, `user-${index + 1}`, index + 1),
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
    });

    expect(updateFor(prisma, 'sp-1')).toMatchObject({
      data: {
        finalRank: 1,
        finalTier: 'master',
      },
    });
    expect(updateFor(prisma, 'sp-2')).toMatchObject({
      data: {
        finalRank: 2,
        finalTier: 'diamond',
      },
    });
    expect(updateFor(prisma, 'sp-3')).toMatchObject({
      data: {
        finalRank: 3,
        finalTier: 'diamond',
      },
    });
    expect(updateFor(prisma, 'sp-4')).toMatchObject({
      data: {
        finalRank: 4,
        finalTier: 'platinum',
      },
    });
    expect(updateFor(prisma, 'sp-10')).toMatchObject({
      data: {
        finalRank: 10,
        finalTier: 'platinum',
      },
    });
    expect(updateFor(prisma, 'sp-11')).toMatchObject({
      data: {
        finalRank: 11,
        finalTier: 'gold',
      },
    });
    expect(updateFor(prisma, 'sp-20')).toMatchObject({
      data: {
        finalRank: 20,
        finalTier: 'silver',
      },
    });
    expect(updateFor(prisma, 'sp-30')).toMatchObject({
      data: {
        finalRank: 30,
        finalTier: 'bronze',
      },
    });
    expect(result.participants.assigned).toBe(40);
  });

  it('uses a clear season.rewardPolicyJson tier policy and ignores reward amounts', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled, {
      tierPolicy: {
        tiers: [
          { tier: 'master', rank: 1, rewardAmountKrw: '999999.00000000' },
          { tier: 'gold', maxPercent: 0.5 },
          { tier: 'bronze', fallback: true },
        ],
      },
    });
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1),
      finalRanking('sp-2', 'user-2', 2),
      finalRanking('sp-3', 'user-3', 3),
      finalRanking('sp-4', 'user-4', 4),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
    });

    expect(result.policy.source).toBe('season_reward_policy');
    expect(result.topAssignments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          finalRank: 1,
          finalTier: 'master',
        }),
        expect.objectContaining({
          finalRank: 2,
          finalTier: 'gold',
        }),
        expect.objectContaining({
          finalRank: 3,
          finalTier: 'bronze',
        }),
      ]),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('treats finalRank-only or finalTier-only participants as existing and does not overwrite them', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-final-rank', 'user-1', 1, { finalRank: 99 }),
      finalRanking('sp-final-tier', 'user-2', 2, { finalTier: 'gold' }),
      finalRanking('sp-new', 'user-3', 3),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
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
      totalFinalRanked: 3,
      wouldAssign: 1,
      assigned: 1,
      existing: 2,
      skipped: 2,
    });
    expect(result.assignedParticipantIds).toEqual(['sp-new']);
  });

  it('treats missing season as a job-level error inside the batch envelope', async () => {
    const { service, batchService, prisma } = createService();
    prisma.season.findUnique.mockResolvedValue(null);

    await expect(
      service.run({
        seasonId: 'missing-season',
        rankingDate,
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
        rankingDate,
      }),
    );

    expect(response.error.code).toBe(code);
    expect(prisma.seasonRanking.findMany).not.toHaveBeenCalled();
  });

  it('rejects invalid rankingDate as BAD_REQUEST', async () => {
    const { service } = createService();

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        rankingDate: '2026-02-31',
      }),
    );

    expect(response.error.code).toBe('BAD_REQUEST');
  });

  it('fails when final rankings are unavailable for the selected rankingDate', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, []);

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        rankingDate,
      }),
    );

    expect(response.error.code).toBe('FINAL_RANKING_UNAVAILABLE');
    expect(response.data.resultPayloadJson).toMatchObject({
      reason: 'FINAL_RANKING_UNAVAILABLE',
      participants: {
        totalFinalRanked: 0,
        wouldAssign: 0,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not update rewardGrantedAt when assigning final tiers', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1, {
        rewardGrantedAt: new Date('2026-05-22T00:00:00.000Z'),
      }),
    ]);

    await service.run({
      seasonId: 'season-1',
      rankingDate,
    });

    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'sp-1',
        seasonId: 'season-1',
        finalRank: null,
        finalTier: null,
      },
      data: {
        finalRank: 1,
        finalTier: 'master',
      },
    });
    expect(
      prisma.__tx.seasonParticipant.updateMany.mock.calls[0][0].data,
    ).not.toHaveProperty('rewardGrantedAt');
  });

  it('does not create reward/payment/badge/trophy or provider, price, wallet, order, position, snapshot, or ranking rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-1', 'user-1', 1)]);

    await service.run({
      seasonId: 'season-1',
      rankingDate,
    });

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
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
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

  it('caps topAssignments at 10 rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(
      prisma,
      Array.from({ length: 12 }, (_, index) =>
        finalRanking(`sp-${index + 1}`, `user-${index + 1}`, index + 1),
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
    });

    expect(result.topAssignments).toHaveLength(10);
  });
});

function createService() {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new FinalTierAssignmentJobService(
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
      findMany: jest.fn(),
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
    },
    order: {
      create: jest.fn(),
      update: jest.fn(),
    },
    position: {
      create: jest.fn(),
      update: jest.fn(),
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
  service: FinalTierAssignmentJobService,
  input: Parameters<FinalTierAssignmentJobService['run']>[0],
): Promise<FinalTierAssignmentJobResult> {
  const response = await service.run(input);

  return response.data.run
    .resultPayloadJson as unknown as FinalTierAssignmentJobResult;
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
          resultPayloadJson: FinalTierAssignmentJobResult;
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
  rewardPolicyJson: Prisma.JsonValue | null = null,
) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
    rewardPolicyJson,
  });
}

function mockFinalRankings(
  prisma: PrismaMock,
  rankings: ReturnType<typeof finalRanking>[],
) {
  prisma.seasonRanking.findMany.mockResolvedValue(rankings);
}

function finalRanking(
  seasonParticipantId: string,
  userId: string,
  rank: number,
  options: {
    totalAssetKrw?: string;
    returnRate?: string;
    finalRank?: number | null;
    finalTier?: string | null;
    rewardGrantedAt?: Date | null;
  } = {},
) {
  return {
    seasonParticipantId,
    rank,
    totalAssetKrw: new Prisma.Decimal(
      options.totalAssetKrw ?? `${(1000 - rank).toFixed(8)}`,
    ),
    returnRate: new Prisma.Decimal(options.returnRate ?? '0.00000000'),
    seasonParticipant: {
      id: seasonParticipantId,
      userId,
      finalRank: options.finalRank ?? null,
      finalTier: options.finalTier ?? null,
      rewardGrantedAt: options.rewardGrantedAt ?? null,
    },
  };
}

function updateFor(prisma: PrismaMock, seasonParticipantId: string) {
  const call = prisma.__tx.seasonParticipant.updateMany.mock.calls.find(
    ([input]) => input.where.id === seasonParticipantId,
  );

  if (!call) {
    throw new Error(`Missing updateMany call for ${seasonParticipantId}.`);
  }

  return call[0];
}
