const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
const { futuresFixture, futuresCandlesFixture, accounts } = require('./futuresFixtures.cjs');
const { deferred } = require('./walletTransferHarness.cjs');
const { conditionalFixture } = require('./conditionalFixtures.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function futuresHarness(options = {}) {
  const h = { accountId: options.accountId ?? 'A', routeAccountId: options.accountId ?? 'A', requests: [], reads: [], invalidations: [], navigation: [], orderBookRequests: [], alerts: [], options, session: 1,
    // Screen focus (another screen in front when false) and the signed-in role (admin diagnostics).
    focused: true, role: options.role ?? (options.diagnostics ? 'admin' : 'user'),
    // The full-screen chart route's params (`screen: 'chart'`).
    chart: { instrumentId: options.instrumentId ?? 'btc', symbol: 'BTCUSDT', displayPriceDecimals: 2 } };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = config => { h.invalidations.push(config?.queryKey ?? []); return invalidate(config); };
  const transport = { apiClient: {
      get: async (path, config) => {
        const id = path.split('/')[2]; h.reads.push(path);
        if (h.readGate) await h.readGate.promise;
        if (h.readFailure) throw h.readFailure;
        if (h.readFailures?.[path]) throw h.readFailures[path];
        // Contract chart (market data, not account-scoped): /futures/instruments/:id/candles
        if (path.startsWith('/futures/instruments/') && path.includes('/candles')) {
          const instrumentId = decodeURIComponent(path.split('/')[3]);
          const params = new URLSearchParams(path.split('?')[1] ?? '');
          const interval = params.get('interval') ?? '4h';
          h.candleReads ??= []; h.candleReads.push(instrumentId);
          // Which 봉 시간 each read asked for (instrument:interval:range:limit).
          h.candleWindows ??= []; h.candleWindows.push(`${instrumentId}:${interval}:${params.get('range')}:${params.get('limit')}`);
          if (h.candleGates?.[interval]) await h.candleGates[interval].promise;
          if (h.candleFailure) throw h.candleFailure;
          return { data: { success: true, data: h.futuresCandles?.(instrumentId, interval) ?? futuresCandlesFixture(instrumentId, Date.now(), interval) } };
        }
        const f = futuresFixture(h.wrongScope ?? id, h.options);
        // 손절가/익절가 plans on pending entries: closed unless a test opens them.
        if (path.includes('entry-tp-sl-plans')) {
          // One entry's plans (the sheet) or the account's open/ended plans (lists).
          const entryId = config?.params?.entryId;
          const all = h.entryTpSlPlans ?? [];
          const plans = entryId ? all.filter((plan) => plan.entryId === entryId || plan.childOrderId === entryId)
            : all.filter((plan) => (config?.params?.state === 'ended') === (plan.status !== 'pending'));
          return { data: { success: true, data: { tradingAccountId: h.wrongScope ?? id,
            capabilities: h.entryTpSlCapabilities ?? { spot: { enabled: false, canCreate: false }, futures: { enabled: false, canCreate: false }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 },
            entry: entryId ? h.entryTpSlEntry?.(entryId) ?? null : null, plans,
            pagination: { limit: 100, offset: 0, total: plans.length, returned: plans.length, nextOffset: null } } } };
        }
        // Independent position 손절가/익절가: capabilities + rows per state (open/ended).
        if (path.includes('tp-sl-settings')) {
          const state = config?.params?.state === 'ended' ? 'ended' : 'open';
          const settings = h.futuresTpSl?.[state] ?? [];
          return { data: { success: true, data: { tradingAccountId: h.wrongScope ?? id,
            capabilities: h.futuresTpSlCapabilities ?? { enabled: true, canCreate: true, canCancel: true, maxLivePerAccount: 30 }, settings,
            pagination: { limit: 100, offset: 0, total: settings.length, returned: settings.length, nextOffset: null } } } };
        }
        // Futures conditional entries: capabilities + rows per state (open/ended).
        if (path.includes('conditional-entries')) {
          const state = path.includes('state=ended') ? 'ended' : 'open';
          const entries = h.conditionalEntries?.[state] ?? [];
          return { data: { success: true, data: { tradingAccountId: h.wrongScope ?? id,
            capabilities: h.conditionalCapabilities ?? { enabled: true, canCreate: true, maxLivePerAccount: 20 }, entries,
            pagination: { limit: 100, offset: 0, total: entries.length, returned: entries.length, nextOffset: null } } } };
        }
        if (path.includes('limit-orders')) return { data: { data: { tradingAccountId: h.wrongScope ?? id, orders: h.pendingEntries ?? [], pagination: { limit: 100, offset: 0, total: h.pendingEntries?.length ?? 0, returned: h.pendingEntries?.length ?? 0, nextOffset: null } } } };
        const key = path.includes('instruments') ? 'catalog' : path.includes('positions') ? 'positions' : path.includes('executions') ? 'executions' : path.includes('liquidations') ? 'liquidations' : 'final';
        // Market list tests replace the catalog's contracts (24h statistics etc.).
        if (key === 'catalog' && h.catalogInstruments) return { data: { success: true, data: { ...f.catalog, instruments: h.catalogInstruments(f.catalog.instruments[0]) } } };
        return { data: { success: true, data: f[key] } };
      },
      post: async (path, body) => {
        h.requests.push({ path, body }); if (h.gate) await h.gate.promise;
        if (h.failure) throw h.failure;
        if (path.includes('conditional-entries')) return { data: { success: true, data: { tradingAccountId: path.split('/')[2], duplicate: false,
          entry: { id: 'entry', state: path.endsWith('/cancel') ? 'canceled' : 'watching', ...body } } } };
        if (path.includes('entry-tp-sl-plans')) {
          const accountId = path.split('/')[2];
          if (path.endsWith('/cancel')) return { data: { success: true, data: { tradingAccountId: accountId, duplicate: false,
            plan: { id: path.split('/')[4], status: 'canceled', terminalReason: 'user_canceled' } } } };
          const plan = (kind, leg) => ({ id: `plan-${kind}`, entryType: body.entryType, entryId: body.entryId, childOrderId: null, domain: 'futures',
            kind, triggerPrice: leg.triggerPrice, ratioPercent: leg.ratio, status: 'pending', triggerCondition: 'at_or_above' });
          return { data: { success: true, data: { tradingAccountId: accountId, duplicate: false, entry: h.entryTpSlEntry?.(body.entryId) ?? null,
            plans: [...(body.stopLoss ? [plan('stop_loss', body.stopLoss)] : []), ...(body.takeProfit ? [plan('take_profit', body.takeProfit)] : [])] } } };
        }
        if (path.includes('tp-sl-settings')) {
          const row = (kind, leg) => ({ id: `tp-sl-${kind}`, tradingAccountId: path.split('/')[2], positionId: body.positionId, kind,
            triggerPrice: leg.triggerPrice, quantity: leg.quantity, state: 'watching', status: 'watching' });
          return { data: { success: true, data: path.endsWith('/cancel')
            ? { tradingAccountId: path.split('/')[2], duplicate: false, setting: { id: path.split('/')[5], state: 'canceled', status: 'canceled' } }
            : { tradingAccountId: path.split('/')[2], duplicate: false,
              settings: [...(body.stopLoss ? [row('stop_loss', body.stopLoss)] : []), ...(body.takeProfit ? [row('take_profit', body.takeProfit)] : [])] } } };
        }
        return { data: { success: true, data: { tradingAccountId: path.split('/')[2], commandId: 'command', execution: { positionId: body.positionId ?? 'position', direction: body.direction ?? 'long', leverage: Number(body.leverage ?? 37), positionAfter: { quantity: body.operation === 'close' ? '0.00000000' : body.quantity ?? '1.00000000' }, operation: body.operation, feeAmount: '0.1' } } } };
      },
    } };
  const api = load(resolve(__dirname, '../src/features/futures/api.ts'), { '../../services/api/client': transport });
  const tpSlApi = load(resolve(__dirname, '../src/features/futures/tpSlApi.ts'), { '../../services/api/client': transport });
  const entryTpSlApi = load(resolve(__dirname, '../src/features/conditional/entryTpSlApi.ts'), { '../../services/api/client': transport });
  // Modal: the chart's 봉 시간 sheet (BottomSheetBackdrop) mounts one.
  const native = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'ScrollView', 'TextInput', 'KeyboardAvoidingView', 'Modal'].map(name => [name, name]));
  native.useWindowDimensions = () => options.dimensions ?? { width: 390, height: 844, fontScale: 1 };
  Object.assign(native, { Alert: { alert: (...args) => { h.alerts.push(args); } }, AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) }, Platform: { OS: 'web' }, StyleSheet: { create: value => value }, Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
    // Bottom sheets (주문방식, 선물 상품) mount these only while open.
    Pressable: 'Pressable', BackHandler: { addEventListener: () => ({ remove() {} }) } });
  const conditionalApi = load(resolve(__dirname, '../src/features/conditional/api.ts'), {
    '../../services/api/client': { apiClient: {
      get: async (path, config) => { const id = path.split('/')[2]; h.protectionReads ??= []; h.protectionReads.push({path,config}); return { data: { data: conditionalFixture(id, { domain:'futures', enabled: options.protectionEnabled === true, ...h.protectionOptions }) } }; },
      post: async (path, body) => { h.requests.push({path,body}); return {data:{data:{tradingAccountId:path.split('/')[2],groupId:'group',status:'active'}}}; },
    } },
  });
  const mocks = {
    'react-native': native,
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) },
    '../../components/states/AdminDiagnosticPanel': { default: () => null, __esModule: true },
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    '@react-navigation/native': { useIsFocused: () => h.focused }, '@react-navigation/elements': { useHeaderHeight: () => 64 },
    '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => h.role === 'admin' },
    '../../features/futures/api': api,
    '../../features/futures/tpSlApi': tpSlApi,
    '../../features/conditional/entryTpSlApi': entryTpSlApi,
    '../../features/conditional/api': conditionalApi,
    // 대기 주문 › 조건주문 also lists Spot watches; inert, account-scoped pages.
    '../../features/conditional/conditionalBuyApi': { getConditionalBuyOrders: async id => ({ tradingAccountId: id,
      capabilities: { enabled: true, canCreate: true, canCancel: true, canUseLimit: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 },
      conditionalOrders: [], pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } }) },
    '../../features/conditional/conditionalSellApi': { getConditionalSellOrders: async id => ({ tradingAccountId: id,
      capabilities: { enabled: true, condition: { enabled: true, canCreate: true, canUseLimit: true }, protection: { enabled: true, canCreate: true, canUseLimit: true }, canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 },
      conditionalOrders: [], pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } }) },
    '../../features/tradingAccount/api': { getTradingAccountOrders: async id => ({ tradingAccountId: id, orders: [], pagination: { offset: 0, limit: 100, total: 0, returned: 0, nextOffset: null } }),
      // A beginner selection (h.accountState) reads its learning permissions here.
      getBeginnerQuestProgress: async () => h.questProgress,
      // The account's trade fee policy (the futures ratio slider keeps room for the fee).
      getTradingAccount: async id => {
        h.accountReads = (h.accountReads ?? 0) + 1;
        if (h.feeFailure) throw h.feeFailure;
        return { id, tradingAccountId: id, mode: 'general', status: 'active', feePolicy: { tradeFeeRate: h.tradeFeeRate ?? '0.001000', fxFeeRate: '0.001000' } };
      } },
    // The ratio slider's browser input (the native one needs gesture-handler).
    '../order/QuantityRatioSlider': load(resolve(__dirname, '../src/screens/order/QuantityRatioSlider.web.tsx'), {}),
    '../../features/record/api': load(resolve(__dirname, '../src/features/record/api.ts'), { '../../services/api/client': { apiClient: {} }, './openOrder': require('../src/features/record/openOrder.ts') }),
    '../../features/futures/policy': load(resolve(__dirname, '../src/features/futures/policy.ts'), {}),
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts, selectedAccountId: h.accountId, isLoading: false, ...h.accountState }) },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.session, isCurrentSession: owner => owner === h.session },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    // The detail's won figure: the wallet's USD/KRW read (h.fxRate overrides).
    '../../features/wallet/api': { getCurrentFxRate: async () => {
      h.fxReads = (h.fxReads ?? 0) + 1;
      if (h.fxFailure) throw h.fxFailure;
      return h.fxRate ?? { state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW', rate: '1400.00000000',
        validUntil: new Date(Date.now() + 600_000).toISOString(), effectiveAt: new Date().toISOString() };
    } },
    '../../components/charts/CandlestickChart': { default: 'CandlestickChart', __esModule: true },
    // Contract ladder: screens observe the subscription request and render
    // whatever book state a test sets (no socket in unit tests).
    '../../constants/env': { buildWsUrl: () => 'wss://app.example/api/v1/ws' },
    '../../features/futures/useFuturesOrderBook': { useFuturesOrderBook: (request) => {
      h.orderBookRequests.push(request);
      return h.orderBookState ?? { latestOrderBook: null, statusMessage: '호가 정보를 불러오는 중입니다.' };
    } },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
    // The wallet's 이체 / 환전 panels inside the futures screen's sheet: their own
    // tests render them; here the sheet shows which one opened, with what.
    './WalletTransferSheet': { default: 'WalletTransferPanel', __esModule: true },
    './WalletFxSheet': { default: 'WalletFxPanel', __esModule: true },
  };
  if (options.diagnostics) {
    delete mocks['../../components/states/AdminDiagnosticPanel'];
    delete mocks['./AdminDiagnosticPanel'];
    delete mocks['../../components/states/ErrorState'];
    const me = { id: 'user-1', role: h.role };
    mocks['../../features/me/api'] = { getMe: async () => me };
    client.setQueryData(['me'], me);
  }
  const screenFile = { market: '../src/screens/market/FuturesMarketList.tsx', chart: '../src/screens/futures/FuturesChartScreen.tsx',
    detail: '../src/screens/futures/FuturesDetailScreen.tsx' }[options.screen] ?? '../src/screens/futures/FuturesScreen.tsx';
  const loaded = load(resolve(__dirname, screenFile), mocks);
  // MarketScreen's composition: the controls (header card), then the rows.
  const screen = options.screen === 'market' ? (props) => {
    const market = loaded.useFuturesMarket({ ...props, active: true });
    return React.createElement(React.Fragment, null,
      React.createElement(loaded.FuturesMarketControls, { market, sort: props.sort, onSortChange: props.onSortChange }),
      React.createElement(loaded.FuturesMarketRows, { market }));
  } : loaded.default;
  // The market list's sort/refresh are owned by MarketScreen; tests drive them.
  h.sort = 'turnover_desc'; h.refreshVersion = 0;
  // `options.routeDirection`: the detail's 매수하기 (long) / 매도하기 (short) request on the futures
  // screen (`options.direction` is the fixture position's own side).
  const params = () => options.screen === 'chart' ? { accountId: h.routeAccountId, ...h.chart }
    : options.screen === 'detail' ? { accountId: h.routeAccountId, instrumentId: options.instrumentId ?? 'btc' }
      : { accountId: h.routeAccountId, instrumentId: options.instrumentId, ...(options.routeDirection ? { direction: options.routeDirection } : {}) };
  // The detail's contract picker changes the route's instrument (setParams).
  const tree = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(screen, { route: { params: params() }, navigation: { navigate: (...args) => h.navigation.push(args), goBack: () => h.navigation.push(['goBack']),
    setParams: (next) => { h.navigation.push(['setParams', next]); if (next.instrumentId) options.instrumentId = next.instrumentId; } }, onSelect: (...args) => h.navigation.push(args),
    sort: h.sort, onSortChange: sort => { h.sort = sort; }, refreshVersion: h.refreshVersion }));
  h.flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); await h.flush(); };
  h.update = async () => { await act(async () => h.renderer.update(tree())); await h.flush(); };
  h.node = id => h.renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
  h.change = async (id, value) => { await act(async () => h.node(id).props.onChangeText(value)); };
  h.input = async (label, value) => { await act(async () => h.renderer.root.findAll(n => n.type === 'TextInput' && n.props.accessibilityLabel === label)[0].props.onChangeText(value)); };
  h.press = async id => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  h.choose = async label => { await act(async () => h.renderer.root.findAll(n => n.type === 'Pressable' && n.props.accessibilityLabel === label)[0].props.onPress()); await h.flush(); };
  // 주문방식 through the real field and sheet, as the user picks it.
  h.selectMethod = async method => { await h.press('order-type-select'); await h.press(`order-method-${method}`); };
  h.orderType = () => [h.node('order-type-select-value')?.props.children].flat().join('');
  // Another contract through the header's picker sheet.
  h.selectInstrument = async id => { await h.press('futures-instrument-select'); await h.press(`futures-instrument-${id}`); };
  // The positions / pending / history views under the trade card.
  h.view = async view => h.press(`futures-view-${view}`);
  // The USD order amount (a notional, never contracts).
  h.amount = async value => h.change('futures-amount', value);
  // Leverage through the field and its sheets: a preset row, else 직접 설정하기.
  h.setLeverage = async value => {
    await h.press('futures-leverage-select');
    if (h.node(`futures-leverage-option-${value}`)) { await h.press(`futures-leverage-option-${value}`); return; }
    await h.press('futures-leverage-custom');
    await h.change('futures-leverage-input', String(value));
    await h.press('futures-leverage-apply');
  };
  h.leverage = () => [h.node('futures-leverage-value')?.props.children].flat().join('');
  h.text = () => JSON.stringify(h.renderer.toJSON());
  h.api = api; h.client = client;
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}
module.exports = { futuresHarness, futuresCandlesFixture, deferred };
