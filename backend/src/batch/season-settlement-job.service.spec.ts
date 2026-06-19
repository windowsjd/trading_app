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
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
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
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
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
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { SeasonSettlementJobService } from './season-settlement-job.service';
import {
  SEASON_SETTLEMENT_JOB_NAME,
  SeasonSettlementJobResult,
} from './season-settlement-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type PrismaMock = ReturnType<typeof createPrismaMock>;

const BATCH_STARTED_AT = new Date('2026-05-21T00:00:30.000Z');

describe('SeasonSettlementJobService', () => {
  const settlementDate = '2026-05-21';
  const settlementDateValue = new Date('2026-05-21T00:00:00.000Z');

  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);

    await service.run({
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: SEASON_SETTLEMENT_JOB_NAME,
        idempotencyKey: 'season-settlement:season-1:2026-05-21',
        dryRun: true,
        requestedBy: 'operator',
        requestPayload: {
          seasonId: 'season-1',
          settlementDate: '2026-05-21',
          dryRun: true,
          requestedBy: 'operator',
          idempotencyKey: 'season-settlement:season-1:2026-05-21',
        },
      }),
    );
  });

  it('keeps an explicit idempotencyKey when provided', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);

    await service.run({
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
      idempotencyKey: 'manual-key',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-key',
      }),
    );
  });

  it('returns wouldCreate in dry-run without creating final rankings or settling the season', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [
      snapshot('sp-1', 'user-1', '1000.00000000'),
      snapshot('sp-2', 'user-2', '2000.00000000'),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.__tx.season.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      season: {
        previousStatus: SeasonStatus.ended,
        nextStatus: SeasonStatus.settled,
        updated: false,
      },
      participants: {
        total: 2,
        snapshotted: 2,
        missingSnapshots: 0,
      },
      finalRankings: {
        wouldCreate: 2,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      createdFinalRankingIds: [],
    });
  });

  it('creates final season_rankings and transitions the season to settled', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [
      snapshot('sp-1', 'user-1', '1000.00000000', '0.00000000'),
      snapshot('sp-2', 'user-2', '2000.00000000', '10.00000000'),
    ]);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create
      .mockResolvedValueOnce({ id: 'final-ranking-1' })
      .mockResolvedValueOnce({ id: 'final-ranking-2' });
    prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
    });

    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonId: 'season-1',
          participantStatus: {
            in: [
              ParticipantStatus.active,
              ParticipantStatus.finished,
              ParticipantStatus.rewarded,
            ],
          },
        },
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledWith({
      data: {
        seasonId: 'season-1',
        seasonParticipantId: 'sp-2',
        rankType: SeasonRankingType.final,
        rank: 1,
        totalAssetKrw: '2000.00000000',
        returnRate: '10.00000000',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: new Date('2026-05-21T00:00:10.000Z'),
        rankingDate: settlementDateValue,
        capturedAt: BATCH_STARTED_AT,
      },
      select: {
        id: true,
      },
    });
    expect(prisma.__tx.season.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'season-1',
        status: {
          in: [SeasonStatus.ended, SeasonStatus.settled],
        },
      },
      data: {
        status: SeasonStatus.settled,
      },
    });
    expect(result.season.updated).toBe(true);
    expect(result.finalRankings).toEqual({
      wouldCreate: 2,
      created: 2,
      existing: 0,
      skipped: 0,
    });
    expect(result.createdFinalRankingIds).toEqual([
      'final-ranking-1',
      'final-ranking-2',
    ]);
  });

  it('uses one transaction for final ranking writes and season status update', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });
    prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

    await service.run({
      seasonId: 'season-1',
      settlementDate,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.season.updateMany).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.season.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite existing final rankings and settles an ended season only', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, [
      existingRanking('final-existing', 'sp-1', 'user-1', 1),
    ]);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([
      existingRanking('final-existing', 'sp-1', 'user-1', 1),
    ]);
    prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
    });

    expect(prisma.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.__tx.season.updateMany).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      season: {
        previousStatus: SeasonStatus.ended,
        nextStatus: SeasonStatus.settled,
        updated: true,
      },
      finalRankings: {
        wouldCreate: 0,
        created: 0,
        existing: 1,
        skipped: 1,
      },
    });
  });

  it('returns an idempotent existing/skipped result for already settled seasons', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, [
      existingRanking('final-existing', 'sp-1', 'user-1', 1),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(result.season).toEqual({
      previousStatus: SeasonStatus.settled,
      nextStatus: SeasonStatus.settled,
      updated: true,
    });
    expect(result.finalRankings).toEqual({
      wouldCreate: 0,
      created: 0,
      existing: 1,
      skipped: 1,
    });
    expect(result.finalTiers.assigned).toBe(1);
  });

  it('treats missing season as a job-level error inside the batch envelope', async () => {
    const { service, batchService, prisma } = createService();
    prisma.season.findUnique.mockResolvedValue(null);

    await expect(
      service.run({
        seasonId: 'missing-season',
        settlementDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(batchService.runJob).toHaveBeenCalled();
  });

  it.each([SeasonStatus.active, SeasonStatus.upcoming])(
    'rejects %s seasons at job level',
    async (status) => {
      const { service, prisma } = createService();
      mockSeason(prisma, status);

      await expect(
        service.run({
          seasonId: 'season-1',
          settlementDate,
        }),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    },
  );

  it('rejects invalid settlementDate as BAD_REQUEST', async () => {
    const { service } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        settlementDate: '2026-02-31',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('fails when no settlementDate snapshots exist', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, []);

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        settlementDate,
      }),
    );

    expect(response.error.code).toBe('NO_FINAL_SNAPSHOTS_AVAILABLE');
    expect(response.data.resultPayloadJson).toMatchObject({
      reason: 'NO_FINAL_SNAPSHOTS_AVAILABLE',
      participants: {
        total: 1,
        snapshotted: 0,
        missingSnapshots: 1,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails when eligible participant snapshots are missing', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        settlementDate,
      }),
    );

    expect(response.error.code).toBe('MISSING_FINAL_SNAPSHOTS');
    expect(response.data.resultPayloadJson).toMatchObject({
      participants: {
        total: 2,
        snapshotted: 1,
        missingSnapshots: 1,
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ranks by returnRate desc, then userId asc, then seasonParticipantId asc', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-c', userId: 'user-c' },
      { id: 'sp-a2', userId: 'user-a' },
      { id: 'sp-a1', userId: 'user-a' },
      { id: 'sp-high', userId: 'user-high' },
    ]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [
      snapshot('sp-c', 'user-c', '1000.00000000', '1.00000000'),
      snapshot('sp-a2', 'user-a', '1000.00000000', '1.00000000'),
      snapshot('sp-a1', 'user-a', '1000.00000000', '1.00000000'),
      snapshot('sp-high', 'user-high', '2000.00000000', '2.00000000'),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
    });

    expect(result.topRanks.map((row) => row.seasonParticipantId)).toEqual([
      'sp-high',
      'sp-a1',
      'sp-a2',
      'sp-c',
    ]);
    expect(result.topRanks.map((row) => row.rank)).toEqual([1, 2, 3, 4]);
  });

  it('uses deterministic sequential rank for equal totalAssetKrw', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-b', userId: 'user-b' },
      { id: 'sp-a', userId: 'user-a' },
    ]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [
      snapshot('sp-b', 'user-b', '1000.00000000'),
      snapshot('sp-a', 'user-a', '1000.00000000'),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
    });

    expect(result.topRanks).toMatchObject([
      {
        seasonParticipantId: 'sp-a',
        userId: 'user-a',
        rank: 1,
      },
      {
        seasonParticipantId: 'sp-b',
        userId: 'user-b',
        rank: 2,
      },
    ]);
  });

  it('limits topRanks to 10 rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    const participants = Array.from({ length: 12 }, (_, index) => ({
      id: `sp-${index}`,
      userId: `user-${index.toString().padStart(2, '0')}`,
    }));
    mockParticipants(prisma, participants);
    mockExistingRankings(prisma, []);
    mockSnapshots(
      prisma,
      participants.map((participant, index) =>
        snapshot(
          participant.id,
          participant.userId,
          `${(2000 - index).toFixed(8)}`,
        ),
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
    });

    expect(result.topRanks).toHaveLength(10);
  });

  it('does not create reward/payment/badge/trophy or provider, price, wallet, order, position, or snapshot rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });
    prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

    await service.run({
      seasonId: 'season-1',
      settlementDate,
    });

    expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
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
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.upsert).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.deleteMany).not.toHaveBeenCalled();
  });
});

