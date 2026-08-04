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
      // Already assigned, and CONSISTENT with the policy: rank 2 of 2 falls in
      // the silver cutoff. An inconsistent stored tier is now a conflict
      // (작업 8 §16), which the dedicated test below covers.
      finalRanking('sp-2', 'user-2', 2, {
        finalRank: 2,
        finalTier: 'silver',
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
        existingFinalRank: null,
        existingFinalTier: null,
        computedFinalTier: 'master',
        willAssign: true,
        skipReason: null,
      },
      {
        seasonParticipantId: 'sp-2',
        finalRank: 2,
        finalTier: 'silver',
        existingFinalRank: 2,
        existingFinalTier: 'silver',
        computedFinalTier: 'silver',
        willAssign: false,
        skipReason: 'FINAL_RESULT_ALREADY_EXISTS',
      },
    ]);
  });

  it('updates finalRank/finalTier for settled season final rankings in one transaction', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-1', 'user-1', 1)]);

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
    expect(result.participants).toEqual({
      totalFinalRanked: 1,
      wouldAssign: 1,
      assigned: 1,
      existing: 0,
      skipped: 0,
    });
    expect(result.assignedParticipantIds).toEqual(['sp-1']);
  });

  it('uses fixed cumulative cutoff tiers for 100 participants', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(
      prisma,
      Array.from({ length: 100 }, (_, index) =>
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
    expect(updateFor(prisma, 'sp-4')).toMatchObject({
      data: {
        finalRank: 4,
        finalTier: 'master',
      },
    });
    expect(updateFor(prisma, 'sp-5')).toMatchObject({
      data: {
        finalRank: 5,
        finalTier: 'diamond',
      },
    });
    expect(updateFor(prisma, 'sp-11')).toMatchObject({
      data: {
        finalRank: 11,
        finalTier: 'diamond',
      },
    });
    expect(updateFor(prisma, 'sp-12')).toMatchObject({
      data: {
        finalRank: 12,
        finalTier: 'platinum',
      },
    });
    expect(updateFor(prisma, 'sp-23')).toMatchObject({
      data: {
        finalRank: 23,
        finalTier: 'platinum',
      },
    });
    expect(updateFor(prisma, 'sp-24')).toMatchObject({
      data: {
        finalRank: 24,
        finalTier: 'gold',
      },
    });
    expect(updateFor(prisma, 'sp-40')).toMatchObject({
      data: {
        finalRank: 40,
        finalTier: 'gold',
      },
    });
    expect(updateFor(prisma, 'sp-41')).toMatchObject({
      data: {
        finalRank: 41,
        finalTier: 'silver',
      },
    });
    expect(updateFor(prisma, 'sp-70')).toMatchObject({
      data: {
        finalRank: 70,
        finalTier: 'silver',
      },
    });
    expect(updateFor(prisma, 'sp-71')).toMatchObject({
      data: {
        finalRank: 71,
        finalTier: 'bronze',
      },
    });
    expect(result.participants.assigned).toBe(100);
    expect(result.policy.tiers).toMatchObject([
      { tier: 'master', cumulativeRatio: 0.04 },
      { tier: 'diamond', cumulativeRatio: 0.11 },
      { tier: 'platinum', cumulativeRatio: 0.23 },
      { tier: 'gold', cumulativeRatio: 0.4 },
      { tier: 'silver', cumulativeRatio: 0.7 },
      { tier: 'bronze', cumulativeRatio: 1 },
    ]);
  });

  it('uses fixed cumulative cutoff tiers for 10 participants', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(
      prisma,
      Array.from({ length: 10 }, (_, index) =>
        finalRanking(`sp-${index + 1}`, `user-${index + 1}`, index + 1),
      ),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
    });

    expect(result.topAssignments).toMatchObject([
      { finalRank: 1, finalTier: 'master' },
      { finalRank: 2, finalTier: 'diamond' },
      { finalRank: 3, finalTier: 'platinum' },
      { finalRank: 4, finalTier: 'gold' },
      { finalRank: 5, finalTier: 'silver' },
      { finalRank: 6, finalTier: 'silver' },
      { finalRank: 7, finalTier: 'silver' },
      { finalRank: 8, finalTier: 'bronze' },
      { finalRank: 9, finalTier: 'bronze' },
      { finalRank: 10, finalTier: 'bronze' },
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('assigns master for a single final-ranked participant', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [finalRanking('sp-1', 'user-1', 1)]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
      dryRun: true,
    });

    expect(result.topAssignments).toMatchObject([
      {
        finalRank: 1,
        finalTier: 'master',
      },
    ]);
  });

  it('ignores season.rewardPolicyJson tier cutoff overrides', async () => {
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

    expect(result.policy.source).toBe('default_mvp');
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
          finalTier: 'silver',
        }),
      ]),
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  /**
   * 작업 8 §16 REPLACES the old behaviour here.
   *
   * A participant holding a finalRank with no finalTier (or the reverse) used
   * to be counted as "already assigned" and skipped, which left that user with
   * half a result forever and made the job report success. Each of these three
   * states is now a conflict the operator has to resolve by re-running
   * settlement, not something the tier job papers over.
   */
  it('refuses to complete a HALF-assigned final result instead of skipping it', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-rank-only', 'user-1', 1, { finalRank: 1 }),
      finalRanking('sp-new', 'user-2', 2),
    ]);

    await expect(
      service.run({ seasonId: 'season-1', rankingDate }),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: { code: 'FINAL_TIER_ASSIGNMENT_CONFLICT' },
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a stored finalRank that disagrees with the final ranking row', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1, { finalRank: 99, finalTier: 'master' }),
      finalRanking('sp-2', 'user-2', 2),
    ]);

    await expect(
      service.run({ seasonId: 'season-1', rankingDate }),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: { code: 'FINAL_TIER_ASSIGNMENT_CONFLICT' },
      },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a stored finalTier that disagrees with the tier policy', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      // rank 1 of 2 computes to master, not bronze.
      finalRanking('sp-1', 'user-1', 1, { finalRank: 1, finalTier: 'bronze' }),
      finalRanking('sp-2', 'user-2', 2),
    ]);

    await expect(
      service.run({ seasonId: 'season-1', rankingDate }),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: { code: 'FINAL_TIER_ASSIGNMENT_CONFLICT' },
      },
    });
  });

  it('still treats a fully consistent existing result as idempotent', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1, { finalRank: 1, finalTier: 'master' }),
      finalRanking('sp-new', 'user-2', 2),
    ]);

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      rankingDate,
    });

    expect(prisma.__tx.seasonParticipant.updateMany).toHaveBeenCalledTimes(1);
    expect(result.participants).toEqual({
      totalFinalRanked: 2,
      wouldAssign: 1,
      assigned: 1,
      existing: 1,
      skipped: 1,
    });
    expect(result.assignedParticipantIds).toEqual(['sp-new']);
  });

  it('refuses to assign tiers while a settled season still holds an open account', async () => {
    const { service, prisma } = createService();
    mockSeason(prisma, SeasonStatus.settled);
    mockFinalRankings(prisma, [
      finalRanking('sp-1', 'user-1', 1),
      finalRanking('sp-2', 'user-2', 2),
    ]);
    // 작업 8 보완 §A-6: account state comes from the season-wide participant
    // read, not from the final ranking rows.
    mockSeasonAccountParticipants([
      seasonAccountParticipant('sp-1', 'user-1', {
        status: 'active',
        closedAt: null,
      }),
      seasonAccountParticipant('sp-2', 'user-2'),
    ]);

    await expect(
      service.run({ seasonId: 'season-1', rankingDate }),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        error: { code: 'SEASON_ACCOUNT_CLOSE_INCOMPLETE' },
      },
    });
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

  // ----------------------------------------------------------- 작업 8 보완
  // §A-6: EVERY season account is checked, including participants that never
  // appear in a final ranking. Checking only ranked participants let an
  // excluded or registered participant keep a live account in a settled season.

  describe('§A-6 every season account closed', () => {
    const rankedSeason = (prisma: PrismaMock) => {
      mockSeason(prisma, SeasonStatus.settled);
      mockFinalRankings(prisma, [
        finalRanking('sp-1', 'user-1', 1),
        finalRanking('sp-2', 'user-2', 2),
      ]);
    };

    const expectBlocked = (service: FinalTierAssignmentJobService) =>
      expect(
        service.run({ seasonId: 'season-1', rankingDate }),
      ).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { error: { code: 'SEASON_ACCOUNT_CLOSE_INCOMPLETE' } },
      });

    it('blocks when an EXCLUDED participant, absent from the final ranking, still holds an active account', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1'),
        seasonAccountParticipant('sp-2', 'user-2'),
        seasonAccountParticipant('sp-x', 'user-x', {
          participantStatus: 'excluded',
          status: 'active',
          closedAt: null,
        }),
      ]);

      await expectBlocked(service);
      expect(prisma.__tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
    });

    it('blocks when a REGISTERED participant account is suspended', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1'),
        seasonAccountParticipant('sp-2', 'user-2'),
        seasonAccountParticipant('sp-r', 'user-r', {
          participantStatus: 'registered',
          status: 'suspended',
        }),
      ]);

      await expectBlocked(service);
      expect(prisma.__tx.seasonParticipant.updateMany).not.toHaveBeenCalled();
    });

    it('blocks when an account reads as closed but carries closedAt = null', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1', { closedAt: null }),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await expectBlocked(service);
    });

    it('blocks when a participant and its account disagree about the owner', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1', {
          accountUserId: 'someone-else',
        }),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await expectBlocked(service);
    });

    it('blocks when a GENERAL account is linked to a season participant', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1', { mode: 'general' }),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await expectBlocked(service);
    });

    it('blocks when the account back-link points at another participant', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1', {
          backLinkParticipantId: 'sp-9',
        }),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await expectBlocked(service);
    });

    it('refuses instead of closing the account itself', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1', {
          status: 'active',
          closedAt: null,
        }),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await expectBlocked(service);
      // This job has no tradingAccount writer at all: closure stays atomic
      // with settlement, and the recovery is to re-run that job.
      expect(
        (prisma as unknown as Record<string, unknown>).tradingAccount,
      ).toBeUndefined();
    });

    it('proceeds when every participant of the season, ranked or not, is closed', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1'),
        seasonAccountParticipant('sp-2', 'user-2'),
        seasonAccountParticipant('sp-x', 'user-x', {
          participantStatus: 'excluded',
        }),
        seasonAccountParticipant('sp-r', 'user-r', {
          participantStatus: 'registered',
        }),
      ]);

      const result = await runAndGetResult(service, {
        seasonId: 'season-1',
        rankingDate,
      });

      expect(result.participants.assigned).toBe(2);
    });

    it('checks every participant with ONE seasonId query, not one per participant', async () => {
      const { service, prisma } = createService();
      rankedSeason(prisma);
      mockSeasonAccountParticipants([
        seasonAccountParticipant('sp-1', 'user-1'),
        seasonAccountParticipant('sp-2', 'user-2'),
      ]);

      await runAndGetResult(service, { seasonId: 'season-1', rankingDate });

      expect(prisma.seasonParticipant.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { seasonId: 'season-1' } }),
      );
    });
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
      // 작업 8 보완 §A-6: EVERY participant of the settled season, whatever its
      // status, is checked for a closed season account.
      findMany: jest.fn(() => Promise.resolve(finalTierSeasonParticipants())),
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

