jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
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
import { RankingRefreshService } from './ranking-refresh.service';

describe('RankingRefreshService', () => {
  const capturedAt = new Date('2026-06-10T00:10:00.000Z');

  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      season: {
        findUnique: jest.fn(),
      },
      seasonParticipant: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      seasonRanking: {
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
      prisma.seasonParticipant.findMany.mock.calls[0][0].where
        .participantStatus.in,
    ).not.toContain(ParticipantStatus.excluded);
    expect(prisma.seasonRanking.deleteMany).toHaveBeenCalledWith({
      where: {
        seasonId: 'season-1',
        rankType: SeasonRankingType.daily,
        rankingDate: new Date('2026-06-10T00:00:00.000Z'),
      },
    });
  });
});
