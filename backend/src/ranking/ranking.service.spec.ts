jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
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
  };
});

import { HttpException } from '@nestjs/common';
import {
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

  const rankingRow = (rank: number, seasonParticipantId = `sp-${rank}`) => {
    const day = Math.min(rank, 9).toString().padStart(2, '0');

    return {
      rank,
      seasonParticipantId,
      totalAssetKrw: new Prisma.Decimal(`${1000000 - rank}.00000000`),
      returnRate: new Prisma.Decimal('10.00000000'),
      maxDrawdown: new Prisma.Decimal('2.50000000'),
      totalFillCount: rank,
      reachedReturnAt:
        rank === 2 ? null : new Date(`2026-05-${day}T00:10:00.000Z`),
      capturedAt,
      seasonParticipant: {
        userId: `user-${rank}`,
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
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(2);
    prisma.seasonRanking.findMany.mockResolvedValueOnce([
      rankingRow(1),
      rankingRow(2),
    ]);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      rank: 2,
      seasonParticipantId: 'sp-2',
      totalAssetKrw: new Prisma.Decimal('999998.00000000'),
      returnRate: new Prisma.Decimal('9.00000000'),
      maxDrawdown: new Prisma.Decimal('3.00000000'),
      totalFillCount: 4,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
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
    prisma.seasonRanking.findMany.mockResolvedValueOnce([rankingRow(1)]);

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
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(25);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      rank: 15,
      seasonParticipantId: 'sp-15',
      totalAssetKrw: new Prisma.Decimal('999985.00000000'),
      returnRate: new Prisma.Decimal('5.00000000'),
      maxDrawdown: new Prisma.Decimal('4.00000000'),
      totalFillCount: 7,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        finalTier: null,
      },
    });
    prisma.seasonRanking.findMany.mockResolvedValueOnce(
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
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      rank: 50,
      seasonParticipantId: 'sp-50',
      totalAssetKrw: new Prisma.Decimal('999950.00000000'),
      returnRate: new Prisma.Decimal('5.00000000'),
      maxDrawdown: new Prisma.Decimal('4.00000000'),
      totalFillCount: 8,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        finalTier: null,
      },
    });
    prisma.seasonRanking.findMany.mockResolvedValueOnce(
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
    });
    prisma.seasonRanking.count.mockResolvedValueOnce(100);
    prisma.seasonRanking.findUnique.mockResolvedValueOnce({
      rank: 11,
      seasonParticipantId: 'sp-11',
      totalAssetKrw: new Prisma.Decimal('999989.00000000'),
      returnRate: new Prisma.Decimal('8.00000000'),
      maxDrawdown: new Prisma.Decimal('2.00000000'),
      totalFillCount: 11,
      reachedReturnAt: null,
      capturedAt,
      seasonParticipant: {
        finalTier: 'diamond',
      },
    });
    prisma.seasonRanking.findMany.mockResolvedValueOnce([
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
});
