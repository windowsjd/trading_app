export const ROUTES = {
  SPLASH: 'Splash',

  LOGIN: 'Login',
  SIGNUP: 'Signup',

  SEASON_JOIN: 'SeasonJoin',

  HOME: 'Home',
  PORTFOLIO: 'Portfolio',
  WALLET_FX: 'WalletFx',

  MARKET: 'Market',
  MARKET_SEARCH: 'MarketSearch',
  ASSET_DETAIL: 'AssetDetail',

  ORDER: 'Order',

  RANKING: 'Ranking',
  USER_SEASON_SUMMARY: 'UserSeasonSummary',

  RECORD_SEASON_LIST: 'RecordSeasonList',
  RECORD_SEASON_DETAIL: 'RecordSeasonDetail',
  RECORD_ORDER_LIST: 'RecordOrderList',
  RECORD_EXCHANGE_LIST: 'RecordExchangeList',

  REWARD: 'Reward',

  MY: 'My',
  SETTINGS: 'Settings',
} as const;

export type RouteName = (typeof ROUTES)[keyof typeof ROUTES];