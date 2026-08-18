jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    TradingAccountMode: { season: 'season', general: 'general' },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
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
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
    OrderType: {
      market: 'market',
      limit: 'limit',
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
    expect(
      prisma.seasonParticipant.findMany.mock.calls[0][0].where.participantStatus
        .in,
    ).not.toContain(ParticipantStatus.excluded);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledWith({
      data: {
        seasonId: 'season-1',
        seasonParticipantId: 'sp-2',
        // 작업 8 dual-write.
        tradingAccountId: 'account-of-sp-2',
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

  it('uses Season.endAt and the season settlement valuation workflow when valuation service is available', async () => {
    const valuationService = {
      calculateSeasonParticipantValuation: jest.fn().mockResolvedValue({
        totalAssetKrw: '1000.00000000',
        returnRate: '0.00000000',
        krwCash: '1000.00000000',
        usdCashKrw: '0.00000000',
        domesticStockValueKrw: '0.00000000',
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
      }),
    };
    const { service, prisma } = createService(valuationService);
    const seasonEndAt = new Date('2026-05-21T00:00:00.000Z');
    mockSeason(prisma, SeasonStatus.ended);
    mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
    mockExistingRankings(prisma, []);
    prisma.equitySnapshot.findMany.mockResolvedValue([]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      settlementDate,
      dryRun: true,
    });

    expect(
      valuationService.calculateSeasonParticipantValuation,
    ).toHaveBeenCalledWith('sp-1', seasonEndAt, 'season_settlement');
    expect(prisma.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      participants: {
        total: 1,
        snapshotted: 1,
        missingSnapshots: 0,
      },
      finalRankings: {
        wouldCreate: 1,
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

  it.each([
    ['open submitted limit-buy orders remain', 2, 0],
    ['wallet reservations remain', 0, 1],
  ])(
    'blocks settlement while %s',
    async (_label, openOrderCount, reservedWalletCount) => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.ended);
      prisma.order.count.mockResolvedValueOnce(openOrderCount);
      prisma.cashWallet.count.mockResolvedValueOnce(reservedWalletCount);

      const response = await captureHttpExceptionResponse(
        service.run({
          seasonId: 'season-1',
          settlementDate,
        }),
      );

      expect(response.error.code).toBe('OPEN_LIMIT_ORDER_RESERVATIONS');
      // Fails closed BEFORE any settlement write path.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(
        prisma.seasonRanking?.createMany ?? jest.fn(),
      ).not.toHaveBeenCalled();
    },
  );

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

  // ------------------------------------------------------------- 작업 8 보완
  // §A-1: the rows a final ranking is COMPUTED FROM are scope-verified, and a
  // damaged input fails the whole settlement rather than excluding one row.

  describe('§A-1 settlement source snapshot scope', () => {
    const settleWithSnapshots = (
      snapshots: Array<ReturnType<typeof snapshot>>,
    ) => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.ended);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      mockExistingRankings(prisma, []);
      mockSnapshots(prisma, snapshots);
      prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
      prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });

      return { service, prisma };
    };

    it('fails closed when a fallback daily snapshot has no trading account scope', async () => {
      const damaged = snapshot('sp-1', 'user-1', '1000.00000000');
      damaged.tradingAccountId = null as unknown as string;
      const { service, prisma } = settleWithSnapshots([
        damaged,
        snapshot('sp-2', 'user-2', '2000.00000000'),
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
          },
        },
      });
      // Not "settle the other one": no ranking row and no status change at all.
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
      expect(prisma.__tx.season.updateMany).not.toHaveBeenCalled();
    });

    it('fails closed when a fallback daily snapshot belongs to another account', async () => {
      const damaged = snapshot('sp-1', 'user-1', '1000.00000000');
      damaged.tradingAccountId = 'account-of-sp-2';
      const { service, prisma } = settleWithSnapshots([
        damaged,
        snapshot('sp-2', 'user-2', '2000.00000000'),
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: {
          error: { code: 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH' },
        },
      });
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    });

    it('fails closed when a season daily snapshot carries general-mode performance columns', async () => {
      const damaged = snapshot('sp-1', 'user-1', '1000.00000000');
      damaged.timeWeightedReturnFactor = new Prisma.Decimal(
        '1.05000000',
      ) as unknown as null;
      const { service, prisma } = settleWithSnapshots([
        damaged,
        snapshot('sp-2', 'user-2', '2000.00000000'),
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: {
          error: { code: 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH' },
        },
      });
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    });

    it('selects the scope columns on the fallback daily snapshot read', async () => {
      const { service, prisma } = settleWithSnapshots([
        snapshot('sp-1', 'user-1', '1000.00000000'),
        snapshot('sp-2', 'user-2', '2000.00000000'),
      ]);
      prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

      await service.run({ seasonId: 'season-1', settlementDate });

      expect(prisma.dailyPortfolioSnapshot.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            tradingAccountId: true,
            cumulativeExternalFundingKrw: true,
            investmentPnlKrw: true,
            timeWeightedReturnFactor: true,
          }),
        }),
      );
    });

    it('fails closed when a live-valuation equity snapshot has no trading account scope', async () => {
      const valuationService = {
        calculateSeasonParticipantValuation: jest.fn().mockResolvedValue({
          totalAssetKrw: '1000.00000000',
          returnRate: '0.00000000',
          krwCash: '1000.00000000',
          usdCashKrw: '0.00000000',
          domesticStockValueKrw: '0.00000000',
          usStockValueKrw: '0.00000000',
          cryptoValueKrw: '0.00000000',
        }),
      };
      const { service, prisma } = createService(valuationService);
      mockSeason(prisma, SeasonStatus.ended);
      mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
      mockExistingRankings(prisma, []);
      prisma.equitySnapshot.findMany.mockResolvedValue([
        {
          id: 'equity-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: null,
          cumulativeExternalFundingKrw: null,
          investmentPnlKrw: null,
          timeWeightedReturnFactor: null,
          totalAssetKrw: new Prisma.Decimal('900.00000000'),
          returnRate: new Prisma.Decimal('-10.00000000'),
          capturedAt: new Date('2026-05-20T00:00:00.000Z'),
          createdAt: new Date('2026-05-20T00:00:00.000Z'),
        },
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: {
          error: {
            // NOT collapsed into 503 FINAL_VALUATION_FAILED: retrying cannot
            // fix a scope fault, only the repair scripts can.
            code: 'SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED',
          },
        },
      });
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    });

    it('produces the unchanged final ranking when every source snapshot is correctly scoped', async () => {
      const { service, prisma } = settleWithSnapshots([
        snapshot('sp-1', 'user-1', '1000.00000000', '0.00000000'),
        snapshot('sp-2', 'user-2', '2000.00000000', '10.00000000'),
      ]);
      prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        settlementDate,
      });

      expect(result.topRanks.map((row) => row.seasonParticipantId)).toEqual([
        'sp-2',
        'sp-1',
      ]);
      expect(result.topRanks.map((row) => row.rank)).toEqual([1, 2]);
      expect(result.season.updated).toBe(true);
    });
  });

  // §A-2: a REUSED final ranking is the authority for the whole confirmed
  // result, not only for the rank.

  describe('§A-2 existing final ranking reuse consistency', () => {
    const reuseSetup = () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.ended);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      mockExistingRankings(prisma, [
        existingRanking('ranking-1', 'sp-1', 'user-1', 1),
        existingRanking('ranking-2', 'sp-2', 'user-2', 2),
      ]);
      prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

      return { service, prisma };
    };

    it('copies every financial result from the final ranking onto the participant', async () => {
      const { service, prisma } = reuseSetup();

      await service.run({ seasonId: 'season-1', settlementDate });

      const call = (
        prisma.__tx.seasonParticipant.updateMany.mock.calls as Array<
          [{ where: { id?: string }; data: Record<string, unknown> }]
        >
      ).find(([input]) => input.where.id === 'sp-1');
      expect(call).toBeDefined();
      expect(call![0].data).toEqual({
        totalAssetKrw: new Prisma.Decimal('1000.00000000'),
        totalReturnRate: new Prisma.Decimal('0.00000000'),
        maxDrawdown: new Prisma.Decimal('0.00000000'),
        totalFillCount: 0,
        finalRank: 1,
        finalTier: 'master',
        currentRank: 1,
      });
    });

    it('rolls the whole settlement back when a participant result disagrees with its final ranking', async () => {
      const { service, prisma } = reuseSetup();
      // The write lands, but something else has left sp-2 with a different
      // totalAssetKrw by the time the pre-settled re-verification reads it.
      prisma.__tx.seasonParticipant.findMany.mockImplementation(
        (args: { select?: Record<string, unknown> }) => {
          if (!args.select?.finalTier) {
            return Promise.resolve(settlementAccountParticipants());
          }

          return Promise.resolve([
            {
              id: 'sp-1',
              totalAssetKrw: new Prisma.Decimal('1000.00000000'),
              totalReturnRate: new Prisma.Decimal('0'),
              maxDrawdown: new Prisma.Decimal('0'),
              totalFillCount: 0,
              currentRank: 1,
              finalRank: 1,
              finalTier: 'master',
            },
            {
              id: 'sp-2',
              totalAssetKrw: new Prisma.Decimal('999999.00000000'),
              totalReturnRate: new Prisma.Decimal('0'),
              maxDrawdown: new Prisma.Decimal('0'),
              totalFillCount: 0,
              currentRank: 2,
              finalRank: 2,
              finalTier: 'silver',
            },
          ]);
        },
      );

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: { error: { code: 'FINAL_RESULTS_INTEGRITY' } },
      });
      expect(prisma.__tx.season.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      ['maxDrawdown', { maxDrawdown: new Prisma.Decimal('7.00000000') }],
      ['totalFillCount', { totalFillCount: 42 }],
      ['finalTier', { finalTier: 'bronze' }],
      ['half-assigned finalTier', { finalTier: null }],
    ])(
      'refuses to settle when the stored %s disagrees with the final ranking',
      async (_label, override) => {
        const { service, prisma } = reuseSetup();
        prisma.__tx.seasonParticipant.findMany.mockImplementation(
          (args: { select?: Record<string, unknown> }) => {
            if (!args.select?.finalTier) {
              return Promise.resolve(settlementAccountParticipants());
            }

            return Promise.resolve([
              {
                id: 'sp-1',
                totalAssetKrw: new Prisma.Decimal('1000.00000000'),
                totalReturnRate: new Prisma.Decimal('0'),
                maxDrawdown: new Prisma.Decimal('0'),
                totalFillCount: 0,
                currentRank: 1,
                finalRank: 1,
                finalTier: 'master',
                ...override,
              },
              {
                id: 'sp-2',
                totalAssetKrw: new Prisma.Decimal('1000.00000000'),
                totalReturnRate: new Prisma.Decimal('0'),
                maxDrawdown: new Prisma.Decimal('0'),
                totalFillCount: 0,
                currentRank: 2,
                finalRank: 2,
                finalTier: 'silver',
              },
            ]);
          },
        );

        await expect(
          service.run({ seasonId: 'season-1', settlementDate }),
        ).rejects.toMatchObject({
          response: { error: { code: 'FINAL_RESULTS_INTEGRITY' } },
        });
        expect(prisma.__tx.season.updateMany).not.toHaveBeenCalled();
      },
    );

    it('refuses to reuse a final ranking that does not cover every eligible participant', async () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.ended);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      // Two rows, right COUNT — so the pre-lock `participants.length -
      // existing.length` check sees 0 missing — but sp-2 has no row and a
      // no-longer-eligible sp-3 has one. Exactly what a count-only check lets
      // through, and it would have settled sp-2 with no final result at all.
      mockExistingRankings(prisma, [
        existingRanking('ranking-1', 'sp-1', 'user-1', 1),
        existingRanking('ranking-3', 'sp-3', 'user-3', 2),
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        response: { error: { code: 'FINAL_RESULTS_INTEGRITY' } },
      });
      expect(prisma.__tx.season.updateMany).not.toHaveBeenCalled();
    });

    it('is idempotent: a clean re-run adds no ranking row and produces the same result', async () => {
      const { service, prisma } = reuseSetup();

      const first = await runAndGetResult(service, {
        seasonId: 'season-1',
        settlementDate,
      });
      const second = await runAndGetResult(service, {
        seasonId: 'season-1',
        settlementDate,
      });

      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
      expect(first.finalRankings.existing).toBe(2);
      expect(second.finalRankings.existing).toBe(2);
      expect(second.assignedFinalTierParticipantIds).toEqual(
        first.assignedFinalTierParticipantIds,
      );
      expect(second.topRanks).toEqual(first.topRanks);
    });
  });

  // §A-5: a settled season never gets a NEW final ranking.

  describe('§A-5 settled season without a final ranking', () => {
    it('refuses to compute a new final ranking for a settled season with no final rows', async () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.settled);
      mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
      mockExistingRankings(prisma, []);
      mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { error: { code: 'FINAL_RESULTS_INTEGRITY' } },
      });
      // No recomputation, no snapshot, no ranking row.
      expect(prisma.dailyPortfolioSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.__tx.equitySnapshot.create).not.toHaveBeenCalled();
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    });

    it('refuses when a settled season has final rankings for only some participants', async () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.settled);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      mockExistingRankings(prisma, [
        existingRanking('ranking-1', 'sp-1', 'user-1', 1),
      ]);

      await expect(
        service.run({ seasonId: 'season-1', settlementDate }),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { error: { code: 'FINAL_RESULTS_INTEGRITY' } },
      });
      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
    });

    it('replays idempotently for a settled season with a complete final ranking', async () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.settled);
      mockParticipants(prisma, [
        { id: 'sp-1', userId: 'user-1' },
        { id: 'sp-2', userId: 'user-2' },
      ]);
      mockExistingRankings(prisma, [
        existingRanking('ranking-1', 'sp-1', 'user-1', 1),
        existingRanking('ranking-2', 'sp-2', 'user-2', 2),
      ]);
      prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        settlementDate,
      });

      expect(prisma.__tx.seasonRanking.create).not.toHaveBeenCalled();
      expect(result.finalRankings.existing).toBe(2);
      expect(result.message).toContain('already settled');
    });

    it('still allows a first settlement for an ended season with no final ranking', async () => {
      const { service, prisma } = createService();
      mockSeason(prisma, SeasonStatus.ended);
      mockParticipants(prisma, [{ id: 'sp-1', userId: 'user-1' }]);
      mockExistingRankings(prisma, []);
      mockSnapshots(prisma, [snapshot('sp-1', 'user-1', '1000.00000000')]);
      prisma.__tx.seasonRanking.findMany.mockResolvedValue([]);
      prisma.__tx.seasonRanking.create.mockResolvedValue({ id: 'ranking-1' });
      prisma.__tx.season.updateMany.mockResolvedValue({ count: 1 });

      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        settlementDate,
      });

      expect(prisma.__tx.seasonRanking.create).toHaveBeenCalledTimes(1);
      expect(result.season.updated).toBe(true);
    });
  });
});

