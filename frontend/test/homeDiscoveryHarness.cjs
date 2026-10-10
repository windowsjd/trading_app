const { interactionHarness, React, act } = require('./interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
const account = (mode, id = mode) => ({ id, mode, status: 'active', season: mode === 'season' ? {
  seasonId: `season-${id}`, seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active',
} : null });
const position = (i, id = 'season', unavailable = false) => ({
  positionId: `${id}-p${i}`, assetId: `${id}-a${i}`, name: `종목 ${i}`, symbol: `S${i}`,
  assetType: i === 0 ? 'us_stock' : 'domestic_stock', currencyCode: i === 0 ? 'USD' : 'KRW', market: 'TEST',
  quantity: '1', averageCost: '900', valuation: unavailable ? { state: 'unavailable' } : {
    state: 'available', priceCurrency: i === 0 ? 'USD' : 'KRW', positionValue: i === 0 ? '100' : '90000',
    positionValueKrw: String(150000 - i), returnRate: i % 2 ? '-1' : '2',
  },
});
const asset = (i, type) => ({
  id: `${type}-${i}`, name: `시장 종목 ${i}`, symbol: `S${i}`, market: 'TEST', assetType: type,
  priceCurrency: 'KRW', settlementCurrency: 'KRW', turnover: String(100000 - i), turnoverPeriod: type === 'crypto' ? 'rolling_24h' : 'session',
  isActive: true, marketStatus: 'open', tradable: true,
  price: { state: 'available', priceCurrency: 'KRW', currentPrice: '100', changeRate: ['1', '-1', '0', null][i % 4] },
});
function setup(mode = 'season', count = 7, screen = 'home', options = {}) {
  const h = interactionHarness();
  h.native.SafeAreaView = 'SafeAreaView';
  h.native.FlatList = ({ data = [], ListHeaderComponent, ListEmptyComponent, ListFooterComponent, renderItem, ...props }) => React.createElement('FlatList', props,
    ListHeaderComponent, data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.positionId ?? index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent);
  h.account = account(mode); h.requests = []; h.navigation = []; h.positions = {};
  h.positions[mode] = Array.from({ length: count }, (_, i) => position(i, mode));
  h.markets = Object.fromEntries(['domestic_stock', 'us_stock', 'crypto'].map(type => [type, Array.from({ length: 5 }, (_, i) => asset(i, type))]));
  h.beforeRead = options.beforeRead ?? (async () => {});
  const focusListeners = new Set();
  h.focus = () => { act(() => focusListeners.forEach(listener => listener())); };
  const NavigationContext = React.createContext({ addListener: (event, listener) => {
    if (event === 'focus') focusListeners.add(listener);
    return () => focusListeners.delete(listener);
  } });
  const read = async (section, params = {}) => { const request = { section, ...params }; h.requests.push(request); await h.beforeRead(request); };
  const mocks = {
    '../../features/quest/QuestGuideProvider': { useQuestGuide: () => null },
    '../../features/quest/QuestTargetHighlight': { default: () => null, __esModule: true },
    '@react-navigation/native': { NavigationContext, useIsFocused: () => true },
    '../../features/futures/api': { getFuturesPositions: async id => {
      await read('futures', { account: id });
      return h.futures?.[id] ?? require('./futuresFixtures.cjs').futuresFixture(id).positions;
    } },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ selectedAccount: h.account, selectedAccountId: h.account.id, capabilities: { canTrade: true, canExchange: true } }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate: (...args) => h.navigation.push(args) }) },
    '../../features/tradingAccount/api': {
      getTradingAccountPortfolio: async id => { await read('portfolio', { account: id }); return options.portfolios?.[id] ?? { state: 'available', sectionErrors: [], summary: { totalAssetKrw: id } }; },
      getTradingAccountPositions: async (id, params) => {
        await read('positions', { account: id, ...params });
        const all = h.positions[id] ?? [], rows = all.slice(params.offset, params.offset + params.limit);
        return { tradingAccountId: id, positions: rows, pagination: { total: all.length, offset: params.offset, limit: params.limit, returned: rows.length, nextOffset: params.offset + rows.length < all.length ? params.offset + rows.length : null } };
      },
      getTradingAccountEquity: async (id, range, granularity) => { await read('equity', { account: id, range, granularity }); return { points: [] }; },
      getTradingAccountWallets: async id => { await read('wallets', { account: id }); return { tradingAccountId: id, wallets: [] }; },
    },
    '../../features/me/api': { getMe: async () => { await read('me'); return { nickname: 'mycroft' }; } },
    '../../features/ranking/api': {
      getRankings: async params => { await read('ranking', params); return { state: 'available', myRanking: { state: 'available', rank: 99999, provisionalTier: 'master', finalTier: 'diamond' } }; },
      getRankingTier: (row, type) => row ? (type === 'final' ? row.finalTier : row.provisionalTier) : '-',
    },
    '../../features/market/api': { getAssets: async params => { await read('hot', params); return { sortSnapshot: `snapshot-${params.assetType}`, assets: h.markets[params.assetType], pagination: { nextOffset: null } }; } },
    './HomeAssetHero': { __esModule: true, default: 'Hero' },
    './HomeAssetTrend': { __esModule: true, default: 'Trend' },
    '../home/HomeAssetHero': { __esModule: true, default: 'Hero' },
    '../home/HomeAssetTrend': { __esModule: true, default: 'Trend' },
    '../../components/common/CTAButton': { __esModule: true, default: 'CTA' },
    '../../components/charts': { DonutChart: 'DonutChart', LineChart: 'LineChart' },
    '../../components/tradingAccount/AccountSwitcher': { __esModule: true, default: ({ children }) => React.createElement('AccountSwitcher', {}, children) },
    '../../components/tradingAccount/AccountSetupPanel': { __esModule: true, default: 'AccountSetupPanel' },
    '../../components/states/FullPageLoading': { __esModule: true, default: 'FullPageLoading' },
    ...Object.fromEntries(['ErrorState', 'InlineEmptyState', 'SectionSkeleton', 'AdminDiagnosticPanel'].map(name => ['../../components/states/' + name, { __esModule: true, default: name }])),
  };
  mocks['./AdminDiagnosticPanel'] = mocks['../../components/states/AdminDiagnosticPanel'];
  for (const name of ['ErrorState', 'InlineEmptyState', 'SectionSkeleton']) mocks['../states/' + name] = mocks['../../components/states/' + name];
  const Screen = h.load(screen === 'wallet' ? 'src/screens/wallet/WalletScreen.tsx' : screen === 'portfolio' ? 'src/screens/home/PortfolioScreen.tsx' : 'src/screens/home/HomeScreen.tsx', mocks).default;
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity, ...options.queryDefaults } } });
  const tree = () => React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Screen, { navigation: { navigate() {} } }));
  h.renderer = h.render(tree());
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.rows = () => h.renderer.root.findAll(node => node.type === 'Pressable' && /^home-position-item-/.test(node.props.testID ?? ''));
  h.hotRows = () => h.renderer.root.findAll(node => node.type === 'Pressable' && /^home-hot-item-/.test(node.props.testID ?? ''));
  h.press = async id => { act(() => h.node(id).props.onPress()); await flush(); };
  h.refresh = async () => { act(() => h.renderer.root.findByType('ScrollView').props.refreshControl.props.onRefresh()); await flush(); };
  h.switch = async next => { h.account = next; act(() => h.renderer.update(tree())); await flush(); };
  h.close = () => { act(() => h.renderer.unmount()); h.client.clear(); };
  return h;
}
module.exports = { setup, account, position, asset, flush, act };
