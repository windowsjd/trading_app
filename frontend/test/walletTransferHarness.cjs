// Production form/API/scope logic, real React reconciliation and Query mutations.
// Native hosts, wallet reads and HTTP are the test boundaries.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { getTradingAccountCapabilities } = require('../src/features/tradingAccount/capabilities.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function walletTransferHarness() {
  const h = { accountId: 'A', requests: [], invalidations: [], reads: [], walletState: {} };
  h.accounts = {
    A: { id: 'A', mode: 'general', status: 'active', season: null },
    B: { id: 'B', mode: 'season', status: 'active', season: { seasonId: 'season', seasonName: '테스트 시즌', seasonStatus: 'active', participantStatus: 'active', startAt: new Date(Date.now() - 86400000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() } },
  };
  h.wallets = Object.fromEntries(['A', 'B'].map(accountId => [accountId, {
    tradingAccountId: accountId,
    wallets: [
      { id: `${accountId}:crypto_futures`, walletScope: 'crypto_futures', currencyCode: 'USD', balanceAmount: '50', reservedAmount: '0' },
      { id: `${accountId}:crypto_spot`, walletScope: 'crypto_spot', currencyCode: 'USD', balanceAmount: '200', reservedAmount: '50' },
      { id: `${accountId}:securities`, walletScope: 'securities', currencyCode: 'USD', balanceAmount: '1000', reservedAmount: '300' },
      { id: `${accountId}:krw`, walletScope: 'securities', currencyCode: 'KRW', balanceAmount: '10000', reservedAmount: '0' },
    ],
  }]));
  const client = new query.QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = config => { h.invalidations.push(config.queryKey); return invalidate(config); };
  const api = load(resolve(__dirname, '../src/features/tradingAccount/api.ts'), {
    '../../services/api/client': { apiClient: {
      post: async (path, body) => {
        h.requests.push({ path, body });
        if (path.endsWith('/quote')) {
          if (h.quoteGate) await h.quoteGate.promise;
          if (h.quoteFailure) throw h.quoteFailure;
          const fromCurrency = body.sourceWalletId.endsWith(':krw') ? 'KRW' : 'USD';
          const quote = {
            tradingAccountId: path.split('/')[2], sourceWalletId: body.sourceWalletId, destinationWalletId: body.destinationWalletId,
            quoteId: `quote-${h.requests.length}`, fromCurrency, toCurrency: fromCurrency === 'KRW' ? 'USD' : 'KRW', sourceAmount: body.amount,
            appliedRate: '1400.00000000', grossTargetAmount: '100.00000000', netTargetAmount: '99.90000000',
            feeRate: '0.001000', feeAmount: '0.10000000', feeCurrency: fromCurrency === 'KRW' ? 'USD' : 'KRW',
            maxChangeBps: '30.0000', expiresAt: h.expiresAt ?? new Date(Date.now() + 15000).toISOString(),
            rateCapturedAt: new Date().toISOString(), rateEffectiveAt: new Date().toISOString(), rateSource: null,
          };
          h.quote = quote;
          return { data: { success: true, data: h.quoteResponse ?? quote } };
        }
        if (h.gate) await h.gate.promise;
        if (h.failure) throw h.failure;
        if (path.endsWith('/execute')) {
          const q = h.quote;
          const wallet = (walletId, currencyCode) => ({ walletId, walletScope: walletId.endsWith(':krw') ? 'securities' : walletId.split(':')[1], currencyCode, balanceAfter: '500.00000000', availableAfter: '200.00000000' });
          return { data: { success: true, data: h.response ?? {
            tradingAccountId: path.split('/')[2], commandId: 'command-1', quoteId: q.quoteId, transferId: 'transfer-1',
            executedAt: new Date().toISOString(), sourceAmount: q.sourceAmount, receivedAmount: '99.82869375',
            source: wallet(q.sourceWalletId, q.fromCurrency), destination: wallet(q.destinationWalletId, q.toCurrency),
            fx: { ...q, appliedRate: '1401.00000000', quotedRate: q.appliedRate, netTargetAmount: '99.82869375', feeAmount: '0.09992862', exchangeId: 'exchange-1' },
          } } };
        }
        const wallet = (walletId, balance) => ({ walletId, walletScope: walletId.split(':')[1], balanceAfter: balance, availableAfter: balance });
        return { data: { success: true, data: h.response ?? {
          tradingAccountId: path.split('/')[2], transferId: 'transfer-1', currencyCode: 'USD', amount: body.amount,
          executedAt: '2026-10-06T00:00:00.000Z', source: wallet(body.sourceWalletId, '500.00000000'), destination: wallet(body.destinationWalletId, '400.00000000'),
        } } };
      },
    } },
  });
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TextInput', 'KeyboardAvoidingView'].map(name => [name, name]));
  Object.assign(native, { Platform: { OS: 'web' }, StyleSheet: { create: v => v } });
  const Screen = load(resolve(__dirname, '../src/screens/wallet/WalletTransferScreen.tsx'), {
    'react-native': native,
    '@tanstack/react-query': { ...query, useQuery: options => { h.reads.push(options.queryKey); return { data: h.wallets[h.accountId], isLoading: false, isError: false, refetch() {}, ...h.walletState }; } },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ selectedAccount: h.accounts[h.accountId], capabilities: getTradingAccountCapabilities(h.accounts[h.accountId]), isLoading: false, isError: false }) },
    '../../components/tradingAccount/AccountSwitcher': { default: 'AccountSwitcher', __esModule: true },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
  }).default;
  const tree = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen));
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); };
  h.update = async () => { await act(async () => { h.renderer.update(tree()); }); };
  h.switchAccount = async id => { h.accountId = id; await h.update(); };
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.press = async id => { await act(async () => { h.node(id).props.onPress(); }); };
  h.amount = async value => { await act(async () => { h.node('wallet-transfer-amount').props.onChangeText(value); }); };
  h.flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 20)); }); };
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}
module.exports = { walletTransferHarness, deferred };
