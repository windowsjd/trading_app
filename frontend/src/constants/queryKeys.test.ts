import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { QUERY_KEYS, normalizeFilterKey } from './queryKeys.ts';

const A = 'account-aaa';
const B = 'account-bbb';

/**
 * The property every test here is really about: react-query invalidates by KEY
 * PREFIX, so "does account A's mutation touch account B?" is decided entirely
 * by whether B's key starts with A's prefix.
 */
function startsWith(key: readonly unknown[], prefix: readonly unknown[]) {
  return prefix.every((segment, index) => key[index] === segment);
}

describe('account-scoped query keys keep accounts apart', () => {
  it('separates the SAME portfolio range across two accounts', () => {
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.portfolioEquity(A, '7d'),
      QUERY_KEYS.tradingAccount.portfolioEquity(B, '7d'),
    );
  });

  it('separates the SAME asset filter across two accounts', () => {
    const filters = { assetType: 'crypto', assetId: 'asset-btc' };

    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.positions(A, filters),
      QUERY_KEYS.tradingAccount.positions(B, filters),
    );
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.orders(A, filters),
      QUERY_KEYS.tradingAccount.orders(B, filters),
    );
  });

  it('separates the SAME orderId across two accounts', () => {
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.orderDetail(A, 'order-1'),
      QUERY_KEYS.tradingAccount.orderDetail(B, 'order-1'),
    );
  });

  it('carries the accountId in EVERY financial key', () => {
    const keys: readonly unknown[][] = [
      [...QUERY_KEYS.tradingAccount.detail(A)],
      [...QUERY_KEYS.tradingAccount.portfolio(A)],
      [...QUERY_KEYS.tradingAccount.portfolioEquity(A, '1d')],
      [...QUERY_KEYS.tradingAccount.wallets(A)],
      [...QUERY_KEYS.tradingAccount.walletTransactions(A)],
      [...QUERY_KEYS.tradingAccount.positions(A)],
      [...QUERY_KEYS.tradingAccount.orders(A)],
      [...QUERY_KEYS.tradingAccount.orderDetail(A, 'o1')],
      [...QUERY_KEYS.tradingAccount.quote(A, 'q1')],
      [...QUERY_KEYS.tradingAccount.adRewardEligibility(A)],
      [...QUERY_KEYS.tradingAccount.adRewardClaims(A)],
    ];

    for (const key of keys) {
      assert.ok(
        key.includes(A),
        `key ${JSON.stringify(key)} must be scoped to the account`,
      );
    }
  });

  it('never keys on mode alone — two season accounts must not share a cache entry', () => {
    const seasonA = QUERY_KEYS.tradingAccount.portfolio('season-acc-1');
    const seasonB = QUERY_KEYS.tradingAccount.portfolio('season-acc-2');

    assert.notDeepEqual(seasonA, seasonB);
    assert.ok(!seasonA.includes('season' as never));
  });
});

