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

  
} as const;