function createService() {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new SeasonSettlementJobService(
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
    season: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    seasonParticipant: {
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    equitySnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async () => ({ id: 'final-snapshot' })),
      update: jest.fn(async () => ({ id: 'final-snapshot' })),
    },
    seasonRanking: {
      findMany: jest.fn(),
      create: jest.fn(),
      count: jest.fn(),
    },
  };

  return {
    __tx: tx,
    $transaction: jest.fn(async (callback) => callback(tx)),
    season: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    seasonParticipant: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    seasonRanking: {
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
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
      findMany: jest.fn().mockResolvedValue([]),
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
  service: SeasonSettlementJobService,
  input: Parameters<SeasonSettlementJobService['run']>[0],
): Promise<SeasonSettlementJobResult> {
  const response = await service.run(input);

  return response.data.run
    .resultPayloadJson as unknown as SeasonSettlementJobResult;
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
          resultPayloadJson: SeasonSettlementJobResult;
        };
      };
    }

    throw error;
  }

  throw new Error('Expected HttpException.');
}

function mockSeason(prisma: PrismaMock, status: SeasonStatus) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
    endAt: new Date('2026-05-21T00:00:00.000Z'),
  });
}

function mockParticipants(
  prisma: PrismaMock,
  participants: Array<{ id: string; userId: string }>,
) {
  prisma.seasonParticipant.findMany.mockResolvedValue(
    participants.map((participant) => ({
      totalFillCount: 0,
      ...participant,
    })),
  );
}

