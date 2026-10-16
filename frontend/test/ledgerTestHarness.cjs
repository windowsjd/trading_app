// Execute the real screen/API modules in Node. Only native hosts, hook
// scheduling, HTTP, account context and the query observer are replaced.
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const ts = require('typescript');
const React = require('react');

// Animation clocks are a native boundary. A screen mock without Animated (or
// Platform) gets a still clock: values never advance unless a test drives them.
class StillValue {
  constructor(value) { this.value = value; }
  setValue(value) { this.value = value; }
  stopAnimation() {}
  addListener() { return '0'; }
  removeListener() {}
  interpolate(config) { return { value: this, ...config }; }
}
const stillAnimated = { Value: StillValue, View: 'AnimatedView', timing: () => ({ start() {}, stop() {} }), spring: () => ({ start() {}, stop() {} }), loop: () => ({ start() {}, stop() {} }) };
const withNativeDefaults = (native) => native && (!native.Animated || !native.Platform)
  ? { Platform: { OS: 'android' }, ...native, Animated: native.Animated ?? stillAnimated }
  : native;

// Screens import app modules as '../../<dir>/<path>' and tests key their
// mocks that way; modules in nested folders (features/conditional/tpsl)
// reach the same modules through deeper relative paths. Only those nested
// modules are re-keyed: every other file keeps its own specifiers.
const SRC = resolve(__dirname, '../src') + '/';
function srcKey(file, name) {
  if (!name.startsWith('.') || !file.startsWith(SRC) || file.slice(SRC.length).split('/').length < 4) return name;
  const target = resolve(dirname(file), name);
  return target.startsWith(SRC) ? '../../' + target.slice(SRC.length) : name;
}

