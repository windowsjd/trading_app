// Real React reconciliation + React Query mutations; deterministic market/account
// reads and HTTP responses. Scope changes unmount the actual shared order form.
const { resolve } = require('node:path');
const React = require('react');
const Decimal = require('decimal.js');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { load } = require('./ledgerTestHarness.cjs');
const {
  getTradingAccountCapabilities,
} = require('../src/features/tradingAccount/capabilities.ts');
const timeframes = require('../src/features/asset/chartTimeframes.ts');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
/** Server gates for new SELL intents: closed unless a test opens them. */
function defaultSellList(id) {
  return {
    tradingAccountId: id,
    capabilities: { enabled: false, condition: { enabled: false, canCreate: false, canUseLimit: false },
      protection: { enabled: false, canCreate: false, canUseLimit: false }, canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30 },
    conditionalOrders: [],
    pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null },
  };
}
function inlineTradingHarness() {
  const h = {
    assetId: 'bnb',
    dimensions: { width: 320, height: 700, fontScale: 1 },
    accountId: 'general',
    focused: true,
    connectionState: 'subscribed',
    role: 'user',
    priceErrors: [],
    requests: [],
    alerts: [],
    invalidations: [],
    queries: [],
    navigation: [],
    accounts: [
      { id: 'general', mode: 'general', status: 'active', season: null },
      {
        id: 'season',
        mode: 'season',
        status: 'active',
        season: {
          seasonId: 's1',
          seasonStatus: 'active',
          participantStatus: 'active',
          seasonName: '시즌',
          startAt: new Date(Date.now() - 86400000).toISOString(),
          endAt: new Date(Date.now() + 86400000).toISOString(),
        },
      },
    ],
    assets: {},
    positions: { general: '4', season: '1' },
    quoteGate: null,
    createGate: null,
    failure: null,
    ticker: null,
    candle: null,
    candleStale: false,
    resync: 0,
    refetches: 0,
    animations: [],
    marketRequests: [],
    keyboardDismissals: 0,
    // Nothing is preselected in the order form. Tests written for one order
    // form pick it through the real 주문방식 sheet right after each mount
    // (see h.mount); a test about the unselected form sets this to null.
    method: 'market',
    conditionalList: null,
    // SELL intents list (gates + live rows) and its create answers.
    sellList: null,
    orderCapabilities: null,
  };
  for (const [id, price, type] of [
    ['bnb', '763.79', 'crypto'],
    ['btc', '98765.1234', 'crypto'],
    ['samsung', '70000', 'domestic_stock'],
  ]) {
    h.assets[id] = {
      id,
      name: id === 'samsung' ? 'Samsung Electronics' : id.toUpperCase(),
      symbol: id === 'samsung' ? '005930' : `${id.toUpperCase()}USDT`,
      assetType: type,
      market: type === 'crypto' ? 'BINANCE' : 'KRX',
      priceCurrency: type === 'crypto' ? 'USD' : 'KRW',
      settlementCurrency: type === 'crypto' ? 'USD' : 'KRW',
      displayPriceDecimals: 4,
      marketStatus: type === 'crypto' ? 'always_open' : 'closed',
      isActive: true,
      tradable: type === 'crypto',
      price: {
        state: 'available',
        currentPrice: price,
        priceCurrency: type === 'crypto' ? 'USD' : 'KRW',
        priceKrwState: 'available',
        priceKrw: '1054259',
        changeRate: '0.33',
        priceCapturedAt: new Date().toISOString(),
      },
    };
  }
  const api = load(resolve('src/features/tradingAccount/api.ts'), {
    '../../services/api/client': {
      apiClient: {
        get: async (url, config) => {
          const id = url.split('/')[2];
          const { limit, offset } = config.params;
          if (url.endsWith('/orders')) {
            h.orderReads ??= [];
            h.orderReads.push({ id, ...config.params });
            if (h.orderGate?.[id]) await h.orderGate[id].promise;
            if (h.orderError) throw h.orderError;
            const orders = (h.orders?.[id] ?? []).filter((row) => !config.params.status || row.status === config.params.status);
            const page = orders.slice(offset, offset + limit);
            return { data: { success: true, data: { tradingAccountId: h.orderEnvelopeId ?? id, state: 'available', orders: page,
              pagination: { offset, limit, total: orders.length, returned: page.length, nextOffset: offset + limit < orders.length ? offset + limit : null } } } };
          }
          h.holdingsReads ??= [];
          h.holdingsReads.push({ id, offset, limit });
          const result = h.holdings?.[id] ?? [{
            ...h.assets[h.assetId], assetId: h.assetId, positionId: id + h.assetId,
            quantity: h.positions[id] ?? '0', averageCost: '700', currencyCode: 'USD',
            valuation: { state: 'unavailable' },
          }];
          if (h.holdingsGate?.[id]) await h.holdingsGate[id].promise;
          if (h.holdingsError) throw h.holdingsError;
          return { data: { success: true, data: {
            tradingAccountId: id, state: 'available', positions: result.slice(offset, offset + limit),
            pagination: { offset, limit, total: result.length, returned: result.slice(offset, offset + limit).length, nextOffset: offset + limit < result.length ? offset + limit : null },
          } } };
        },
        post: async (url, body) => {
          h.requests.push({ url, body });
          const isQuote = url.endsWith('/quote');
          if (isQuote && h.quoteGate) await h.quoteGate.promise;
          if (!isQuote && h.createGate) await h.createGate.promise;
          if (isQuote && h.quoteFailure) throw h.quoteFailure;
          if (!isQuote && h.failure) throw h.failure;
          if (!isQuote) h.onCreate?.(url, body);
          const asset = h.assets[body.assetId];
          const quantity = body.amount !== undefined
            ? new Decimal(body.amount).div(body.limitPrice ?? asset.price.currentPrice ?? '100')
              .toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6) : body.quantity;
          const data = isQuote
            ? {
                state: 'available',
                asset,
                side: body.side,
                quantity,
                ...(body.amount !== undefined ? { amount: body.amount } : {}),
                orderType: body.orderType ?? 'market',
                quoteId: `q-${h.requests.length}`,
                expiresAt: new Date(
                  Date.now() + (h.ttl ?? 60000),
                ).toISOString(),
                price: asset.price.currentPrice,
                currencyCode: asset.settlementCurrency,
                grossAmount: '100',
                feeAmount: '0.1',
                netAmount: '99.9',
                feeRate: '0.001',
                limitPrice: body.limitPrice,
                quotedGrossAmount: '100',
                quotedFeeAmount: '0.1',
                quotedNetAmount: '99.9',
                reservedQuantity: body.quantity,
              }
            : {
                order: {
                  ...body,
                  quantity,
                  asset,
                  currencyCode: asset.settlementCurrency,
                },
                execution: {
                  state: body.orderType === 'limit' ? 'submitted' : 'executed',
                },
              };
          return { data: { success: true, data: isQuote ? { ...data, ...h.quoteOverride } : { ...data, ...h.createOverride } } };
        },
      },
    },
  });
  h.client = new query.QueryClient({
    defaultOptions: { mutations: { retry: false, gcTime: Infinity }, queries: { retry: false, gcTime: Infinity } },
  });
  const invalidate = h.client.invalidateQueries.bind(h.client);
  h.client.invalidateQueries = async (options) => {
    h.invalidations.push(options.queryKey);
    return invalidate(options);
  };
  const native = {
    ...Object.fromEntries(
      [
        'View',
        'Text',
        'SafeAreaView',
        'ScrollView',
        'RefreshControl',
        'TextInput',
        'KeyboardAvoidingView',
        'Pressable',
      ].map((name) => [name, name]),
    ),
    Modal: 'Modal',
    ActivityIndicator: 'ActivityIndicator',
    // Recorded, never shown: e.g. the beginner learning guard's explanation.
    Alert: { alert: (...args) => { h.alerts.push(args); } },
    StyleSheet: { create: (value) => value, absoluteFillObject: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 } },
    Platform: { OS: 'android' },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss: () => { h.keyboardDismissals++; } },
    BackHandler: { addEventListener: (_event, handler) => { h.backHandler = handler; return { remove() { if (h.backHandler === handler) h.backHandler = null; } }; } },
    PanResponder: { create: (config) => { h.panConfig = config; return { panHandlers: {} }; } },
    Easing: { out: (fn) => fn, in: (fn) => fn, quad: (n) => n * n, cubic: (n) => n * n * n },
    // Motion is visual only here: every run lands on its target at once and
    // is recorded, so screen/order tests stay independent of a clock.
    Animated: {
      Value: class {
        constructor(value) { this.value = value; }
        setValue(value) { this.value = value; }
        interpolate(config) { return { value: this, ...config }; }
      },
      View: 'AnimatedView',
      add: (a, b) => ({ add: [a, b] }),
      // A loading loop never completes; it is recorded, not run.
      loop: () => ({ start: () => {}, stop: () => {} }),
      timing: (value, options) => ({
        start: (callback) => {
          value.setValue(options.toValue);
          h.animations.push(options);
          callback?.({ finished: true });
        },
        stop: () => {},
      }),
    },
    useWindowDimensions: () => h.dimensions,
  };
  native.ScrollView = ({ refreshControl, children, ...props }) => React.createElement('ScrollView', props, refreshControl, children);
  native.FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }) =>
    React.createElement('FlatList', props, ListHeaderComponent ?? null,
      data?.length
        ? data.map((item, index) => React.createElement(React.Fragment, { key: keyExtractor(item, index) }, renderItem({ item, index })))
        : ListEmptyComponent ?? null,
      ListFooterComponent ?? null);
  const nav = {
    navigate: (...args) => h.navigation.push(args),
    goBack: () => h.navigation.push(['back']),
    reset: (...args) => h.navigation.push(args),
    popTo: (...args) => h.navigation.push(['popTo', ...args]),
    // Native-stack setParams merges into the current route; h.update() renders it.
    setParams: (params) => {
      h.navigation.push(['setParams', params]);
      if (params.assetId !== undefined) h.assetId = params.assetId;
      if (params.side !== undefined) h.routeSide = params.side;
      if (params.accountId !== undefined) h.routeAccountId = params.accountId;
    },
  };
  const refetch = () => {
    h.refetches++;
  };
  const meApi = {
    getMe: async () => {
      if (h.meGate) await h.meGate.promise;
      if (h.meError) throw h.meError;
      return { role: h.role };
    },
  };
  const adminHook = load(resolve('src/features/auth/useAdminDiagnostics.ts'), {
    '../me/api': meApi,
  });
  const mocks = {
    '../../features/me/api': meApi,
    '../../features/futures/api': {
      getFuturesLimitOrders: async id => ({ tradingAccountId: id, orders: h.pendingEntries?.[id] ?? [] }),
      cancelFuturesLimitOrder: async (id, orderId) => { h.protectionRequests ??= []; h.protectionRequests.push({accountId:id,orderId}); },
    },
    '../../features/conditional/api': {
      createProtection: async (accountId, body) => { h.protectionRequests ??= []; h.protectionRequests.push({accountId,body}); },
      cancelProtection: async (accountId, groupId, key) => { h.protectionRequests ??= []; h.protectionRequests.push({accountId,groupId,key}); if(h.protectionGate) await h.protectionGate.promise; },
    },
    // Conditional BUY transport: records requests like the order client does.
    '../../features/conditional/conditionalBuyApi': {
      getConditionalBuyOrders: async (id) => h.conditionalList,
      getConditionalBuyOrder: async () => { throw new Error('conditional detail not used here'); },
      createConditionalBuyOrder: async (id, body) => {
        h.requests.push({ url: `/trading-accounts/${id}/conditional-buy-orders`, body });
        if (h.conditionalGate) await h.conditionalGate.promise;
        if (h.conditionalFailure) throw h.conditionalFailure;
        const asset = h.assets[body.assetId];
        // A test may answer as a replay of a watch that moved on (h.conditionalResult).
        return { tradingAccountId: id, duplicate: !!h.conditionalResult, conditionalOrder: {
          id: `cb-${h.requests.length}`, assetId: body.assetId, asset: { id: asset.id, symbol: asset.symbol, name: asset.name, market: asset.market, assetType: asset.assetType },
          side: 'buy', triggerCondition: body.triggerCondition, triggerPrice: body.triggerPrice, executionType: body.executionType,
          limitPrice: body.limitPrice ?? null, quantity: body.quantity ?? null, amount: body.amount ?? null, currencyCode: asset.settlementCurrency,
          status: 'watching', state: 'watching', trigger: null, order: null, attemptCount: 0, lastAttemptAt: null, failureCode: null,
          terminalReason: null, createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString(),
          ...h.conditionalResult,
        } };
      },
      cancelConditionalBuyOrder: async (id, conditionalOrderId) => {
        h.requests.push({ url: `/trading-accounts/${id}/conditional-buy-orders/${conditionalOrderId}/cancel` });
        return { tradingAccountId: id, duplicate: false, conditionalOrder: null };
      },
    },
    // SELL intent transport: records requests like the order client does.
    '../../features/conditional/conditionalSellApi': {
      getConditionalSellOrders: async (id) => h.sellList ?? defaultSellList(id),
      getConditionalSellOrder: async () => { throw new Error('conditional sell detail not used here'); },
      createConditionalSellOrder: async (id, body) => {
        h.requests.push({ url: `/trading-accounts/${id}/conditional-sell-orders`, body });
        if (h.sellGate) await h.sellGate.promise;
        if (h.sellFailure) throw h.sellFailure;
        const asset = h.assets[body.assetId];
        const legs = body.kind === 'condition'
          ? [['condition', body.triggerCondition, body]]
          : [['stop_loss', 'at_or_below', body.stopLoss], ['take_profit', 'at_or_above', body.takeProfit]].filter((leg) => leg[2]);
        return { tradingAccountId: id, duplicate: !!h.sellResult, conditionalOrders: legs.map(([kind, triggerCondition, leg], index) => ({
          id: `cs-${h.requests.length}-${index}`, assetId: body.assetId, asset: { id: asset.id, symbol: asset.symbol, name: asset.name, market: asset.market, assetType: asset.assetType },
          side: 'sell', kind, positionId: `${id}${body.assetId}`, triggerCondition, triggerPrice: leg.triggerPrice, executionType: leg.executionType,
          limitPrice: leg.limitPrice ?? null, quantity: leg.quantity, currencyCode: asset.settlementCurrency,
          status: 'watching', state: 'watching', position: null, executionAvailableQuantity: null, quantityLimited: false,
          trigger: null, order: null, attemptCount: 0, lastAttemptAt: null, failureCode: null, terminalReason: null,
          createdAt: new Date().toISOString(), endedAt: null, updatedAt: new Date().toISOString(), ...h.sellResult,
        })) };
      },
      cancelConditionalSellOrder: async (id, conditionalOrderId) => {
        h.requests.push({ url: `/trading-accounts/${id}/conditional-sell-orders/${conditionalOrderId}/cancel` });
        return { tradingAccountId: id, duplicate: false, conditionalOrder: null };
      },
    },
    './QuantityRatioSlider': load(resolve('src/screens/order/QuantityRatioSlider.web.tsx'), {}),
    react: React,
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 24, bottom: 34, left: 0, right: 0 }) },
    '@react-navigation/elements': { useHeaderHeight: () => 48 },
    'react-native-svg': { default: 'Svg', Path: 'Path', Rect: 'Rect', __esModule: true },
    '../../features/auth/useAdminDiagnostics': adminHook,
    '@react-navigation/native': { useIsFocused: () => h.focused },
    '../../theme/useReducedMotion': { useReducedMotion: () => h.reduced ?? false },
    '@tanstack/react-query': {
      ...query,
      useQuery: (options) => {
        h.queries.push(options);
        const [scope, resource, id] = options.queryKey;
        if (options.queryKey[3] === 'holdings' || resource === 'orders') return query.useQuery(options);
        if (resource === 'futures') return query.useQuery(options);
        const base = {
          isLoading: false,
          isPending: false,
          isError: false,
          refetch,
        };
        if (scope === 'asset' && resource !== 'detail' && h.candleFailure)
          return { ...base, isError: true, error: h.candleFailure, data: undefined };
        if (scope === 'asset')
          return {
            ...base,
            data:
              resource === 'detail'
                ? { asset: h.assets[id], priceErrors: h.priceErrors }
                : {
                    interval: options.queryKey[4],
                    candles: h.candlesByKey?.[`${id}:${options.queryKey[4]}`] ?? [
                      {
                        time: '2026-09-19T00:00:00Z',
                        open: '760',
                        high: '770',
                        low: '750',
                        close: '765',
                        volume: '100',
                      },
                    ],
                  },
          };
        // Server gates for new conditional / LOC orders: closed unless a test opens them.
        if (resource === 'conditionalBuyOrders') return { ...base, data: h.conditionalList ?? { tradingAccountId: id,
          capabilities: { enabled: false, canCreate: false, canCancel: true, canUseLimit: false, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 },
          conditionalOrders: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } } };
        if (resource === 'conditionalSellOrders') return { ...base, data: h.sellList ?? defaultSellList(id) };
        if (resource === 'orderCapabilities') return { ...base, data: h.orderCapabilities ?? { tradingAccountId: id,
          limitOrder: { enabled: true, autoExecutionEnabled: false }, limitOnClose: { enabled: false, markets: ['KRX'], sides: ['buy'], attachedProtection: false } } };
        if (resource === 'protections') return { ...base, data: h.protections ?? { tradingAccountId: id, capabilities: { enabled: false, canCreateSpot: false, canCreateFutures: false, canUseSpotLimit: false, canCancel: true }, groups: [], pagination: { total: 0, limit: 30, offset: 0, hasNext: false } } };
        if (resource === 'detail')
          return { ...base, data: { feePolicy: { tradeFeeRate: h.feeRate ?? '0.001' } } };
        if (resource === 'wallets')
          return {
            ...base,
            ...h.walletState,
            data: {
              wallets: [
                {
                  walletScope: 'crypto_spot',
                  currencyCode: 'USD',
                  balanceAmount: h.usdBalance ?? '10000',
                  reservedAmount: h.usdReserved ?? '1000',
                  availableAmount: h.usdAvailable,
                },
                { walletScope: 'securities', currencyCode: 'USD', balanceAmount: h.securitiesUsdBalance ?? h.usdBalance ?? '10000', reservedAmount: h.usdReserved ?? '1000', availableAmount: h.usdAvailable },
                { walletScope: 'securities', currencyCode: 'KRW', balanceAmount: h.krwBalance ?? '1000000' },
              ],
            },
          };
        if (resource === 'positions')
          return {
            ...base,
            ...h.positionState,
            data: {
              state: h.positionDataState ?? 'available',
              positions: [
                {
                  assetId: h.assetId,
                  quantity: h.positions[id] ?? '0',
                  // Server-reported reservation facts, when a test sets them.
                  ...(h.positionAvailable?.[id] !== undefined ? { availableQuantity: h.positionAvailable[id] } : {}),
                  ...(h.positionReserved?.[id] !== undefined ? { reservedQuantity: h.positionReserved[id] } : {}),
                  averageCost: '700',
                  currencyCode: 'USD',
                  valuation: { state: 'unavailable' },
                },
              ],
            },
          };
        if (resource === 'quests') {
          if (options.enabled !== false && !h.questProgress) throw new Error('Missing beginner quest fixture');
          return { ...base, data: h.questProgress };
        }
        throw new Error('Unexpected query ' + options.queryKey);
      },
    },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => {
        const selectedAccount = h.accounts.find((a) => a.id === h.accountId);
        return {
          accounts: h.accounts,
          selectedAccountId: h.accountId,
          selectedAccount,
          capabilities: selectedAccount
            ? getTradingAccountCapabilities(selectedAccount)
            : null,
          isLoading: false,
          isEmpty: !selectedAccount,
          ...h.accountState,
        };
      },
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => nav },
    '../../constants/env': {
      buildWsUrl: () => 'ws://test/api/v1/ws',
    },
    '../../features/asset/api': timeframes,
    '../../features/asset/useAssetTicker': {
      useAssetTicker: () => ({ latestTicker: h.ticker, connectionState: h.connectionState, isStale: h.tickerStale, showReconnectBanner: h.reconnect, runtime: { assetId: h.assetId, socketStatus: h.connectionState, tickerStale: h.tickerStale } }),
    },
    '../../features/asset/useAssetOrderBook': {
      useAssetOrderBook: (options) => {
        h.bookOptions = options;
        return {
          latestOrderBook: null,
          statusMessage: '호가 정보를 불러오는 중입니다.',
        };
      },
    },
    '../../features/asset/useAssetCandle': {
      useAssetCandle: (options) => {
        h.candleOptions = options;
        return {
          latestCandle: h.candle,
          isStale: h.candleStale,
          resyncVersion: h.resync, runtime: { assetId: h.assetId, candleStale: h.candleStale, staleReason: h.candleStale ? 'freshness_timeout' : null },
          liveEnabled: options.enabled,
        };
      },
    },
    '../../features/asset/useStaleRecheck': { useStaleRecheck: () => {} },
    '../../components/charts': { CandlestickChart: 'CandlestickChart' },
    '../../components/charts/ChartTimeframeSelector': {
      default: 'ChartTimeframeSelector',
      __esModule: true,
    },
    '../../components/common/CTAButton': {
      default: 'CTAButton',
      __esModule: true,
    },
    './OrderSuccessBottomSheet': {
      default: 'OrderSuccessBottomSheet',
      __esModule: true,
    },
    ...Object.fromEntries(
      [
        'FullPageLoading',
        'ErrorState',
        'InlineEmptyState',
        'SectionSkeleton',
      ].map((name) => [
        '../../components/states/' + name,
        { default: name, __esModule: true },
      ]),
    ),
  };
  mocks['../../components/states/AdminDiagnosticPanel'] = load(
    resolve('src/components/states/AdminDiagnosticPanel.tsx'),
    {
      'react-native': native,
      '../../features/me/api': meApi,
    },
  );
  mocks['./AdminDiagnosticPanel'] = mocks['../../components/states/AdminDiagnosticPanel'];
  // Order asset sheet: the real shared search hook over a fixture Assets API.
  const marketApi = {
    getAssets: async (params) => {
      h.marketRequests.push(params);
      const gate = h.marketGates?.[params.search ?? ''];
      if (gate) await gate.promise;
      if (h.marketFailure) throw h.marketFailure;
      const search = params.search?.toUpperCase();
      const rows = Object.values(h.assets).filter((asset) =>
        (!params.assetType || asset.assetType === params.assetType) &&
        (!search || asset.symbol.toUpperCase().includes(search) || asset.name.toUpperCase().includes(search)));
      const offset = params.offset ?? 0;
      const limit = params.limit ?? 20;
      const page = rows.slice(offset, offset + limit);
      return {
        assets: page.map((asset) => ({ ...asset, changeRate: asset.price.changeRate })),
        pagination: { offset, limit, total: rows.length, returned: page.length, nextOffset: offset + limit < rows.length ? offset + limit : null },
        priceErrors: [],
      };
    },
  };
  mocks['../../features/market/useMarketAssetSearch'] = load(resolve('src/features/market/useMarketAssetSearch.ts'), {
    './api': marketApi,
  });
  mocks['../../features/market/useMarketTickers'] = {
    useMarketTickers: (options) => {
      h.marketTickerOptions = options;
      return { tickersByAssetId: new Map(), staleAssetIds: new Set() };
    },
  };
  mocks['../order/OrderPanel'] = load(
    resolve('src/screens/order/OrderPanel.tsx'),
    mocks,
  );
  mocks['../../features/record/api'] = load(resolve('src/features/record/api.ts'), {
    '../../services/api/client': { apiClient: {} },
    './openOrder': require('../src/features/record/openOrder.ts'),
  });
  mocks['./PendingOrders'] = load(resolve('src/screens/asset/PendingOrders.tsx'), mocks);
  mocks['./AccountHoldings'] = load(resolve('src/screens/asset/AccountHoldings.tsx'), mocks);
  mocks['../../features/asset/AssetOrderLadder'] = load(
    resolve('src/features/asset/AssetOrderLadder.tsx'),
    mocks,
  );
  mocks['../asset/AccountHoldings'] = mocks['./AccountHoldings'];
  mocks['./OrderPanel'] = mocks['../order/OrderPanel'];
  h.OrderScreen = load(resolve('src/screens/order/OrderScreen.tsx'), mocks).default;
  const chartModule = load(resolve('src/screens/asset/AssetChartScreen.tsx'), mocks);
  h.Chart = chartModule.default;
  mocks['./AssetChartScreen'] = chartModule;
  h.Detail = load(resolve('src/screens/asset/AssetDetailScreen.tsx'), mocks).default;
  h.Screen = h.OrderScreen;
  const element = () =>
    React.createElement(
      query.QueryClientProvider,
      { client: h.client },
      React.createElement(h.Screen, {
        route: { params: { assetId: h.assetId, accountId: h.routeAccountId ?? h.accountId, side: h.routeSide ?? 'buy' } },
        navigation: nav,
      }),
    );
  h.mount = async () => {
    h.routeAccountId ??= h.accountId;
    await act(async () => {
      h.renderer = create(element());
    });
    if (h.method && h.node('order-type-select')) await h.selectOrderType(h.method);
  };
  h.update = async () =>
    act(async () => {
      h.renderer.update(element());
    });
  h.flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  h.close = async () => {
    await act(async () => h.renderer.unmount());
    h.client.clear();
  };
  h.node = (id) =>
    h.renderer.root.findAll(
      (node) => typeof node.type === 'string' && (node.props.testID ?? node.props['data-testid']) === id,
    )[0];
  h.press = async (id) => {
    const node = h.node(id);
    if (!node) throw new Error('Missing ' + id);
    await act(async () => node.props.onPress());
    // A side switch starts a fresh form with no method; pick h.method again
    // through the sheet, as the user has to.
    if ((id === 'asset-detail-buy-button' || id === 'asset-detail-sell-button') && h.method && h.node('order-type-select') && !h.orderMethodChosen())
      await h.selectOrderType(h.method);
  };
  h.orderMethodChosen = () => h.orderType() !== '주문방식 선택하기';
  // A replaced form (asset/account/session/return): no method and no draft.
  h.freshForm = () => h.orderType() === '주문방식 선택하기'
    && h.node('order-quantity-input') === undefined && h.node('order-limit-price-input') === undefined;
  h.input = async (id, value) =>
    act(async () => h.node(id).props.onChangeText(value));
  // 주문방식: the field opens the sheet, a row picks the method.
  h.selectOrderType = async (type) => {
    await h.press('order-type-select');
    await h.press(`order-method-${type}`);
  };
  h.orderType = () => {
    const value = h.node('order-type-select-value');
    return value ? [value.props.children].flat().join('') : null;
  };
  h.slide = async (percent) => act(async () =>
    h.node('order-quantity-slider').props.onChange({ currentTarget: { valueAsNumber: percent } }));
  h.success = () => h.renderer.root.findByType('OrderSuccessBottomSheet').props;
  return h;
}
module.exports = { inlineTradingHarness, deferred, act };
