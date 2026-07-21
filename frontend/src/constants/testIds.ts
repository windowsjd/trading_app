export const TEST_IDS = {
  auth: {
    loginScreen: 'auth-login-screen',
    loginEmailInput: 'auth-login-email-input',
    loginPasswordInput: 'auth-login-password-input',
    loginSubmit: 'auth-login-submit',
  
    signupScreen: 'auth-signup-screen',
    signupEmailInput: 'auth-signup-email-input',
    signupNicknameInput: 'auth-signup-nickname-input',
    signupPasswordInput: 'auth-signup-password-input',
    signupConfirmPasswordInput: 'auth-signup-confirm-password-input',
    signupSubmit: 'auth-signup-submit',
  },

  season: {
    joinScreen: 'season-join-screen',
    joinSubmit: 'season-join-submit',
  },

  home: {
    screen: 'home-screen',
    summaryCard: 'home-summary-card',
    goSeasonJoin: 'home-go-season-join',
    goWalletFx: 'home-go-wallet-fx',
    goPortfolio: 'home-go-portfolio',
    positionItem: (assetId: string) => `home-position-item-${assetId}`,
  },

  walletFx: {
    screen: 'wallet-fx-screen',
    amountInput: 'wallet-fx-amount-input',
    quoteSubmit: 'wallet-fx-quote-submit',
    executeSubmit: 'wallet-fx-execute-submit',
    directionKrwUsd: 'wallet-fx-direction-krw-usd',
    directionUsdKrw: 'wallet-fx-direction-usd-krw',
  },

  walletTransactions: {
    screen: 'wallet-transactions-screen',
    item: (key: string) => `wallet-transaction-item-${key}`,
  },

  market: {
    screen: 'market-screen',
    tabDomestic: 'market-tab-domestic',
    tabUs: 'market-tab-us',
    tabCrypto: 'market-tab-crypto',
    searchInput: 'market-search-input',
    item: (assetId: string) => `market-item-${assetId}`,
  },

  assetDetail: {
    screen: 'asset-detail-screen',
    buyButton: 'asset-detail-buy-button',
    sellButton: 'asset-detail-sell-button',
    reconnectBanner: 'asset-detail-reconnect-banner',
    chartRetry: 'asset-detail-chart-retry',
  },

  order: {
    screen: 'order-screen',
    quantityInput: 'order-quantity-input',
    quoteSubmit: 'order-quote-submit',
    executeSubmit: 'order-execute-submit',
    typeToggleMarket: 'order-type-toggle-market',
    typeToggleLimit: 'order-type-toggle-limit',
    limitPriceInput: 'order-limit-price-input',
  },

  portfolio: {
    screen: 'portfolio-screen',
    loading: 'portfolio-loading',
    retry: 'portfolio-retry',
    goMarket: 'portfolio-go-market',
    equityRetry: 'portfolio-equity-retry',
    assetTab: (assetClass: string) => `portfolio-asset-tab-${assetClass}`,
    equityRange: (range: string) => `portfolio-equity-range-${range}`,
    positionItem: (assetId: string) => `portfolio-position-item-${assetId}`,
  },

  ranking: {
    screen: 'ranking-screen',
    retry: 'ranking-retry',
    tabAll: 'ranking-tab-all',
    tabNearMe: 'ranking-tab-near-me',
    tabTop10: 'ranking-tab-top10',
    joinCta: 'ranking-join-cta',
    item: (userId: string) => `ranking-item-${userId}`,
  },
  userSummary: {
    screen: 'user-summary-screen',
    retry: 'user-summary-retry',
    notFound: 'user-summary-not-found',
  },

  record: {
    seasonListScreen: 'record-season-list-screen',
    seasonListRetry: 'record-season-list-retry',
    seasonListJoinCta: 'record-season-list-join-cta',
    seasonItem: (seasonId: string) => `record-season-item-${seasonId}`,

    seasonDetailScreen: 'record-season-detail-screen',
    seasonDetailRetry: 'record-season-detail-retry',
    profitAnalysisScreen: 'record-profit-analysis-screen',
    seasonDetailProfitAnalysisCta: 'record-season-detail-profit-analysis-cta',
    seasonDetailOrdersCta: 'record-season-detail-orders-cta',
    seasonDetailExchangesCta: 'record-season-detail-exchanges-cta',

    orderListScreen: 'record-order-list-screen',
    orderListRetry: 'record-order-list-retry',
    orderFilterAll: 'record-order-filter-all',
    orderFilterBuy: 'record-order-filter-buy',
    orderFilterSell: 'record-order-filter-sell',
    orderItem: (key: string) => `record-order-item-${key}`,
    orderCancel: (key: string) => `record-order-cancel-${key}`,

    exchangeListScreen: 'record-exchange-list-screen',
    exchangeListRetry: 'record-exchange-list-retry',
    exchangeItem: (key: string) => `record-exchange-item-${key}`,
  },

  my: {
    screen: 'my-screen',
    rewardMenu: 'my-reward-menu',
    settingsMenu: 'my-settings-menu',
    logoutMenu: 'my-logout-menu',
  },

  reward: {
    screen: 'reward-screen',
    retry: 'reward-retry',
    badgeItem: (code: string) => `reward-badge-${code}`,
    rewardItem: (seasonId: string, rewardCode: string) =>
        `reward-item-${seasonId}-${rewardCode}`,
  },

  settings: {
    screen: 'settings-screen',
    nicknameInput: 'settings-nickname-input',
    saveNickname: 'settings-save-nickname',
    logout: 'settings-logout',
  },
  
} as const;
