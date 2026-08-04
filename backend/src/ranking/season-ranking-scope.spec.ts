jest.mock('../generated/prisma/client', () => ({
  TradingAccountMode: { season: 'season', general: 'general' },
}));

import { HttpStatus } from '@nestjs/common';
import {
  assertExistingRankingRowScopeWritable,
  assertSeasonRankingScope,
  assertSeasonRankingScopeForParticipant,
  assertSeasonRankingScopes,
  requireSeasonRankingAccountScope,
  resolveSeasonRankingAccountScopes,
  SEASON_RANKING_SCOPE_SELECT,
  seasonRankingScopeErrorCodes,
  type SeasonRankingScopeRow,
} from './season-ranking-scope';

/**
 * 작업 8 §6.2 / §8 / §11. Pure policy: no DB, no Prisma runtime.
 *
 * The thing being pinned down throughout is that damage is never SOFTENED —
 * not into an empty ranking, not into a shorter one, and not into a silent
 * repair. Every case below asserts a structured 500 with a code that tells the
 * operator which repair to run.
 */

const SEASON_ID = 'season-1';
const PARTICIPANT_ID = 'sp-1';
const ACCOUNT_ID = 'account-1';
const USER_ID = 'user-1';

function scopeRow(
  overrides: Partial<SeasonRankingScopeRow> = {},
): SeasonRankingScopeRow {
  return {
    id: 'ranking-1',
    seasonId: SEASON_ID,
    seasonParticipantId: PARTICIPANT_ID,
    tradingAccountId: ACCOUNT_ID,
    seasonParticipant: {
      id: PARTICIPANT_ID,
      seasonId: SEASON_ID,
      userId: USER_ID,
      tradingAccountId: ACCOUNT_ID,
      tradingAccount: { id: ACCOUNT_ID, mode: 'season', userId: USER_ID },
    },
    ...overrides,
  };
}

function expectScopeFailure(run: () => unknown, code: string) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeDefined();
  const exception = thrown as {
    getStatus: () => number;
    getResponse: () => { error: { code: string; message: string } };
  };
  expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  expect(exception.getResponse().error.code).toBe(code);
  // Every scope failure names the repair; an operator must never have to guess.
  expect(exception.getResponse().error.message).toContain(
    'repair-ranking-scope',
  );
}

