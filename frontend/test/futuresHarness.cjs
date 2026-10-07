const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { futuresFixture, accounts } = require('./futuresFixtures.cjs');
const { deferred } = require('./walletTransferHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function futuresHarness(options = {}) {
  const h = { accountId: options.accountId ?? 'A', routeAccountId: options.accountId ?? 'A', requests: [], reads: [], invalidations: [], options, session: 1 };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = config => { h.invalidations.push(config?.queryKey ?? []); return invalidate(config); };
  const api = load(resolve(__dirname, '../src/features/futures/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async path => {
        const id = path.split('/')[2]; h.reads.push(path);
        if (h.readGate) await h.readGate.promise;
        if (h.readFailure) throw h.readFailure;
        const f = futuresFixture(h.wrongScope ?? id, h.options);
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
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TextInput', 'KeyboardAvoidingView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'web' }, StyleSheet: { create: value => value }, Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} } });
  const screen = load(resolve(__dirname, '../src/screens/futures/FuturesScreen.tsx'), {
    'react-native': native,
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    '@react-navigation/native': { useIsFocused: () => true }, '@react-navigation/elements': { useHeaderHeight: () => 64 },
    '../../features/futures/api': api,
    '../../features/futures/policy': load(resolve(__dirname, '../src/features/futures/policy.ts'), {}),
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts, selectedAccountId: h.accountId, isLoading: false }) },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.session, isCurrentSession: owner => owner === h.session },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
  }).default;
  const tree = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(screen, { route: { params: { accountId: h.routeAccountId } }, navigation: { navigate() {} } }));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); await h.flush(); };
  h.update = async () => { await act(async () => h.renderer.update(tree())); await h.flush(); };
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.change = async (id, value) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.press = async id => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  h.choose = async label => { await act(async () => h.renderer.root.findAll(n => n.type === 'Pressable' && n.props.accessibilityLabel === label)[0].props.onPress()); await h.flush(); };
  h.text = () => JSON.stringify(h.renderer.toJSON());
  h.api = api; h.client = client;
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}
module.exports = { futuresHarness, deferred };
