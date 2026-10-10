// Production screens, account provider, API wrappers, React Query and diagnostic
// components. Only HTTP, storage, native hosts and unrelated market/chart UI are
// fixtures; financial requests and their errors follow the real query lifecycle.
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('./interactionTestHarness.cjs');
const { position } = require('./homeDiscoveryHarness.cjs');
const { QUERY_KEYS } = require('../src/constants/queryKeys.ts');

const privateText = 'Bearer fake-only-token postgresql://fixture:fake-password@db.invalid/private-db https://provider.invalid/private RAW_EXCEPTION exact balance 184527.938475';
function failure(requestId, code = 'INTERNAL_SERVER_ERROR') {
  const diagnostic = { version: 1, code, httpStatus: 500,
    timestamp: '2026-10-08T00:00:00Z', requestId, domain: 'PORTFOLIO', operation: 'FINANCIAL_READ', failureStage: 'response_validation',
    evidence: { selectionResult: 'REJECTED', safeCause: { category: 'db_transaction_conflict' } },
    exception: { type: 'Error', message: 'Unexpected internal failure.', applicationStack: [], stack: [], truncated: false },
    diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, truncated: false };
  return { isAxiosError: true, message: privateText, stack: privateText,
    response: { status: 500, data: { success: false, error: { code, message: privateText, diagnostic } } } };
}
const portfolio = id => ({ tradingAccountId: id, state: 'available', sectionErrors: [],
  summary: { totalAssetKrw: '10000000', krwCash: '1000000', usdCashKrw: '0', assetValueKrw: '9000000',
    realizedPnlKrw: '0', unrealizedPnlKrw: '0', returnRate: '0', returnRateMethod: 'time_weighted' },
  allocation: { state: 'available', cashKrwValue: '1000000', domesticStockValueKrw: '9000000', usStockValueKrw: '0', cryptoValueKrw: '0' } });

