// Load the actual screens, display helpers and API client wrappers. Replace
// native hosts, HTTP and hook scheduling so rendered text and controls run in Node.
const React = require('react');
const { resolve } = require('node:path');
const { load, elements } = require('./ledgerTestHarness.cjs');
const { getTradingAccountCapabilities } = require('../src/features/tradingAccount/capabilities.ts');
const timeframes = require('../src/features/asset/chartTimeframes.ts');

// The field's value per method (features/order/orderMethods ORDER_METHOD_LABEL).
const METHOD_LABEL = { market: '시장가', limit: '지정가', conditional: '조건주문', loc: 'LOC 주문', protection: '손절가/익절가 설정' };
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
    // Every order form starts at 시장가: h.render picks another method
    // through the 주문방식 field; null keeps each form at its default.
    method: 'market',
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
        if (h.post) return { data: { success: true, data: await h.post(url, body) } };
        return { data: { success: true, data: url.endsWith('/quote') ? h.quote : h.result } };
      },
    } },
  });
  const native = {
    ...Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'TextInput',
      'Pressable', 'KeyboardAvoidingView'].map(name => [name, name])),
    StyleSheet: { create: styles => styles, absoluteFillObject: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } },
    Platform: { OS: 'web' },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: () => {} },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    Modal: 'Modal',
    Easing: { out: fn => fn, in: fn => fn, quad: n => n * n, cubic: n => n * n * n },
    // Side/order-type motion is visual; runs land on their targets at once.
    Animated: {
      Value: class { constructor(value) { this.value = value; } setValue(value) { this.value = value; } interpolate(config) { return { value: this, ...config }; } },
      View: 'AnimatedView',
      timing: (value, options) => ({ start: callback => { value.setValue(options.toValue); callback?.({ finished: true }); }, stop: () => {} }),
      spring: (value, options) => ({ start: callback => { value.setValue(options.toValue); callback?.({ finished: true }); }, stop: () => {} }),
      // A loading loop never completes; it is recorded, not run.
      loop: () => ({ start: () => {}, stop: () => {} }),
    },
  };
  const mocks = {
    './QuantityRatioSlider': load(resolve(__dirname, '../src/screens/order/QuantityRatioSlider.web.tsx'), {}),
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '@react-navigation/elements': { useHeaderHeight: () => 0 },
    'react-native-svg': { default: 'Svg', Path: 'Path', __esModule: true },
    '../../features/asset/AssetOrderLadder': { default: props => React.createElement('AssetOrderLadder', props, props.currentPrice), __esModule: true },
    '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => h.role === 'admin' },
    '@react-navigation/native': { useIsFocused: () => h.isFocused ?? true },
    react: { ...React,
      useCallback: (fn, deps) => {
        const slot = index++;
        if (!slots[slot] || deps.some((dep, i) => !Object.is(dep, slots[slot].deps[i]))) slots[slot] = { fn, deps };
        return slots[slot].fn;
      },
      useMemo: fn => fn(),
      // No provider is rendered here: every context reads its default.
      useContext: context => context._currentValue,
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
      // Same positional slots: layout effects run with the passive ones here.
      useLayoutEffect: (fn, deps) => {
        const slot = index++;
        if (!slots[slot] || deps?.some((dep, i) => !Object.is(dep, slots[slot][i]))) {
          slots[slot] = deps;
          effects.push(fn);
        }
      },
      // No provider renders here (see useContext): a store reads its snapshot.
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    },
    'react-native': native,
    '@tanstack/react-query': {
      useQueryClient: () => queryClient,
      useQuery: options => {
        h.queries.push(options);
        const [scope, resource] = options.queryKey;
        const base = { refetch: () => {}, isLoading: false, isError: false };
        if (scope === 'asset') return { ...base, data: resource === 'detail' ? { asset: h.asset } : { candles: h.candles ?? [] } };
        // Server gates for new conditional / LOC orders (closed unless a test opens them).
        if (resource === 'conditionalBuyOrders') return { ...base, ...h.conditionalQuery, data: h.conditionalQuery?.data ?? { tradingAccountId: h.account.id,
          capabilities: { enabled: false, canCreate: false, canCancel: true, canUseLimit: false, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 },
          conditionalOrders: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } } };
        if (resource === 'conditionalSellOrders') return { ...base, ...h.sellQuery, data: h.sellQuery?.data ?? { tradingAccountId: h.account.id,
          capabilities: { enabled: false, condition: { enabled: false, canCreate: false, canUseLimit: false }, protection: { enabled: false, canCreate: false, canUseLimit: false }, canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30 },
          conditionalOrders: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } } };
        if (resource === 'orderCapabilities') return { ...base, ...h.capabilityQuery, data: h.capabilityQuery?.data ?? { tradingAccountId: h.account.id,
          limitOrder: { enabled: true, autoExecutionEnabled: false }, limitOnClose: { enabled: false, markets: ['KRX'], sides: ['buy'], attachedProtection: false } } };
        if (resource === 'protections') return { ...base, data: { tradingAccountId: 'account-1', capabilities: { enabled: false, canCreateSpot: false, canUseSpotLimit: false, canCancel: true }, groups: [] } };
        // 손절가/익절가 plans on pending entries: closed and empty.
        if (resource === 'entryTpSl') return { ...base, data: { tradingAccountId: h.account.id,
          capabilities: { spot: { enabled: false, canCreate: false }, futures: { enabled: false, canCreate: false }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 },
          entry: null, plans: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } } };
        if (resource === 'positions' || resource === 'holdings') return { ...base, ...h.positionQuery,
          data: h.positionQuery.data ? { tradingAccountId: h.account.id, ...h.positionQuery.data } : undefined };
        if (resource === 'fx-rate') return { ...base, ...h.rateQuery };
        if (resource === 'detail') return { ...base, data: { feePolicy: { fxFeeRate: '0.001', tradeFeeRate: '0.001' } } };
        if (resource === 'wallets') {
          const result = { ...base, data: { tradingAccountId: h.account.id, wallets: [
          { walletScope: 'securities', currencyCode: 'KRW', balanceAmount: '1000000', reservedAmount: '0' }, { walletScope: 'securities', currencyCode: 'USD', balanceAmount: '100', reservedAmount: '0' },
          { walletScope: 'crypto_spot', currencyCode: 'USD', balanceAmount: '100', reservedAmount: '0' }, { walletScope: 'crypto_futures', currencyCode: 'USD', balanceAmount: '0', reservedAmount: '0' },
        ] }, ...h.walletQuery };
          result.refetch = async () => h.walletRefetch ? h.walletRefetch() : result;
          return result;
        }
        if (resource === 'quests' && options.enabled === false) return base;
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
    '../../constants/env': { buildWsUrl: () => null },
    '../../features/asset/api': { ...timeframes },
    '../../features/wallet/api': {},
    '../../features/asset/useAssetTicker': { useAssetTicker: () => ({ latestTicker: h.ticker, isStale: h.tickerStale, showReconnectBanner: h.reconnect }) },
    '../../features/asset/useAssetOrderBook': { useAssetOrderBook: (options) => { h.orderBookOptions = options; return h.orderBookState ?? { latestOrderBook: null, statusMessage: '호가 정보를 불러오는 중입니다.' }; } },
    '../../features/asset/useAssetEstimatedQuote': { useAssetEstimatedQuote: (options) => { h.estimatedQuoteOptions = options; return h.estimatedQuoteState ?? { latestEstimate: null, supported: false, statusMessage: null }; } },
    '../../features/asset/AssetEstimatedQuoteCard': { default: 'AssetEstimatedQuoteCard', __esModule: true },
    '../../features/asset/useAssetCandle': { useAssetCandle: (options) => { h.liveCandleOptions = options; return {}; } },
    '../../features/asset/useStaleRecheck': { useStaleRecheck: () => {} },
    '../../features/wallet/useFxRateUpdates': { useFxRateUpdates: () => {} },
    '../../components/charts': { CandlestickChart: 'CandlestickChart' },
    '../../features/asset/AssetOrderBookCard': { default: 'AssetOrderBookCard', __esModule: true },
    '../../features/asset/orderBookPreview': load(resolve(__dirname, '../src/features/asset/orderBookPreview.ts'), {}),
    '../../components/charts/ChartTimeframeSelector': { default: 'ChartTimeframeSelector', __esModule: true },
    '../../components/charts/ChartLoading': { default: 'ChartLoading', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'InlineEmptyState', 'SectionSkeleton',
      'BlockedState', 'AdminDiagnosticPanel'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
    ...Object.fromEntries(['AccountSwitcher', 'PreviewAmounts'].map(name => ['../../components/tradingAccount/' + name, { default: name, __esModule: true }])),
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    './OrderSuccessBottomSheet': { default: 'OrderSuccessBottomSheet', __esModule: true },
    // The real field + sheet (motion, insets, back handling) is covered by the
    // react-test-renderer harness; positional hook slots here cannot follow a
    // sheet mounting mid-tree. This stub renders the same testIDs and calls.
    './OrderTypeSelect': { __esModule: true, default: (props) => {
      h.methodSlotBoundary = index;
      return React.createElement('OrderTypeSelect', { testID: 'order-type-select', disabled: props.disabled, method: props.method },
        React.createElement('Text', { testID: 'order-type-select-value' }, METHOD_LABEL[props.method]),
        ...props.options.map(option => React.createElement('Pressable', { key: option.method, testID: `order-method-${option.method}`,
          disabled: option.availability.state !== 'available', availability: option.availability.state, onPress: () => props.onSelect(option.method) })));
    } },
    // Only OrderTradingScreen renders here; the asset sheet belongs to its route wrapper.
    './OrderAssetSheet': { default: 'OrderAssetSheet', __esModule: true },
    './FxSuccessBottomSheet': { default: 'FxSuccessBottomSheet', __esModule: true },
  };
  mocks['./AdminDiagnosticPanel'] = mocks['../../components/states/AdminDiagnosticPanel'];
  mocks['../states/AdminDiagnosticPanel'] = mocks['../../components/states/AdminDiagnosticPanel'];
  const order = load(resolve(__dirname, '../src/screens/order/OrderPanel.tsx'), mocks);
  mocks['../order/OrderPanel'] = order;
  mocks['./OrderPanel'] = order;
  mocks['./PendingOrders'] = { default: 'PendingOrders', __esModule: true };
  mocks['./AccountHoldings'] = load(resolve(__dirname, '../src/screens/asset/AccountHoldings.tsx'), mocks);
  mocks['../asset/AccountHoldings'] = mocks['./AccountHoldings'];
  const chartModule = load(resolve(__dirname, '../src/screens/asset/AssetChartScreen.tsx'), mocks);
  mocks['./AssetChartScreen'] = chartModule;
  const module = load(resolve(__dirname, '../src/screens', screenName), mocks);
  const screen = module.OrderTradingScreen ?? module.AssetDetailContent ?? module.AssetChartContent ?? module.OrderForm ?? module.default;
  function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return React.cloneElement(node, {}, expand(node.props.children));
  }
  const renderOnce = (side) => {
    index = 0; effects = []; h.queries = [];
    const tree = expand(screen({ assetId: h.asset.id, accountId: h.account.id, side, onReturnToAsset: () => {}, route: { params: { assetId: h.asset.id, accountId: h.account.id, side } }, navigation }));
    effects.forEach(fn => fn());
    return tree;
  };
  const find = (tree, testID) => elements(tree).find(node => node.props.testID === testID);
  h.render = (side = 'sell') => {
    let tree = renderOnce(side);
    const value = find(tree, 'order-type-select-value');
    if (h.method && value && value.props.children !== METHOD_LABEL[h.method]) {
      find(tree, `order-method-${h.method}`).props.onPress();
      // Components after the field mount new inputs now; their slots held
      // only first-render state, so they start again from their initial values.
      slots.length = h.methodSlotBoundary;
      tree = renderOnce(side);
    }
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