/**
 * EVERY participant of the settled season, whatever its status (작업 8 보완 §A-6).
 *
 * Deliberately a SEPARATE fixture from the final ranking rows: the whole point
 * of §A-6 is that `excluded` and `registered` participants never appear in a
 * final ranking, yet their season accounts must still be closed.
 */
type SeasonAccountParticipantFixture = {
  id: string;
  userId: string;
  participantStatus: string;
  tradingAccountId: string | null;
  tradingAccount: {
    id: string;
    mode: string;
    status: string;
    userId: string;
    closedAt: Date | null;
    seasonParticipant: { id: string } | null;
  } | null;
};

let seasonAccountParticipants: SeasonAccountParticipantFixture[] = [];

function finalTierSeasonParticipants() {
  return seasonAccountParticipants;
}

function seasonAccountParticipant(
  id: string,
  userId: string,
  options: {
    participantStatus?: string;
    mode?: string;
    status?: string;
    closedAt?: Date | null;
    accountUserId?: string;
    backLinkParticipantId?: string;
  } = {},
): SeasonAccountParticipantFixture {
  const accountId = `account-of-${id}`;

  return {
    id,
    userId,
    participantStatus: options.participantStatus ?? 'finished',
    tradingAccountId: accountId,
    tradingAccount: {
      id: accountId,
      mode: options.mode ?? 'season',
      status: options.status ?? 'closed',
      userId: options.accountUserId ?? userId,
      closedAt:
        options.closedAt === undefined
          ? new Date('2026-05-21T00:00:00.000Z')
          : options.closedAt,
      seasonParticipant: { id: options.backLinkParticipantId ?? id },
    },
  };
}

