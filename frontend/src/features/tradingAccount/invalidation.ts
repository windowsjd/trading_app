import { QUERY_KEYS } from '../../constants/queryKeys.ts';

/**
 * Which cache entries a successful account-scoped mutation refreshes
 * (작업 10 §A-11).
 *
 * Two rules decide every list below.
 *
 * 1. INVALIDATE ONLY THE ACTING ACCOUNT. Each key carries its accountId
 *    immediately after the resource name, so `['tradingAccount','wallets',A]`
 *    matches every one of A's wallet entries and cannot prefix-match B's. A
 *    blanket `QUERY_KEYS.tradingAccount.all` would throw away B's perfectly
 *    good, still-correct cache and make every switch back to B a cold load —
 *    for a mutation that provably could not have changed B's money.
 *
 * 2. DON'T TOUCH SHARED MARKET DATA. Prices, candles, and asset detail are the
 *    same rows for every account and every user. An order changes what the
 *    user OWNS, not what a share is worth, so invalidating market queries here
 *    would refetch data that cannot have changed and, on the asset screen,
 *    replace a live chart with a spinner as a side effect of buying.
 *
 * These take the minimal `invalidateQueries` surface rather than a QueryClient
 * so they can be unit-tested without a React tree or a network client.
 */

export type InvalidatorClient = {
  invalidateQueries: (filters: {
    queryKey: readonly unknown[];
  }) => Promise<unknown> | unknown;
};

type QueryKey = readonly unknown[];

function invalidateAll(client: InvalidatorClient, keys: readonly QueryKey[]) {
  return Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/** Wallet balances + ledger for one account. */
function walletKeys(accountId: string): QueryKey[] {
  return [QUERY_KEYS.tradingAccount.walletsAll(accountId)];
}

/** Portfolio overview AND every equity range for one account. */
function portfolioKeys(accountId: string): QueryKey[] {
  return [QUERY_KEYS.tradingAccount.portfolioAll(accountId)];
}

/**
 * After creating an order: holdings, cash, the order itself, and the valuation
 * that depends on all three.
 *
 * Season ranking is refreshed too — a filled order changes the user's own
 * standing, and the leaderboard is season-wide public data with no accountId in
 * its key, so there is no per-account entry to be selective about.
 */
export function invalidateAfterOrderCreate(
  client: InvalidatorClient,
  accountId: string,
  options: { seasonUi?: boolean } = {},
) {
  const keys: QueryKey[] = [
    QUERY_KEYS.tradingAccount.ordersAll(accountId),
    QUERY_KEYS.tradingAccount.positionsAll(accountId),
    ...walletKeys(accountId),
    ...portfolioKeys(accountId),
    // Season history/record lists are keyed by seasonId, not accountId; a new
    // order must appear there too.
    ...(options.seasonUi
      ? [QUERY_KEYS.record.all, QUERY_KEYS.ranking.all, QUERY_KEYS.home.dashboard]
      : []),
  ];

  return invalidateAll(client, keys);
}

/**
 * After cancelling: the order's status, and the cash its reservation released.
 * Positions are NOT invalidated — a cancel never fills, so no holding changed.
 */
export function invalidateAfterOrderCancel(
  client: InvalidatorClient,
  accountId: string,
  options: { seasonUi?: boolean } = {},
) {
  const keys: QueryKey[] = [
    QUERY_KEYS.tradingAccount.ordersAll(accountId),
    ...walletKeys(accountId),
    ...portfolioKeys(accountId),
    ...(options.seasonUi ? [QUERY_KEYS.record.all, QUERY_KEYS.home.dashboard] : []),
  ];

  return invalidateAll(client, keys);
}

/**
 * After FX: both wallets moved and the KRW valuation of the USD side changed.
 * Positions are untouched — an exchange moves cash between currencies, it does
 * not buy or sell anything.
 */
export function invalidateAfterFx(
  client: InvalidatorClient,
  accountId: string,
  options: { seasonUi?: boolean } = {},
) {
  const keys: QueryKey[] = [
    ...walletKeys(accountId),
    ...portfolioKeys(accountId),
    ...(options.seasonUi ? [QUERY_KEYS.home.dashboard, QUERY_KEYS.ranking.all] : []),
  ];

  return invalidateAll(client, keys);
}

/**
 * After an ad-reward claim: the claim itself, remaining eligibility, and the
 * cash it granted. General-only, so no season UI is refreshed.
 */
export function invalidateAfterAdRewardClaim(
  client: InvalidatorClient,
  accountId: string,
) {
  const keys: QueryKey[] = [
    QUERY_KEYS.tradingAccount.adRewardsAll(accountId),
    ...walletKeys(accountId),
    ...portfolioKeys(accountId),
  ];

  return invalidateAll(client, keys);
}
