// Production screens, API wrappers, React Query and panels; only transport and native hosts are fixtures.
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('./interactionTestHarness.cjs');
const { recordDetail, recordEquity } = require('./recordFixtures.ts');
const { QUERY_KEYS } = require('../src/constants/queryKeys.ts');
const { failure, privateText } = require('./financialDiagnosticsHarness.cjs');
function secondaryDiagnosticsHarness(screen, role = 'admin') {
  const h = interactionHarness();
  Object.assign(h, { role, failures: {}, requests: [], gates: {}, alerts: [], route: { seasonId: 'record-0', userId: 'friend' } });
  h.season = { id: 'season-1', name: '시즌', status: 'active', effectiveMode: 'active', joined: false, startAt: '2026-01-01T00:00:00Z', endAt: '2027-01-01T00:00:00Z', initialCapitalKrw: '10000000' };
  h.data = {
    '/records/me/seasons': { state: 'empty', seasons: [], items: [], pagination: { total: 0, nextOffset: null } },
    '/records/me/seasons/record-0': recordDetail(),
    '/records/me/seasons/record-0/equity': recordEquity,
    '/friends': { users: [], pagination: { nextOffset: null } },
    '/friends/requests': { users: [], pagination: { nextOffset: null } },
    '/friends/search': { users: [], pagination: { nextOffset: null } },
    '/rewards/me': { state: 'empty', items: [] }, '/badges/me': { state: 'empty', items: [] },
    '/ranking': { state: 'unavailable', season: h.season, myRanking: { state: 'unavailable' }, rankings: [], items: [], pagination: { nextOffset: null } },
    '/users/friend/season-summary': { user: { id: 'friend', nickname: '친구' }, season: null, state: 'not_joined', portfolioAccess: 'private', portfolio: null },
  };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity }, mutations: { retry: false } } });
  const call = async (method, url, body) => {
    const path = url.split('?')[0], key = method === 'GET' ? path : `${method} ${path}`;
    h.requests.push(key);
    if (h.gates[key]) await h.gates[key].promise;
    if (h.failures[key]) throw h.failures[key];
    const data = path === '/me' ? { id: 'user-1', role: h.role, nickname: body?.nickname ?? '사용자', email: 'test@example.com', portfolioPublic: body?.portfolioPublic ?? false, status: 'active' }
      : path === '/seasons/current' ? h.season : path.endsWith('/join') ? { seasonId: h.season.id } : h.data[path];
    return { status: 200, data: { success: true, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) } };
  };
  const transport = { apiClient: Object.fromEntries(['get', 'post', 'patch', 'delete'].map(method => [method, (path, body) => call(method.toUpperCase(), path, body)])) };
  const api = name => h.load(`src/features/${name}/api.ts`, { '../../services/api/client': transport });
  h.client.setQueryData(QUERY_KEYS.me, { id: 'user-1', role, nickname: '사용자', email: 'test@example.com', portfolioPublic: false });
  const account = { id: 'A', mode: 'season', status: 'active', season: { seasonId: h.season.id, seasonStatus: 'active' } };
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', Switch: 'Switch',
    Alert: { alert: (...args) => h.alerts.push(args) },
    FlatList: ({ data, renderItem, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }) => React.createElement('FlatList', props, ListHeaderComponent, data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: index }, renderItem({ item, index }))) : ListEmptyComponent, ListFooterComponent),
  });
  const mocks = {
    ...Object.fromEntries(['me','record','ranking','season','reward','friends'].map(name => [`../../features/${name}/api`, api(name)])),
    '@react-navigation/native': { useIsFocused: () => true, useFocusEffect() {}, NavigationContext: React.createContext(undefined) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: [account], selectedAccount: account, isLoading: false, refetchAccounts: async () => ({ data: { accounts: [account] } }), selectAccount() {} }) },
    '../../features/friends/cache': h.load('src/features/friends/cache.ts'),
    '../../features/auth/session': { endSession: async () => {} },
    '../../services/api/client': { getRequestGeneration: () => 0 },
    '../../features/me/profileImageCache': h.load('src/features/me/profileImageCache.ts'),
    '../../features/auth/useLogout': { useLogout: () => () => {} },
    '../../features/me/profileImage': { selectProfileImage: async () => null },
    '../../components/charts': { LineChart: 'LineChart', DonutChart: 'DonutChart' },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/tradingAccount/AccountSetupPanel': { default: 'AccountSetupPanel', __esModule: true },
  };
  const files = { ranking: 'ranking/RankingScreen', summary: 'ranking/UserSeasonSummaryScreen', list: 'record/RecordSeasonListScreen', detail: 'record/RecordSeasonDetailScreen', profit: 'record/RecordProfitAnalysisScreen', friends: 'friends/FriendsScreen', season: 'season/SeasonJoinScreen', reward: 'reward/RewardScreen', settings: 'my/SettingsScreen', my: 'my/MyScreen' };
  const Screen = h.load(`src/screens/${files[screen]}.tsx`, mocks).default;
  const tree = () => React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Screen, { route: { params: h.route }, navigation: { navigate() {}, reset() {} } }));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  h.start = async () => { h.renderer = h.render(tree()); await h.flush(); await h.flush(); };
  h.update = async () => { act(() => h.renderer.update(tree())); await h.flush(); };
  h.panels = () => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'admin-diagnostic-panel');
  h.expand = async () => { act(() => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'admin-diagnostic-toggle').forEach(node => { if (!node.props.accessibilityState.expanded) node.props.onPress(); })); await h.flush(); };
  h.text = () => h.renderer.root.findAllByType('Text').flatMap(node => [node.props.children].flat(Infinity)).filter(value => typeof value === 'string' || typeof value === 'number').join(' ').replace(/\u200b/g, '');
  h.press = async (predicate) => { const node = h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.onPress && predicate(node.props))[0]; if (!node) throw Error('button missing'); act(() => node.props.onPress()); await h.flush(); await h.flush(); };
  h.retry = async () => { const state = h.renderer.root.findAll(node => node.type.name === 'ErrorState')[0]; act(() => state.props.onRetry()); await h.flush(); await h.flush(); };
  h.close = () => { act(() => h.renderer?.unmount()); h.client.clear(); };
  return h;
}
module.exports = { secondaryDiagnosticsHarness, failure, privateText, act, QUERY_KEYS };
