jest.mock('../prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { HttpException } from '@nestjs/common';
import { RewardsService } from './rewards.service';

type PrismaMock = ReturnType<typeof createPrismaMock>;

describe('RewardsService', () => {
  it('returns empty state when no rewards exist', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 0 }]);
    prisma.$queryRaw.mockResolvedValueOnce([]);

    const response = await service.getMyRewards('user-1');

    expect(response).toEqual({
      success: true,
      data: {
        state: 'empty',
        items: [],
        pagination: {
          limit: 50,
          offset: 0,
          total: 0,
          returned: 0,
          nextOffset: null,
        },
      },
    });
    expect(queryValues(prisma)).toEqual(['user-1', 50, 0]);
  });

  it('returns only authenticated user rewards', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 5 }]);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        seasonId: 'season-1',
        seasonName: 'Season 1',
        rewardType: 'badge',
        rewardCode: 'TIER_GOLD',
        rewardName: '골드 뱃지',
        grantedAt: new Date('2026-05-23T00:00:00.000Z'),
        finalRank: 12,
        finalTier: 'gold',
        createdAt: new Date('2026-05-23T00:00:01.000Z'),
      },
    ]);

    const response = await service.getMyRewards('user-1', {
      limit: '200',
      offset: '3',
    });

    expect(queryValues(prisma)).toEqual(['user-1', 100, 3]);
    expect(response.data).toEqual({
      state: 'available',
      items: [
        {
          seasonId: 'season-1',
          seasonName: 'Season 1',
          rewardType: 'badge',
          rewardCode: 'TIER_GOLD',
          rewardName: '골드 뱃지',
          grantedAt: '2026-05-23T00:00:00.000Z',
          finalRank: 12,
          finalTier: 'gold',
        },
      ],
      pagination: {
        limit: 100,
        offset: 3,
        total: 5,
        returned: 1,
        nextOffset: 4,
      },
    });
  });

  it('returns fulfilled internal SeasonReward rows through user rewards API', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        seasonId: 'season-1',
        seasonName: 'Season 1',
        rewardType: 'internal',
        rewardCode: 'manual_reward_2026_001',
        rewardName: '시즌 보상',
        grantedAt: new Date('2026-06-09T00:00:00.000Z'),
        finalRank: 1,
        finalTier: 'master',
        createdAt: new Date('2026-06-09T00:00:01.000Z'),
      },
    ]);

    const response = await service.getMyRewards('user-1');

    expect(response.data.items).toEqual([
      {
        seasonId: 'season-1',
        seasonName: 'Season 1',
        rewardType: 'internal',
        rewardCode: 'manual_reward_2026_001',
        rewardName: '시즌 보상',
        grantedAt: '2026-06-09T00:00:00.000Z',
        finalRank: 1,
        finalTier: 'master',
      },
    ]);
  });

  it('returns only authenticated user badges', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ count: 1 }]);
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        badgeId: 'badge-1',
        badgeType: 'tier_badge',
        code: 'TIER_GOLD',
        name: '골드 뱃지',
        description: null,
        iconUrl: null,
        seasonId: 'season-1',
        seasonName: 'Season 1',
        awardedAt: new Date('2026-05-23T00:00:00.000Z'),
        createdAt: new Date('2026-05-23T00:00:01.000Z'),
      },
    ]);

    const response = await service.getMyBadges('user-1');

    expect(queryValues(prisma)).toEqual(['user-1', 50, 0]);
    expect(response.data).toEqual({
      state: 'available',
      items: [
        {
          badgeId: 'badge-1',
          badgeType: 'tier_badge',
          code: 'TIER_GOLD',
          name: '골드 뱃지',
          description: null,
          iconUrl: null,
          seasonId: 'season-1',
          seasonName: 'Season 1',
          awardedAt: '2026-05-23T00:00:00.000Z',
        },
      ],
      pagination: {
        limit: 50,
        offset: 0,
        total: 1,
        returned: 1,
        nextOffset: null,
      },
    });
  });

  it('does not mutate DB for rewards or badges reads', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([]);

    await service.getMyRewards('user-1');
    await service.getMyBadges('user-1');

    expectNoWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service, prisma } = createService();

    await expect(service.getMyRewards(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

function createService() {
  const prisma = createPrismaMock();
  const service = new RewardsService(prisma as never);

  return {
    service,
    prisma,
  };
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    badge: writeModelMock(),
    userBadge: writeModelMock(),
    seasonReward: writeModelMock(),
    seasonParticipant: writeModelMock(),
  };
}

function writeModelMock() {
  return {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  };
}

function queryValues(prisma: PrismaMock) {
  return prisma.$queryRaw.mock.calls.at(-1)?.slice(1) ?? [];
}

function expectNoWrites(prisma: PrismaMock) {
  expect(prisma.$executeRaw).not.toHaveBeenCalled();

  for (const model of [
    prisma.badge,
    prisma.userBadge,
    prisma.seasonReward,
    prisma.seasonParticipant,
  ]) {
    for (const method of [
      'create',
      'update',
      'updateMany',
      'upsert',
      'delete',
      'deleteMany',
    ] as const) {
      expect(model[method]).not.toHaveBeenCalled();
    }
  }
}
