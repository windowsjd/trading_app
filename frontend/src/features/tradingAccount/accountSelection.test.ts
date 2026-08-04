import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  selectTradingAccountId,
  sortAccountsForDisplay,
  type SelectableAccount,
} from './accountSelection.ts';
import { getSelectionStorageKey } from './selectionStorage.ts';

function seasonAccount(
  id: string,
  overrides: {
    status?: SelectableAccount['status'];
    seasonStatus?: string;
    participantStatus?: string;
    openedAt?: string;
    closedAt?: string | null;
  } = {},
): SelectableAccount {
  return {
    id,
    mode: 'season',
    status: overrides.status ?? 'active',
    openedAt: overrides.openedAt ?? '2026-05-01T00:00:00.000Z',
    closedAt: overrides.closedAt ?? null,
    season: {
      seasonId: `season-of-${id}`,
      seasonName: `시즌 ${id}`,
      seasonStatus: (overrides.seasonStatus ?? 'active') as never,
      startAt: '2026-05-01T00:00:00.000Z',
      endAt: '2026-05-31T00:00:00.000Z',
      seasonParticipantId: `sp-${id}`,
      participantStatus: (overrides.participantStatus ?? 'active') as never,
      joinedAt: '2026-05-01T00:00:00.000Z',
    },
  };
}

function generalAccount(
  id: string,
  overrides: {
    status?: SelectableAccount['status'];
    openedAt?: string;
  } = {},
): SelectableAccount {
  return {
    id,
    mode: 'general',
    status: overrides.status ?? 'active',
    openedAt: overrides.openedAt ?? '2026-04-01T00:00:00.000Z',
    closedAt: null,
    season: null,
  };
}

describe('selectTradingAccountId', () => {
  it('keeps a stored account that is still owned', () => {
    const accounts = [seasonAccount('s1'), generalAccount('g1')];

    assert.deepEqual(selectTradingAccountId(accounts, 'g1'), {
      accountId: 'g1',
      reason: 'stored',
    });
  });

  it('falls back when there is no stored account', () => {
    const accounts = [generalAccount('g1'), seasonAccount('s1')];

    assert.deepEqual(selectTradingAccountId(accounts, null), {
      accountId: 's1',
      reason: 'active_season',
    });
  });

  it('DROPS a stored account the user no longer owns instead of retrying it', () => {
    const accounts = [generalAccount('g1')];

    // 'ghost' would 404 forever, and on a shared device it could be another
    // user's id: never kept.
    assert.deepEqual(selectTradingAccountId(accounts, 'ghost'), {
      accountId: 'g1',
      reason: 'active_general',
    });
  });

  it('prefers the active season account over the general account', () => {
    const accounts = [
      generalAccount('g1', { openedAt: '2026-06-01T00:00:00.000Z' }),
      seasonAccount('s1', { openedAt: '2026-05-01T00:00:00.000Z' }),
    ];

    // Even though the general account is newer.
    assert.equal(selectTradingAccountId(accounts, null).accountId, 's1');
  });

  it('picks the general account when no season is being competed in', () => {
    const accounts = [
      seasonAccount('s-old', { status: 'closed', seasonStatus: 'settled' }),
      generalAccount('g1'),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, null), {
      accountId: 'g1',
      reason: 'active_general',
    });
  });

  it('does not prefer an EXCLUDED participant season account', () => {
    const accounts = [
      seasonAccount('s-excluded', { participantStatus: 'excluded' }),
      generalAccount('g1'),
    ];

    assert.equal(selectTradingAccountId(accounts, null).accountId, 'g1');
  });

  it('falls back to the most recently opened readable account', () => {
    const accounts = [
      seasonAccount('s-2025', {
        status: 'closed',
        openedAt: '2025-01-01T00:00:00.000Z',
      }),
      seasonAccount('s-2026', {
        status: 'closed',
        openedAt: '2026-01-01T00:00:00.000Z',
      }),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, null), {
      accountId: 's-2026',
      reason: 'most_recent',
    });
  });

  it('returns an explicit empty result when the user owns nothing', () => {
    assert.deepEqual(selectTradingAccountId([], 'anything'), {
      accountId: null,
      reason: 'none',
    });
  });

  it('is deterministic when two accounts share an openedAt', () => {
    const accounts = [
      seasonAccount('b', { status: 'closed' }),
      seasonAccount('a', { status: 'closed' }),
    ];

    const first = selectTradingAccountId(accounts, null).accountId;
    const second = selectTradingAccountId([...accounts].reverse(), null)
      .accountId;

    assert.equal(first, second, 'selection must not depend on input order');
  });
});

