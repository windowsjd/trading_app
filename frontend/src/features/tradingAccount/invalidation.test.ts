import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  invalidateAfterAdRewardClaim,
  invalidateAfterFx,
  invalidateAfterOrderCancel,
  invalidateAfterOrderCreate,
  type InvalidatorClient,
} from './invalidation.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const A = 'account-A';
const B = 'account-B';

function recorder() {
  const keys: unknown[][] = [];
  const client: InvalidatorClient = {
    invalidateQueries: ({ queryKey }) => {
      keys.push([...queryKey]);
    },
  };
  return { client, keys };
}

/**
 * react-query invalidates by PREFIX. This mirrors that rule so the tests assert
 * what actually happens at runtime rather than exact-key equality.
 */
function matchesAny(invalidated: unknown[][], target: readonly unknown[]) {
  return invalidated.some(
    (prefix) =>
      prefix.length <= target.length &&
      prefix.every((segment, index) => segment === target[index]),
  );
}

describe('account-scoped invalidation targets ONE account', () => {
  const otherAccountEntries = [
    QUERY_KEYS.tradingAccount.portfolio(B),
    QUERY_KEYS.tradingAccount.portfolioEquity(B, '7d'),
    QUERY_KEYS.tradingAccount.wallets(B),
    QUERY_KEYS.tradingAccount.walletTransactions(B, { currency: 'KRW' }),
    QUERY_KEYS.tradingAccount.positions(B, { limit: 20 }),
    QUERY_KEYS.tradingAccount.orders(B, { limit: 20 }),
    QUERY_KEYS.tradingAccount.orderDetail(B, 'order-1'),
    QUERY_KEYS.tradingAccount.adRewardEligibility(B),
  ];

  const sharedMarketEntries = [
    QUERY_KEYS.asset.detail('asset-1'),
    QUERY_KEYS.asset.price('asset-1'),
    QUERY_KEYS.asset.candles('asset-1', { range: '1d', interval: '5m' }),
    QUERY_KEYS.market.assets({ assetType: 'crypto' }),
  ];

  const mutations: Array<{
    name: string;
    run: (client: InvalidatorClient) => unknown;
    mustInvalidate: readonly (readonly unknown[])[];
    mustNotInvalidate?: readonly (readonly unknown[])[];
  }> = [
    {
      name: 'order create',
      run: (client) => invalidateAfterOrderCreate(client, A, { seasonUi: true }),
      mustInvalidate: [
        QUERY_KEYS.tradingAccount.orders(A, { limit: 20 }),
        QUERY_KEYS.tradingAccount.orderDetail(A, 'order-9'),
        QUERY_KEYS.tradingAccount.positions(A, { limit: 20 }),
        QUERY_KEYS.tradingAccount.wallets(A),
        QUERY_KEYS.tradingAccount.walletTransactions(A, {}),
        QUERY_KEYS.tradingAccount.portfolio(A),
        QUERY_KEYS.tradingAccount.portfolioEquity(A, 'all'),
      ],
    },
    {
      name: 'order cancel',
      run: (client) => invalidateAfterOrderCancel(client, A, { seasonUi: true }),
      mustInvalidate: [
        QUERY_KEYS.tradingAccount.orders(A, { limit: 20 }),
        QUERY_KEYS.tradingAccount.orderDetail(A, 'order-9'),
        QUERY_KEYS.tradingAccount.wallets(A),
        QUERY_KEYS.tradingAccount.walletTransactions(A, {}),
        QUERY_KEYS.tradingAccount.portfolio(A),
      ],
      // A cancel never fills, so no holding changed.
      mustNotInvalidate: [QUERY_KEYS.tradingAccount.positions(A, { limit: 20 })],
    },
    {
      name: 'fx execute',
      run: (client) => invalidateAfterFx(client, A, { seasonUi: true }),
      mustInvalidate: [
        QUERY_KEYS.tradingAccount.wallets(A),
        QUERY_KEYS.tradingAccount.walletTransactions(A, {}),
        QUERY_KEYS.tradingAccount.portfolio(A),
        QUERY_KEYS.tradingAccount.portfolioEquity(A, '30d'),
      ],
      // An exchange moves cash between currencies; it buys nothing.
      mustNotInvalidate: [QUERY_KEYS.tradingAccount.positions(A, { limit: 20 })],
    },
    {
      name: 'ad reward claim',
      run: (client) => invalidateAfterAdRewardClaim(client, A),
      mustInvalidate: [
        QUERY_KEYS.tradingAccount.adRewardEligibility(A),
        QUERY_KEYS.tradingAccount.adRewardClaims(A, { limit: 20 }),
        QUERY_KEYS.tradingAccount.wallets(A),
        QUERY_KEYS.tradingAccount.portfolio(A),
      ],
    },
  ];

  for (const mutation of mutations) {
    it(`${mutation.name} refreshes the acting account's entries`, async () => {
      const { client, keys } = recorder();
      await mutation.run(client);

      for (const target of mutation.mustInvalidate) {
        assert.ok(
          matchesAny(keys, target),
          `${mutation.name} should invalidate ${JSON.stringify(target)}`,
        );
      }
    });

    it(`${mutation.name} leaves the OTHER account's cache alone`, async () => {
      const { client, keys } = recorder();
      await mutation.run(client);

      for (const target of otherAccountEntries) {
        assert.ok(
          !matchesAny(keys, target),
          `${mutation.name} must not invalidate account B's ${JSON.stringify(target)}`,
        );
      }
    });

    it(`${mutation.name} does not throw away shared market data`, async () => {
      const { client, keys } = recorder();
      await mutation.run(client);

      for (const target of sharedMarketEntries) {
        assert.ok(
          !matchesAny(keys, target),
          `${mutation.name} must not invalidate ${JSON.stringify(target)}`,
        );
      }
    });

    it(`${mutation.name} never invalidates the whole tradingAccount tree`, async () => {
      const { client, keys } = recorder();
      await mutation.run(client);

      // `['tradingAccount']` alone would prefix-match every account.
      assert.ok(
        !keys.some((key) => key.length === 1 && key[0] === 'tradingAccount'),
        'a blanket tradingAccount.all invalidation discards other accounts',
      );
    });

    if (mutation.mustNotInvalidate) {
      it(`${mutation.name} does not refresh data it cannot have changed`, async () => {
        const { client, keys } = recorder();
        await mutation.run(client);

        for (const target of mutation.mustNotInvalidate!) {
          assert.ok(
            !matchesAny(keys, target),
            `${mutation.name} should not invalidate ${JSON.stringify(target)}`,
          );
        }
      });
    }
  }

  it('skips season-only views for a general account', async () => {
    const { client, keys } = recorder();
    await invalidateAfterOrderCreate(client, A, { seasonUi: false });

    assert.ok(!matchesAny(keys, QUERY_KEYS.ranking.all));
    assert.ok(!matchesAny(keys, QUERY_KEYS.record.all));
    assert.ok(!matchesAny(keys, QUERY_KEYS.home.dashboard));
  });

  it('refreshes season-only views for a season account', async () => {
    const { client, keys } = recorder();
    await invalidateAfterOrderCreate(client, A, { seasonUi: true });

    // These are keyed by season, not by account, so they have no per-account
    // entry to be selective about.
    assert.ok(matchesAny(keys, QUERY_KEYS.ranking.all));
    assert.ok(matchesAny(keys, QUERY_KEYS.record.all));
  });
});

describe('query keys separate accounts structurally', () => {
  it("account A's prefix cannot match account B's entries", () => {
    const prefixA = QUERY_KEYS.tradingAccount.walletsAll(A);
    const entryB = QUERY_KEYS.tradingAccount.walletTransactions(B, {});

    assert.ok(!matchesAny([[...prefixA]], entryB));
  });

  it('two season accounts do not share one cache entry', () => {
    // The reason the key carries the accountId rather than the mode.
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.portfolio('season-2026-01'),
      QUERY_KEYS.tradingAccount.portfolio('season-2026-02'),
    );
  });

  it('normalises equivalent filters to one entry', () => {
    assert.deepEqual(
      QUERY_KEYS.tradingAccount.orders(A, { side: undefined, limit: 20 }),
      QUERY_KEYS.tradingAccount.orders(A, { limit: 20 }),
    );
    assert.deepEqual(
      QUERY_KEYS.tradingAccount.orders(A, { limit: 20, side: '' }),
      QUERY_KEYS.tradingAccount.orders(A, { side: undefined, limit: 20 }),
    );
  });
});
