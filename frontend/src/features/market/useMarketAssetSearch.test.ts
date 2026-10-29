import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';
import type { GetAssetsParams } from './api.ts';

const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

const usStock = (symbol: string, name: string, market = 'NAS') => ({ id: `us-${symbol}`, assetType: 'us_stock', symbol, name, market });
// The server's US list (one sort), and what its English-name/symbol search answers.
const US_LIST = [usStock('NVDA', 'NVIDIA Corp.'), usStock('GOOGL', 'Alphabet Inc. Class A'), usStock('AAPL', 'Apple Inc.'),
  usStock('GOOG', 'Alphabet Inc. Class C'), usStock('JPM', 'JPMorgan Chase & Co.', 'NYS')];
const DOMESTIC = [{ id: 'kr-005930', assetType: 'domestic_stock', symbol: '005930', name: 'Samsung Electronics', market: 'KRX' }];

async function searchHarness(t: TestContext) {
  const h = interactionHarness('android');
  Object.assign(h.native, { SafeAreaView: 'SafeAreaView', TextInput: 'TextInput', KeyboardAvoidingView: 'KeyboardAvoidingView' });
  h.native.FlatList = (props: { ListHeaderComponent?: unknown; ListEmptyComponent?: unknown; data?: unknown[] }) =>
    React.createElement('FlatList', props, props.ListHeaderComponent, props.data?.length ? null : props.ListEmptyComponent);
  const requests: GetAssetsParams[] = [];
  // Test controls: failed US list reads, held search answers, and the server's sort.
  const control = { failUsList: 0, held: new Map<string, Promise<void>>() };
  const page = (assets: unknown[], params: GetAssetsParams) => ({
    assets, priceErrors: [], sortSnapshot: 'sort-1',
    pagination: { offset: params.offset ?? 0, limit: params.limit ?? 20, returned: assets.length, total: assets.length, nextOffset: null },
  });
  const marketApi = {
    getAssets: async (params: GetAssetsParams) => {
      requests.push(params);
      if (params.assetType === 'us_stock' && params.limit === 100 && control.failUsList > 0) {
        control.failUsList -= 1;
        throw Object.assign(new Error('Network Error'), { isAxiosError: true });
      }
      const held = params.search ? control.held.get(params.search) : undefined;
      if (held) await held;
      const pool = [...(params.assetType !== 'domestic_stock' && params.assetType !== 'crypto' ? US_LIST : []),
        ...(params.assetType === undefined || params.assetType === 'domestic_stock' ? DOMESTIC : [])];
      // The server's own sort: ascending is the reverse order here.
      const sorted = params.sortOrder === 'asc' ? [...pool].reverse() : pool;
      const needle = params.search?.toLowerCase();
      return page(needle ? sorted.filter((asset) => `${asset.symbol} ${asset.name}`.toLowerCase().includes(needle)) : sorted, params);
    },
  };
  const Screen = h.load('src/screens/market/MarketSearchScreen.tsx', {
    '@react-navigation/native': { useIsFocused: () => true },
    '@react-navigation/elements': { useHeaderHeight: () => 56 },
    '../../features/market/MarketSortControl': { __esModule: true, default: 'SortControl' },
    '../../features/market/MarketAssetRow': { __esModule: true, default: 'AssetRow' },
    '../../features/market/useMarketTickers': {
      useMarketTickers: () => ({ tickersByAssetId: new Map(), staleAssetIds: new Set(), showReconnectBanner: false }),
    },
    '../../constants/env': { buildWsUrl: () => undefined },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'EmptyState', 'AdminDiagnosticPanel']
      .map((name) => ['../../components/states/' + name, { __esModule: true, default: name }])),
    '../../features/market/api': marketApi,
    '../../features/market/useMarketAssetSearch': h.load('src/features/market/useMarketAssetSearch.ts', { './api': marketApi }),
  }).default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const renderer = h.render(React.createElement(QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} }, route: { params: {} } })));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); }); };
  const type = async (text: string) => {
    act(() => renderer.root.findByProps({ testID: 'market-search-input' }).props.onChangeText(text));
    await flush();
  };
  const ids = () => renderer.root.findAll((node: any) => node.type === 'FlatList')[0]?.props.data.map((item: { id: string }) => item.id) ?? [];
  const usListReads = () => requests.filter((params) => params.assetType === 'us_stock' && params.limit === 100);
  return { renderer, requests, type, ids, usListReads, flush, control, client };
}

