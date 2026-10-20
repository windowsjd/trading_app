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
      TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' },
    },
    PrismaClient: class PrismaClient {},
    SeasonRankingType: { daily: 'daily', final: 'final' },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      season: 'season',
      general: 'general',
      beginner: 'beginner',
    },
  };
});

import { HttpException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { SeasonFinalResultService } from './season-final-result.service';

const SEASON = {
  id: 'season-1',
  name: '2026 가을 시즌',
  status: 'settled',
  startAt: new Date('2026-09-01T00:00:00.000Z'),
  endAt: new Date('2026-10-01T00:00:00.000Z'),
};

function participant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'participant-1',
    seasonId: 'season-1',
    userId: 'user-1',
    tradingAccountId: 'account-1',
    tradingAccount: { id: 'account-1', mode: 'season', userId: 'user-1' },
    participantStatus: 'finished',
    finalRank: 3,
    finalTier: 'gold',
    finalQualified: null,
    finalTradedInstrumentCount: null,
    finalRecognizedTurnoverKrw: null,
    // The participant's own totals differ from the final row on purpose: a
    // ranked result must read the final ranking row, as the records list does.
    totalAssetKrw: new Prisma.Decimal('99'),
    totalReturnRate: new Prisma.Decimal('-0.5'),
    finalResultViewedAt: null,
    seasonRankings: [
      {
        id: 'ranking-1',
        seasonId: 'season-1',
        tradingAccountId: 'account-1',
        rank: 3,
        totalAssetKrw: new Prisma.Decimal('12345678.9'),
        returnRate: new Prisma.Decimal('23.4567'),
        capturedAt: new Date('2026-10-01T00:00:05.000Z'),
      },
    ],
    ...overrides,
  };
}

function harness(state: {
  season?: typeof SEASON | null;
  participant?: ReturnType<typeof participant> | null;
  stored?: Date | null;
}) {
  const tx = {
    season: {
      findUnique: jest.fn(() =>
        Promise.resolve(state.season === undefined ? SEASON : state.season),
      ),
    },
    seasonParticipant: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          state.participant === undefined ? participant() : state.participant,
        ),
      ),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
    seasonParticipant: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      findUnique: jest.fn(() =>
        Promise.resolve({
          finalResultViewedAt:
            state.stored === undefined
              ? new Date('2026-10-02T01:02:03.000Z')
              : state.stored,
        }),
      ),
    },
  };
  const service = new SeasonFinalResultService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma, tx };
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      const body = error.getResponse() as { error?: { code?: string } };
      return { status: error.getStatus(), code: body.error?.code ?? null };
    }
    throw error;
  }
  throw new Error('expected the call to fail');
}

