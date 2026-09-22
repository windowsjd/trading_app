jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{ Decimal: typeof Prisma.Decimal }>(
    '@prisma/client/runtime/client',
  );
  return {
    Prisma: {
      Decimal,
      TransactionIsolationLevel: { ReadCommitted: 'ReadCommitted' },
    },
    PrismaClient: class PrismaClient {},
    TradingAccountMode: { season: 'season', general: 'general' },
    ParticipantStatus: {
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
    },
    SeasonStatus: { active: 'active' },
    SeasonRankingType: { daily: 'daily', final: 'final' },
    SnapshotReason: { scheduled: 'scheduled' },
  };
});
jest.mock('../portfolio/portfolio-valuation.service', () => ({
  PortfolioValuationService: class PortfolioValuationService {},
}));

import { Prisma } from '../generated/prisma/client';
import { RankingRefreshService } from './ranking-refresh.service';

const capturedAt = new Date('2026-09-22T00:10:00Z');
const pastPeak = new Date('2026-09-22T00:00:00Z');
const pastLow = new Date('2026-09-22T00:05:00Z');
const future = new Date('2026-09-22T00:15:00Z');
const accountId = (index: number) =>
  `account-${String(index).padStart(2, '0')}`;

function snapshot(
  index: number,
  asset: string,
  rate: string,
  at: Date,
  createdAt = at,
) {
  return {
    id: `${accountId(index)}-${createdAt.toISOString()}`,
    tradingAccountId: accountId(index),
    totalAssetKrw: new Prisma.Decimal(asset),
    returnRate: new Prisma.Decimal(rate),
    capturedAt: at,
    createdAt,
    cumulativeExternalFundingKrw: null as Prisma.Decimal | null,
    investmentPnlKrw: null as Prisma.Decimal | null,
    timeWeightedReturnFactor: null as Prisma.Decimal | null,
  };
}

function setup(count = 33) {
  const participants = Array.from({ length: count }, (_, index) => ({
    id: `participant-${index}`,
    seasonId: 'season-1',
    userId: `user-${index}`,
    participantStatus: 'active',
    tradingAccountId: accountId(index),
    tradingAccount: {
      id: accountId(index),
      userId: `user-${index}`,
      mode: 'season',
      status: 'active',
      seasonParticipant: { id: `participant-${index}` },
    },
    initialCapitalKrw: new Prisma.Decimal(1000),
    totalFillCount: index,
  }));
  const histories = participants.flatMap((_, index) => {
    if (index % 3 === 0) {
      return [
        snapshot(index, '2000', '100', pastPeak),
        snapshot(index, '1000', '0', pastLow),
      ];
    }
    if (index % 3 === 1) {
      return [
        snapshot(index, '1000', '0', pastPeak),
        snapshot(index, '900', '-10', capturedAt),
        snapshot(
          index,
          '1200',
          '20',
          capturedAt,
          new Date(capturedAt.getTime() + 1),
        ),
      ];
    }
    return [
      snapshot(index, '2000', '100', pastPeak),
      snapshot(index, '500', '-50', future),
    ];
  });
  const readRows: number[] = [];
  const prisma = {
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([
      {
        id: 'season-1',
        status: 'active',
        start_at: pastPeak,
        end_at: new Date('2026-10-01T00:00:00Z'),
      },
    ]),
    season: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'season-1',
        status: 'active',
        startAt: pastPeak,
        endAt: new Date('2026-10-01T00:00:00Z'),
      }),
    },
    seasonParticipant: {
      findMany: jest.fn().mockResolvedValue(participants),
      update: jest.fn(),
    },
    seasonRanking: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    equitySnapshot: {
      findMany: jest.fn(
        (input: { where: { tradingAccountId: { in: string[] } } }) => {
          const rows = histories.filter((row) =>
            input.where.tradingAccountId.in.includes(row.tradingAccountId),
          );
          readRows.push(rows.length);
          return Promise.resolve(rows);
        },
      ),
      createMany: jest.fn(),
    },
  };
  prisma.$transaction.mockImplementation(
    (callback: (tx: unknown) => Promise<unknown>) => callback(prisma),
  );
  const valuation = {
    calculateTradingAccountValuation: jest.fn((id: string) =>
      Promise.resolve({
        seasonParticipantId: participants.find(
          (participant) => participant.tradingAccountId === id,
        )!.id,
        tradingAccountId: id,
        totalAssetKrw: '1500.00000000',
        returnRate: '50.00000000',
        krwCash: '1500.00000000',
        usdCashKrw: '0.00000000',
        domesticStockValueKrw: '0.00000000',
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
      }),
    ),
  };
  const service = new RankingRefreshService(
    prisma as never,
    valuation as never,
  );
  return { prisma, valuation, service, participants, histories, readRows };
}

