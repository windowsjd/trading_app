import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { loadEntryRoute, resolveAuthedEntryRoute } from './entry.ts';

/**
 * App entry is decided by owned accounts (작업 11 §3).
 *
 * The bug these lock down: entry used to ask `getCurrentSeason()`, so a user
 * holding a working general account was routed to the season screen whenever no
 * season was open — an app they could use, hidden behind a page about something
 * they were not doing.
 */

describe('resolveAuthedEntryRoute', () => {
  it('sends a user who owns ANY account into the app', () => {
    assert.equal(resolveAuthedEntryRoute([{ id: 'acc-1' }]), 'home');
  });

  it('sends a user who owns a general account into the app', () => {
    // The case that was broken: no season anywhere in the decision.
    assert.equal(resolveAuthedEntryRoute([{ id: 'general-1' }]), 'home');
  });

  it('sends a user who owns nothing to account setup', () => {
    assert.equal(resolveAuthedEntryRoute([]), 'account_setup');
  });

  it('treats a missing list as "owns nothing" rather than throwing', () => {
    assert.equal(resolveAuthedEntryRoute(undefined), 'account_setup');
    assert.equal(resolveAuthedEntryRoute(null), 'account_setup');
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

    await loadEntryRoute(client, 'user-a', async () => ({
      accounts: [{ id: 'acc-1' }],
    }));

    // Same entry the account provider mounts on: one request, and no chance of
    // routing on one user's list while selecting from another's.
    assert.deepEqual(client.keys, [
      [...QUERY_KEYS.tradingAccount.list('user-a')],
    ]);
  });

  it('routes to setup when the user owns nothing', async () => {
    const client = fakeClient();

    const route = await loadEntryRoute(client, 'user-a', async () => ({
      accounts: [],
    }));

    assert.equal(route, 'account_setup');
  });

  it('propagates a failure instead of reporting "no accounts"', async () => {
    const client = fakeClient();

    await assert.rejects(
      loadEntryRoute(client, 'user-a', async () => {
        throw new Error('network down');
      }),
      /network down/,
    );
  });
});