describe('SeasonFinalResultService.getMyFinalResult', () => {
  it('returns the ranked result from the final ranking row with the participant rank and tier', async () => {
    const { service, prisma, tx } = harness({});

    const response = await service.getMyFinalResult('user-1', ' season-1 ');

    expect(response.data.result).toEqual({
      state: 'available',
      finalRank: 3,
      finalTier: 'gold',
      totalAssetKrw: '12345678.90000000',
      returnRate: '23.45670000',
      capturedAt: '2026-10-01T00:00:05.000Z',
    });
    expect(response.data.viewedAt).toBeNull();
    expect(response.data.participantStatus).toBe('finished');
    expect(response.data.season).toEqual({
      id: 'season-1',
      name: '2026 가을 시즌',
      status: 'settled',
      startAt: '2026-09-01T00:00:00.000Z',
      endAt: '2026-10-01T00:00:00.000Z',
    });
    // One snapshot for season, participant and final row; nothing written.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'RepeatableRead',
    });
    expect(tx.seasonParticipant.findUnique.mock.calls[0][0].where).toEqual({
      seasonId_userId: { seasonId: 'season-1', userId: 'user-1' },
    });
    expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  });

  it('returns the settled totals without a rank or tier for a participant who did not qualify', async () => {
    const { service } = harness({
      participant: participant({
        finalQualified: false,
        finalRank: null,
        finalTier: null,
        finalTradedInstrumentCount: 2,
        finalRecognizedTurnoverKrw: new Prisma.Decimal('1500000'),
        totalAssetKrw: new Prisma.Decimal('10200000'),
        totalReturnRate: new Prisma.Decimal('2'),
        seasonRankings: [],
      }),
    });

    const { data } = await service.getMyFinalResult('user-1', 'season-1');

    expect(data.result).toEqual({
      state: 'not_qualified',
      totalAssetKrw: '10200000.00000000',
      returnRate: '2.00000000',
      tradedInstrumentCount: 2,
      recognizedTurnoverKrw: '1500000.00000000',
    });
  });

  it('separates exclusion, pending settlement, damaged data and non-participation', async () => {
    const cases: Array<[Parameters<typeof harness>[0], string]> = [
      [
        {
          participant: participant({
            participantStatus: 'excluded',
            finalRank: null,
            finalTier: null,
            seasonRankings: [],
          }),
        },
        'excluded',
      ],
      // An ended season is not settled: no figure is final yet.
      [{ season: { ...SEASON, status: 'ended' } }, 'pending'],
      [{ participant: participant({ seasonRankings: [] }) }, 'unavailable'],
      [{ participant: participant({ finalTier: '  ' }) }, 'unavailable'],
      [
        {
          participant: participant({
            seasonRankings: [{ ...participant().seasonRankings[0], rank: 4 }],
          }),
        },
        'unavailable',
      ],
      [
        {
          participant: participant({
            participantStatus: 'registered',
            finalRank: null,
            finalTier: null,
            seasonRankings: [],
          }),
        },
        'unavailable',
      ],
      [{ participant: null }, 'not_joined'],
    ];

    for (const [state, expected] of cases) {
      const { service } = harness(state);
      const { data } = await service.getMyFinalResult('user-1', 'season-1');
      expect(data.result.state).toBe(expected);
      expect('totalAssetKrw' in data.result).toBe(false);
    }
  });

  it('reports the stored first view', async () => {
    const { service } = harness({
      participant: participant({
        finalResultViewedAt: new Date('2026-10-02T00:00:00.000Z'),
      }),
    });

    const { data } = await service.getMyFinalResult('user-1', 'season-1');

    expect(data.viewedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('rejects a missing user, a blank id, an unknown season and a mis-scoped final row', async () => {
    expect(
      await errorOf(harness({}).service.getMyFinalResult(undefined, 's')),
    ).toEqual({ status: 401, code: 'UNAUTHORIZED' });
    expect(
      await errorOf(harness({}).service.getMyFinalResult('user-1', '  ')),
    ).toEqual({ status: 400, code: 'INVALID_SEASON_ID' });
    expect(
      await errorOf(
        harness({ season: null }).service.getMyFinalResult('user-1', 'x'),
      ),
    ).toEqual({ status: 404, code: 'SEASON_NOT_FOUND' });
    const misScoped = participant({
      seasonRankings: [
        { ...participant().seasonRankings[0], tradingAccountId: 'other' },
      ],
    });
    expect(
      (
        await errorOf(
          harness({ participant: misScoped }).service.getMyFinalResult(
            'user-1',
            'season-1',
          ),
        )
      ).status,
    ).toBe(500);
  });
});

describe('SeasonFinalResultService.markMyFinalResultViewed', () => {
  it('stores only the first view and returns the stored instant', async () => {
    const { service, prisma } = harness({});

    const response = await service.markMyFinalResultViewed(
      'user-1',
      'season-1',
    );

    expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledTimes(1);
    const [update] = prisma.seasonParticipant.updateMany.mock.calls[0] as [
      { where: unknown; data: { finalResultViewedAt: unknown } },
    ];
    expect(update.where).toEqual({
      id: 'participant-1',
      finalResultViewedAt: null,
    });
    expect(update.data.finalResultViewedAt instanceof Date).toBe(true);
    expect(response).toEqual({
      success: true,
      data: { seasonId: 'season-1', viewedAt: '2026-10-02T01:02:03.000Z' },
    });
  });

  it('is idempotent: a repeated view keeps the first stored instant', async () => {
    const first = new Date('2026-10-02T00:00:00.000Z');
    const { service, prisma } = harness({ stored: first });
    prisma.seasonParticipant.updateMany.mockResolvedValue({ count: 0 });

    const response = await service.markMyFinalResultViewed(
      'user-1',
      'season-1',
    );

    expect(response.data.viewedAt).toBe('2026-10-02T00:00:00.000Z');
  });

  it('marks shown not-qualified and excluded results', async () => {
    for (const shown of [
      participant({
        finalQualified: false,
        finalRank: null,
        finalTier: null,
        seasonRankings: [],
      }),
      participant({
        participantStatus: 'excluded',
        finalRank: null,
        finalTier: null,
        seasonRankings: [],
      }),
    ]) {
      const { service, prisma } = harness({ participant: shown });
      await service.markMyFinalResultViewed('user-1', 'season-1');
      expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledTimes(1);
    }
  });

  it('stores nothing for a pending or damaged result, or for a non-participant', async () => {
    const cases: Array<[Parameters<typeof harness>[0], number, string]> = [
      [
        { season: { ...SEASON, status: 'ended' } },
        409,
        'SEASON_FINAL_RESULT_UNAVAILABLE',
      ],
      [
        { participant: participant({ seasonRankings: [] }) },
        409,
        'SEASON_FINAL_RESULT_UNAVAILABLE',
      ],
      [{ participant: null }, 404, 'SEASON_NOT_JOINED'],
    ];

    for (const [state, status, code] of cases) {
      const { service, prisma } = harness(state);
      expect(
        await errorOf(service.markMyFinalResultViewed('user-1', 'season-1')),
      ).toEqual({ status, code });
      expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
    }
  });

  it('fails instead of claiming a view it cannot read back', async () => {
    const { service } = harness({ stored: null });

    expect(
      await errorOf(service.markMyFinalResultViewed('user-1', 'season-1')),
    ).toEqual({ status: 500, code: 'SEASON_FINAL_RESULT_VIEW_FAILED' });
  });
});
