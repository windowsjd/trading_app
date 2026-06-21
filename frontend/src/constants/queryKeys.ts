export const QUERY_KEYS = {
  me: ['me'] as const,

  season: {
    current: ['season', 'current'] as const,
  },

  home: {
    dashboard: ['home', 'dashboard'] as const,
  },

  wallet: {
    all: ['wallet'] as const,
    balances: ['wallet', 'balances'] as const,
    fxRate: (pair: string) => ['wallet', 'fx-rate', pair] as const,
    fxHistory: (cursor?: string | null) =>
      ['wallet', 'fx-history', cursor ?? null] as const,
  },

  market: {
    assets: (params: {
      assetClass: string;
      query?: string;
      cursor?: string | null;
      sort?: string;
    }) =>
      [
        'market',
        'assets',
        params.assetClass,
        params.query ?? '',
        params.sort ?? '',
        params.cursor ?? null,
      ] as const,
  },

  asset: {
    detail: (assetId: string) => ['asset', 'detail', assetId] as const,
    candles: (assetId: string, interval: string) =>
      ['asset', 'candles', assetId, interval] as const,
    price: (assetId: string) => ['asset', 'price', assetId] as const,
  },

  order: {
    myList: (params?: Record<string, unknown>) =>
      ['order', 'my-list', params ?? {}] as const,
  },

  ranking: {
    current: (scope: 'all' | 'top10', cursor?: string | null) =>
      ['ranking', 'current', scope, cursor ?? null] as const,
    nearMe: (size: number) => ['ranking', 'near-me', size] as const,
    userSeasonSummary: (userId: string) =>
      ['ranking', 'user-season-summary', userId] as const,
  },

  record: {
    seasons: (cursor?: string | null) =>
      ['record', 'seasons', cursor ?? null] as const,
    seasonDetail: (seasonId: string) =>
      ['record', 'season-detail', seasonId] as const,
    seasonOrders: (seasonId: string, cursor?: string | null) =>
      ['record', 'season-orders', seasonId, cursor ?? null] as const,
    seasonExchanges: (seasonId: string, cursor?: string | null) =>
      ['record', 'season-exchanges', seasonId, cursor ?? null] as const,
  },

  reward: {
    rewards: ['reward', 'rewards'] as const,
    badges: ['reward', 'badges'] as const,
  },

  
} as const;