function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const localRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    const key = srcKey(file, name);
    if (key !== name && Object.hasOwn(mocks, key)) return mocks[key];
    if (name === 'react-native-svg') return { __esModule: true, default: 'Svg',
      ...Object.fromEntries(['Path', 'Circle', 'Rect', 'Defs', 'LinearGradient', 'Stop', 'G', 'Line', 'Polygon'].map(value => [value, value])) };
    // New guide hooks share the screen's account/transport boundaries. Resolve
    // those boundaries irrespective of the caller's relative import depth.
    for (const suffix of ['tradingAccount/TradingAccountContext', 'tradingAccount/api', 'quest/QuestGuideProvider']) {
      if (name.endsWith('/' + suffix) || (suffix === 'quest/QuestGuideProvider' && name === './QuestGuideProvider')) {
        const boundary = mocks['../../features/' + suffix];
        if (boundary) return boundary;
        if (suffix === 'quest/QuestGuideProvider') return { useQuestGuide: () => null };
      }
    }
    if (name.endsWith('/useLearningAccess') || name.endsWith('/useTradingGuideFacts')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (key.endsWith('/conditional/api') || (file.includes('/features/conditional/') && name === './api')) {
      return mocks['../../features/conditional/api'] ?? { getProtections: async id => ({ tradingAccountId: id, capabilities: { enabled: false, canCreateSpot: false, canCreateFutures: false, canUseSpotLimit: false, canCancel: true }, groups: [], pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } }) };
    }
    // Conditional BUY transport: screens that exercise it pass their own mock.
    if (key.endsWith('/conditional/conditionalBuyApi') || (file.includes('/features/conditional/') && name === './conditionalBuyApi')) {
      return mocks['../../features/conditional/conditionalBuyApi'] ?? {
        getConditionalBuyOrders: async id => ({ tradingAccountId: id, capabilities: { enabled: false, canCreate: false, canCancel: true, canUseLimit: false, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 20 }, conditionalOrders: [], pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } }),
        getConditionalBuyOrder: async () => { throw new Error('conditional detail not mocked'); },
        createConditionalBuyOrder: async () => { throw new Error('conditional create not mocked'); },
        cancelConditionalBuyOrder: async () => { throw new Error('conditional cancel not mocked'); },
      };
    }
    // SELL intent transport (conditions, stop-loss/take-profit): disabled and
    // empty unless a screen test passes its own mock.
    if (key.endsWith('/conditional/conditionalSellApi') || (file.includes('/features/conditional/') && name === './conditionalSellApi')) {
      return mocks['../../features/conditional/conditionalSellApi'] ?? {
        getConditionalSellOrders: async id => ({ tradingAccountId: id, capabilities: { enabled: false, condition: { enabled: false, canCreate: false, canUseLimit: false }, protection: { enabled: false, canCreate: false, canUseLimit: false }, canCancel: true, markets: ['KRX', 'CRYPTO_SPOT'], maxLivePerAccount: 30 }, conditionalOrders: [], pagination: { limit: 30, offset: 0, total: 0, returned: 0, nextOffset: null } }),
        getConditionalSellOrder: async () => { throw new Error('conditional sell detail not mocked'); },
        createConditionalSellOrder: async () => { throw new Error('conditional sell create not mocked'); },
        cancelConditionalSellOrder: async () => { throw new Error('conditional sell cancel not mocked'); },
      };
    }
    // 손절가/익절가 plans on pending entries: disabled and empty unless a
    // screen test passes its own mock.
    if (key.endsWith('/conditional/entryTpSlApi') || (file.includes('/features/conditional/') && name === './entryTpSlApi')) {
      return mocks['../../features/conditional/entryTpSlApi'] ?? {
        getEntryTpSlPlans: async (id, entry) => ({ tradingAccountId: id, capabilities: { spot: { enabled: false, canCreate: false }, futures: { enabled: false, canCreate: false }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 }, entry: null, plans: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null }, requested: entry }),
        getAccountEntryTpSlPlans: async id => ({ tradingAccountId: id, capabilities: { spot: { enabled: false, canCreate: false }, futures: { enabled: false, canCreate: false }, canCancel: true, maxPendingPerAccount: 30, maxPerEntry: 10 }, entry: null, plans: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } }),
        createEntryTpSlPlans: async () => { throw new Error('entry TP/SL create not mocked'); },
        cancelEntryTpSlPlan: async () => { throw new Error('entry TP/SL cancel not mocked'); },
      };
    }
    // Independent Futures 손절가/익절가 transport: disabled and empty by default.
    if (key.endsWith('/futures/tpSlApi') || (file.includes('/features/futures/') && name === './tpSlApi')) {
      return mocks['../../features/futures/tpSlApi'] ?? {
        getFuturesTpSlSettings: async id => ({ tradingAccountId: id, capabilities: { enabled: false, canCreate: false, canCancel: true, maxLivePerAccount: 30 }, settings: [], pagination: { limit: 100, offset: 0, total: 0, returned: 0, nextOffset: null } }),
        createFuturesTpSlSettings: async () => { throw new Error('futures TP/SL create not mocked'); },
        cancelFuturesTpSlSetting: async () => { throw new Error('futures TP/SL cancel not mocked'); },
      };
    }
    // Home reads the shared USD/KRW rate to order spot and futures together.
    // Screens that exercise FX mock this boundary themselves.
    if (key.endsWith('/features/wallet/api')) {
      return mocks['../../features/wallet/api'] ?? { getCurrentFxRate: async () => ({ state: 'available', baseCurrency: 'USD',
        quoteCurrency: 'KRW', rate: '1350', validUntil: new Date(Date.now() + 60_000).toISOString() }) };
    }
    // The ratio slider's native build needs gesture-handler; screen tests pass
    // its browser input. Shared sheets outside the order screen get the same.
    if (name.endsWith('/QuantityRatioSlider') && !file.includes('/src/screens/order/')) {
      return mocks['./QuantityRatioSlider'] ?? mocks['../order/QuantityRatioSlider']
        ?? load(resolve(__dirname, '../src/screens/order/QuantityRatioSlider.web.tsx'), {});
    }
    if (name.endsWith('.png')) return { uri: resolve(dirname(file), name) };
    if (name.endsWith('.json')) return require(resolve(dirname(file), name));
    // This presentation table imports PNGs, so use the same asset-aware loader
    // as TSX components instead of Node's native TypeScript require.
    if (name.endsWith('/tierBackgrounds')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (name.endsWith('/ProfileAvatar')) return { default: 'ProfileAvatar', __esModule: true };
    if (name.endsWith('/theme/native')) return withNativeDefaults(mocks['react-native']);
    if (name.endsWith('/theme/safeArea')) return mocks['react-native-safe-area-context'] ?? { SafeAreaView: 'SafeAreaView' };
    if (name.endsWith('/theme/useReducedMotion')) return { useReducedMotion: () => false };
    if (name.endsWith('/theme/appearance')) return { AppearanceProvider: ({ children }) => children, useAppearance: () => ({ preference: 'system', financialPreference: 'red_blue', financialColors: require('../src/theme/financialColors.ts').getFinancialColors('light'), mode: 'light', colors: { screen: '#fff', text: '#111', border: '#ddd' }, setPreference() {} }) };
    // Interaction animation is a native boundary here; its real component has
    // separate render tests. Keep screen/query/gesture tests focused on actions.
    if (name.endsWith('/ActionPressable')) return { default: 'Pressable', __esModule: true };
    if (name.endsWith('/hooks/usePullToRefresh')) return load(resolve(dirname(file), name + '.tsx'), mocks);
    if (name.endsWith('/hooks/useFocusedInputScroll')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (name.endsWith('/usePortfolioFocusRecovery')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (name.endsWith('/useFuturesHoldings')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (key === '../../features/futures/api' || (file.includes('/features/futures/') && name === './api')) {
      if (mocks['../../features/futures/api']) return mocks['../../features/futures/api'];
      if (mocks['../../services/api/client']) return load(resolve(dirname(file), name + '.ts'), mocks);
      // Spot screens still load the shared 손절가/익절가 sheet (and its Futures
      // part); without a transport mock nothing there may reach the network.
      return new Proxy({}, { get: (_, prop) => prop === '__esModule' ? true
        : async () => { throw new Error(`futures api ${String(prop)} not mocked`); } });
    }
    // The ranking tab's 순위 안내 hook shares the screen's ranking transport.
    if (name.endsWith('/useRankingInsights')) return load(resolve(dirname(file), name + '.ts'), mocks);
    if (file.includes('/features/ranking/') && name === './api') return mocks['../../features/ranking/api'] ?? load(resolve(dirname(file), 'api.ts'), mocks);
    if (name.startsWith('.')) {
      const tsx = resolve(dirname(file), name + '.tsx');
      if (existsSync(tsx)) return load(tsx, mocks);
      return require(resolve(dirname(file), name.endsWith('.ts') ? name : name + '.ts'));
    }
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

/** @param {{ data?: any, currencyCode?: string, mode?: string, source?: string }} options */
function createLedgerHarness({ data, currencyCode, mode = 'general', source } = {}) {
  const slots = [];
  let index = 0;
  const query = { data: data ? { pages: [data] } : undefined, isLoading: false, isFetching: false, isFetchingNextPage: false, isError: false, error: null, refetch: () => {}, fetchNextPage: () => {} };
  const account = { selectedAccountId: 'ta-1', selectedAccount: { mode }, isLoading: false, isEmpty: false };
  const api = load(resolve(__dirname, '../src/features/tradingAccount/api.ts'), {
    '../../services/api/client': { apiClient: { get: async (path, config) => {
      result.requests.push({ path, ...config });
      return { data: result.response };
    } } },
  });
  const result = { query, account, requests: [], response: { success: true, data }, options: null };
  const screen = load(source ?? resolve(__dirname, '../src/screens/home/WalletTransactionsScreen.tsx'), {
    react: { ...React, useRef: (value) => ({ current: value }), useEffect() {}, useMemo: (fn) => fn(), useState: (initial) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    } },
    'react-native': { RefreshControl: 'RefreshControl', View: 'View', Text: 'Text', SafeAreaView: 'SafeAreaView', FlatList: 'FlatList', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (styles) => styles } },
    '@tanstack/react-query': { useInfiniteQuery: (options) => { result.options = options; return query; } },
    '../../features/tradingAccount/api': api,
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => account },
    '../../features/tradingAccount/accountDisplay': { getAccountDisplay: () => ({ title: '선택 계정', statusLabel: '운영 중' }) },
    '../../components/tradingAccount/AccountSwitcher': { default: 'AccountSwitcher', __esModule: true },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'EmptyState'].map((name) => ['../../components/states/' + name, { default: name, __esModule: true }])),
  }).default;
  result.render = () => { index = 0; return screen({ route: { params: { currencyCode } } }); };
  return result;
}

function elements(node, type) {
  if (Array.isArray(node)) return node.flatMap((child) => elements(child, type));
  if (!React.isValidElement(node)) return [];
  return [...(!type || node.type === type ? [node] : []), ...elements(node.props.children, type)];
}

module.exports = { createLedgerHarness, elements, load };