function mockSeasonAccountParticipants(
  participants: SeasonAccountParticipantFixture[],
) {
  seasonAccountParticipants = participants;
}

function mockFinalRankings(
  prisma: PrismaMock,
  rankings: ReturnType<typeof finalRanking>[],
) {
  prisma.seasonRanking.findMany.mockResolvedValue(rankings);
  // Default: every ranked participant's account is properly closed, so §A-6
  // passes unless a test deliberately breaks one.
  mockSeasonAccountParticipants(
    rankings.map((ranking) =>
      seasonAccountParticipant(
        ranking.seasonParticipantId,
        ranking.seasonParticipant.userId,
      ),
    ),
  );
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
  const accountId = `account-of-${seasonParticipantId}`;

  return {
    id: `ranking-${seasonParticipantId}`,
    seasonId: 'season-1',
    seasonParticipantId,
    // 작업 8: final rankings are account-scoped, and this job re-verifies both
    // the scope and that the settled season's accounts are already closed.
    tradingAccountId: accountId,
    rank,
    totalAssetKrw: new Prisma.Decimal(
      options.totalAssetKrw ?? `${(1000 - rank).toFixed(8)}`,
    ),
    returnRate: new Prisma.Decimal(options.returnRate ?? '0.00000000'),
    seasonParticipant: {
      id: seasonParticipantId,
      seasonId: 'season-1',
      userId,
      tradingAccountId: accountId,
      finalRank: options.finalRank ?? null,
      finalTier: options.finalTier ?? null,
      rewardGrantedAt: options.rewardGrantedAt ?? null,
      tradingAccount: {
        id: accountId,
        mode: 'season',
        status: 'closed',
        userId,
        closedAt: new Date('2026-05-21T00:00:00.000Z'),
      },
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
