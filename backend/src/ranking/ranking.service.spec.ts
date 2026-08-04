jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    TradingAccountMode: { season: 'season', general: 'general' },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    Prisma: {
      Decimal,
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
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
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
  SeasonStatus,
} from '../generated/prisma/client';
import { RankingService } from './ranking.service';

describe('RankingService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const rankingDate = new Date('2026-05-07T00:00:00.000Z');
  const capturedAt = new Date('2026-05-07T00:10:00.000Z');

  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
  };

  const createPrisma = () => ({
    season: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    seasonRanking: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
    },
    fxExecuteRequest: {
      create: jest.fn(),
      update: jest.fn(),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new RankingService(prisma as never);

    return { prisma, service };
  };

  const expectNoRankingWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.seasonRanking,
      prisma.dailyPortfolioSnapshot,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.seasonRanking.deleteMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  /**
   * 작업 8 §11: every ranking row is selected WITH its account scope and
   * verified against its participant before the page is returned. The scope
   * columns below are internal — `formatRankingRow` never emits them, which the
   * "no tradingAccountId in the public response" test asserts directly.
   */
  const rankingScopeFor = (seasonParticipantId: string, userId: string) => ({
    seasonId: 'season-1',
    seasonParticipantId,
    tradingAccountId: `account-${seasonParticipantId}`,
    seasonParticipant: {
      id: seasonParticipantId,
      seasonId: 'season-1',
      userId,
      tradingAccountId: `account-${seasonParticipantId}`,
      tradingAccount: {
        id: `account-${seasonParticipantId}`,
        mode: 'season',
        userId,
      },
    },
  });

  /**
   * 작업 8 보완 §A-4: `getRanking` now issues TWO `seasonRanking.findMany` calls
   * — the whole-set scope preflight first, then the paginated window. Tests
   * queue both; by default the set and the page are the same rows, and a test
   * that wants damage OUTSIDE the window passes a wider `setRows`.
   */
  const mockRankingRows = (
    prisma: ReturnType<typeof createPrisma>,
    pageRows: unknown[],
    setRows: unknown[] = pageRows,
  ) => {
    prisma.seasonRanking.findMany
      .mockResolvedValueOnce(setRows)
      .mockResolvedValueOnce(pageRows);
  };

  const rankingRow = (rank: number, seasonParticipantId = `sp-${rank}`) => {
    const day = Math.min(rank, 9).toString().padStart(2, '0');
    const userId = `user-${rank}`;
    const scope = rankingScopeFor(seasonParticipantId, userId);

    return {
      ...scope,
      id: `ranking-${seasonParticipantId}`,
      rank,
      totalAssetKrw: new Prisma.Decimal(`${1000000 - rank}.00000000`),
      returnRate: new Prisma.Decimal('10.00000000'),
      maxDrawdown: new Prisma.Decimal('2.50000000'),
      totalFillCount: rank,
      reachedReturnAt:
        rank === 2 ? null : new Date(`2026-05-${day}T00:10:00.000Z`),
      capturedAt,
      seasonParticipant: {
        ...scope.seasonParticipant,
        finalTier: null,
        user: {
          nickname: `trader-${rank}`,
          profileImageUrl: rank === 1 ? 'https://example.com/p.png' : null,
        },
      },
    };
  };

  const mockAvailableRanking = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-2',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: null,
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(2);
    mockRankingRows(prisma, [rankingRow(1), rankingRow(2)]);
    const myScope = rankingScopeFor('sp-2', 'user-2');
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      ...myScope,
      id: 'ranking-sp-2',
      rank: 2,
      totalAssetKrw: new Prisma.Decimal('999998.00000000'),
      returnRate: new Prisma.Decimal('9.00000000'),
      maxDrawdown: new Prisma.Decimal('3.00000000'),
      totalFillCount: 4,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        ...myScope.seasonParticipant,
        finalTier: null,
      },
    });
  };

  it('returns latest rankingDate ranking list and myRanking', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockAvailableRanking(prisma);

    const response = await service.getRanking('user-2', {});

    expect(response.data).toMatchObject({
      state: 'available',
      rankType: SeasonRankingType.daily,
      rankingDate: '2026-05-07',
      capturedAt: '2026-05-07T00:10:00.000Z',
      pagination: {
        limit: 50,
        offset: 0,
        total: 2,
        returned: 2,
        nextOffset: null,
      },
      rankings: [
        {
          rank: 1,
          seasonParticipantId: 'sp-1',
          userId: 'user-1',
          nickname: 'trader-1',
          profileImageUrl: 'https://example.com/p.png',
          totalAssetKrw: '999999.00000000',
          returnRate: '10.00000000',
          maxDrawdown: '2.50000000',
          totalFillCount: 1,
          reachedReturnAt: '2026-05-01T00:10:00.000Z',
          percentile: '50.00000000',
          provisionalTier: 'master',
          finalTier: null,
        },
        {
          rank: 2,
          seasonParticipantId: 'sp-2',
          userId: 'user-2',
          nickname: 'trader-2',
          profileImageUrl: null,
          percentile: '100.00000000',
          provisionalTier: 'silver',
          finalTier: null,
        },
      ],
      myRanking: {
        state: 'available',
        rank: 2,
        seasonParticipantId: 'sp-2',
        totalAssetKrw: '999998.00000000',
        returnRate: '9.00000000',
        maxDrawdown: '3.00000000',
        totalFillCount: 4,
        reachedReturnAt: null,
        rankingDate: '2026-05-07',
        percentile: '100.00000000',
        provisionalTier: 'silver',
        finalTier: null,
      },
    });
    expectNoRankingWrites(prisma);
  });

  it('hides myRanking when the joined participant is ranking hidden', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-2',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: new Date('2026-05-07T00:20:00.000Z'),
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(1);
    mockRankingRows(prisma, [rankingRow(1)]);

    const response = await service.getRanking('user-2', {});

    expect(response.data.rankings).toHaveLength(1);
    expect(response.data.myRanking).toMatchObject({
      state: 'unavailable',
      reason: 'RANKING_HIDDEN',
    });
    expect(prisma.seasonRanking.findUnique).not.toHaveBeenCalled();
    expectNoRankingWrites(prisma);
  });

  it('uses explicit seasonId and rankingDate', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    mockAvailableRanking(prisma);

    const response = await service.getRanking('user-2', {
      seasonId: 'season-1',
      rankingDate: '2026-05-07',
      rankType: 'daily',
      limit: '10',
      offset: '5',
    });

    expect(response.data.pagination).toMatchObject({
      limit: 10,
      offset: 5,
    });
    expect(prisma.season.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'season-1',
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
    expect(prisma.seasonRanking.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonId: 'season-1',
          rankType: SeasonRankingType.daily,
          rankingDate,
        },
      }),
    );
    expectNoRankingWrites(prisma);
  });

  it('keeps subsequent offset pages pinned to the requested capturedAt snapshot', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockAvailableRanking(prisma);

    const response = await service.getRanking('user-2', {
      rankingDate: '2026-05-07',
      capturedAt: capturedAt.toISOString(),
      limit: '1',
      offset: '1',
    });

    expect(response.data.capturedAt).toBe(capturedAt.toISOString());
    expect(prisma.seasonRanking.count).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        rankType: SeasonRankingType.daily,
        rankingDate,
        capturedAt,
        seasonParticipant: {
          participantStatus: {
            not: ParticipantStatus.excluded,
          },
          rankingHiddenAt: null,
        },
      },
    });
    expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          capturedAt,
        }),
        skip: 1,
        take: 1,
      }),
    );
    expectNoRankingWrites(prisma);
  });

  it('returns RANKING_SNAPSHOT_CHANGED when requested capturedAt differs from the latest snapshot', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });

    await expect(
      service.getRanking('user-2', {
        rankingDate: '2026-05-07',
        capturedAt: '2026-05-07T00:09:00.000Z',
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'RANKING_SNAPSHOT_CHANGED',
        },
      },
      status: 409,
    });
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expectNoRankingWrites(prisma);
  });

  it('rejects non-UTC ranking capturedAt query values', async () => {
    const { service } = createService();

    await expect(
      service.getRanking('user-1', {
        capturedAt: '2026-05-07T09:10:00+09:00',
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns myRanking not_joined when user has not joined', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
    prisma.seasonRanking.count.mockResolvedValueOnce(1);
    mockRankingRows(prisma, [rankingRow(1)]);

    const response = await service.getRanking('user-x', {});

    expect(response.data.myRanking).toEqual({
      state: 'not_joined',
      reason: 'SEASON_NOT_JOINED',
      message: 'My ranking is available after joining the season.',
    });
    expect(prisma.seasonRanking.findUnique).not.toHaveBeenCalled();
    expectNoRankingWrites(prisma);
  });

  it('limits scope=top10 to the first ten ranking rows', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-15',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: null,
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(25);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      ...rankingScopeFor('sp-15', 'user-15'),
      id: 'ranking-sp-15',
      rank: 15,
      totalAssetKrw: new Prisma.Decimal('999985.00000000'),
      returnRate: new Prisma.Decimal('5.00000000'),
      maxDrawdown: new Prisma.Decimal('4.00000000'),
      totalFillCount: 7,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        ...rankingScopeFor('sp-15', 'user-15').seasonParticipant,
        finalTier: null,
      },
    });
    mockRankingRows(
      prisma,
      Array.from({ length: 10 }, (_, index) => rankingRow(index + 1)),
    );

    const response = await service.getRanking('user-15', {
      scope: 'top10',
      limit: '50',
    });

    expect(response.data.pagination).toMatchObject({
      limit: 10,
      offset: 0,
      total: 10,
      returned: 10,
      nextOffset: null,
    });
    expect(response.data.rankings).toHaveLength(10);
    expect(response.data.rankings[9].rank).toBe(10);
    expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          rank: {
            lte: 10,
          },
        }),
        skip: 0,
        take: 10,
      }),
    );
    expectNoRankingWrites(prisma);
  });

  it('returns a scope=near_me window around my ranking', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-50',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: null,
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      ...rankingScopeFor('sp-50', 'user-50'),
      id: 'ranking-sp-50',
      rank: 50,
      totalAssetKrw: new Prisma.Decimal('999950.00000000'),
      returnRate: new Prisma.Decimal('5.00000000'),
      maxDrawdown: new Prisma.Decimal('4.00000000'),
      totalFillCount: 8,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        ...rankingScopeFor('sp-50', 'user-50').seasonParticipant,
        finalTier: null,
      },
    });
    mockRankingRows(
      prisma,
      Array.from({ length: 10 }, (_, index) => rankingRow(index + 45)),
    );

    const response = await service.getRanking('user-50', {
      scope: 'near_me',
      limit: '10',
    });

    expect(response.data.pagination).toMatchObject({
      limit: 10,
      offset: 44,
      total: 100,
      returned: 10,
      nextOffset: 54,
    });
    expect(response.data.rankings.map((row) => row.rank)).toEqual([
      45, 46, 47, 48, 49, 50, 51, 52, 53, 54,
    ]);
    expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 44,
        take: 10,
      }),
    );
    expectNoRankingWrites(prisma);
  });

  it('returns finalTier for final rankings without mutating participants', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce({
      rankingDate,
      capturedAt,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-11',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: null,
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      ...rankingScopeFor('sp-11', 'user-11'),
      id: 'ranking-sp-11',
      rank: 11,
      totalAssetKrw: new Prisma.Decimal('999989.00000000'),
      returnRate: new Prisma.Decimal('8.00000000'),
      maxDrawdown: new Prisma.Decimal('2.00000000'),
      totalFillCount: 11,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        ...rankingScopeFor('sp-11', 'user-11').seasonParticipant,
        finalTier: 'diamond',
      },
    });
    mockRankingRows(prisma, [
      {
        ...rankingRow(11, 'sp-11'),
        seasonParticipant: {
          ...rankingRow(11, 'sp-11').seasonParticipant,
          finalTier: 'diamond',
        },
      },
    ]);

    const response = await service.getRanking('user-11', {
      rankType: 'final',
    });

    expect(response.data.rankings[0]).toMatchObject({
      rank: 11,
      percentile: '11.00000000',
      provisionalTier: null,
      finalTier: 'diamond',
    });
    expect(response.data.myRanking).toMatchObject({
      state: 'available',
      rank: 11,
      percentile: '11.00000000',
      provisionalTier: null,
      finalTier: 'diamond',
    });
    expectNoRankingWrites(prisma);
  });

  it('returns unavailable when ranking rows do not exist', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
      participantStatus: ParticipantStatus.active,
      rankingHiddenAt: null,
    });

    const response = await service.getRanking('user-1', {});

    expect(response.data).toMatchObject({
      state: 'unavailable',
      reason: 'RANKING_UNAVAILABLE',
      rankingDate: null,
      rankings: [],
      pagination: {
        total: 0,
        returned: 0,
        nextOffset: null,
      },
      myRanking: {
        state: 'unavailable',
        reason: 'MY_RANKING_UNAVAILABLE',
      },
    });
    expect(prisma.seasonRanking.findMany).not.toHaveBeenCalled();
    expectNoRankingWrites(prisma);
  });

  it('returns unavailable when no current season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getRanking('user-1', {});

    expect(response.data).toMatchObject({
      state: 'unavailable',
      season: null,
      reason: 'CURRENT_SEASON_NOT_FOUND',
      rankings: [],
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoRankingWrites(prisma);
  });

  it('rejects invalid rankType', async () => {
    const { service } = createService();

    await expect(
      service.getRanking('user-1', { rankType: 'weekly' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects invalid rankingDate', async () => {
    const { service } = createService();

    await expect(
      service.getRanking('user-1', { rankingDate: '2026-02-31' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects invalid scope', async () => {
    const { service } = createService();

    await expect(
      service.getRanking('user-1', { scope: 'friends' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('clamps limit to max 100', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockAvailableRanking(prisma);

    const response = await service.getRanking('user-2', {
      limit: '150',
    });

    expect(response.data.pagination.limit).toBe(100);
    expect(prisma.seasonRanking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
    expectNoRankingWrites(prisma);
  });

  it('rejects invalid limit and offset', async () => {
    const { service } = createService();

    await expect(
      service.getRanking('user-1', { limit: '0' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getRanking('user-1', { offset: '-1' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getRanking(undefined, {})).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  // ----------------------------------------------------------- 작업 8 보완
  // §A-4: the WHOLE selected snapshot is verified, not just the page. A
  // damaged row outside the pagination window used to leave the visible pages
  // returning a clean 200 over a leaderboard nobody had checked.

  describe('§A-4 whole-set scope preflight', () => {
    const damagedRow = (rank: number, overrides: Record<string, unknown>) => ({
      ...rankingRow(rank),
      ...overrides,
    });

    const setupHundredRowSeason = (
      prisma: ReturnType<typeof createPrisma>,
      damaged: unknown,
    ) => {
      mockCurrentSeason(prisma);
      prisma.seasonRanking.findFirst.mockResolvedValueOnce({
        rankingDate,
        capturedAt,
      });
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
      prisma.seasonRanking.count.mockResolvedValue(100);

      const page = Array.from({ length: 50 }, (_, index) =>
        rankingRow(index + 1),
      );
      const wholeSet = [
        ...Array.from({ length: 99 }, (_, index) => rankingRow(index + 1)),
        damaged,
      ];
      mockRankingRows(prisma, page, wholeSet);
    };

    it('fails the FIRST page when row 100 has a null trading account scope', async () => {
      const { service, prisma } = createService();
      setupHundredRowSeason(
        prisma,
        damagedRow(100, { tradingAccountId: null }),
      );

      await expect(
        service.getRanking('user-x', { limit: '50', offset: '0' }),
      ).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        response: {
          error: { code: 'SEASON_RANKING_SCOPE_REPAIR_REQUIRED' },
        },
      });
    });

    it('fails top10 when a row outside the top ten is mis-scoped', async () => {
      const { service, prisma } = createService();
      setupHundredRowSeason(
        prisma,
        damagedRow(100, { tradingAccountId: 'account-sp-1' }),
      );

      await expect(
        service.getRanking('user-x', { scope: 'top10' }),
      ).rejects.toMatchObject({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        response: { error: { code: 'SEASON_RANKING_SCOPE_MISMATCH' } },
      });
    });

    it('preflights the whole snapshot key before the page query', async () => {
      const { service, prisma } = createService();
      mockCurrentSeason(prisma);
      mockAvailableRanking(prisma);

      await service.getRanking('user-2', {});

      expect(prisma.seasonRanking.findMany.mock.calls[0][0]).toMatchObject({
        where: {
          seasonId: 'season-1',
          rankType: SeasonRankingType.daily,
          rankingDate,
          capturedAt,
        },
      });
      // The preflight carries NO pagination and NO public participant filter:
      // it is about the set, not about what this caller can see.
      expect(
        prisma.seasonRanking.findMany.mock.calls[0][0].skip,
      ).toBeUndefined();
      expect(
        prisma.seasonRanking.findMany.mock.calls[0][0].take,
      ).toBeUndefined();
      expect(
        prisma.seasonRanking.findMany.mock.calls[0][0].where.seasonParticipant,
      ).toBeUndefined();
    });

    it('never exposes tradingAccountId in the public payload of a healthy set', async () => {
      const { service, prisma } = createService();
      mockCurrentSeason(prisma);
      mockAvailableRanking(prisma);

      const response = await service.getRanking('user-2', {});

      expect(JSON.stringify(response)).not.toContain('tradingAccountId');
      expect(JSON.stringify(response)).not.toContain('account-sp-');
      expect(response.data.state).toBe('available');
      expect(response.data.rankings).toHaveLength(2);
    });

    it('keeps the unavailable contract when the snapshot has no rows at all', async () => {
      const { service, prisma } = createService();
      mockCurrentSeason(prisma);
      prisma.seasonRanking.findFirst.mockResolvedValueOnce(null);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

      const response = await service.getRanking('user-x', {});

      expect(response.data.state).toBe('unavailable');
      expect(response.data.reason).toBe('RANKING_UNAVAILABLE');
      expect(prisma.seasonRanking.findMany).not.toHaveBeenCalled();
    });
  });
});
