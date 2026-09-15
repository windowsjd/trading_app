// Real screens, API mapper and installed query observers. Only native hosts,
// React hook scheduling, HTTP and account/auth context are replaced.
const { resolve } = require('node:path');
const React = require('react');
const { QueryClient, QueryObserver, InfiniteQueryObserver } = require('@tanstack/react-query');
const { load, elements } = require('./ledgerTestHarness.cjs');

function createRecordCacheHarness(total = 23) {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, staleTime: Infinity, gcTime: Infinity,
  } } });
  const h = { client, requests: [], options: [], observers: [], total, failure: null };
  const records = Array.from({ length: total }, (_, i) => ({
    seasonId: `season-${i}`, seasonName: `시즌 ${i}`, joinedAt: '2026-09-01T00:00:00Z',
    finalRank: i + 1, finalReturnRate: '0.1',
  }));
  const api = load(resolve(__dirname, '../src/features/record/api.ts'), {
    '../../services/api/client': { apiClient: { get: async (path) => {
      h.requests.push(path);
      if (h.failure) throw h.failure;
      const url = new URL(path, 'https://test.invalid');
      const limit = Number(url.searchParams.get('limit'));
      const offset = Number(url.searchParams.get('offset'));
      const seasons = records.slice(offset, offset + limit);
      return { data: { success: true, data: { seasons, pagination: {
        total, limit, offset, returned: seasons.length,
        nextOffset: offset + seasons.length < total ? offset + seasons.length : null,
      } } } };
    } } },
  });
  const observers = [];
  function observe(Observer, options) {
    h.options.push(options);
    const observer = new Observer(client, options);
    observers.push(observer);
    h.observers.push(observer);
    return observer.getOptimisticResult(client.defaultQueryOptions({
      ...options, _optimisticResults: 'optimistic',
    }));
  }
  const native = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'Pressable', 'FlatList'].map(n => [n, n]));
  native.StyleSheet = { create: s => s };
  const mocks = {
    react: { ...React, useMemo: fn => fn() },
    'react-native': native,
    '@tanstack/react-query': {
      useQuery: options => observe(QueryObserver, options),
      useInfiniteQuery: options => observe(InfiniteQueryObserver, options),
    },
    '../../features/record/api': api,
    '../../features/me/api': { getMe: async () => ({ id: 'user-a', nickname: '사용자 A', email: 'a@example.test' }) },
    '../../features/season/api': { getCurrentSeason: async () => null },
    '../../features/ranking/api': { getRankings: async () => ({}), getRankingTier: () => '-' },
    '../../features/auth/useLogout': { useLogout: () => () => {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({
      selectedAccount: { id: 'account-a', mode: 'general' }, isLoading: false,
    }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'EmptyState'].map(n => [
      '../../components/states/' + n, { default: n, __esModule: true },
    ])),
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
  };
  const screens = {
    my: load(resolve(__dirname, '../src/screens/my/MyScreen.tsx'), mocks).default,
    record: load(resolve(__dirname, '../src/screens/record/RecordSeasonListScreen.tsx'), mocks).default,
  };
  h.render = (screen) => {
    h.options = []; h.observers = [];
    return screens[screen]({ navigation: { navigate() {} } });
  };
  h.fetch = async (screen) => {
    h.render(screen);
    await Promise.all(h.options.filter(q => q.enabled !== false).map(q =>
      q.getNextPageParam ? client.fetchInfiniteQuery(q) : client.fetchQuery(q)));
    return h.render(screen);
  };
  h.close = () => { observers.forEach(o => o.destroy()); client.clear(); };
  return h;
}
module.exports = { createRecordCacheHarness, elements };
