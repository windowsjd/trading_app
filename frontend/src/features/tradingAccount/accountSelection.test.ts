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
