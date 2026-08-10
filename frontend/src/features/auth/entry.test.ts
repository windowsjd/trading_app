import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { loadEntryRoute, resolveAuthedEntryRoute } from './entry.ts';

/**
 * App entry routes on INTENT plus the stored choice (작업 13 §2).
 *
 * The bug these lock down: entry used to answer "owns anything → home", so a
 * user holding only a season account was dropped straight into season Home on
 * every login — the mode question was never asked, and a season participant
 * had no doorway to 일반 투자 at all.
 */

const seasonOnly = [{ id: 'season-acc-1' }];
const generalOnly = [{ id: 'general-acc-1' }];
const both = [{ id: 'general-acc-1' }, { id: 'season-acc-1' }];

describe('resolveAuthedEntryRoute — new login', () => {
  it('asks the mode question even when the user owns only a season account', () => {
    // The broken case: this used to route straight into season Home.
    assert.equal(
      resolveAuthedEntryRoute('new_login', seasonOnly, null),
      'mode_selection',
    );
  });

  it('asks the mode question when the user owns only a general account', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', generalOnly, null),
      'mode_selection',
    );
  });

  it('asks the mode question when the user owns both kinds of account', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', both, null),
      'mode_selection',
    );
  });

  it('asks the mode question when the user owns nothing — the screen offers both starts', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', [], null),
      'mode_selection',
    );
  });

  it('is NOT skipped by a stored selection: a new login re-asks', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', both, 'general-acc-1'),
      'mode_selection',
    );
  });

  it('treats a missing list as "owns nothing" rather than throwing', () => {
    assert.equal(
      resolveAuthedEntryRoute('new_login', undefined, null),
      'mode_selection',
    );
    assert.equal(
      resolveAuthedEntryRoute('new_login', null, null),
      'mode_selection',
    );
  });
});

describe('resolveAuthedEntryRoute — session restore', () => {
  it('keeps the stored account when it is still owned', () => {
    assert.equal(
      resolveAuthedEntryRoute('session_restore', both, 'season-acc-1'),
      'home',
    );
  });

  it('re-asks when nothing was stored — never "active season by default"', () => {
    assert.equal(
      resolveAuthedEntryRoute('session_restore', seasonOnly, null),
      'mode_selection',
    );
  });

  it('re-asks when the stored account is no longer owned', () => {
    assert.equal(
      resolveAuthedEntryRoute('session_restore', seasonOnly, 'gone-acc'),
      'mode_selection',
    );
  });

  it('re-asks when the user owns nothing any more', () => {
    assert.equal(
      resolveAuthedEntryRoute('session_restore', [], 'season-acc-1'),
      'mode_selection',
    );
  });
});

describe('loadEntryRoute', () => {
  function fakeClient() {
    const keys: unknown[][] = [];

    return {
      keys,
      async fetchQuery<T>(options: {
        queryKey: readonly unknown[];
        queryFn: () => Promise<T>;
      }): Promise<T> {
        keys.push([...options.queryKey]);
        return options.queryFn();
      },
    };
  }

  it('reads the account list under the CURRENT USER key', async () => {
    const client = fakeClient();

    await loadEntryRoute(client, 'user-a', 'new_login', {
      loadAccounts: async () => ({ accounts: [{ id: 'acc-1' }] }),
      readStoredAccountId: async () => null,
    });

    // Same entry the account provider mounts on: one request, and no chance of
    // routing on one user's list while selecting from another's.
    assert.deepEqual(client.keys, [
      [...QUERY_KEYS.tradingAccount.list('user-a')],
    ]);
  });

  it('does not even READ the stored selection on a new login', async () => {
    let storedReads = 0;

    const route = await loadEntryRoute(fakeClient(), 'user-a', 'new_login', {
      loadAccounts: async () => ({ accounts: [{ id: 'acc-1' }] }),
      readStoredAccountId: async () => {
        storedReads += 1;
        return 'acc-1';
      },
    });

    assert.equal(route, 'mode_selection');
    assert.equal(storedReads, 0);
  });

  it('restores the stored account on a session restore', async () => {
    const route = await loadEntryRoute(
      fakeClient(),
      'user-a',
      'session_restore',
      {
        loadAccounts: async () => ({ accounts: [{ id: 'acc-1' }] }),
        readStoredAccountId: async (userId) => {
          assert.equal(userId, 'user-a');
          return 'acc-1';
        },
      },
    );

    assert.equal(route, 'home');
  });

  it('sends a restore with a dropped selection to mode selection', async () => {
    const route = await loadEntryRoute(
      fakeClient(),
      'user-a',
      'session_restore',
      {
        loadAccounts: async () => ({ accounts: [{ id: 'acc-1' }] }),
        readStoredAccountId: async () => null,
      },
    );

    assert.equal(route, 'mode_selection');
  });

  it('propagates a failure instead of reporting "no accounts"', async () => {
    await assert.rejects(
      loadEntryRoute(fakeClient(), 'user-a', 'new_login', {
        loadAccounts: async () => {
          throw new Error('network down');
        },
        readStoredAccountId: async () => null,
      }),
      /network down/,
    );
  });
});