describe('invalidation prefixes cannot cross accounts', () => {
  it("account A's portfolio prefix does not match account B's entries", () => {
    const prefix = QUERY_KEYS.tradingAccount.portfolioAll(A);

    assert.ok(startsWith(QUERY_KEYS.tradingAccount.portfolio(A), prefix));
    assert.ok(
      startsWith(QUERY_KEYS.tradingAccount.portfolioEquity(A, '30d'), prefix),
    );
    assert.ok(!startsWith(QUERY_KEYS.tradingAccount.portfolio(B), prefix));
    assert.ok(
      !startsWith(QUERY_KEYS.tradingAccount.portfolioEquity(B, '30d'), prefix),
    );
  });

  it('an order mutation on A refreshes A orders/wallets/positions/portfolio only', () => {
    // What a create/cancel handler invalidates.
    const refreshed = [
      QUERY_KEYS.tradingAccount.ordersAll(A),
      QUERY_KEYS.tradingAccount.walletsAll(A),
      QUERY_KEYS.tradingAccount.positionsAll(A),
      QUERY_KEYS.tradingAccount.portfolioAll(A),
    ];
    const accountBEntries = [
      QUERY_KEYS.tradingAccount.orders(B),
      QUERY_KEYS.tradingAccount.wallets(B),
      QUERY_KEYS.tradingAccount.positions(B),
      QUERY_KEYS.tradingAccount.portfolio(B),
      QUERY_KEYS.tradingAccount.portfolioEquity(B, '1d'),
    ];

    for (const prefix of refreshed) {
      for (const entry of accountBEntries) {
        assert.ok(
          !startsWith(entry, prefix),
          `${JSON.stringify(prefix)} must not match ${JSON.stringify(entry)}`,
        );
      }
    }
  });

  it('separates the owned-account LIST across two users', () => {
    // 작업 11 §3.1. Before this, both users read one shared entry, so the first
    // frame after a switch could offer — and then select — an account the new
    // user does not own.
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.list('user-a'),
      QUERY_KEYS.tradingAccount.list('user-b'),
    );
    assert.ok(
      startsWith(
        QUERY_KEYS.tradingAccount.list('user-a'),
        QUERY_KEYS.tradingAccount.listAll,
      ),
      'listAll must remain a usable invalidation prefix for any user',
    );
  });

  it('separates the SAME leaderboard request across two seasons', () => {
    // 작업 11 §10.1: Home names the selected account's season explicitly, the
    // public tab means "current". They must not share one entry.
    assert.notDeepEqual(
      QUERY_KEYS.ranking.list({ scope: 'near_me', seasonId: 'season-1' }),
      QUERY_KEYS.ranking.list({ scope: 'near_me', seasonId: 'season-2' }),
    );
    assert.notDeepEqual(
      QUERY_KEYS.ranking.list({ scope: 'near_me', seasonId: 'season-1' }),
      QUERY_KEYS.ranking.list({ scope: 'near_me' }),
    );
  });

  it('the account-wide prefix still clears everything at logout', () => {
    const all = QUERY_KEYS.tradingAccount.all;

    for (const entry of [
      QUERY_KEYS.tradingAccount.portfolio(A),
      QUERY_KEYS.tradingAccount.wallets(B),
      QUERY_KEYS.tradingAccount.list('user-1'),
    ]) {
      assert.ok(startsWith(entry, all));
    }
  });
});

describe('normalizeFilterKey', () => {
  it('treats undefined, null, empty string and omission as the same query', () => {
    const base = normalizeFilterKey({ assetType: 'crypto' });

    assert.equal(normalizeFilterKey({ assetType: 'crypto', assetId: undefined }), base);
    assert.equal(normalizeFilterKey({ assetType: 'crypto', assetId: null }), base);
    assert.equal(normalizeFilterKey({ assetType: 'crypto', assetId: '' }), base);
    assert.equal(normalizeFilterKey(undefined), '');
    assert.equal(normalizeFilterKey(null), '');
  });

  it('is independent of object key order', () => {
    assert.equal(
      normalizeFilterKey({ side: 'buy', status: 'submitted' }),
      normalizeFilterKey({ status: 'submitted', side: 'buy' }),
    );
  });

  it('still distinguishes genuinely different filters', () => {
    assert.notEqual(
      normalizeFilterKey({ side: 'buy' }),
      normalizeFilterKey({ side: 'sell' }),
    );
    assert.notEqual(
      normalizeFilterKey({ limit: 20 }),
      normalizeFilterKey({ limit: 50 }),
    );
  });

  it('gives equal filters on different accounts DIFFERENT full keys', () => {
    const filters = { side: 'buy', status: 'submitted' };

    assert.equal(
      normalizeFilterKey(filters),
      normalizeFilterKey({ status: 'submitted', side: 'buy' }),
    );
    assert.notDeepEqual(
      QUERY_KEYS.tradingAccount.orders(A, filters),
      QUERY_KEYS.tradingAccount.orders(B, filters),
    );
  });
});
