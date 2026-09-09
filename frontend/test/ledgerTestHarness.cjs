// Execute the real screen/API modules in Node. Only native hosts, hook
// scheduling, HTTP, account context and the query observer are replaced.
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const ts = require('typescript');
const React = require('react');

function load(file, mocks) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const localRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name.startsWith('.')) return require(resolve(dirname(file), name.endsWith('.ts') ? name : name + '.ts'));
    return require(name);
  };
  new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
  return module.exports;
}

function createLedgerHarness({ data, currencyCode, mode = 'general', source } = {}) {
  const slots = [];
  let index = 0;
  const query = { data: data ? { pages: [data] } : undefined, isLoading: false, isError: false, error: null, refetch: () => {}, fetchNextPage: () => {} };
  const account = { selectedAccountId: 'ta-1', selectedAccount: { mode }, isLoading: false, isEmpty: false };
  const api = load(resolve(__dirname, '../src/features/tradingAccount/api.ts'), {
    '../../services/api/client': { apiClient: { get: async (path, config) => {
      result.requests.push({ path, ...config });
      return { data: result.response };
    } } },
  });
  const result = { query, account, requests: [], response: { success: true, data }, options: null };
  const screen = load(source ?? resolve(__dirname, '../src/screens/home/WalletTransactionsScreen.tsx'), {
    react: { ...React, useMemo: (fn) => fn(), useState: (initial) => {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (next) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next; }];
    } },
    'react-native': { View: 'View', Text: 'Text', SafeAreaView: 'SafeAreaView', FlatList: 'FlatList', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (styles) => styles } },
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

module.exports = { createLedgerHarness, elements };
