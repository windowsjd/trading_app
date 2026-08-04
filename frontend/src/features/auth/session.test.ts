import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { clearSessionCache, seedSessionCache } from './sessionCache.ts';

/**
 * These cover the CACHE half of the session boundary — the half that decides
 * whether the next user of this device can read the previous user's balances.
 * The token/AsyncStorage half lives in `session.ts` and needs React Native
 * storage, which is not what is at risk here.
 */

/**
 * A minimal stand-in for the react-query client that records the operations the
 * session boundary performs, and models the ONE property under test: `clear()`
 * removes entries, so nothing survives to be read by the next user.
 */
function fakeQueryClient() {
  const store = new Map<string, unknown>();
  const ops: string[] = [];

  return {
    ops,
    store,
    seed(queryKey: readonly unknown[], data: unknown) {
      store.set(JSON.stringify(queryKey), data);
    },
    read(queryKey: readonly unknown[]) {
      return store.get(JSON.stringify(queryKey));
    },
    size() {
      return store.size;
    },
    clear() {
      ops.push('clear');
      store.clear();
    },
    setQueryData(queryKey: readonly unknown[], data: unknown) {
      ops.push(`setQueryData:${JSON.stringify(queryKey)}`);
      store.set(JSON.stringify(queryKey), data);
      return data;
    },
    invalidateQueries({ queryKey }: { queryKey: readonly unknown[] }) {
      ops.push(`invalidate:${JSON.stringify(queryKey)}`);
      // NOTE: invalidation deliberately does NOT delete. That is exactly why
      // logout must clear rather than invalidate.
      return Promise.resolve();
    },
  };
}

/** Every financial entry a signed-in user accumulates, legacy keys included. */
function seedFinancialCache(client: ReturnType<typeof fakeQueryClient>) {
  client.seed(QUERY_KEYS.me, { id: 'user-a', nickname: '사용자 A' });
  client.seed(QUERY_KEYS.tradingAccount.list('user-a'), {
    accounts: [{ id: 'acc-a' }],
  });
  client.seed(QUERY_KEYS.tradingAccount.portfolio('acc-a'), {
    summary: { totalAssetKrw: '12345678' },
  });
  client.seed(QUERY_KEYS.tradingAccount.wallets('acc-a'), { wallets: [] });
  client.seed(QUERY_KEYS.tradingAccount.orders('acc-a', {}), { orders: [] });
  // The legacy keys that the old two-key logout left behind.
  client.seed(QUERY_KEYS.wallet.balances, { wallets: [] });
  client.seed(QUERY_KEYS.position.all, []);
  client.seed(QUERY_KEYS.portfolio.overview, {});
  client.seed(QUERY_KEYS.order.myList(), {});
  client.seed(QUERY_KEYS.record.seasons({ limit: 20 }), {});
  client.seed(QUERY_KEYS.ranking.all, []);
}

const USER_B = {
  id: 'user-b',
  email: 'b@example.com',
  nickname: '사용자 B',
  status: 'active' as const,
};

describe('session boundary', () => {
  describe('clearSessionCache (logout / expiry)', () => {
    it('removes EVERY cached entry, legacy financial keys included', async () => {
      const client = fakeQueryClient();
      seedFinancialCache(client);
      assert.ok(client.size() > 0);

      clearSessionCache(client);

      assert.equal(
        client.size(),
        0,
        'no entry may survive into the next session',
      );
    });

    it("user B's first render cannot read user A's portfolio", async () => {
      const client = fakeQueryClient();
      seedFinancialCache(client);

      clearSessionCache(client);

      // The specific failure this prevents: B opens Portfolio, react-query
      // finds a cached entry, and paints A's total asset value before B's own
      // request has even been issued.
      assert.equal(
        client.read(QUERY_KEYS.tradingAccount.portfolio('acc-a')),
        undefined,
      );
      assert.equal(client.read(QUERY_KEYS.wallet.balances), undefined);
      assert.equal(client.read(QUERY_KEYS.me), undefined);
    });

    it('CLEARS rather than invalidates — an invalidated entry is still readable', async () => {
      const client = fakeQueryClient();
      seedFinancialCache(client);

      clearSessionCache(client);

      assert.ok(client.ops.includes('clear'));
      assert.ok(
        !client.ops.some((op) => op.startsWith('invalidate:')),
        'invalidation leaves a readable window during refetch',
      );
    });

  });

  describe('seedSessionCache (login / signup)', () => {
    it("clears the previous user's cache BEFORE seeding the new one", async () => {
      const client = fakeQueryClient();
      seedFinancialCache(client);

      await seedSessionCache(client, USER_B);

      const clearIndex = client.ops.indexOf('clear');
      const seedIndex = client.ops.findIndex((op) =>
        op.startsWith('setQueryData:'),
      );
      assert.ok(clearIndex >= 0);
      assert.ok(seedIndex > clearIndex, 'clear must happen first');
      assert.equal(
        client.read(QUERY_KEYS.tradingAccount.portfolio('acc-a')),
        undefined,
      );
    });

    it('seeds `me` from the login response so the account list can load at once', async () => {
      const client = fakeQueryClient();
      await seedSessionCache(client, USER_B);

      // Without this the provider sits on its pre-login 401 for `me`, the
      // account query stays disabled (`enabled: !!userId`), and the switcher
      // stays empty until the app is restarted.
      assert.deepEqual(client.read(QUERY_KEYS.me), USER_B);
    });

    it('refetches the owned-account list for the new user', async () => {
      const client = fakeQueryClient();

      await seedSessionCache(client, USER_B);

      assert.ok(
        client.ops.includes(
          `invalidate:${JSON.stringify(QUERY_KEYS.tradingAccount.list(USER_B.id))}`,
        ),
      );
    });

  });
});
