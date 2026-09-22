jest.mock('../generated/prisma/client', () => ({
  SnapshotReason: { scheduled: 'scheduled' },
}));

import type { Prisma } from '../generated/prisma/client';
import {
  insertCurrentRankingRows,
  insertMissingScheduledEquitySnapshots,
} from './current-ranking-publication';

const capturedAt = new Date('2026-09-22T00:14:59.999Z');

function rankingRows(count: number): Prisma.SeasonRankingCreateManyInput[] {
  return Array.from({ length: count }, (_, index) => ({
    seasonId: 'season-1',
    seasonParticipantId: `participant-${index}`,
    tradingAccountId: `account-${index}`,
    rankType: 'daily',
    rank: index + 1,
    totalAssetKrw: '11000000.00000000',
    returnRate: '10.00000000',
    maxDrawdown: '12.50000000',
    totalFillCount: index,
    reachedReturnAt: capturedAt,
    rankingDate: new Date('2026-09-22T00:00:00.000Z'),
    capturedAt,
  }));
}

function equityRows(count: number): Prisma.EquitySnapshotCreateManyInput[] {
  return Array.from({ length: count }, (_, index) => ({
    tradingAccountId: `account-${index}`,
    totalAssetKrw: '11000000.00000000',
    returnRate: '10.00000000',
    krwCash: '7000000.00000000',
    usdCashKrw: '1000000.00000000',
    domesticStockValueKrw: '1000000.00000000',
    usStockValueKrw: '1000000.00000000',
    cryptoValueKrw: '1000000.00000000',
    snapshotReason: 'scheduled',
    capturedAt,
  }));
}

describe('current ranking publication batches', () => {
  it('inserts every ranking row unchanged with at most 200 rows per statement', async () => {
    const tx = { seasonRanking: { createMany: jest.fn() } };
    const rows = rankingRows(401);

    await insertCurrentRankingRows(tx as never, rows);

    expect(tx.seasonRanking.createMany.mock.calls).toEqual([
      [{ data: rows.slice(0, 200) }],
      [{ data: rows.slice(200, 400) }],
      [{ data: rows.slice(400) }],
    ]);
  });

  it('does not issue writes or existence queries for an empty generation', async () => {
    const tx = {
      seasonRanking: { createMany: jest.fn() },
      equitySnapshot: { findMany: jest.fn(), createMany: jest.fn() },
    };

    await insertCurrentRankingRows(tx as never, []);
    await insertMissingScheduledEquitySnapshots(tx as never, {
      capturedAt,
      rows: [],
    });

    expect(tx.seasonRanking.createMany).not.toHaveBeenCalled();
    expect(tx.equitySnapshot.findMany).not.toHaveBeenCalled();
    expect(tx.equitySnapshot.createMany).not.toHaveBeenCalled();
  });

  it('propagates a ranking insertion failure instead of skipping conflicting rows', async () => {
    const failure = new Error('unique constraint violation');
    const tx = {
      seasonRanking: {
        createMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 200 })
          .mockRejectedValueOnce(failure),
      },
    };

    await expect(
      insertCurrentRankingRows(tx as never, rankingRows(401)),
    ).rejects.toBe(failure);
    expect(tx.seasonRanking.createMany).toHaveBeenCalledTimes(2);
  });

  it('keeps existing bucket snapshots and inserts all remaining account payloads unchanged', async () => {
    const tx = {
      equitySnapshot: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            { tradingAccountId: 'account-0' },
            { tradingAccountId: 'account-199' },
          ])
          .mockResolvedValueOnce([
            { tradingAccountId: 'account-200' },
            { tradingAccountId: 'account-210' },
          ])
          .mockResolvedValueOnce([{ tradingAccountId: 'account-400' }]),
        createMany: jest.fn(),
      },
    };
    const rows = equityRows(401);

    await insertMissingScheduledEquitySnapshots(tx as never, {
      capturedAt,
      rows,
    });

    expect(tx.equitySnapshot.findMany).toHaveBeenCalledTimes(3);
    for (let batch = 0; batch < 3; batch++) {
      expect(tx.equitySnapshot.findMany).toHaveBeenNthCalledWith(batch + 1, {
        where: {
          tradingAccountId: {
            in: rows
              .slice(batch * 200, (batch + 1) * 200)
              .map((row) => row.tradingAccountId),
          },
          snapshotReason: 'scheduled',
          capturedAt: {
            gte: new Date('2026-09-22T00:10:00.000Z'),
            lt: new Date('2026-09-22T00:15:00.000Z'),
          },
        },
        select: { tradingAccountId: true },
      });
    }
    expect(tx.equitySnapshot.createMany.mock.calls).toEqual([
      [{ data: rows.slice(1, 199) }],
      [
        {
          data: rows
            .slice(201, 400)
            .filter((row) => row.tradingAccountId !== 'account-210'),
        },
      ],
    ]);
  });

  it.each([
    ['2026-09-22T00:10:00.000Z', '2026-09-22T00:10:00.000Z'],
    ['2026-09-22T00:14:59.999Z', '2026-09-22T00:10:00.000Z'],
    ['2026-09-22T00:15:00.000Z', '2026-09-22T00:15:00.000Z'],
  ])('uses the existing five-minute bucket for %s', async (at, start) => {
    const tx = {
      equitySnapshot: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(),
      },
    };
    const time = new Date(at);
    const rows = equityRows(1).map((row) => ({ ...row, capturedAt: time }));

    await insertMissingScheduledEquitySnapshots(tx as never, {
      capturedAt: time,
      rows,
    });

    expect(tx.equitySnapshot.findMany).toHaveBeenCalledWith({
      where: {
        tradingAccountId: { in: ['account-0'] },
        snapshotReason: 'scheduled',
        capturedAt: {
          gte: new Date(start),
          lt: new Date(new Date(start).getTime() + 5 * 60_000),
        },
      },
      select: { tradingAccountId: true },
    });
    expect(tx.equitySnapshot.createMany).toHaveBeenCalledWith({ data: rows });
  });

  it('propagates snapshot query failure without creating a snapshot', async () => {
    const failure = new Error('snapshot read failed');
    const tx = {
      equitySnapshot: {
        findMany: jest.fn().mockRejectedValue(failure),
        createMany: jest.fn(),
      },
    };

    await expect(
      insertMissingScheduledEquitySnapshots(tx as never, {
        capturedAt,
        rows: equityRows(1),
      }),
    ).rejects.toBe(failure);
    expect(tx.equitySnapshot.createMany).not.toHaveBeenCalled();
  });

  it('propagates snapshot insertion failure without processing later batches', async () => {
    const failure = new Error('snapshot insert failed');
    const tx = {
      equitySnapshot: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockRejectedValue(failure),
      },
    };

    await expect(
      insertMissingScheduledEquitySnapshots(tx as never, {
        capturedAt,
        rows: equityRows(401),
      }),
    ).rejects.toBe(failure);
    expect(tx.equitySnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(tx.equitySnapshot.createMany).toHaveBeenCalledTimes(1);
  });
});
