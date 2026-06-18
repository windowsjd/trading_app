jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { SeasonRankingType } from '../generated/prisma/client';
import { writeDailyPortfolioSnapshot } from './daily-portfolio-snapshot-generation';
import { writeSeasonRankings } from './season-ranking-generation';

describe('snapshot and ranking generation dry-run behavior', () => {
  it('does not upsert daily portfolio snapshots during dry-run', async () => {
    const prisma = {
      dailyPortfolioSnapshot: {
        upsert: jest.fn(),
      },
    };

    const result = await writeDailyPortfolioSnapshot(prisma, {
      valuation: {
        seasonParticipantId: 'sp-1',
        totalAssetKrw: '1000.00000000',
        returnRate: '0.00000000',
        krwCash: '1000.00000000',
        usdCashKrw: '0.00000000',
        assetValueKrw: '0.00000000',
        domesticStockValueKrw: '0.00000000',
        usStockValueKrw: '0.00000000',
        cryptoValueKrw: '0.00000000',
        realizedPnlKrw: '0.00000000',
        unrealizedPnlKrw: '0.00000000',
        valuationAt: new Date('2026-05-07T00:00:00.000Z'),
      },
      snapshotDate: new Date('2026-05-07T00:00:00.000Z'),
      capturedAt: new Date('2026-05-07T00:00:01.000Z'),
      dryRun: true,
    });

    expect(prisma.dailyPortfolioSnapshot.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      seasonParticipantId: 'sp-1',
      dryRun: true,
    });
  });

  it('does not replace season rankings during dry-run', async () => {
    const prisma = {
      $transaction: jest.fn(),
    };

    const result = await writeSeasonRankings(prisma, {
      seasonId: 'season-1',
      rankType: SeasonRankingType.daily,
      rankingDate: new Date('2026-05-07T00:00:00.000Z'),
      capturedAt: new Date('2026-05-07T00:00:01.000Z'),
      rows: [
        {
          rank: 1,
          seasonParticipantId: 'sp-1',
          userId: 'user-1',
          totalAssetKrw: '1000.00000000',
          returnRate: '0.00000000',
          maxDrawdown: '0.00000000',
          totalFillCount: 0,
          reachedReturnAt: new Date('2026-05-07T00:00:01.000Z'),
        },
      ],
      dryRun: true,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        rank: 1,
        seasonParticipantId: 'sp-1',
        userId: 'user-1',
        totalAssetKrw: '1000.00000000',
        returnRate: '0.00000000',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: new Date('2026-05-07T00:00:01.000Z'),
        dryRun: true,
      },
    ]);
  });
});