function mockSnapshots(
  prisma: PrismaMock,
  snapshots: ReturnType<typeof snapshot>[],
) {
  prisma.dailyPortfolioSnapshot.findMany.mockResolvedValue(snapshots);
}

function mockExistingRankings(
  prisma: PrismaMock,
  rankings: ReturnType<typeof existingRanking>[],
) {
  prisma.seasonRanking.findMany.mockResolvedValue(rankings);
  prisma.__tx.seasonRanking.findMany.mockResolvedValue(rankings);
  prisma.__tx.seasonRanking.count.mockImplementation(
    async () =>
      rankings.length + prisma.__tx.seasonRanking.create.mock.calls.length,
  );
  prisma.__tx.seasonParticipant.count.mockResolvedValue(0);
  prisma.__tx.seasonParticipant.update.mockResolvedValue({ id: 'sp-updated' });
  prisma.__tx.seasonParticipant.updateMany.mockResolvedValue({ count: 1 });
}

function snapshot(
  seasonParticipantId: string,
  userId: string,
  totalAssetKrw: string,
  returnRate = '0.00000000',
  capturedAt = new Date('2026-05-21T00:00:10.000Z'),
) {
  return {
    seasonParticipantId,
    snapshotDate: new Date('2026-05-21T00:00:00.000Z'),
    totalAssetKrw: new Prisma.Decimal(totalAssetKrw),
    returnRate: new Prisma.Decimal(returnRate),
    capturedAt,
    createdAt: capturedAt,
    seasonParticipant: {
      userId,
    },
  };
}

function existingRanking(
  id: string,
  seasonParticipantId: string,
  userId: string,
  rank: number,
) {
  return {
    id,
    seasonParticipantId,
    rank,
    totalAssetKrw: new Prisma.Decimal('1000.00000000'),
    returnRate: new Prisma.Decimal('0.00000000'),
    maxDrawdown: new Prisma.Decimal('0.00000000'),
    totalFillCount: 0,
    reachedReturnAt: null,
    seasonParticipant: {
      userId,
    },
  };
}