describe('selection storage is scoped per user', () => {
  it('gives two users different keys so a choice never leaks between them', () => {
    const keyA = getSelectionStorageKey('user-a');
    const keyB = getSelectionStorageKey('user-b');

    assert.notEqual(keyA, keyB);
    assert.ok(keyA.includes('user-a'));
    assert.ok(keyB.includes('user-b'));
  });
});

describe('sortAccountsForDisplay', () => {
  it('offers the competing season first, then general, then inactive accounts', () => {
    const accounts = [
      seasonAccount('s-closed', { status: 'closed' }),
      generalAccount('g1'),
      seasonAccount('s-suspended', { status: 'suspended' }),
      seasonAccount('s-active'),
    ];

    assert.deepEqual(
      sortAccountsForDisplay(accounts).map((account) => account.id),
      ['s-active', 'g1', 's-suspended', 's-closed'],
    );
  });
});

describe('selection never prefers a season that is no longer running (작업 10 §A-9)', () => {
  // The regression this closes: `isParticipatingSeasonAccount` checked the
  // ACCOUNT's status but not the SEASON's, so an ended season whose account had
  // not been closed yet outranked a live general account. The user landed on a
  // frozen leaderboard position they could not trade from.
  const cases: Array<{ seasonStatus: string; label: string }> = [
    { seasonStatus: 'ended', label: 'ended (settlement pending)' },
    { seasonStatus: 'settled', label: 'settled' },
    { seasonStatus: 'upcoming', label: 'upcoming' },
  ];

  for (const { seasonStatus, label } of cases) {
    it(`does not prefer a still-active account of a ${label} season over an active general account`, () => {
      const accounts = [
        seasonAccount('s-stale', {
          status: 'active',
          seasonStatus,
          openedAt: '2026-06-01T00:00:00.000Z',
        }),
        generalAccount('g1', { openedAt: '2026-01-01T00:00:00.000Z' }),
      ];

      assert.deepEqual(selectTradingAccountId(accounts, null), {
        accountId: 'g1',
        reason: 'active_general',
      });
    });
  }

  it('still prefers a genuinely active season over an active general account', () => {
    const accounts = [
      seasonAccount('s-live', { seasonStatus: 'active' }),
      generalAccount('g1', { openedAt: '2026-07-01T00:00:00.000Z' }),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, null), {
      accountId: 's-live',
      reason: 'active_season',
    });
  });

  it('a stale season account is still REACHABLE as the most recent fallback', () => {
    // It is readable history, just not the landing place. With no general
    // account it must still be selected rather than leaving an empty state.
    const accounts = [
      seasonAccount('s-ended', { status: 'active', seasonStatus: 'ended' }),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, null), {
      accountId: 's-ended',
      reason: 'most_recent',
    });
  });

  it('keeps a stored CLOSED account: an explicit choice outranks the policy', () => {
    const accounts = [
      seasonAccount('s-closed', { status: 'closed', seasonStatus: 'settled' }),
      generalAccount('g1'),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, 's-closed'), {
      accountId: 's-closed',
      reason: 'stored',
    });
  });

  it('drops a stored id the user does not own and falls back by policy', () => {
    const accounts = [
      seasonAccount('s-live'),
      generalAccount('g1'),
    ];

    assert.deepEqual(selectTradingAccountId(accounts, 'someone-elses-account'), {
      accountId: 's-live',
      reason: 'active_season',
    });
  });
});

describe('display ordering follows the same season-liveness rule', () => {
  it('ranks an ended season account below the active general account', () => {
    const accounts = [
      seasonAccount('s-ended', { status: 'active', seasonStatus: 'ended' }),
      generalAccount('g1'),
    ];

    assert.deepEqual(
      sortAccountsForDisplay(accounts).map((account) => account.id),
      ['g1', 's-ended'],
    );
  });
});