function createService(portfolioValuationService?: {
  calculateSeasonParticipantValuation: jest.Mock;
}) {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new SeasonSettlementJobService(
    batchService as never,
    prisma as never,
    portfolioValuationService as never,
  );

  return {
    service,
    prisma,
    batchService,
  };
}

function createPrismaMock() {
  settlementParticipantResults = new Map();
  const tx = {
    // The season row lock taken first inside the settlement transaction
    // (작업 8 §13.3 / §14.1).
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'season-1',
        status: 'ended',
        start_at: new Date('2026-05-01T00:00:00.000Z'),
        end_at: SEASON_END_AT,
      },
    ]),
    season: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: { count: jest.fn().mockResolvedValue(0) },
    cashWallet: { count: jest.fn().mockResolvedValue(0) },
    position: { count: jest.fn().mockResolvedValue(0) },
    // Settlement closes EVERY season account, so it re-reads all participants
    // with their account link under the lock (작업 8 §14.2).
    tradingAccount: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    seasonParticipant: {
      // 작업 7 dual-write: the settlement snapshot writer resolves the
      // participant's verified account inside the transaction.
      findUnique: jest.fn(async (args: { where: { id: string } }) => ({
        tradingAccountId: `account-of-${args.where.id}`,
      })),
      // THREE different reads hit this delegate now: the season-wide account
      // list (`where.seasonId` alone), the ranking scope resolution
      // (`where.id.in`), and the 작업 8 보완 §A-2 final-result read-back
      // (`select.finalTier`), which must see what this transaction just wrote.
      findMany: jest.fn(
        (args: {
          where: { id?: { in: string[] }; seasonId?: string };
          select?: Record<string, unknown>;
        }) => {
          const ids = args.where.id?.in;

          if (args.select?.finalTier) {
            return Promise.resolve(
              (ids ?? [...settlementParticipantResults.keys()]).flatMap(
                (id) => {
                  const stored = settlementParticipantResults.get(id);
                  return stored ? [{ id, ...stored }] : [];
                },
              ),
            );
          }

          const rows = settlementAccountParticipants();
          return Promise.resolve(
            ids
              ? rows
                  .filter((row) => ids.includes(row.id))
                  .map((row) => ({ ...row, seasonId: 'season-1' }))
              : rows,
          );
        },
      ),
      update: jest.fn(
        (args: { where: { id: string }; data: Record<string, unknown> }) => {
          recordSettlementParticipantResult(args.where.id, args.data);
          return Promise.resolve({ id: args.where.id });
        },
      ),
      updateMany: jest.fn(
        (args: { where: { id?: string }; data: Record<string, unknown> }) => {
          if (args.where.id) {
            recordSettlementParticipantResult(args.where.id, args.data);
          }
          return Promise.resolve({ count: 1 });
        },
      ),
      count: jest.fn().mockResolvedValue(0),
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
      count: jest.fn().mockResolvedValue(0),
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
      // Settlement precondition: no wallet may still hold a reservation.
      count: jest.fn().mockResolvedValue(0),
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
      // Settlement precondition: no submitted limit-buy order may remain.
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    position: {
      // Settlement precondition: no position may still hold a sell reservation.
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(),
      update: jest.fn(),
    },
    equitySnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
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

const SEASON_END_AT = new Date('2026-05-21T00:00:00.000Z');

/**
 * The participants settlement re-reads under the season lock to close their
 * accounts (작업 8 §14.2). Season-wide by design, so the default fixture covers
 * the two eligible participants every test in this file uses.
 */
let accountParticipants: Array<{
  id: string;
  userId: string;
  participantStatus: string;
  tradingAccountId: string;
  tradingAccount: {
    id: string;
    mode: string;
    status: string;
    userId: string;
    closedAt: Date | null;
    seasonParticipant: { id: string };
  };
}> = [];

function settlementAccountParticipants() {
  return accountParticipants;
}

/**
 * What the settlement transaction has written onto each participant so far.
 *
 * 작업 8 보완 §A-2 re-reads the participant results inside the transaction and
 * refuses to settle when they disagree with the final ranking, so the mock has
 * to behave like a transaction: writes are visible to the later read.
 */
type StoredParticipantResult = {
  totalAssetKrw: Prisma.Decimal;
  totalReturnRate: Prisma.Decimal;
  maxDrawdown: Prisma.Decimal;
  totalFillCount: number;
  currentRank: number | null;
  finalRank: number | null;
  finalTier: string | null;
};

let settlementParticipantResults = new Map<string, StoredParticipantResult>();

function emptyParticipantResult(): StoredParticipantResult {
  return {
    totalAssetKrw: new Prisma.Decimal(0),
    totalReturnRate: new Prisma.Decimal(0),
    maxDrawdown: new Prisma.Decimal(0),
    totalFillCount: 0,
    currentRank: null,
    finalRank: null,
    finalTier: null,
  };
}

function recordSettlementParticipantResult(
  id: string,
  data: Record<string, unknown>,
) {
  const stored =
    settlementParticipantResults.get(id) ?? emptyParticipantResult();
  const decimal = (value: unknown, fallback: Prisma.Decimal) =>
    value === undefined ? fallback : new Prisma.Decimal(value as string);

  settlementParticipantResults.set(id, {
    totalAssetKrw: decimal(data.totalAssetKrw, stored.totalAssetKrw),
    totalReturnRate: decimal(data.totalReturnRate, stored.totalReturnRate),
    maxDrawdown: decimal(data.maxDrawdown, stored.maxDrawdown),
    totalFillCount:
      data.totalFillCount === undefined
        ? stored.totalFillCount
        : (data.totalFillCount as number),
    currentRank:
      data.currentRank === undefined
        ? stored.currentRank
        : (data.currentRank as number | null),
    finalRank:
      data.finalRank === undefined
        ? stored.finalRank
        : (data.finalRank as number | null),
    finalTier:
      data.finalTier === undefined
        ? stored.finalTier
        : (data.finalTier as string | null),
  });
}

function accountParticipant(
  id: string,
  userId: string,
  participantStatus = 'active',
) {
  return {
    id,
    userId,
    participantStatus,
    tradingAccountId: `account-of-${id}`,
    tradingAccount: {
      id: `account-of-${id}`,
      mode: 'season',
      status: 'active',
      userId,
      closedAt: null,
      seasonParticipant: { id },
    },
  };
}

function mockSeason(prisma: PrismaMock, status: SeasonStatus) {
  prisma.season.findUnique.mockResolvedValue({
    id: 'season-1',
    status,
    endAt: SEASON_END_AT,
  });
  prisma.__tx.$queryRaw.mockResolvedValue([
    {
      id: 'season-1',
      status,
      start_at: new Date('2026-05-01T00:00:00.000Z'),
      end_at: SEASON_END_AT,
    },
  ]);
}

function mockParticipants(
  prisma: PrismaMock,
  participants: Array<{ id: string; userId: string }>,
) {
  // Settlement resolves the participant → season account map from THIS query
  // (작업 8 보완 §A-1), so the fixture carries the scope columns every ranking
  // participant read selects.
  prisma.seasonParticipant.findMany.mockResolvedValue(
    participants.map((participant) => ({
      totalFillCount: 0,
      seasonId: 'season-1',
      participantStatus: 'active',
      tradingAccountId: `account-of-${participant.id}`,
      tradingAccount: {
        id: `account-of-${participant.id}`,
        mode: 'season',
        status: 'active',
        userId: participant.userId,
      },
      ...participant,
    })),
  );
  prisma.seasonParticipant.count.mockResolvedValue(participants.length);
  accountParticipants = participants.map((participant) =>
    accountParticipant(participant.id, participant.userId),
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
  // update/updateMany keep the stateful transaction implementation from
  // createPrismaMock: 작업 8 보완 §A-2 reads the participant results back inside
  // the same transaction, so a flat mockResolvedValue would hide the write.
}

function snapshot(
  seasonParticipantId: string,
  userId: string,
  totalAssetKrw: string,
  returnRate = '0.00000000',
  capturedAt = new Date('2026-05-21T00:00:10.000Z'),
) {
  return {
    id: `snapshot-${seasonParticipantId}`,
    seasonParticipantId,
    // Ranking-input scope columns (작업 8 보완 §A-1): a season daily snapshot is
    // scoped to its participant's season account and carries NO general-mode
    // performance column.
    tradingAccountId: `account-of-${seasonParticipantId}`,
    cumulativeExternalFundingKrw: null,
    investmentPnlKrw: null,
    timeWeightedReturnFactor: null,
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
    seasonId: 'season-1',
    seasonParticipantId,
    // Existing final rankings are re-verified before they are reused as a
    // settlement result (작업 8 §14.5), so the fixture carries its scope.
    tradingAccountId: `account-of-${seasonParticipantId}`,
    rank,
    totalAssetKrw: new Prisma.Decimal('1000.00000000'),
    returnRate: new Prisma.Decimal('0.00000000'),
    maxDrawdown: new Prisma.Decimal('0.00000000'),
    totalFillCount: 0,
    reachedReturnAt: null,
    seasonParticipant: {
      id: seasonParticipantId,
      seasonId: 'season-1',
      userId,
      tradingAccountId: `account-of-${seasonParticipantId}`,
      tradingAccount: {
        id: `account-of-${seasonParticipantId}`,
        mode: 'season',
        userId,
      },
    },
  };
}
