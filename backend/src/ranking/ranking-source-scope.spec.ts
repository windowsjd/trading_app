jest.mock('../generated/prisma/client', () => {
  // Typed so the mocked module's Decimal is not an `any` leaking into every
  // fixture in the file.
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    Prisma: { Decimal },
    TradingAccountMode: { season: 'season', general: 'general' },
  };
});

import { HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  assertRankingSourceOrderScopes,
  assertRankingSourceSnapshotScopes,
  buildRankingParticipantScopes,
  rankingSourceScopeErrorCodes,
} from './ranking-source-scope';

/**
 * 작업 8 §9. The point of every test here is that a damaged INPUT row is never
 * quietly excluded from a ranking calculation.
 *
 * Exclusion is not neutral: dropping a low equity point LOWERS max drawdown
 * (tie-break #2) and dropping an executed order LOWERS totalFillCount
 * (tie-break #3). Both move the damaged account UP the leaderboard, so the job
 * fails closed instead.
 */

const SEASON_ID = 'season-1';

const participant = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  seasonId: SEASON_ID,
  userId: `user-${id}`,
  tradingAccountId: `account-${id}`,
  tradingAccount: {
    id: `account-${id}`,
    mode: 'season' as const,
    userId: `user-${id}`,
  },
  ...overrides,
});

function expectSourceFailure(run: () => unknown, code: string) {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeDefined();
  const exception = thrown as {
    getStatus: () => number;
    getResponse: () => { error: { code: string } };
  };
  expect(exception.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
  expect(exception.getResponse().error.code).toBe(code);
}

describe('ranking participant scopes', () => {
  it('builds the participant → account map in one pass', () => {
    const scopes = buildRankingParticipantScopes(SEASON_ID, [
      participant('sp-1'),
      participant('sp-2'),
    ]);

    expect(scopes.get('sp-1')).toBe('account-sp-1');
    expect(scopes.get('sp-2')).toBe('account-sp-2');
  });

  it('refuses a participant with no account link', () => {
    expectSourceFailure(
      () =>
        buildRankingParticipantScopes(SEASON_ID, [
          participant('sp-1', { tradingAccountId: null, tradingAccount: null }),
        ]),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('refuses a participant linked to a general account', () => {
    expectSourceFailure(
      () =>
        buildRankingParticipantScopes(SEASON_ID, [
          participant('sp-1', {
            tradingAccount: {
              id: 'account-sp-1',
              mode: 'general',
              userId: 'user-sp-1',
            },
          }),
        ]),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });

  it('refuses a participant from another season', () => {
    expectSourceFailure(
      () =>
        buildRankingParticipantScopes(SEASON_ID, [
          participant('sp-1', { seasonId: 'season-2' }),
        ]),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });
});

describe('ranking source snapshot scopes', () => {
  const scopes = buildRankingParticipantScopes(SEASON_ID, [
    participant('sp-1'),
  ]);

  const snapshotRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'snapshot-1',
    seasonParticipantId: 'sp-1',
    tradingAccountId: 'account-sp-1',
    cumulativeExternalFundingKrw: null,
    investmentPnlKrw: null,
    timeWeightedReturnFactor: null,
    ...overrides,
  });

  it('accepts a correctly scoped season snapshot', () => {
    expect(() =>
      assertRankingSourceSnapshotScopes({
        kind: 'daily portfolio snapshot',
        rows: [snapshotRow()],
        participantScopes: scopes,
      }),
    ).not.toThrow();
  });

  it('fails the job on a null account scope', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceSnapshotScopes({
          kind: 'daily portfolio snapshot',
          rows: [snapshotRow({ tradingAccountId: null })],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('fails the job on an account that disagrees with the participant', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceSnapshotScopes({
          kind: 'equity snapshot',
          rows: [snapshotRow({ tradingAccountId: 'account-other' })],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });

  it('fails the job on a snapshot with no participant at all', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceSnapshotScopes({
          kind: 'daily portfolio snapshot',
          rows: [snapshotRow({ seasonParticipantId: null })],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });

  it('fails the job on a participant outside this ranking set', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceSnapshotScopes({
          kind: 'daily portfolio snapshot',
          rows: [snapshotRow({ seasonParticipantId: 'sp-unknown' })],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });

  it('rejects a season snapshot carrying GENERAL performance columns', () => {
    // Its returnRate would be a TWR percent, not the initial-capital return
    // the season ranking sorts by — two different quantities.
    for (const field of [
      'cumulativeExternalFundingKrw',
      'investmentPnlKrw',
      'timeWeightedReturnFactor',
    ]) {
      expectSourceFailure(
        () =>
          assertRankingSourceSnapshotScopes({
            kind: 'daily portfolio snapshot',
            rows: [snapshotRow({ [field]: new Prisma.Decimal('1') })],
            participantScopes: scopes,
          }),
        rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
      );
    }
  });
});

describe('ranking source order scopes', () => {
  const scopes = buildRankingParticipantScopes(SEASON_ID, [
    participant('sp-1'),
  ]);

  it('accepts a correctly scoped executed order', () => {
    expect(() =>
      assertRankingSourceOrderScopes({
        rows: [
          {
            id: 'order-1',
            seasonParticipantId: 'sp-1',
            tradingAccountId: 'account-sp-1',
          },
        ],
        participantScopes: scopes,
      }),
    ).not.toThrow();
  });

  it('fails the job rather than under-counting fills on a null scope', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceOrderScopes({
          rows: [
            {
              id: 'order-1',
              seasonParticipantId: 'sp-1',
              tradingAccountId: null,
            },
          ],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_REPAIR_REQUIRED,
    );
  });

  it('fails the job on an order scoped to a foreign account', () => {
    expectSourceFailure(
      () =>
        assertRankingSourceOrderScopes({
          rows: [
            {
              id: 'order-1',
              seasonParticipantId: 'sp-1',
              tradingAccountId: 'account-other',
            },
          ],
          participantScopes: scopes,
        }),
      rankingSourceScopeErrorCodes.SEASON_RANKING_SOURCE_SCOPE_MISMATCH,
    );
  });
});