describe('current ranking history batches', () => {
  it('reads 16/16/1 complete account histories and publishes the unchanged full ranking', async () => {
    const { service, prisma, participants, valuation, readRows } = setup();

    await expect(
      service.refreshCurrentRankingForSeason('season-1', { capturedAt }),
    ).resolves.toEqual({
      skipped: false,
      rankingsCreated: 33,
      rankingDate: '2026-09-22',
    });

    expect(valuation.calculateTradingAccountValuation).toHaveBeenCalledTimes(
      33,
    );
    expect(prisma.equitySnapshot.findMany).toHaveBeenCalledTimes(3);
    expect(readRows).toEqual([37, 38, 2]);
    for (let batch = 0; batch < 3; batch++) {
      expect(prisma.equitySnapshot.findMany).toHaveBeenNthCalledWith(
        batch + 1,
        {
          where: {
            tradingAccountId: {
              in: participants
                .slice(batch * 16, (batch + 1) * 16)
                .map((participant) => participant.tradingAccountId),
            },
          },
          orderBy: [
            { tradingAccountId: 'asc' },
            { capturedAt: 'asc' },
            { createdAt: 'asc' },
            { id: 'asc' },
          ],
          select: {
            id: true,
            tradingAccountId: true,
            cumulativeExternalFundingKrw: true,
            investmentPnlKrw: true,
            timeWeightedReturnFactor: true,
            totalAssetKrw: true,
            returnRate: true,
            capturedAt: true,
            createdAt: true,
          },
        },
      );
    }

    // Equal return rates sort by MDD 10, 50, 75, then by fill count.
    const ordered = [1, 0, 2].flatMap((remainder) =>
      participants.filter(
        (participant) => participant.totalFillCount % 3 === remainder,
      ),
    );
    const expected = ordered.map((participant, index) => ({
      seasonId: 'season-1',
      seasonParticipantId: participant.id,
      tradingAccountId: participant.tradingAccountId,
      rankType: 'daily',
      rank: index + 1,
      totalAssetKrw: '1500.00000000',
      returnRate: '50.00000000',
      maxDrawdown: ['50.00000000', '10.00000000', '75.00000000'][
        participant.totalFillCount % 3
      ],
      totalFillCount: participant.totalFillCount,
      reachedReturnAt:
        participant.totalFillCount % 3 === 1 ? capturedAt : pastPeak,
      rankingDate: new Date('2026-09-22T00:00:00Z'),
      capturedAt,
    }));
    expect(prisma.seasonRanking.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.seasonRanking.createMany).toHaveBeenCalledWith({
      data: expected,
    });
    expect(prisma.seasonParticipant.update).toHaveBeenCalledTimes(33);
    for (const row of expected) {
      expect(prisma.seasonParticipant.update).toHaveBeenCalledWith({
        where: { id: row.seasonParticipantId },
        data: {
          totalAssetKrw: row.totalAssetKrw,
          totalReturnRate: row.returnRate,
          maxDrawdown: row.maxDrawdown,
          currentRank: row.rank,
        },
        select: { id: true },
      });
    }
  });

  it('does not append the current valuation when history already has its capturedAt', async () => {
    const { service, prisma, histories } = setup(1);
    histories.splice(
      0,
      histories.length,
      snapshot(0, '1000', '0', pastPeak),
      snapshot(0, '900', '-10', capturedAt),
      snapshot(0, '1200', '20', capturedAt, new Date(capturedAt.getTime() + 1)),
      snapshot(0, '1000', '0', future),
    );

    await service.refreshCurrentRankingForSeason('season-1', { capturedAt });

    expect(prisma.seasonRanking.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          seasonParticipantId: 'participant-0',
          totalAssetKrw: '1500.00000000',
          maxDrawdown: '16.66666667',
          reachedReturnAt: capturedAt,
        }),
      ],
    });
  });

  it.each([
    'cumulativeExternalFundingKrw',
    'investmentPnlKrw',
    'timeWeightedReturnFactor',
  ] as const)(
    'fails the entire generation on %s damage in the last history batch',
    async (field) => {
      const { service, prisma, histories, valuation } = setup();
      histories[histories.length - 1][field] = new Prisma.Decimal(1);

      await expect(
        service.refreshCurrentRankingForSeason('season-1', { capturedAt }),
      ).rejects.toMatchObject({
        response: { error: { code: 'SEASON_RANKING_SOURCE_SCOPE_MISMATCH' } },
      });

      expect(valuation.calculateTradingAccountValuation).toHaveBeenCalledTimes(
        33,
      );
      expect(prisma.equitySnapshot.findMany).toHaveBeenCalledTimes(3);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.seasonRanking.deleteMany).not.toHaveBeenCalled();
      expect(prisma.seasonRanking.createMany).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
      expect(prisma.equitySnapshot.createMany).not.toHaveBeenCalled();
    },
  );
});
