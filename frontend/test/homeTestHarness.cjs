// Actual screens/API + installed QueryObserver. Native hosts and HTTP are the
// only platform boundaries; this checks first-render cache behavior on switches.
const { resolve } = require('node:path');
const React = require('react');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const { load, elements } = require('./ledgerTestHarness.cjs');
const { getTradingAccountCapabilities } = require('../src/features/tradingAccount/capabilities.ts');
function createHomeHarness(mode = 'general') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const h = {
    client,
    mode,
    queries: [],
    requests: [],
    navigation: [],
    now: Date.parse('2026-09-09T00:00:00Z'),
    account: {
      id: mode + '-1',
      mode,
      status: 'active',
      season:
        mode === 'season'
          ? {
              seasonId: 'season-1',
              seasonName: '9월 시즌',
              seasonStatus: 'active',
              participantStatus: 'active',
              startAt: '2026-09-01T00:00:00Z',
              endAt: '2026-10-01T00:00:00Z',
            }
          : null,
    },
  };
  h.getCapabilities = () => getTradingAccountCapabilities(h.account, h.now);
  const api = load(
    resolve(__dirname, '../src/features/tradingAccount/api.ts'),
    {
      '../../services/api/client': {
        apiClient: {
          get: async (path, config) => {
            h.requests.push({ path, ...config });
            return { data: typeof h.response === 'function' ? h.response(path, config) : h.response };
          },
        },
      },
    },
  );
  const native = Object.fromEntries(
    ['View', 'Text', 'Pressable', 'ScrollView', 'SafeAreaView', 'RefreshControl'].map((name) => [
      name,
      name,
    ]),
  );
  native.StyleSheet = { create: (styles) => styles };
  native.Platform = { OS: 'android' };
  native.useWindowDimensions = () => ({ width: 390, height: 844, fontScale: 1 });
  const root = { navigate: (...args) => h.navigation.push(args) };
  let stateIndex = 0;
  let stateAccount = h.account.id;
  let states = [];
  const mocks = {
    react: { ...React, useRef: (value) => ({ current: value }), useEffect() {}, useMemo: (fn) => fn(), useState: (initial) => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], (value) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    } },
    'react-native': native,
    '@tanstack/react-query': {
      useQuery: (options) => {
        const i = h.queries.length;
        h.queries.push(options);
        if (!observers[i]) observers[i] = new QueryObserver(client, options);
        return observers[i].getOptimisticResult(
          client.defaultQueryOptions({
            ...options,
            _optimisticResults: 'optimistic',
          }),
        );
      },
    },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({
        selectedAccountId: h.account.id,
        selectedAccount: h.account,
        capabilities: h.capabilities === undefined
          ? h.getCapabilities()
          : h.capabilities,
      }),
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => root },
    '../../features/ranking/api': {
      getRankings: () => {},
      getRankingTier: load(resolve(__dirname, '../src/features/ranking/api.ts'), {
        '../../services/api/client': { apiClient: {} },
      }).getRankingTier,
    },
    '../../features/me/api': { getMe: () => {} },
    '../../features/market/api': { getAssets: () => {} },
    '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
    '../../components/charts': {
      DonutChart: 'DonutChart',
      LineChart: 'LineChart',
    },
    ...Object.fromEntries(
      [
        'FullPageLoading',
        'ErrorState',
        'InlineEmptyState',
        'EmptyState',
        'SectionSkeleton',
      ].map((name) => [
        '../../components/states/' + name,
        { default: name, __esModule: true },
      ]),
    ),
    ...Object.fromEntries(
      ['AccountSwitcher', 'AccountSetupPanel'].map((name) => [
        '../../components/tradingAccount/' + name,
        { default: name, __esModule: true },
      ]),
    ),
    '../../components/common/CTAButton': {
      default: 'CTAButton',
      __esModule: true,
    },
    './GeneralAccountHome': { default: 'GeneralAccountHome', __esModule: true },
    './SeasonAccountHome': { default: 'SeasonAccountHome', __esModule: true },
  };
  let observers = [];
  const hero = load(resolve(__dirname, '../src/screens/home/HomeAssetHero.tsx'), mocks).default;
  const positionRow = load(resolve(__dirname, '../src/components/tradingAccount/PositionAssetRow.tsx'), mocks).default;
  mocks['../../components/tradingAccount/PositionAssetRow'] = { default: positionRow, __esModule: true };
  mocks['../home/HomeAssetHero'] = { default: hero, __esModule: true };
  const wallet = load(resolve(__dirname, '../src/screens/wallet/WalletScreen.tsx'), mocks).default;
  const expandDisplay = (node) => {
    if (Array.isArray(node)) return node.map(expandDisplay);
    if (!React.isValidElement(node)) return node;
    if (node.type === hero || node.type === positionRow || node.type === charts || homeComponents.includes(node.type)) return expandDisplay(node.type(node.props));
    return React.cloneElement(node, {}, expandDisplay(node.props.children));
  };
  h.renderWallet = () => {
    h.queries = [];
    const outer = wallet({ navigation: root });
    const branch = elements(outer).find((node) => typeof node.type === 'function');
    return { tree: expandDisplay(branch.type(branch.props)), branch };
  };
  const homeComponents = ['HomeAccountContext', 'HomeHoldings', 'HomeHotMarket'].map(name => {
    const module = load(resolve(__dirname, `../src/screens/home/${name}.tsx`), mocks);
    mocks[`./${name}`] = { ...module, __esModule: true };
    return module.default;
  });
  mocks['./HomeAssetHero'] = { default: hero, __esModule: true };
  const charts = load(
    resolve(__dirname, '../src/screens/home/HomeAssetTrend.tsx'),
    mocks,
  ).default;
  mocks['./HomeAssetTrend'] = { default: charts, __esModule: true };
  const home = load(
    resolve(__dirname, '../src/screens/home/HomeScreen.tsx'),
    mocks,
  ).default;
  const general = load(
    resolve(__dirname, '../src/screens/home/GeneralAccountHome.tsx'),
    mocks,
  ).default;
  const season = load(
    resolve(__dirname, '../src/screens/home/SeasonAccountHome.tsx'),
    mocks,
  ).default;
  const cta = load(
    resolve(__dirname, '../src/components/common/CTAButton.tsx'),
    mocks,
  ).default;
  h.renderCta = (node) => cta(node.props);
  h.renderFx = () => {
    h.fxQueries = [];
    const screen = load(resolve(__dirname, '../src/screens/wallet/WalletFxScreen.tsx'), {
      ...mocks,
      react: {
        ...React,
        useMemo: (fn) => fn(),
        useEffect: () => {},
        useRef: (value) => ({ current: value }),
        useState: (value) => [value, () => {}],
      },
      '@tanstack/react-query': {
        useQueryClient: () => client,
        useMutation: () => ({}),
        useQuery: (options) => {
          h.fxQueries.push(options);
          return { isLoading: true };
        },
      },
      '../../features/wallet/api': { getCurrentFxRate: () => {} },
      '../../features/asset/useStaleRecheck': { useStaleRecheck: () => {} },
      '../../features/wallet/useFxRateUpdates': { useFxRateUpdates: () => {} },
      '../../components/states/BlockedState': { default: 'BlockedState', __esModule: true },
      '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
      '../../components/tradingAccount/PreviewAmounts': { default: 'PreviewAmounts', __esModule: true },
      './FxSuccessBottomSheet': { default: 'FxSuccessBottomSheet', __esModule: true },
    }).default;
    return screen({ navigation: root });
  };
  h.home = () => home({ navigation: root });
  h.render = () => {
    if (stateAccount !== h.account.id) { states = []; stateAccount = h.account.id; }
    stateIndex = 0;
    h.queries = [];
    const branch = elements(h.home()).find(
      (node) =>
        node.type ===
        (h.account.mode === 'general'
          ? 'GeneralAccountHome'
          : 'SeasonAccountHome'),
    );
    const screenTree = (h.account.mode === 'general' ? general : season)(
      branch.props,
    );
    const tree = expandDisplay(screenTree);
    const chart = elements(screenTree).find((node) => node.type === charts);
    return { tree, chart: chart ? charts(chart.props) : null, branch };
  };
  h.openTrend = () => {
    const rendered = h.render();
    elements(rendered.chart, 'Pressable').find((node) => node.props.testID === 'home-trend-toggle').props.onPress();
    return h.render();
  };
  h.selectRange = (range) => {
    elements(h.render().chart, 'Pressable').find((node) => node.props.testID === `home-trend-range-${range}`).props.onPress();
    return h.render();
  };
  h.seed = (account, equity) => {
    const base = ['tradingAccount', 'portfolio', account.id];
    const summary = {
      totalAssetKrw: '10001000',
      krwCash: '1000',
      usdCashKrw: '9000',
      assetValueKrw: '9991000',
      returnRate: '0',
      returnRateMethod:
        account.mode === 'general' ? 'time_weighted' : 'initial_capital',
      initialFundingKrw: '10000000',
      cumulativeExternalFundingKrw: '10001000',
      cumulativeAdRewardKrw: '1000',
      investmentPnlKrw: '0',
      realizedPnlKrw: '1234',
      unrealizedPnlKrw: '-2345',
    };
    client.setQueryData([...base, 'overview'], {
      tradingAccountId: account.id,
      state: 'available',
      summary,
      allocation: {
        state: 'available',
        cashKrwValue: '10000',
        domesticStockValueKrw: '1000',
        usStockValueKrw: '9900000',
        cryptoValueKrw: '90000',
      },
      sectionErrors: [],
    });
    client.setQueryData([...base, 'equity', '30d', 'daily'], equity);
    const keys = require('../src/constants/queryKeys.ts').QUERY_KEYS;
    client.setQueryData(keys.tradingAccount.wallets(account.id), {
      tradingAccountId: account.id, wallets: [],
    });
    client.setQueryData(
      keys.tradingAccount.positions(account.id, { limit: 1 }),
      { positions: [], pagination: { total: 0 } },
    );

    client.setQueryData(keys.me, { id: 'user-1', nickname: '김재민' });
    client.setQueryData(keys.tradingAccount.holdings(account.id), { tradingAccountId: account.id, positions: [] }, { updatedAt: 1 });
    if (account.season) client.setQueryData(keys.ranking.list({
      scope: 'all', seasonId: account.season.seasonId,
      rankType: account.season.seasonStatus === 'settled' ? 'final' : 'daily',
      limit: 1, offset: 0,
    }), { myRanking: { state: 'available', rank: 2, provisionalTier: 'Silver', finalTier: 'Gold' } });
  };
  h.failEquity = (error) =>
    client
      .getQueryCache()
      .find({
        queryKey: [
          'tradingAccount',
          'portfolio',
          h.account.id,
          'equity',
          '30d',
          'daily',
        ],
      })
      .setState({ status: 'error', error });
  h.close = () => {
    observers.forEach((observer) => observer.destroy());
    client.clear();
  };
  h.renderOrders = (scope, accounts) => {
    const recordApi = load(resolve(__dirname, '../src/features/record/api.ts'), {
      '../../services/api/client': { apiClient: {} },
    });
    const screen = load(resolve(__dirname, '../src/screens/history/TradeHistoryScreen.tsx'), {
      ...mocks,
      react: { ...React, useMemo: (fn) => fn(), useEffect: () => {}, useRef: (value) => ({ current: value }), useState: (value) => [value, () => {}] },
      'react-native': { ...native, AppState: { currentState: 'active' } },
      '@react-navigation/native': { useIsFocused: () => true },
      '@tanstack/react-query': {
        useQueryClient: () => client, useMutation: () => ({}),
        useInfiniteQuery: (options) => { h.orderQuery = options; return { isLoading: true }; },
      },
      '../../features/record/api': recordApi,
      '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts, isLoading: false, isError: false }) },
    }).default;
    return screen({ route: { params: scope } });
  };
  return h;
}
module.exports = { createHomeHarness, elements };
