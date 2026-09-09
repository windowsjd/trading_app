// Actual screens/API + installed QueryObserver. Native hosts and HTTP are the
// only platform boundaries; this checks first-render cache behavior on switches.
const { resolve } = require('node:path');
const React = require('react');
const { QueryClient, QueryObserver } = require('@tanstack/react-query');
const { load, elements } = require('./ledgerTestHarness.cjs');
function createHomeHarness(mode = 'general') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const h = {
    mode,
    queries: [],
    requests: [],
    navigation: [],
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
            }
          : null,
    },
  };
  const api = load(
    resolve(__dirname, '../src/features/tradingAccount/api.ts'),
    {
      '../../services/api/client': {
        apiClient: {
          get: async (path, config) => {
            h.requests.push({ path, ...config });
            return { data: h.response };
          },
        },
      },
    },
  );
  const native = Object.fromEntries(
    ['View', 'Text', 'Pressable', 'ScrollView', 'SafeAreaView'].map((name) => [
      name,
      name,
    ]),
  );
  native.StyleSheet = { create: (styles) => styles };
  const root = { navigate: (...args) => h.navigation.push(args) };
  const mocks = {
    react: { ...React, useMemo: (fn) => fn() },
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
        selectedAccount: h.account,
        capabilities: { canTrade: true, canExchange: true },
      }),
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => root },
    '../../features/ranking/api': {
      getRankings: () => {},
      getRankingTier: () => '골드',
    },
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
  const charts = load(
    resolve(__dirname, '../src/screens/home/HomePortfolioCharts.tsx'),
    mocks,
  ).default;
  mocks['./HomePortfolioCharts'] = { default: charts, __esModule: true };
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
  h.home = () => home({ navigation: root });
  h.render = () => {
    h.queries = [];
    const branch = elements(h.home()).find(
      (node) =>
        node.type ===
        (h.account.mode === 'general'
          ? 'GeneralAccountHome'
          : 'SeasonAccountHome'),
    );
    const tree = (h.account.mode === 'general' ? general : season)(
      branch.props,
    );
    const chart = elements(tree).find((node) => node.type === charts);
    return { tree, chart: chart ? charts(chart.props) : null, branch };
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
      wallets: [],
    });
    client.setQueryData(
      keys.tradingAccount.positions(account.id, { limit: 5 }),
      { positions: [] },
    );
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
    const screen = load(resolve(__dirname, '../src/screens/record/RecordOrderListScreen.tsx'), {
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
