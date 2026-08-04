jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    TradingAccountMode: { season: 'season', general: 'general' },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
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
    SnapshotReason: {
      scheduled: 'scheduled',
    },
  };
});

jest.mock('../portfolio/portfolio-valuation.service', () => ({
  PortfolioValuationService: class PortfolioValuationService {},
}));

import {
  ParticipantStatus,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { Prisma } from '../generated/prisma/client';
import { RankingRefreshService } from './ranking-refresh.service';

const { Decimal } = Prisma;

describe('RankingRefreshService', () => {
  const capturedAt = new Date('2026-06-10T00:10:00.000Z');

  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      // The write transaction takes the season row lock before it touches
      // anything (작업 8 §13.1); the mock returns the season as still active so
      // this suite keeps testing candidate selection, not the lock.
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'season-1',
          status: SeasonStatus.active,
          start_at: new Date('2026-06-01T00:00:00.000Z'),
          end_at: new Date('2026-06-30T00:00:00.000Z'),
        },
      ]),
      season: {
        findUnique: jest.fn(),
      },
      seasonParticipant: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      seasonRanking: {
        // 작업 8 보완 §A-3: the existing set is read and verified BEFORE it is
        // deleted, so routine refresh cannot launder scope damage.
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      equitySnapshot: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));

    return prisma;
  };

  it('does not include excluded participants in current ranking refresh candidates', async () => {
    const prisma = createPrisma();
    const service = new RankingRefreshService(prisma as never, {} as never);
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.active,
      startAt: new Date('2026-06-01T00:00:00.000Z'),
      endAt: new Date('2026-06-30T00:00:00.000Z'),
    });
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([]);
    prisma.seasonRanking.deleteMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.refreshCurrentRankingForSeason('season-1', {
      capturedAt,
      createEquitySnapshots: false,
    });

    expect(result).toMatchObject({
      skipped: false,
      rankingsCreated: 0,
      rankingDate: '2026-06-10',
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
    expect(prisma.seasonRanking.deleteMany).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        rankType: SeasonRankingType.daily,
        rankingDate: new Date('2026-06-10T00:00:00.000Z'),
      },
    });
  });
  // ----------------------------------------------------------- 작업 8 보완
  // §A-3: routine refresh must not DELETE a damaged ranking set. The refresh
  // policy is delete-then-recreate with correct scopes, so without this the
  // five-minute tick quietly erases exactly the damage the repair script
  // exists to find and count.

  describe('§A-3 refusal to delete a damaged existing ranking set', () => {
    const scopedParticipant = (id: string, userId: string) => ({
      id,
      seasonId: 'season-1',
      userId,
      participantStatus: ParticipantStatus.active,
      tradingAccountId: `account-of-${id}`,
      tradingAccount: {
        id: `account-of-${id}`,
        mode: 'season',
        status: 'active',
        userId,
        // The ranking WRITER additionally verifies the reverse link.
        seasonParticipant: { id },
      },
      initialCapitalKrw: new Decimal('1000000'),
      totalFillCount: 0,
    });

    const existingRankingRow = (
      id: string,
      seasonParticipantId: string,
      userId: string,
      overrides: Record<string, unknown> = {},
    ) => ({
      id,
      seasonId: 'season-1',
      seasonParticipantId,
      tradingAccountId: `account-of-${seasonParticipantId}`,
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
      ...overrides,
    });

    const setup = (existingRows: unknown[]) => {
      const prisma = createPrisma();
      const valuation = {
        calculateSeasonParticipantValuation: jest.fn().mockResolvedValue({
          totalAssetKrw: '1000000.00000000',
          returnRate: '0.00000000',
          krwCash: '1000000.00000000',
          usdCashKrw: '0.00000000',
          domesticStockValueKrw: '0.00000000',
          usStockValueKrw: '0.00000000',
          cryptoValueKrw: '0.00000000',
        }),
      };
      const service = new RankingRefreshService(
        prisma as never,
        valuation as never,
      );
      prisma.season.findUnique.mockResolvedValue({
        id: 'season-1',
        status: SeasonStatus.active,
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-30T00:00:00.000Z'),
      });
      prisma.seasonParticipant.findMany.mockResolvedValue([
        scopedParticipant('sp-1', 'user-1'),
      ]);
      prisma.equitySnapshot.findMany.mockResolvedValue([]);
      prisma.seasonRanking.findMany.mockResolvedValue(existingRows);
      prisma.seasonRanking.deleteMany.mockResolvedValue({ count: 0 });
      prisma.seasonRanking.create.mockResolvedValue({ id: 'new-ranking' });
      prisma.seasonParticipant.update.mockResolvedValue({ id: 'sp-1' });

      return { prisma, service };
    };

    const expectRefreshAborted = async (
      prisma: ReturnType<typeof createPrisma>,
      service: RankingRefreshService,
      code: string,
    ): Promise<void> => {
      await expect(
        service.refreshCurrentRankingForSeason('season-1', { capturedAt }),
      ).rejects.toMatchObject({
        response: { error: { code } },
      });

      // Nothing was destroyed, nothing was rewritten, and no participant's
      // currentRank moved.
      expect(prisma.seasonRanking.deleteMany).not.toHaveBeenCalled();
      expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
    };

    it('aborts when an existing ranking row has a null trading account scope', async () => {
      const { prisma, service } = setup([
        existingRankingRow('r-1', 'sp-1', 'user-1', {
          tradingAccountId: null,
        }),
      ]);

      await expectRefreshAborted(
        prisma,
        service,
        'SEASON_RANKING_SCOPE_REPAIR_REQUIRED',
      );
    });

    it('aborts when an existing ranking row points at another participant account', async () => {
      const { prisma, service } = setup([
        existingRankingRow('r-1', 'sp-1', 'user-1', {
          tradingAccountId: 'account-of-sp-9',
        }),
      ]);

      await expectRefreshAborted(
        prisma,
        service,
        'SEASON_RANKING_SCOPE_MISMATCH',
      );
    });

    it('aborts when a general account is linked to an existing ranking row', async () => {
      const row = existingRankingRow('r-1', 'sp-1', 'user-1');
      row.seasonParticipant.tradingAccount.mode = 'general';
      const { prisma, service } = setup([row]);

      await expectRefreshAborted(
        prisma,
        service,
        'SEASON_RANKING_SCOPE_MISMATCH',
      );
    });

    it('aborts when an existing ranking row has no participant link', async () => {
      const row = existingRankingRow('r-1', 'sp-1', 'user-1');
      row.seasonParticipant.tradingAccountId = null as unknown as string;
      row.seasonParticipant.tradingAccount = null as never;
      const { prisma, service } = setup([row]);

      await expectRefreshAborted(
        prisma,
        service,
        'TRADING_ACCOUNT_LINK_INTEGRITY',
      );
    });

    it('reads the existing set with the scope columns before deleting it', async () => {
      const { prisma, service } = setup([
        existingRankingRow('r-1', 'sp-1', 'user-1'),
      ]);

      await service.refreshCurrentRankingForSeason('season-1', { capturedAt });

      expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            seasonId: 'season-1',
            rankType: SeasonRankingType.daily,
            rankingDate: new Date('2026-06-10T00:00:00.000Z'),
          },
          select: expect.objectContaining({ tradingAccountId: true }),
        }),
      );
    });

    it('still replaces a correctly scoped existing set', async () => {
      const { prisma, service } = setup([
        existingRankingRow('r-1', 'sp-1', 'user-1'),
      ]);

      const result = await service.refreshCurrentRankingForSeason('season-1', {
        capturedAt,
      });

      expect(result).toMatchObject({ skipped: false, rankingsCreated: 1 });
      expect(prisma.seasonRanking.deleteMany).toHaveBeenCalledTimes(1);
      expect(prisma.seasonRanking.create).toHaveBeenCalledTimes(1);
    });
  });
});
