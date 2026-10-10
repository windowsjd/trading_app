// Real production screen, API, React Query reads/mutations and focus-scroll hook.
// Native measurement/keyboard events, selected account and HTTP are boundaries.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { getTradingAccountCapabilities } = require('../src/features/tradingAccount/capabilities.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function walletTransferHarness({ platform = 'web', diagnostics = false, role = 'user' } = {}) {
  const h = { role, accountId: 'A', requests: [], invalidations: [], reads: [], gets: [], walletState: {}, riskState: {}, events: [], scrolls: [] };
  h.accounts = {
    A: { id: 'A', mode: 'general', status: 'active', season: null },
    B: { id: 'B', mode: 'season', status: 'active', season: { seasonId: 'season', seasonName: '테스트 시즌', seasonStatus: 'active', participantStatus: 'active', startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() } },
  };
  h.wallets = Object.fromEntries(['A', 'B'].map(accountId => [accountId, {
    tradingAccountId: accountId,
    wallets: [
      { id: accountId + ':crypto_futures', walletScope: 'crypto_futures', currencyCode: 'USD', balanceAmount: '50', reservedAmount: '0' },
      { id: accountId + ':crypto_spot', walletScope: 'crypto_spot', currencyCode: 'USD', balanceAmount: '200', reservedAmount: '50' },
      { id: accountId + ':securities', walletScope: 'securities', currencyCode: 'USD', balanceAmount: '1000', reservedAmount: '300' },
      { id: accountId + ':krw', walletScope: 'securities', currencyCode: 'KRW', balanceAmount: '10000', reservedAmount: '0' },
    ],
  }]));
  h.risk = Object.fromEntries(['A', 'B'].map(accountId => [accountId, {
    tradingAccountId: accountId, evaluatedAt: '2026-10-07T00:00:00.000Z',
    collateral: { walletId: accountId + ':crypto_futures', currencyCode: 'USD', freeCollateral: '25.00000000' },
  }]));
  const client = new query.QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = config => { h.invalidations.push(config.queryKey); return invalidate(config); };
  const api = load(resolve(__dirname, '../src/features/tradingAccount/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async path => {
        h.gets.push(path);
        const accountId = path.split('/')[2];
        const risk = path.endsWith('/futures/positions');
        const gate = risk ? h.riskGate?.[accountId] : h.walletGate?.[accountId];
        if (gate) await gate.promise;
        if (risk && h.riskFailure) throw h.riskFailure;
        return { data: { success: true, data: risk ? h.risk[accountId] : h.wallets[accountId] } };
      },
      post: async (path, body) => {
        h.requests.push({ path, body });
        if (h.beforePost) await h.beforePost();
        if (h.gate) await h.gate.promise;
        if (h.failure) throw h.failure;
        const wallet = (walletId, balance) => ({ walletId, walletScope: walletId.split(':')[1], balanceAfter: balance, availableAfter: balance });
        return { data: { success: true, data: h.response ?? {
          tradingAccountId: path.split('/')[2], transferId: 'transfer-1', currencyCode: 'USD', amount: body.amount,
          executedAt: '2026-10-06T00:00:00.000Z', source: wallet(body.sourceWalletId, '500.00000000'), destination: wallet(body.destinationWalletId, '400.00000000'),
        } } };
      },
    } },
  });
  const listeners = new Map();
  const frames = new Map();
  let frameId = 0;
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  h.flushFrames = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback()); };
  h.keyboard = (event, screenY = 400) => { for (const listener of listeners.get(event) ?? []) listener({ endCoordinates: { screenY } }); h.flushFrames(); };
  const native = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'TextInput', 'KeyboardAvoidingView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: platform }, StyleSheet: { create: value => value }, Keyboard: {
    dismiss() { h.events.push('dismiss'); },
    addListener(event, callback) { const set = listeners.get(event) ?? new Set(); set.add(callback); listeners.set(event, set); return { remove: () => set.delete(callback) }; },
  } });
  const mocks = {
    'react-native': native,
    'react-native-svg': { default: 'Svg', Path: 'Path', __esModule: true },
    '@react-navigation/elements': { useHeaderHeight: () => 64 },
    '@tanstack/react-query': { ...query, useQuery: options => {
      h.reads.push({ key: options.queryKey, enabled: options.enabled });
      const state = query.useQuery(options);
      return { ...state, ...(options.queryKey[0] === 'me' ? {} : options.queryKey.includes('futures') ? h.riskState : h.walletState) };
    } },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ selectedAccount: h.accounts[h.accountId], capabilities: getTradingAccountCapabilities(h.accounts[h.accountId]), isLoading: false, isError: false }) },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
  };
  if (diagnostics) {
    delete mocks['./AdminDiagnosticPanel'];
    delete mocks['../../components/states/ErrorState'];
    mocks['../../features/me/api'] = { getMe: async () => ({ id: 'user-1', role: h.role }) };
    client.setQueryData(['me'], { id: 'user-1', role: h.role });
  }
  const Screen = load(resolve(__dirname, '../src/screens/wallet/WalletTransferScreen.tsx'), mocks).default;
  h.bounds = { viewport: [0, 0, 320, 600], input: [0, 420, 288, 52], submit: [0, 550, 288, 52] };
  const measure = key => ({ measureInWindow: callback => callback(...h.bounds[key]) });
  const createNodeMock = element => {
    if (element.type === 'ScrollView') return { getNativeScrollRef: () => measure('viewport'), scrollTo: config => h.scrolls.push(config) };
    if (element.type === 'TextInput') return { blur: () => h.events.push('blur') };
    if (element.type === 'View' && element.props.collapsable === false) return measure(element.props.children?.props.testID === 'wallet-transfer-amount' ? 'input' : 'submit');
    return null;
  };
  const tree = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree(), { createNodeMock }); }); await h.flush(); };
  h.update = async () => { await act(async () => { h.renderer.update(tree()); }); await h.flush(); };
  h.switchAccount = async id => { h.accountId = id; await h.update(); };
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.press = async id => { await act(async () => { h.node(id).props.onPress(); }); await h.flush(); };
  h.choose = async (kind, key) => { await h.press('wallet-transfer-' + kind + '-selector'); await h.press('wallet-transfer-' + kind + '-' + key); };
  h.amount = async value => { await act(async () => { h.node('wallet-transfer-amount').props.onChangeText(value); }); };
  h.focus = async () => { await act(async () => { h.node('wallet-transfer-amount').props.onFocus(); }); h.flushFrames(); };
  h.client = client;
  h.api = api;
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; };
  return h;
}
module.exports = { walletTransferHarness, deferred };
