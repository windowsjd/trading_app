jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    Prisma: {
      Decimal,
    },
  };
});

import { Prisma } from '../generated/prisma/client';
import {
  assignSequentialRanks,
  buildRankingRowsForSnapshots,
  calculateMaxDrawdownPercent,
  calculateReachedReturnAt,
  calculateTotalFillCount,
  compareRankingRows,
} from './ranking-calculation.policy';

describe('ranking calculation policy', () => {
  const date = (value: string) => new Date(value);
  const snapshotDate = (value: string) => date(`${value}T00:00:00.000Z`);

  it('sorts by returnRate, maxDrawdown, fill count, reachedReturnAt, userId, and participant id', () => {
    const rows = [
      row({
        seasonParticipantId: 'sp-return-lower',
        userId: 'user-z',
        returnRate: '9.00000000',
      }),
      row({
        seasonParticipantId: 'sp-drawdown-worse',
        userId: 'user-a',
        maxDrawdown: '3.00000000',
      }),
      row({
        seasonParticipantId: 'sp-fill-worse',
        userId: 'user-a',
        maxDrawdown: '1.00000000',
        totalFillCount: 5,
      }),
      row({
        seasonParticipantId: 'sp-reached-later',
        userId: 'user-a',
        maxDrawdown: '1.00000000',
        totalFillCount: 1,
        reachedReturnAt: date('2026-05-03T00:00:00.000Z'),
      }),
      row({
        seasonParticipantId: 'sp-user-b',
        userId: 'user-b',
        maxDrawdown: '1.00000000',
        totalFillCount: 1,
        reachedReturnAt: date('2026-05-01T00:00:00.000Z'),
      }),
      row({
        seasonParticipantId: 'sp-user-a-2',
        userId: 'user-a',
        maxDrawdown: '1.00000000',
        totalFillCount: 1,
        reachedReturnAt: date('2026-05-01T00:00:00.000Z'),
      }),
      row({
        seasonParticipantId: 'sp-user-a-1',
        userId: 'user-a',
        maxDrawdown: '1.00000000',
        totalFillCount: 1,
        reachedReturnAt: date('2026-05-01T00:00:00.000Z'),
      }),
    ];

    const rankedRows = assignSequentialRanks(rows.toSorted(compareRankingRows));

    expect(
      rankedRows.map((rankingRow) => rankingRow.seasonParticipantId),
    ).toEqual([
      'sp-user-a-1',
      'sp-user-a-2',
      'sp-user-b',
      'sp-reached-later',
      'sp-fill-worse',
      'sp-drawdown-worse',
      'sp-return-lower',
    ]);
    expect(rankedRows.map((rankingRow) => rankingRow.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it('calculates max drawdown as percent from snapshot history', () => {
    expect(
      calculateMaxDrawdownPercent([
        history('sp-1', '2026-05-01', '10000000.00000000'),
      ]).toFixed(8),
    ).toBe('0.00000000');

    expect(
      calculateMaxDrawdownPercent([
        history('sp-1', '2026-05-01', '10000000.00000000'),
        history('sp-1', '2026-05-02', '12000000.00000000'),
        history('sp-1', '2026-05-03', '10800000.00000000'),
      ]).toFixed(8),
    ).toBe('10.00000000');

    expect(
      calculateMaxDrawdownPercent([
        history('sp-1', '2026-05-01', '10000000.00000000'),
        history('sp-1', '2026-05-02', '9000000.00000000'),
        history('sp-1', '2026-05-03', '13000000.00000000'),
        history('sp-1', '2026-05-04', '10400000.00000000'),
      ]).toFixed(8),
    ).toBe('20.00000000');
  });

  it('calculates reachedReturnAt with Decimal percent comparison and fallback', () => {
    const snapshots = [
      history('sp-1', '2026-05-01', '1000.00000000', '5.00000000'),
      history('sp-1', '2026-05-02', '1000.00000000', '12.00000000'),
      history('sp-1', '2026-05-03', '1000.00000000', '14.00000000'),
    ];

    expect(
      calculateReachedReturnAt(
        snapshots,
        new Prisma.Decimal('12.00000000'),
        date('2026-05-04T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-05-02T00:00:00.000Z');

    expect(
      calculateReachedReturnAt(
        snapshots,
        '20.00000000',
        date('2026-05-04T00:00:00.000Z'),
      ).toISOString(),
    ).toBe('2026-05-04T00:00:00.000Z');
  });

  it('counts only executed orders through the ranking cutoff', () => {
    expect(
      calculateTotalFillCount(
        [
          {
            seasonParticipantId: 'sp-1',
            executedAt: date('2026-05-01T00:00:00.000Z'),
          },
          {
            seasonParticipantId: 'sp-1',
            executedAt: date('2026-05-02T00:00:00.000Z'),
          },
          { seasonParticipantId: 'sp-1', executedAt: null },
        ],
        date('2026-05-01T12:00:00.000Z'),
      ),
    ).toBe(1);
  });

  it('builds ranking rows with shared stats and sequential ranks', () => {
    const rows = buildRankingRowsForSnapshots({
      rankingSnapshots: [
        rankingSnapshot(
          'sp-a',
          'user-a',
          '2026-05-03',
          '1000.00000000',
          '10.00000000',
        ),
        rankingSnapshot(
          'sp-b',
          'user-b',
          '2026-05-03',
          '1000.00000000',
          '10.00000000',
        ),
      ],
      historicalSnapshots: [
        history('sp-a', '2026-05-01', '1000.00000000', '5.00000000'),
        history('sp-a', '2026-05-02', '1200.00000000', '10.00000000'),
        history('sp-a', '2026-05-03', '1080.00000000', '10.00000000'),
        history('sp-b', '2026-05-01', '1000.00000000', '10.00000000'),
        history('sp-b', '2026-05-03', '1000.00000000', '10.00000000'),
      ],
      executedOrders: [
        {
          seasonParticipantId: 'sp-a',
          executedAt: date('2026-05-02T00:00:00.000Z'),
        },
        {
          seasonParticipantId: 'sp-a',
          executedAt: date('2026-05-04T00:00:00.000Z'),
        },
      ],
    });

    expect(rows).toMatchObject([
      {
        rank: 1,
        seasonParticipantId: 'sp-b',
        maxDrawdown: '0.00000000',
        totalFillCount: 0,
        reachedReturnAt: date('2026-05-01T00:00:00.000Z'),
      },
      {
        rank: 2,
        seasonParticipantId: 'sp-a',
        maxDrawdown: '10.00000000',
        totalFillCount: 1,
        reachedReturnAt: date('2026-05-02T00:00:00.000Z'),
      },
    ]);
  });

  function row(input: {
    seasonParticipantId: string;
    userId: string;
    returnRate?: string;
    maxDrawdown?: string;
    totalFillCount?: number;
    reachedReturnAt?: Date;
  }) {
    return {
      seasonParticipantId: input.seasonParticipantId,
      userId: input.userId,
      returnRate: input.returnRate ?? '10.00000000',
      maxDrawdown: input.maxDrawdown ?? '0.00000000',
      totalFillCount: input.totalFillCount ?? 0,
      reachedReturnAt:
        input.reachedReturnAt ?? date('2026-05-01T00:00:00.000Z'),
    };
  }

  function rankingSnapshot(
    seasonParticipantId: string,
    userId: string,
    dateText: string,
    totalAssetKrw: string,
    returnRate = '0.00000000',
  ) {
    return {
      ...history(seasonParticipantId, dateText, totalAssetKrw, returnRate),
      userId,
    };
  }

  function history(
    seasonParticipantId: string,
    dateText: string,
    totalAssetKrw: string,
    returnRate = '0.00000000',
  ) {
    return {
      seasonParticipantId,
      snapshotDate: snapshotDate(dateText),
      totalAssetKrw,
      returnRate,
      capturedAt: date(`${dateText}T00:00:00.000Z`),
      createdAt: date(`${dateText}T00:00:01.000Z`),
    };
  }
});