describe('season ranking scope — read side', () => {
  it('accepts a fully scoped row', () => {
    expect(() => assertSeasonRankingScope(scopeRow())).not.toThrow();
  });

  it('reports a null scope as REPAIR_REQUIRED, not as missing data', () => {
    expectScopeFailure(
      () => assertSeasonRankingScope(scopeRow({ tradingAccountId: null })),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('rejects a row whose account disagrees with its participant', () => {
    expectScopeFailure(
      () =>
        assertSeasonRankingScope(
          scopeRow({ tradingAccountId: 'other-account' }),
        ),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });

  it('rejects a row filed under a different season than its participant', () => {
    expectScopeFailure(
      () =>
        assertSeasonRankingScope(
          scopeRow({
            seasonParticipant: {
              ...scopeRow().seasonParticipant!,
              seasonId: 'season-2',
            },
          }),
        ),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });

  it('rejects a GENERAL account in a season ranking', () => {
    expectScopeFailure(
      () =>
        assertSeasonRankingScope(
          scopeRow({
            seasonParticipant: {
              ...scopeRow().seasonParticipant!,
              tradingAccount: {
                id: ACCOUNT_ID,
                mode: 'general',
                userId: USER_ID,
              },
            },
          }),
        ),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });

  it('rejects an account owned by a different user than the participant', () => {
    expectScopeFailure(
      () =>
        assertSeasonRankingScope(
          scopeRow({
            seasonParticipant: {
              ...scopeRow().seasonParticipant!,
              tradingAccount: {
                id: ACCOUNT_ID,
                mode: 'season',
                userId: 'user-2',
              },
            },
          }),
        ),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });

  it('reports a participant with no account link as a LINK integrity problem', () => {
    expectScopeFailure(
      () =>
        assertSeasonRankingScope(
          scopeRow({
            seasonParticipant: {
              ...scopeRow().seasonParticipant!,
              tradingAccountId: null,
              tradingAccount: null,
            },
          }),
        ),
      seasonRankingScopeErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
    );
  });

  it('fails the WHOLE set when one row is damaged, rather than dropping it', () => {
    const rows = [
      scopeRow({ id: 'r1' }),
      scopeRow({ id: 'r2', tradingAccountId: null }),
      scopeRow({ id: 'r3' }),
    ];

    expectScopeFailure(
      () => assertSeasonRankingScopes(rows),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('rejects one account occupying two ranks in the same set', () => {
    const rows = [
      scopeRow({ id: 'r1', seasonParticipantId: 'sp-1' }),
      // Same account under a different participant: one competitor would hold
      // two places on the leaderboard.
      scopeRow({
        id: 'r2',
        seasonParticipantId: 'sp-2',
        seasonParticipant: {
          id: 'sp-2',
          seasonId: SEASON_ID,
          userId: 'user-2',
          tradingAccountId: ACCOUNT_ID,
          tradingAccount: { id: ACCOUNT_ID, mode: 'season', userId: 'user-2' },
        },
      }),
    ];

    expectScopeFailure(
      () => assertSeasonRankingScopes(rows),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });

  it('verifies rankings loaded as a nested relation of their participant', () => {
    const participant = {
      id: PARTICIPANT_ID,
      seasonId: SEASON_ID,
      userId: USER_ID,
      tradingAccountId: ACCOUNT_ID,
      tradingAccount: {
        id: ACCOUNT_ID,
        mode: 'season' as const,
        userId: USER_ID,
      },
    };

    expect(() =>
      assertSeasonRankingScopeForParticipant(participant, [
        { id: 'r1', seasonId: SEASON_ID, tradingAccountId: ACCOUNT_ID },
      ]),
    ).not.toThrow();

    expectScopeFailure(
      () =>
        assertSeasonRankingScopeForParticipant(participant, [
          { id: 'r1', seasonId: SEASON_ID, tradingAccountId: null },
        ]),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('selects the scope columns every reader needs', () => {
    expect(SEASON_RANKING_SCOPE_SELECT).toMatchObject({
      seasonId: true,
      seasonParticipantId: true,
      tradingAccountId: true,
    });
    expect(SEASON_RANKING_SCOPE_SELECT.seasonParticipant.select).toMatchObject({
      id: true,
      seasonId: true,
      userId: true,
      tradingAccountId: true,
    });
  });
});

describe('season ranking scope — write side', () => {
  const participantRow = (overrides: Record<string, unknown> = {}) => ({
    id: PARTICIPANT_ID,
    seasonId: SEASON_ID,
    userId: USER_ID,
    tradingAccountId: ACCOUNT_ID,
    tradingAccount: {
      id: ACCOUNT_ID,
      mode: 'season',
      userId: USER_ID,
      status: 'active',
      seasonParticipant: { id: PARTICIPANT_ID },
    },
    ...overrides,
  });

  const clientWith = (rows: unknown[]) => ({
    seasonParticipant: { findMany: jest.fn().mockResolvedValue(rows) },
  });

  it('resolves every participant in ONE query, not one per row', async () => {
    const client = clientWith([
      participantRow(),
      participantRow({
        id: 'sp-2',
        userId: 'user-2',
        tradingAccountId: 'account-2',
        tradingAccount: {
          id: 'account-2',
          mode: 'season',
          userId: 'user-2',
          status: 'active',
          seasonParticipant: { id: 'sp-2' },
        },
      }),
    ]);

    const scopes = await resolveSeasonRankingAccountScopes(client as never, {
      seasonId: SEASON_ID,
      seasonParticipantIds: [PARTICIPANT_ID, 'sp-2', PARTICIPANT_ID],
    });

    expect(client.seasonParticipant.findMany).toHaveBeenCalledTimes(1);
    expect(scopes.get(PARTICIPANT_ID)?.tradingAccountId).toBe(ACCOUNT_ID);
    expect(scopes.get('sp-2')?.tradingAccountId).toBe('account-2');
  });

  it('refuses to write ANY row when one participant has no account link', async () => {
    const client = clientWith([
      participantRow({ tradingAccountId: null, tradingAccount: null }),
    ]);

    await expect(
      resolveSeasonRankingAccountScopes(client as never, {
        seasonId: SEASON_ID,
        seasonParticipantIds: [PARTICIPANT_ID],
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: seasonRankingScopeErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
        },
      },
    });
  });

  it('refuses a participant linked to a general account', async () => {
    const client = clientWith([
      participantRow({
        tradingAccount: {
          id: ACCOUNT_ID,
          mode: 'general',
          userId: USER_ID,
          status: 'active',
          seasonParticipant: { id: PARTICIPANT_ID },
        },
      }),
    ]);

    await expect(
      requireSeasonRankingAccountScope(client as never, {
        seasonId: SEASON_ID,
        seasonParticipantId: PARTICIPANT_ID,
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        },
      },
    });
  });

  it('refuses an account that points back at a DIFFERENT participant', async () => {
    const client = clientWith([
      participantRow({
        tradingAccount: {
          id: ACCOUNT_ID,
          mode: 'season',
          userId: USER_ID,
          status: 'active',
          seasonParticipant: { id: 'sp-other' },
        },
      }),
    ]);

    await expect(
      requireSeasonRankingAccountScope(client as never, {
        seasonId: SEASON_ID,
        seasonParticipantId: PARTICIPANT_ID,
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        },
      },
    });
  });

  it('refuses a participant belonging to a different season', async () => {
    const client = clientWith([participantRow({ seasonId: 'season-2' })]);

    await expect(
      resolveSeasonRankingAccountScopes(client as never, {
        seasonId: SEASON_ID,
        seasonParticipantIds: [PARTICIPANT_ID],
      }),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
        },
      },
    });
  });

  it('never issues a query for an empty participant list', async () => {
    const client = clientWith([]);

    const scopes = await resolveSeasonRankingAccountScopes(client as never, {
      seasonId: SEASON_ID,
      seasonParticipantIds: [],
    });

    expect(scopes.size).toBe(0);
    expect(client.seasonParticipant.findMany).not.toHaveBeenCalled();
  });
});

describe('existing ranking row scope guard', () => {
  it('allows an update whose stored scope already matches', () => {
    expect(() =>
      assertExistingRankingRowScopeWritable({
        rankingId: 'ranking-1',
        storedTradingAccountId: ACCOUNT_ID,
        expectedTradingAccountId: ACCOUNT_ID,
      }),
    ).not.toThrow();
  });

  it('refuses to quietly fill a legacy NULL scope through a routine update', () => {
    expectScopeFailure(
      () =>
        assertExistingRankingRowScopeWritable({
          rankingId: 'ranking-1',
          storedTradingAccountId: null,
          expectedTradingAccountId: ACCOUNT_ID,
        }),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('never overwrites a non-null scope that disagrees', () => {
    expectScopeFailure(
      () =>
        assertExistingRankingRowScopeWritable({
          rankingId: 'ranking-1',
          storedTradingAccountId: 'account-other',
          expectedTradingAccountId: ACCOUNT_ID,
        }),
      seasonRankingScopeErrorCodes.SEASON_RANKING_SCOPE_MISMATCH,
    );
  });
});
