// Real React reconciliation + React Query mutations; deterministic market/account
// reads and HTTP responses. Scope changes unmount the actual shared order form.
const { resolve } = require('node:path');
const React = require('react');
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
function inlineTradingHarness() {
  const h = {
    assetId: 'bnb',
    accountId: 'general',
    focused: true,
    role: 'user',
    requests: [],
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
          const data = isQuote
            ? {
                state: 'available',
                asset,
                side: body.side,
                quantity: body.quantity,
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
                  asset,
                  currencyCode: asset.settlementCurrency,
                },
                execution: {
                  state: body.orderType === 'limit' ? 'submitted' : 'executed',
                },
              };
          return { data: { success: true, data: isQuote ? { ...data, ...h.quoteOverride } : data } };
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
        'TextInput',
        'KeyboardAvoidingView',
        'Pressable',
      ].map((name) => [name, name]),
    ),
    StyleSheet: { create: (value) => value },
    Platform: { OS: 'android' },
    useWindowDimensions: () => ({ width: 320, height: 700, fontScale: 1 }),
  };
  const nav = {
    navigate: (...args) => h.navigation.push(args),
    goBack: () => h.navigation.push(['back']),
    reset: (...args) => h.navigation.push(args),
    popTo: (...args) => h.navigation.push(['popTo', ...args]),
  };
  const refetch = () => {
    h.refetches++;
  };
  const mocks = {
    react: React,
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    '@react-navigation/elements': { useHeaderHeight: () => 48 },
    'react-native-svg': { default: 'Svg', Path: 'Path', __esModule: true },
    '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => h.role === 'admin' },
    '@react-navigation/native': { useIsFocused: () => h.focused },
    '@tanstack/react-query': {
      ...query,
      useQuery: (options) => {
        h.queries.push(options);
        const [scope, resource, id] = options.queryKey;
        if (options.queryKey[3] === 'holdings') return query.useQuery(options);
        const base = {
          isLoading: false,
          isPending: false,
          isError: false,
          refetch,
        };
        if (scope === 'asset')
          return {
            ...base,
            data:
              resource === 'detail'
                ? { asset: h.assets[id] }
                : {
                    interval: options.queryKey[4],
                    candles: [
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
        if (resource === 'detail')
          return { ...base, data: { feePolicy: { tradeFeeRate: '0.001' } } };
        if (resource === 'wallets')
          return {
            ...base,
            ...h.walletState,
            data: {
              wallets: [
                {
                  currencyCode: 'USD',
                  balanceAmount: h.usdBalance ?? '10000',
                  reservedAmount: h.usdReserved ?? '1000',
                },
                { currencyCode: 'KRW', balanceAmount: h.krwBalance ?? '1000000' },
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
                  averageCost: '700',
                  currencyCode: 'USD',
                  valuation: { state: 'unavailable' },
                },
              ],
            },
          };
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
        };
      },
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => nav },
    '../../constants/env': {
      buildWsUrl: () => 'ws://test/api/v1/ws',
    },
    '../../features/asset/api': timeframes,
    '../../features/asset/useAssetTicker': {
      useAssetTicker: () => ({ latestTicker: h.ticker, isStale: h.tickerStale, showReconnectBanner: h.reconnect }),
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
          resyncVersion: h.resync,
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
        'AdminDiagnosticPanel',
      ].map((name) => [
        '../../components/states/' + name,
        { default: name, __esModule: true },
      ]),
    ),
  };
  mocks['../order/OrderPanel'] = load(
    resolve('src/screens/order/OrderPanel.tsx'),
    mocks,
  );
  mocks['./AccountHoldings'] = load(resolve('src/screens/asset/AccountHoldings.tsx'), mocks);
  mocks['../../features/asset/AssetOrderLadder'] = load(
    resolve('src/features/asset/AssetOrderLadder.tsx'),
    mocks,
  );
  h.Detail = load(
    resolve('src/screens/asset/AssetDetailScreen.tsx'),
    mocks,
  ).default;
  h.Chart = load(
    resolve('src/screens/asset/AssetChartScreen.tsx'),
    mocks,
  ).default;
  h.Screen = h.Detail;
  const element = () =>
    React.createElement(
      query.QueryClientProvider,
      { client: h.client },
      React.createElement(h.Screen, {
        route: { params: { assetId: h.assetId } },
        navigation: nav,
      }),
    );
  h.mount = async () =>
    act(async () => {
      h.renderer = create(element());
    });
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
      (node) => typeof node.type === 'string' && node.props.testID === id,
    )[0];
  h.press = async (id) => {
    const node = h.node(id);
    if (!node) throw new Error('Missing ' + id);
    await act(async () => node.props.onPress());
  };
  h.input = async (id, value) =>
    act(async () => h.node(id).props.onChangeText(value));
  h.success = () => h.renderer.root.findByType('OrderSuccessBottomSheet').props;
  return h;
}
module.exports = { inlineTradingHarness, deferred, act };
