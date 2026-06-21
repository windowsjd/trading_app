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
      excluded: 'excluded',
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

import { HttpStatus } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { SeasonRankingJobService } from './season-ranking-job.service';
import {
  SEASON_RANKING_JOB_NAME,
  SeasonRankingJobResult,
} from './season-ranking-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type PrismaMock = ReturnType<typeof createPrismaMock>;

const BATCH_STARTED_AT = new Date('2026-05-20T00:00:30.000Z');

describe('SeasonRankingJobService', () => {
  const snapshotDate = '2026-05-20';
  const snapshotDateValue = new Date('2026-05-20T00:00:00.000Z');

  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    mockExistingRankings(prisma, []);

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: SEASON_RANKING_JOB_NAME,
        idempotencyKey: 'season-ranking:season-1:2026-05-20',
        dryRun: true,
        requestedBy: 'operator',
        requestPayload: {
          seasonId: 'season-1',
          snapshotDate: '2026-05-20',
          dryRun: true,
          requestedBy: 'operator',
          idempotencyKey: 'season-ranking:season-1:2026-05-20',
        },
      }),
    );
  });

  it('keeps an explicit idempotencyKey when provided', async () => {
    const { service, batchService, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, []);
    mockSnapshots(prisma, []);
    mockExistingRankings(prisma, []);

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'manual-key',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-key',
      }),
    );
  });

  it('returns wouldCreate in dry-run without creating season rankings', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockSnapshots(prisma, [
      snapshot('sp-1', 'user-1', '1000.00000000'),
      snapshot('sp-2', 'user-2', '2000.00000000'),
    ]);
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      dryRun: true,
      participants: {
        snapshotted: 2,
        missingSnapshots: 0,
      },
      rankings: {
        wouldCreate: 2,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      createdRankingIds: [],
    });
  });

  it('creates season_rankings from existing daily snapshots', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockSnapshots(prisma, [
      snapshot('sp-1', 'user-1', '1000.00000000', '0.00000000'),
      snapshot('sp-2', 'user-2', '2000.00000000', '10.00000000'),
    ]);
    mockExistingRankings(prisma, []);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create
      .mockResolvedValueOnce({ id: 'ranking-1' })
      .mockResolvedValueOnce({ id: 'ranking-2' });

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
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
    expect(
      prisma.seasonParticipant.findMany.mock.calls[0][0].where
        .participantStatus.in,
    ).not.toContain(ParticipantStatus.excluded);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledWith({
      data: {
        seasonId: 'season-1',
        seasonParticipantId: 'sp-2',
        rankType: SeasonRankingType.daily,
        rank: 1,
        totalAssetKrw: '2000.00000000',
        returnRate: '10.00000000',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: new Date('2026-05-20T00:00:10.000Z'),
        rankingDate: snapshotDateValue,
        capturedAt: BATCH_STARTED_AT,
      },
      select: {
        id: true,
      },
    });
    expect(result.rankings).toEqual({
      wouldCreate: 2,
      created: 2,
      existing: 0,
      skipped: 0,
    });
    expect(result.createdRankingIds).toEqual(['ranking-1', 'ranking-2']);
  });

  it('classifies existing rankings without overwriting them', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    mockExistingRankings(prisma, [
      existingRanking('ranking-existing', 'sp-1', 'user-1', 1),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    expect(result.rankings).toEqual({
      wouldCreate: 0,
      created: 0,
      existing: 1,
      skipped: 1,
    });
    expect(result.message).toContain('already exist');
  });

  it('returns job-level success with zero created rows when no snapshots exist', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
    ]);
    mockSnapshots(prisma, []);
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result).toMatchObject({
      reason: 'NO_SNAPSHOTS_AVAILABLE',
      participants: {
        snapshotted: 0,
        missingSnapshots: 2,
      },
      rankings: {
        wouldCreate: 0,
        created: 0,
        existing: 0,
        skipped: 0,
      },
      topRanks: [],
      errors: [],
    });
  });

  it('counts missing participant snapshots', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-1', userId: 'user-1' },
      { id: 'sp-2', userId: 'user-2' },
      { id: 'sp-3', userId: 'user-3' },
    ]);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(result.participants).toEqual({
      snapshotted: 1,
      missingSnapshots: 2,
    });
  });

  it('treats missing season as a job-level error inside the batch envelope', async () => {
    const { service, batchService, prisma } = createService();
    prisma.season.findUnique.mockResolvedValue(null);

    await expect(
      service.run({
        seasonId: 'missing-season',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(batchService.runJob).toHaveBeenCalled();
  });

  it('rejects upcoming seasons at job level', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.upcoming);

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejects settled seasons at job level', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('rejects invalid snapshotDate as BAD_REQUEST', async () => {
    const { service } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate: '2026-02-31',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
  });

  it('ranks by returnRate desc before totalAssetKrw', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-low', userId: 'user-low' },
      { id: 'sp-high', userId: 'user-high' },
      { id: 'sp-mid', userId: 'user-mid' },
    ]);
    mockSnapshots(prisma, [
      snapshot('sp-low', 'user-low', '1000.00000000', '1.00000000'),
      snapshot('sp-high', 'user-high', '3000.00000000', '2.00000000'),
      snapshot('sp-mid', 'user-mid', '2000.00000000', '3.00000000'),
    ]);
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(result.topRanks.map((row) => row.seasonParticipantId)).toEqual([
      'sp-mid',
      'sp-high',
      'sp-low',
    ]);
    expect(result.topRanks.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it('uses deterministic unique ranks for equal totalAssetKrw under the current unique rank schema', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [
      { id: 'sp-b', userId: 'user-b' },
      { id: 'sp-a', userId: 'user-a' },
    ]);
    mockSnapshots(prisma, [
      snapshot('sp-b', 'user-b', '1000.00000000'),
      snapshot('sp-a', 'user-a', '1000.00000000'),
    ]);
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
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
    mockSeason(prisma, SeasonStatus.active);
    const participants = Array.from({ length: 12 }, (_, index) => ({
      id: `sp-${index}`,
      userId: `user-${index.toString().padStart(2, '0')}`,
    }));
    mockParticipants(prisma, participants);
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
    mockExistingRankings(prisma, []);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
    });

    expect(result.topRanks).toHaveLength(10);
  });

  it('uses a transaction for non-dry-run ranking writes', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    mockExistingRankings(prisma, []);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledTimes(1);
  });

  it('does not create or mutate provider, price, wallet, order, position, or snapshot rows', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.active);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
    mockExistingRankings(prisma, []);
    prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
    prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.update).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.update).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.upsert).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.deleteMany).not.toHaveBeenCalled();
  });
});

