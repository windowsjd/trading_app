// Production record/history screens, formatters, API wrappers, query hooks and
// refresh logic. Native hosts, HTTP and account context are test boundaries.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { recordDetail, recordEquity } = require('./recordFixtures.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function createRecordScreenHarness(screen = 'detail', scope = { seasonId: 'record-0' }) {
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  const accounts = [{ id: 'historical', mode: 'season', status: 'closed', season: { seasonId: 'record-0', seasonName: '시즌 1', seasonStatus: 'settled' } }, { id: 'current', mode: 'general', status: 'active' }];
  const h = { client, accounts, selectedAccount: accounts[0], requests: [], navigation: [], detail: recordDetail(), equity: recordEquity, orderOptions: null, alerts: [], orders: [
    { id: 'limit-1', assetId: 'asset-1', asset: { name: '삼성전자', symbol: '005930' }, side: 'buy', orderType: 'limit', status: 'submitted', quantity: '2', limitPrice: '50000', reservedAmount: '100000', currencyCode: 'KRW', submittedAt: '2026-09-01T00:00:00Z' },
    { id: 'sell-1', assetId: 'asset-2', side: 'sell', orderType: 'market', status: 'executed', quantity: '1', executedPrice: '70000', grossAmount: '70000', feeAmount: '70', netAmount: '69930', currencyCode: 'KRW', submittedAt: '2026-09-01T00:00:00Z' },
  ], pageLimit: 1 };
  const transport = { apiClient: {
    get: async (path, config) => {
      h.requests.push({ path, params: config?.params });
      if (h.failure) throw h.failure;
      if (path.startsWith('/records/me/seasons/')) return { data: { success: true, data: path.includes('/equity') ? h.equity : h.detail } };
      const all = h.orders.filter(row => !config.params.side || row.side === config.params.side);
      const offset = config.params.offset, orders = all.slice(offset, offset + h.pageLimit);
      return { data: { success: true, data: { tradingAccountId: path.split('/')[2], orders, pagination: { nextOffset: offset + orders.length < all.length ? offset + orders.length : null } } } };
    },
    post: async (path) => {
      h.requests.push({ path, method: 'POST' });
      h.orders[0].status = 'canceled';
      return { data: { success: true, data: { tradingAccountId: path.split('/')[2] } } };
    },
  } };
  const native = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'Pressable', 'ActivityIndicator', 'RefreshControl'].map(name => [name, name]));
  native.StyleSheet = { create: s => s };
  native.Platform = { OS: 'android' };
  native.AppState = { currentState: 'active', addEventListener: (_event, callback) => { h.appState = callback; return { remove() {} }; } };
  native.Alert = { alert: (...args) => h.alerts.push(args) };
  native.FlatList = ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ...props }) => React.createElement('FlatList', props, ListHeaderComponent, ...data.map((item, index) => React.cloneElement(renderItem({ item, index }), { key: item.id })), ListFooterComponent);
  const recordApi = load(resolve('src/features/record/api.ts'), { '../../services/api/client': transport });
  const accountApi = load(resolve('src/features/tradingAccount/api.ts'), { '../../services/api/client': transport });
  const mocks = {
    'react-native': native,
    '@react-navigation/native': { useIsFocused: () => h.focused !== false },
    '@tanstack/react-query': { ...query, useInfiniteQuery: options => { h.orderOptions = options; return query.useInfiniteQuery(options); } },
    '../../features/me/api': { getMe: async () => ({ role: 'user' }) },
    '../../features/record/api': recordApi,
    '../../features/tradingAccount/api': accountApi,
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: h.accounts, selectedAccount: h.selectedAccount, isLoading: false, isError: false }) },
    '../../components/charts': { LineChart: 'LineChart' },
  };
  const file = screen === 'history' ? 'src/screens/history/TradeHistoryScreen.tsx' : `src/screens/record/${screen === 'detail' ? 'RecordSeasonDetailScreen' : 'RecordProfitAnalysisScreen'}.tsx`;
  const Screen = load(resolve(file), mocks).default;
  const element = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen, { route: { params: scope }, navigation: { navigate: (...args) => h.navigation.push(args) } }));
  act(() => { h.renderer = create(element()); });
  h.settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
  h.update = async () => { act(() => h.renderer.update(element())); await h.settle(); };
  h.find = id => h.renderer.root.findAll(n => typeof n.type === 'string' && n.props.testID === id)[0];
  h.text = (node = h.renderer.root) => typeof node === 'string' || typeof node === 'number' ? String(node) : node.children.map(h.text).join('');
  h.press = async id => { await act(async () => h.find(id).props.onPress()); await h.settle(); };
  h.refresh = async () => { await act(async () => { h.renderer.root.findByType(screen === 'history' ? 'FlatList' : 'ScrollView').props.refreshControl.props.onRefresh(); await new Promise(resolve => setTimeout(resolve, 20)); }); };
  h.close = () => { act(() => h.renderer.unmount()); client.clear(); };
  return h;
}
module.exports = { createRecordScreenHarness, act };
