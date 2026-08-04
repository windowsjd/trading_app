export const QUERY_KEYS = {
  me: ['me'] as const,

  season: {
    current: ['season', 'current'] as const,
    list: (params?: { status?: string; limit?: number; offset?: number }) =>
      [
        'season',
        'list',
        params?.status ?? 'all',
        params?.limit ?? null,
        params?.offset ?? 0,
      ] as const,
  },

  home: {
    dashboard: ['home', 'dashboard'] as const,
  },

  wallet: {
    all: ['wallet'] as const,
    balances: ['wallet', 'balances'] as const,
    transactionsAll: ['wallet', 'transactions'] as const,
    transactions: (params?: {
      currency?: string;
      direction?: string;
      txType?: string;
      limit?: number;
      offset?: number;
    }) =>
      [
        'wallet',
        'transactions',
        params?.currency ?? 'all',
        params?.direction ?? 'all',
        params?.txType ?? 'all',
        params?.limit ?? null,
        params?.offset ?? 0,
      ] as const,
    fxRate: (
      params:
        | string
        | {
            baseCurrency?: string;
            quoteCurrency?: string;
            refresh?: boolean;
          },
    ) => {
      if (typeof params === 'string') {
        return ['wallet', 'fx-rate', params] as const;
      }

      return [
        'wallet',
        'fx-rate',
        params.baseCurrency ?? 'USD',
        params.quoteCurrency ?? 'KRW',
        params.refresh ?? false,
      ] as const;
    },
    fxHistory: (cursor?: string | null) =>
      ['wallet', 'fx-history', cursor ?? null] as const,
  },

  market: {
    assets: (params: {
      assetType?: string;
      search?: string;
      market?: string;
      currencyCode?: string;
      withPrice?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      [
        'market',
        'assets',
        params.assetType ?? 'all',
        params.search ?? '',
        params.market ?? '',
        params.currencyCode ?? '',
        params.withPrice ?? false,
        params.limit ?? null,
        params.offset ?? 0,
      ] as const,
  },

  asset: {
    detail: (assetId: string) => ['asset', 'detail', assetId] as const,
    candles: (
      assetId: string,
      params: { range: string; interval: string; limit?: number },
    ) =>
      [
        'asset',
        'candles',
        assetId,
        params.range,
        params.interval,
        params.limit ?? null,
      ] as const,
    price: (assetId: string) => ['asset', 'price', assetId] as const,
  },

  position: {
    all: ['positions'] as const,
    list: (params?: {
      assetType?: string;
      assetId?: string;
      limit?: number;
      offset?: number;
    }) =>
      [
        'positions',
        'list',
        params?.assetType ?? 'all',
        params?.assetId ?? null,
        params?.limit ?? null,
        params?.offset ?? 0,
      ] as const,
  },

  portfolio: {
    all: ['portfolio'] as const,
    overview: ['portfolio', 'overview'] as const,
    positions: (params?: {
      assetType?: string;
      limit?: number;
      offset?: number;
    }) =>
      [
        'portfolio',
        'positions',
        params?.assetType ?? 'all',
        params?.limit ?? null,
        params?.offset ?? 0,
      ] as const,
    equity: (range: string) => ['portfolio', 'equity', range] as const,
  },

  order: {
    myList: (params?: Record<string, unknown>) =>
      ['order', 'my-list', params ?? {}] as const,
  },

  ranking: {
    all: ['ranking'] as const,
    list: (params: {
      scope: string;
      rankType?: string;
      rankingDate?: string | null;
      capturedAt?: string | null;
      limit?: number;
      offset?: number;
    }) =>
      [
        'ranking',
        'list',
        params.scope,
        params.rankType ?? 'auto',
        params.rankingDate ?? null,
        params.capturedAt ?? null,
        params.limit ?? null,
        params.offset ?? 0,
      ] as const,
    userSeasonSummary: (userId: string) =>
      ['ranking', 'user-season-summary', userId] as const,
  },

  record: {
    all: ['record'] as const,
    seasons: (params?: { limit?: number; offset?: number }) =>
      [
        'record',
        'seasons',
        params?.limit ?? null,
        params?.offset ?? 0,
      ] as const,
    seasonDetail: (seasonId: string) =>
      ['record', 'season-detail', seasonId] as const,
    seasonEquity: (params: {
      seasonId: string;
      limit?: number;
      offset?: number;
    }) =>
      [
        'record',
        'season-equity',
        params.seasonId,
        params.limit ?? null,
        params.offset ?? 0,
      ] as const,
    seasonOrders: (
      params: {
        seasonId: string;
        limit?: number;
        offset?: number;
        side?: string;
      },
    ) =>
      [
        'record',
        'season-orders',
        params.seasonId,
        params.side ?? 'all',
        params.limit ?? null,
        params.offset ?? 0,
      ] as const,
    seasonExchanges: (
      params: {
        seasonId: string;
        limit?: number;
        offset?: number;
      },
    ) =>
      [
        'record',
        'season-exchanges',
        params.seasonId,
        params.limit ?? null,
        params.offset ?? 0,
      ] as const,
  },

  reward: {
    rewards: ['reward', 'rewards'] as const,
    badges: ['reward', 'badges'] as const,
  },

  /**
   * ACCOUNT-SCOPED financial cache keys (작업 9 §B-4).
   *
   * Every key below carries the `accountId` itself — not the mode, not "season
   * vs general". Mode is not an identity: a user can hold several season
   * accounts across seasons, and two of them keyed only by `'season'` would
   * share one cache entry. The first screen would then paint the other
   * account's positions and call them yours.
   *
   * The accountId is placed immediately after the resource name so that
   * `['tradingAccount', 'portfolio', accountId]` is a valid invalidation prefix
   * for everything about ONE account's portfolio, at every range — and, just as
   * importantly, so no prefix that includes an accountId can ever match a
   * different account's entries. A mutation on account A therefore cannot
   * invalidate account B's perfectly good cache.
   *
   * Filters are normalised through `normalizeFilterKey` so `undefined`, `''`,
   * and an omitted field all collapse to the same token. Two calls that mean
   * the same query must not produce two cache entries — that is how a screen
   * ends up refetching forever and how a mutation misses the entry it should
   * have refreshed.
   */
  tradingAccount: {
    /** Everything account-scoped; the logout-time clear target. */
    all: ['tradingAccount'] as const,
    /** The owned-account list is per USER, not per account. */
    list: ['tradingAccount', 'list'] as const,
    detail: (accountId: string) =>
      ['tradingAccount', 'detail', accountId] as const,

    portfolioAll: (accountId: string) =>
      ['tradingAccount', 'portfolio', accountId] as const,
    portfolio: (accountId: string) =>
      ['tradingAccount', 'portfolio', accountId, 'overview'] as const,
    portfolioEquity: (accountId: string, range: string) =>
      ['tradingAccount', 'portfolio', accountId, 'equity', range] as const,

    walletsAll: (accountId: string) =>
      ['tradingAccount', 'wallets', accountId] as const,
    wallets: (accountId: string) =>
      ['tradingAccount', 'wallets', accountId, 'balances'] as const,
    walletTransactions: (
      accountId: string,
      filters?: Record<string, unknown>,
    ) =>
      [
        'tradingAccount',
        'wallets',
        accountId,
        'transactions',
        normalizeFilterKey(filters),
      ] as const,

    positionsAll: (accountId: string) =>
      ['tradingAccount', 'positions', accountId] as const,
    positions: (accountId: string, filters?: Record<string, unknown>) =>
      [
        'tradingAccount',
        'positions',
        accountId,
        'list',
        normalizeFilterKey(filters),
      ] as const,

    ordersAll: (accountId: string) =>
      ['tradingAccount', 'orders', accountId] as const,
    orders: (accountId: string, filters?: Record<string, unknown>) =>
      [
        'tradingAccount',
        'orders',
        accountId,
        'list',
        normalizeFilterKey(filters),
      ] as const,
    orderDetail: (accountId: string, orderId: string) =>
      ['tradingAccount', 'orders', accountId, 'detail', orderId] as const,

    quote: (accountId: string, quoteId: string) =>
      ['tradingAccount', 'quotes', accountId, quoteId] as const,

    adRewardsAll: (accountId: string) =>
      ['tradingAccount', 'adRewards', accountId] as const,
    adRewardEligibility: (accountId: string) =>
      ['tradingAccount', 'adRewards', accountId, 'eligibility'] as const,
    adRewardClaims: (accountId: string, filters?: Record<string, unknown>) =>
      [
        'tradingAccount',
        'adRewards',
        accountId,
        'claims',
        normalizeFilterKey(filters),
      ] as const,
  },
} as const;

/**
 * Stable, order-independent serialisation of a filter object.
 *
 * `undefined`, `null`, and `''` all mean "not filtered", so they must produce
 * ONE token rather than three sibling cache entries for the same query. Keys
 * are sorted because object literal order is a property of the call site, not
 * of the query it describes.
 */
export function normalizeFilterKey(
  filters?: Record<string, unknown> | null,
): string {
  if (!filters) return '';

  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}