function createService() {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new SeasonRankingJobService(
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
    seasonRanking: {
      findMany: jest.fn(),
      create: jest.fn(),
    },
  };

  return {
    __tx: tx,
    $transaction: jest.fn(async (callback) => callback(tx)),
    season: {
      findUnique: jest.fn(),
    },
    seasonParticipant: {
      findMany: jest.fn(),
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
    order: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    position: {
      create: jest.fn(),
      update: jest.fn(),
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
  service: SeasonRankingJobService,
  input: Parameters<SeasonRankingJobService['run']>[0],
): Promise<SeasonRankingJobResult> {
  const response = await service.run(input);

  return response.data.run
    .resultPayloadJson as unknown as SeasonRankingJobResult;
}

function mockSeason(prisma: PrismaMock, status: SeasonStatus) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
  });
}

function mockParticipants(
  prisma: PrismaMock,
  participants: Array<{ id: string; userId: string }>,
) {
  prisma.seasonParticipant.findMany.mockResolvedValue(participants);
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
}

function snapshot(
  seasonParticipantId: string,
  userId: string,
  totalAssetKrw: string,
  returnRate = '0.00000000',
  capturedAt = new Date('2026-05-20T00:00:10.000Z'),
) {
  return {
    seasonParticipantId,
    snapshotDate: new Date('2026-05-20T00:00:00.000Z'),
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
