// Load the actual screens, display helpers and API client wrappers. Replace
// native hosts, HTTP and hook scheduling so rendered text and controls run in Node.
const React = require('react');
const { resolve } = require('node:path');
const { load, elements } = require('./ledgerTestHarness.cjs');
const { getTradingAccountCapabilities } = require('../src/features/tradingAccount/capabilities.ts');
const timeframes = require('../src/features/asset/chartTimeframes.ts');

function createTradingUiHarness(screenName) {
  const now = new Date().toISOString();
  const h = {
    asset: {
      id: 'asset-1', assetType: 'domestic_stock', name: '삼성전자', symbol: '005930',
      market: 'KRX', priceCurrency: 'KRW', settlementCurrency: 'KRW', isActive: true,
      marketStatus: 'closed', tradable: false, tradeBlockedReason: 'MARKET_CLOSED',
      price: { state: 'available', currentPrice: '70000', priceCurrency: 'KRW',
        priceKrwState: 'available', priceKrw: '70000', priceCapturedAt: now },
    },
    account: { id: 'account-1', mode: 'general', status: 'active', season: null },
    positionQuery: { data: { positions: [] }, isLoading: false, isError: false },
    rateQuery: { data: { state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW',
      rate: '1350', capturedAt: now, effectiveAt: '2026-01-01T00:00:00Z',
      freshnessAgeSeconds: 123, validUntil: new Date(Date.now() + 3600000).toISOString() },
      isLoading: false, isError: false },
    queries: [], requests: [], navigation: [], jobs: [], ticker: null, tickerStale: false,
  };
  const slots = [];
  let index = 0;
  let effects = [];
  const queryClient = { invalidateQueries: async () => {} };
  const navigation = { navigate: (...args) => h.navigation.push(args), goBack: () => {} };
  const api = load(resolve(__dirname, '../src/features/tradingAccount/api.ts'), {
    '../../services/api/client': { apiClient: {
      post: async (url, body) => {
        h.requests.push({ url, body });
        return { data: { success: true, data: url.endsWith('/quote') ? h.quote : h.result } };
      },
    } },
  });
  const native = {
    ...Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'TextInput',
      'Pressable', 'KeyboardAvoidingView'].map(name => [name, name])),
    StyleSheet: { create: styles => styles }, Platform: { OS: 'web' },
  };
  const mocks = {
    react: { ...React,
      useMemo: fn => fn(),
      useState: initial => {
        const slot = index++;
        if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
        return [slots[slot], next => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
      },
      useRef: initial => {
        const slot = index++;
        slots[slot] ??= { current: initial };
        return slots[slot];
      },
      useEffect: (fn, deps) => {
        const slot = index++;
        if (!slots[slot] || deps?.some((dep, i) => !Object.is(dep, slots[slot][i]))) {
          slots[slot] = deps;
          effects.push(fn);
        }
      },
    },
    'react-native': native,
    '@tanstack/react-query': {
      useQueryClient: () => queryClient,
      useQuery: options => {
        h.queries.push(options);
        const [scope, resource] = options.queryKey;
        const base = { refetch: () => {}, isLoading: false, isError: false };
        if (scope === 'asset') return { ...base, data: resource === 'detail' ? { asset: h.asset } : { candles: h.candles ?? [] } };
        if (resource === 'positions') return { ...base, ...h.positionQuery };
        if (resource === 'fx-rate') return { ...base, ...h.rateQuery };
        if (resource === 'detail') return { ...base, data: { feePolicy: { fxFeeRate: '0.001', tradeFeeRate: '0.001' } } };
        if (resource === 'wallets') return { ...base, data: { wallets: [
          { currencyCode: 'KRW', balanceAmount: '1000000' }, { currencyCode: 'USD', balanceAmount: '100' },
        ] } };
        throw new Error(`Unexpected query: ${options.queryKey}`);
      },
      useMutation: config => ({ isPending: false, reset: () => {}, mutate: variables => {
        h.jobs.push((async () => {
          try { const data = await config.mutationFn(variables); await config.onSuccess?.(data, variables); }
          catch (error) { if (config.onError) config.onError(error, variables); else throw error; }
          finally { config.onSettled?.(); }
        })());
      } }),
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => navigation },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({
      accounts: [h.account], selectedAccountId: h.account.id, selectedAccount: h.account,
      capabilities: getTradingAccountCapabilities(h.account), isLoading: false, isEmpty: false,
    }) },
    '../../constants/env': { buildWsUrl: () => null, LIMIT_ORDER_ENABLED: false },
    '../../features/asset/api': { ...timeframes },
    '../../features/wallet/api': {},
    '../../features/asset/useAssetTicker': { useAssetTicker: () => ({ latestTicker: h.ticker, isStale: h.tickerStale }) },
    '../../features/asset/useAssetCandle': { useAssetCandle: (options) => { h.liveCandleOptions = options; return {}; } },
    '../../features/asset/useStaleRecheck': { useStaleRecheck: () => {} },
    '../../features/wallet/useFxRateUpdates': { useFxRateUpdates: () => {} },
    '../../components/charts': { CandlestickChart: 'CandlestickChart' },
    '../../components/charts/ChartTimeframeSelector': { default: 'ChartTimeframeSelector', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'InlineEmptyState', 'SectionSkeleton',
      'BlockedState', 'AdminDiagnosticPanel'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
    ...Object.fromEntries(['AccountSwitcher', 'PreviewAmounts'].map(name => ['../../components/tradingAccount/' + name, { default: name, __esModule: true }])),
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    './OrderSuccessBottomSheet': { default: 'OrderSuccessBottomSheet', __esModule: true },
    './FxSuccessBottomSheet': { default: 'FxSuccessBottomSheet', __esModule: true },
  };
  const screen = load(resolve(__dirname, '../src/screens', screenName), mocks).default;
  h.render = (side = 'sell') => {
    index = 0; effects = []; h.queries = [];
    const tree = screen({ route: { params: { assetId: h.asset.id, accountId: h.account.id, side } }, navigation });
    effects.forEach(fn => fn());
    return tree;
  };
  h.flush = async () => { await Promise.all(h.jobs.splice(0)); };
  h.control = (tree, testID) => {
    const node = elements(tree).find(node => node.props.testID === testID);
    if (!node) throw new Error(`Missing control ${testID}`);
    return node;
  };
  h.renderCta = node => load(resolve(__dirname, '../src/components/common/CTAButton.tsx'), { 'react-native': native }).default(node.props);
  return h;
}

function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (React.isValidElement(node)) return textContent(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
}

module.exports = { createTradingUiHarness, textContent, elements };