function financialDiagnosticsHarness(screen = 'home', { role = 'admin', mode = 'general', failures = {} } = {}) {
  const h = interactionHarness();
  Object.assign(h, { role, failures, requests: [], alerts: [], accountId: 'A', route: { accountId: 'A' }, gates: {} });
  const season = id => ({ seasonId: `season-${id}`, seasonName: '테스트 시즌', seasonStatus: 'active', participantStatus: 'active',
    startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() });
  h.accounts = [{ id: 'A', mode, status: 'active', season: mode === 'season' ? season('A') : null },
    { id: 'B', mode: 'season', status: 'active', season: season('B') }];
  h.portfolios = { A: portfolio('A'), B: portfolio('B') };
  h.positions = { A: [position(0, 'A'), position(1, 'A')], B: [position(0, 'B'), position(1, 'B')] };
  h.valuationErrors = { A: [], B: [] };
  h.orders = { A: [{ id: 'limit-A', assetId: 'A-a0', asset: { name: '테스트 종목', symbol: 'TEST' }, side: 'buy', orderType: 'limit',
    status: 'submitted', quantity: '2', limitPrice: '100', reservedAmount: '200', currencyCode: 'KRW', submittedAt: '2026-10-08T00:00:00Z' }], B: [] };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity }, mutations: { retry: false } } });
  h.client.setQueryData(QUERY_KEYS.me, { id: 'user-1', role, nickname: '테스트 사용자' });
  const read = async (name, request) => {
    h.requests.push({ name, ...request });
    if (h.gates[name]) await h.gates[name].promise;
    if (h.failures[name]) throw h.failures[name];
  };
  const api = h.load('src/features/tradingAccount/api.ts', {
    '../../services/api/client': { apiClient: {
      get: async (path, config) => {
        const params = config?.params ?? {};
        if (path === '/trading-accounts') {
          await read('accounts', { path });
          return { data: { success: true, data: { accounts: h.accounts } } };
        }
        const id = path.split('/')[2];
        const suffix = path.split('/').slice(3).join('/');
        const name = suffix === 'positions' ? `${id}:positions:${params.limit === 1 ? 'preview' : params.limit === 100 ? 'full' : 'filtered'}` : `${id}:${suffix}`;
        await read(name, { path, params });
        let data;
        if (suffix === 'portfolio') data = h.portfolios[id];
        else if (suffix === 'portfolio/equity') {
          const mode = h.accounts.find(account => account.id === id).mode;
          data = { tradingAccountId: id, mode, state: 'empty', range: params.range, granularity: params.granularity ?? 'intraday',
            returnRateMethod: mode === 'general' ? 'time_weighted' : 'initial_capital', points: [] };
        }
        else if (suffix === 'wallets') data = { tradingAccountId: id, wallets: [] };
        else if (suffix === 'positions') {
          const offset = params.offset ?? 0, all = h.positions[id], rows = all.slice(offset, offset + params.limit);
          data = { tradingAccountId: id, state: 'available', positions: rows, valuationErrors: h.valuationErrors[id],
            pagination: { limit: params.limit, offset, total: all.length, returned: rows.length, nextOffset: offset + rows.length < all.length ? offset + rows.length : null } };
        } else if (suffix === 'wallet-transactions') data = { tradingAccountId: id, transactions: [], pagination: { nextOffset: null } };
        else if (suffix === 'orders') data = { tradingAccountId: id, state: 'available', orders: h.orders[id].map(order => ({ ...order, asset: { ...order.asset } })), pagination: { nextOffset: null } };
        else throw new Error(`Unexpected fixture path: ${path}`);
        return { data: { success: true, data } };
      },
      post: async path => {
        const id = path.split('/')[2];
        await read(`${id}:cancel`, { path, method: 'POST' });
        h.orders[id][0].status = 'canceled';
        return { data: { success: true, data: { tradingAccountId: id } } };
      },
    } },
  });
  const meApi = { getMe: async () => { await read('me', { path: '/me' }); return { id: 'user-1', role: h.role, nickname: '테스트 사용자' }; } };
  const context = h.load('src/features/tradingAccount/TradingAccountContext.tsx', {
    './api': api, '../me/api': meApi,
    './selectionStorage': { readSelectedAccountId: async () => 'A', writeSelectedAccountId: async () => {}, clearSelectedAccountId: async () => {} },
  });
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView',
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Alert: { alert: (...args) => h.alerts.push(args) },
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }) =>
      React.createElement('FlatList', props, ListHeaderComponent,
        data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.positionId ?? item.id ?? index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent),
  });
  const mocks = {
    '../../features/quest/QuestGuideProvider': { useQuestGuide: () => null },
    '../../features/quest/QuestTargetHighlight': { default: () => null, __esModule: true },
    '../../features/futures/api': { getFuturesPositions: async id => {
      await read(`${id}:futures/positions`, { path: `/trading-accounts/${id}/futures/positions` });
      return require('./futuresFixtures.cjs').futuresFixture(id).positions;
    } },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': context,
    '../../features/me/api': meApi,
    '../../features/record/api': h.load('src/features/record/api.ts', { '../../services/api/client': { apiClient: {} } }),
    '../../features/ranking/api': { getRankings: async () => {
      await read('ranking', { path: '/rankings' }); return { state: 'available', myRanking: { state: 'available', rank: 1, provisionalTier: 'silver' } };
    }, getRankingTier: row => row?.provisionalTier ?? null },
    '@react-navigation/native': { NavigationContext: React.createContext(undefined), useIsFocused: () => true },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '../../components/charts': { LineChart: 'LineChart', DonutChart: 'DonutChart' },
    '../../components/tradingAccount/AccountSwitcher': { default: ({ children }) => React.createElement('AccountSwitcher', {}, children), __esModule: true },
    '../../components/tradingAccount/AccountSetupPanel': { default: 'AccountSetupPanel', __esModule: true },
    './HomeHotMarket': { useHomeHotMarket: () => ({ refreshQuery: { refetch() {} } }), default: () => null, __esModule: true },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
  };
  const files = { home: 'home/HomeScreen', wallet: 'wallet/WalletScreen', portfolio: 'home/PortfolioScreen', ledger: 'home/WalletTransactionsScreen', history: 'history/TradeHistoryScreen' };
  const Screen = h.load(`src/screens/${files[screen]}.tsx`, mocks).default;
  const Probe = () => { h.accountContext = context.useTradingAccount(); return null; };
  const tree = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(context.TradingAccountProvider, {}, React.createElement(Probe),
      React.createElement(Screen, { route: { params: h.route }, navigation: { navigate() {} } })));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); };
  h.start = async () => { h.renderer = h.render(tree()); await h.flush(); await h.flush(); };
  h.update = async () => { act(() => h.renderer.update(tree())); await h.flush(); };
  h.switch = async id => { act(() => h.accountContext.selectAccount(id)); await h.flush(); };
  h.find = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.press = async id => { act(() => h.find(id).props.onPress()); await h.flush(); };
  h.text = () => h.renderer.root.findAllByType('Text').flatMap(node => [node.props.children].flat(Infinity))
    .filter(value => typeof value === 'string' || typeof value === 'number').join(' ').replace(/\u200b/g, '');
  h.expand = async () => {
    act(() => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'admin-diagnostic-toggle')
      .forEach(node => { if (!node.props.accessibilityState.expanded) node.props.onPress(); }));
    await h.flush();
  };
  h.retry = async title => {
    const state = h.renderer.root.findAll(node => typeof node.type === 'function' && node.type.name === 'ErrorState')
      .find(node => node.props.title === title);
    act(() => state.props.onRetry()); await h.flush();
  };
  h.close = () => { act(() => h.renderer.unmount()); h.client.clear(); };
  return h;
}
module.exports = { financialDiagnosticsHarness, failure, privateText, act, QUERY_KEYS };
