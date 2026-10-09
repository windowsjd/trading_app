const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { futuresFixture, accounts } = require('./futuresFixtures.cjs');
const { deferred } = require('./walletTransferHarness.cjs');
const { conditionalFixture } = require('./conditionalFixtures.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function futuresHarness(options = {}) {
  const h = { accountId: options.accountId ?? 'A', routeAccountId: options.accountId ?? 'A', requests: [], reads: [], invalidations: [], navigation: [], options, session: 1 };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = config => { h.invalidations.push(config?.queryKey ?? []); return invalidate(config); };
  const api = load(resolve(__dirname, '../src/features/futures/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async path => {
        const id = path.split('/')[2]; h.reads.push(path);
        if (h.readGate) await h.readGate.promise;
        if (h.readFailure) throw h.readFailure;
        if (h.readFailures?.[path]) throw h.readFailures[path];
        const f = futuresFixture(h.wrongScope ?? id, h.options);
        if (path.includes('limit-orders')) return { data: { data: { tradingAccountId: h.wrongScope ?? id, orders: h.pendingEntries ?? [], pagination: { limit: 100, offset: 0, total: h.pendingEntries?.length ?? 0, returned: h.pendingEntries?.length ?? 0, nextOffset: null } } } };
        const key = path.includes('instruments') ? 'catalog' : path.includes('positions') ? 'positions' : path.includes('executions') ? 'executions' : path.includes('liquidations') ? 'liquidations' : 'final';
        return { data: { success: true, data: f[key] } };
      },
      post: async (path, body) => {
        h.requests.push({ path, body }); if (h.gate) await h.gate.promise;
        if (h.failure) throw h.failure;
        return { data: { success: true, data: { tradingAccountId: path.split('/')[2], commandId: 'command', execution: { operation: body.operation, feeAmount: '0.1' } } } };
      },
    } },
  });
  const native = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'TextInput', 'KeyboardAvoidingView'].map(name => [name, name]));
  native.useWindowDimensions = () => options.dimensions ?? { width: 390, height: 844, fontScale: 1 };
  Object.assign(native, { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web' }, StyleSheet: { create: value => value }, Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} } });
  const conditionalApi = load(resolve(__dirname, '../src/features/conditional/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async (path, config) => { const id = path.split('/')[2]; h.protectionReads ??= []; h.protectionReads.push({path,config}); return { data: { data: conditionalFixture(id, { domain:'futures', enabled: options.protectionEnabled === true, ...h.protectionOptions }) } }; },
      post: async (path, body) => { h.requests.push({path,body}); return {data:{data:{tradingAccountId:path.split('/')[2],groupId:'group',status:'active'}}}; },
    } },
  });
  const mocks = {
    'react-native': native,
    '../../components/states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    '@react-navigation/native': { useIsFocused: () => true }, '@react-navigation/elements': { useHeaderHeight: () => 64 },
    '../../features/futures/api': api,
    '../../features/conditional/api': conditionalApi,
    '../../features/tradingAccount/api': { getTradingAccountOrders: async id => ({ tradingAccountId: id, orders: [], pagination: { offset: 0, limit: 100, total: 0, returned: 0, nextOffset: null } }) },
    '../../features/record/api': load(resolve(__dirname, '../src/features/record/api.ts'), { '../../services/api/client': { apiClient: {} }, './openOrder': require('../src/features/record/openOrder.ts') }),
    '../../features/futures/policy': load(resolve(__dirname, '../src/features/futures/policy.ts'), {}),
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts, selectedAccountId: h.accountId, isLoading: false, ...h.accountState }) },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.session, isCurrentSession: owner => owner === h.session },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
  };
  if (options.diagnostics) {
    delete mocks['../../components/states/AdminDiagnosticPanel'];
    delete mocks['./AdminDiagnosticPanel'];
    delete mocks['../../components/states/ErrorState'];
    const me = { id: 'user-1', role: options.role ?? 'admin' };
    mocks['../../features/me/api'] = { getMe: async () => me };
    client.setQueryData(['me'], me);
  }
  const screen = load(resolve(__dirname, options.screen === 'market' ? '../src/screens/market/FuturesMarketList.tsx' : '../src/screens/futures/FuturesScreen.tsx'), mocks).default;
  const tree = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(screen, { route: { params: { accountId: h.routeAccountId, instrumentId: options.instrumentId } }, navigation: { navigate: (...args) => h.navigation.push(args) }, onSelect: (...args) => h.navigation.push(args) }));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); await h.flush(); };
  h.update = async () => { await act(async () => h.renderer.update(tree())); await h.flush(); };
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.change = async (id, value) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.input = async (label, value) => { await act(async () => h.renderer.root.findAll(n => n.type === 'TextInput' && n.props.accessibilityLabel === label)[0].props.onChangeText(value)); };
  h.press = async id => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  h.choose = async label => { await act(async () => h.renderer.root.findAll(n => n.type === 'Pressable' && n.props.accessibilityLabel === label)[0].props.onPress()); await h.flush(); };
  h.text = () => JSON.stringify(h.renderer.toJSON());
  h.api = api; h.client = client;
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}
module.exports = { futuresHarness, deferred };