it('a Korean name finds its US listing, which the server alone (English names, symbols) cannot', async (t) => {
  const s = await searchHarness(t);
  await s.type('애플');
  assert.deepEqual(s.ids(), ['us-AAPL']);
  // The server was still asked; the US list came once, whole, with prices, in the search's sort.
  const search = s.requests.find((params) => params.search === '애플');
  assert.deepEqual([search?.offset, search?.limit, search?.withPrice], [0, 20, true]);
  assert.equal(s.usListReads().length, 1);
  assert.deepEqual([s.usListReads()[0].withPrice, s.usListReads()[0].sortBy, s.usListReads()[0].offset], [true, 'turnover', 0]);
  // Every listing a name matches, in the list's own order.
  await s.type('알파벳');
  assert.deepEqual(s.ids(), ['us-GOOGL', 'us-GOOG']);
  assert.equal(s.usListReads().length, 1, 'later keystrokes reuse the same US list');
});

it('English names and symbols stay on the server search; no extra US list is read for them', async (t) => {
  const s = await searchHarness(t);
  for (const text of ['apple', 'AAPL', 'samsung']) await s.type(text);
  assert.deepEqual(s.ids(), ['kr-005930']);
  assert.equal(s.usListReads().length, 0);
  await s.type('apple');
  assert.deepEqual(s.ids(), ['us-AAPL']);
});

it('a scope without US stocks never matches Korean names of US listings', async (t) => {
  const s = await searchHarness(t);
  const chip = (label: string) => s.renderer.root.findAll((node: any) => node.type === 'Pressable'
    && node.findAll((child: any) => child.type === 'Text' && child.children.join('') === label).length > 0)[0];
  act(() => chip('국내').props.onPress());
  await s.type('애플');
  assert.deepEqual(s.ids(), []);
  assert.equal(s.usListReads().length, 0);
  act(() => chip('미국').props.onPress());
  await s.flush();
  assert.deepEqual(s.ids(), ['us-AAPL']);
});

it('pull to refresh reloads the US list with the rows', async (t) => {
  const s = await searchHarness(t);
  await s.type('엔비디아');
  assert.deepEqual(s.ids(), ['us-NVDA']);
  const list = s.renderer.root.findAll((node: any) => node.type === 'FlatList')[0];
  act(() => { void list.props.refreshControl.props.onRefresh(); });
  await s.flush();
  assert.equal(s.usListReads().length, 2);
  assert.equal(s.usListReads()[1].sortRefresh, true);
  assert.deepEqual(s.ids(), ['us-NVDA']);
});

it('a failed US list read fails only the Korean search, never silently empty; a retry reads it again', async (t) => {
  const s = await searchHarness(t);
  s.control.failUsList = 1;
  await s.type('애플');
  // The error is shown (with a retry), never an empty "no results" for 애플.
  assert.equal(s.renderer.root.findAll((node: any) => node.type === 'ErrorState').length, 1);
  act(() => { s.renderer.root.findAll((node: any) => node.type === 'ErrorState')[0].props.onRetry(); });
  await s.flush();
  assert.deepEqual(s.ids(), ['us-AAPL']);
  assert.equal(s.usListReads().length, 2, 'the retry read the list again');
  // English names and symbols never need the list, so they never fail with it.
  s.control.failUsList = 1;
  await s.type('nvidia');
  assert.deepEqual(s.ids(), ['us-NVDA']);
});

it('a slower answer for an earlier text never replaces the current results', async (t) => {
  const s = await searchHarness(t);
  let release!: () => void;
  s.control.held.set('애플', new Promise<void>((resolve) => { release = resolve; }));
  await s.type('애플');
  // Still loading: the results area says so and the search field stays (typing continues).
  const field = s.renderer.root.findAll((node: any) => node.props?.testID === 'market-search-input');
  assert.equal(field.length, 1);
  assert.equal(s.renderer.root.findAll((node: any) => node.props?.testID === 'market-search-loading').length, 1);
  await s.type('엔비디아');
  assert.deepEqual(s.ids(), ['us-NVDA']);
  release();
  await s.flush();
  assert.deepEqual(s.ids(), ['us-NVDA'], 'the late 애플 answer stays in its own cache entry');
  await s.type('애플');
  assert.deepEqual(s.ids(), ['us-AAPL']);
});

it('the US list is read once per sort and again only after 30 s', async (t) => {
  const s = await searchHarness(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await s.type('알파벳');
  assert.deepEqual(s.ids(), ['us-GOOGL', 'us-GOOG']);
  t.mock.timers.tick(29_000);
  await s.type('애플');
  assert.equal(s.usListReads().length, 1, 'fresh for 30 s');
  t.mock.timers.tick(2_000);
  await s.type('엔비디아');
  assert.equal(s.usListReads().length, 2, 'stale after 30 s: read again');
  // Another sort is another order: its own list, and the matches follow it.
  const control = s.renderer.root.findAll((node: any) => node.type === 'SortControl')[0];
  act(() => control.props.onChange('turnover_asc'));
  await s.flush();
  await s.type('알파벳');
  const reads = s.usListReads();
  assert.deepEqual([reads.length, reads.at(-1)?.sortOrder], [3, 'asc']);
  assert.deepEqual(s.ids(), ['us-GOOG', 'us-GOOGL'], 'the Korean matches follow the chosen sort');
});
