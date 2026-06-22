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
      sort?: string;
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
        params.sort ?? '',
      ] as const,
  },

  asset: {
    detail: (assetId: string) => ['asset', 'detail', assetId] as const,
    candles: (assetId: string, range: string, interval?: string) =>
      ['asset', 'candles', assetId, range, interval ?? null] as const,
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
    positions: (assetType?: string) =>
      ['portfolio', 'positions', assetType ?? 'all'] as const,
    equity: (range: string) => ['portfolio', 'equity', range] as const,
  },

  order: {
    myList: (params?: Record<string, unknown>) =>
      ['order', 'my-list', params ?? {}] as const,
  },

  ranking: {
    all: ['ranking'] as const,
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
