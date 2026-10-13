import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { MarketAssetItemDto } from '../../features/market/api';
import type { WatchlistItemDto } from '../../features/watchlist/api';

const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

type Node = { type: unknown; props: Record<string, any>; findAll: (predicate: (node: Node) => boolean) => Node[] };
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

const row = (id: string, assetType: MarketAssetItemDto['assetType'] = 'domestic_stock'): MarketAssetItemDto => ({
  id, assetType, symbol: id.toUpperCase(), name: `종목 ${id}`, market: assetType === 'us_stock' ? 'NASDAQ' : 'KRX',
  priceCurrency: 'KRW', settlementCurrency: 'KRW', isActive: true, marketStatus: 'open', tradable: true,
  price: { state: 'available', currentPrice: '1000', priceCurrency: 'KRW', changeRate: '0.5' },
});
const watchItem = (asset: MarketAssetItemDto): WatchlistItemDto => ({
  assetId: asset.id, symbol: asset.symbol, name: asset.name, market: asset.market,
  assetType: asset.assetType, isActive: true, addedAt: '2026-10-13T01:00:00.000Z',
});
const firstPage = Array.from({ length: 20 }, (_, index) => row(`kr-${index + 1}`));
const beyondFirstPage = row('kr-99');

/** Market + search screens over one QueryClient with the real watchlist hook,
 * rows and stars; only HTTP and native hosts are fakes. */
function setup({ listFails = false } = {}) {
  const h = interactionHarness();
  h.native.SafeAreaView = 'SafeAreaView';
  h.native.TextInput = 'TextInput';
  h.native.FlatList = (props: any) => React.createElement('FlatList', props, props.ListHeaderComponent,
    props.data.length
      ? props.data.map((item: MarketAssetItemDto) => React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item })))
      : props.ListEmptyComponent);
  const server = { watched: [] as WatchlistItemDto[], listFails };
  const changes: Array<{ method: string; assetId: string } & Pending> = [];
  const viewReads: Array<{ assetType: string } & Pending> = [];
  const navigation = { calls: [] as string[], navigate(route: string, params?: { assetId?: string }) { navigation.calls.push(`${route}:${params?.assetId ?? ''}`); }, setParams() {}, popTo() {} };
  const marketApi = {
    getAssets: async (params: { search?: string; assetType?: string }) => ({
      assets: params.search ? [firstPage[0], beyondFirstPage] : params.assetType === 'domestic_stock' ? firstPage : [],
      priceErrors: [],
      pagination: { offset: 0, limit: 20, returned: 20, total: 20, nextOffset: null },
    }),
  };
  const deferred = (record: object) => new Promise((resolve, reject) => Object.assign(record, { resolve, reject }));
  const watchlist = h.load('src/features/watchlist/useWatchlist.tsx', {
    'react-native': { ...h.native, Alert: { alert() {} }, AppState: { addEventListener: () => ({ remove() {} }) } },
    '../me/api': { getMe: async () => ({ id: 'user-a' }) },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => 1 },
    './api': {
      getWatchlist: async () => {
        if (server.listFails) throw Object.assign(new Error('down'), { response: { status: 503 } });
        return { items: server.watched, limit: 50 };
      },
      getWatchlistAssets: (assetType: string) => { const record = { assetType }; viewReads.push(record as never); return deferred(record); },
      addToWatchlist: (assetId: string) => { const record = { method: 'PUT', assetId }; changes.push(record as never); return deferred(record); },
      removeFromWatchlist: (assetId: string) => { const record = { method: 'DELETE', assetId }; changes.push(record as never); return deferred(record); },
    },
  });
  const stub = (name: string) => ({ __esModule: true, default: name });
  const shared = {
    './FuturesMarketList': stub('FuturesMarketList'),
    '../../features/market/MarketSortControl': stub('SortControl'),
    '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => false },
    '../../features/market/useMarketTickers': { useMarketTickers: () => ({ tickersByAssetId: new Map(), staleAssetIds: new Set(), subscriptionErrorAssetIds: new Set() }) },
    '../../constants/env': { buildWsUrl: () => undefined },
    ...Object.fromEntries(['FullPageLoading', 'ErrorState', 'EmptyState', 'AdminDiagnosticPanel', 'ErrorNotice', 'WhaleLoader']
      .map((name) => ['../../components/states/' + name, stub(name)])),
    '../../features/market/api': marketApi,
    '../../features/market/useMarketAssetSearch': h.load('src/features/market/useMarketAssetSearch.ts', { './api': marketApi }),
    '../../features/watchlist/useWatchlist': watchlist,
  };
  const Market = h.load('src/screens/market/MarketScreen.tsx', shared).default;
  const Search = h.load('src/screens/market/MarketSearchScreen.tsx', shared).default;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const renderer = h.render(React.createElement(QueryClientProvider, { client },
    React.createElement(h.native.View, { testID: 'market-host' }, React.createElement(Market, { navigation, route: { params: {} } })),
    React.createElement(h.native.View, { testID: 'search-host' }, React.createElement(Search, { navigation, route: { params: {} } }))));
  const flush = async () => {
    for (let tick = 0; tick < 6; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const host = (testID: string) => (renderer.root.findAll((node: Node) => node.props.testID === testID)[0] as Node);
  const hosts = (screen: string, predicate: (node: Node) => boolean) =>
    host(`${screen}-host`).findAll((node: Node) => typeof node.type === 'string' && predicate(node));
  const one = (screen: string, testID: string) => hosts(screen, (node) => node.props.testID === testID)[0];
  return {
    server, changes, viewReads, navigation, flush, hosts, one,
    star: (screen: string, assetId: string) => one(screen, `market-watch-${assetId}`),
    exists: (screen: string, testID: string) => hosts(screen, (node) => node.props.testID === testID).length > 0,
    listIds: (screen: string) => (hosts(screen, (node) => node.type === 'FlatList')[0].props.data as MarketAssetItemDto[]).map((item) => item.id),
    press: async (node: Node) => { act(() => node.props.onPress()); await flush(); },
    answer: async (index: number, result: unknown, apply?: () => void) => { apply?.(); changes[index].resolve(result); await flush(); },
    answerView: async (index: number, assets: MarketAssetItemDto[] | Error) => {
      if (assets instanceof Error) viewReads[index].reject(assets);
      else viewReads[index].resolve({ state: 'available', assets, priceErrors: [] });
      await flush();
    },
    search: async (text: string) => { act(() => one('search', 'market-search-input').props.onChangeText(text)); await flush(); },
    done: () => { act(() => renderer.unmount()); client.clear(); },
  };
}

describe('Market watchlist stars and view', () => {
  it('adds and removes from the market list and search results with one shared state', async () => {
    const t = setup();
    try {
      await t.flush();
      await t.search('KR');
      const asset = firstPage[0];
      assert.equal(t.star('market', asset.id).props.accessibilityLabel, `${asset.name} 관심종목에 추가`);
      assert.equal(t.star('search', asset.id).props.accessibilityState.selected, false);

      await t.press(t.star('market', asset.id));
      assert.equal(t.changes.length, 1);
      assert.equal(`${t.changes[0].method}:${t.changes[0].assetId}`, `PUT:${asset.id}`);
      for (const screen of ['market', 'search']) {
        assert.equal(t.star(screen, asset.id).props.accessibilityState.selected, true, `${screen} shows the target`);
        assert.equal(t.star(screen, asset.id).props.accessibilityState.busy, true, `${screen} shows it as pending`);
        assert.equal(t.star(screen, asset.id).props.disabled, true, `${screen} blocks a second request`);
      }
      await t.answer(0, { item: watchItem(asset), created: true }, () => { t.server.watched = [watchItem(asset)]; });
      for (const screen of ['market', 'search']) {
        assert.equal(t.star(screen, asset.id).props.accessibilityState.selected, true);
        assert.equal(t.star(screen, asset.id).props.accessibilityState.busy, false);
        assert.equal(t.star(screen, asset.id).props.accessibilityLabel, `${asset.name} 관심종목에서 해제`);
      }

      await t.press(t.star('search', asset.id));
      assert.equal(`${t.changes[1].method}:${t.changes[1].assetId}`, `DELETE:${asset.id}`);
      await t.answer(1, { assetId: asset.id, removed: true }, () => { t.server.watched = []; });
      assert.equal(t.star('market', asset.id).props.accessibilityState.selected, false);
      assert.equal(t.star('search', asset.id).props.accessibilityState.selected, false);

      assert.equal(t.navigation.calls.length, 0, 'a star press never opens the detail');
      await t.press(t.one('market', `market-item-${asset.id}`));
      assert.deepEqual(t.navigation.calls, [`AssetDetail:${asset.id}`]);
    } finally { t.done(); }
  });

  it("shows the server's watched rows of the selected market, beyond the first page, in watchlist order", async () => {
    const t = setup();
    try {
      t.server.watched = [watchItem(beyondFirstPage), watchItem(firstPage[3])];
      await t.flush();
      assert.equal(t.listIds('market').includes(beyondFirstPage.id), false);
      assert.equal(t.exists('market', 'market-scope'), true);
      await t.press(t.one('market', 'market-scope-watchlist'));
      assert.equal(t.viewReads.length, 1);
      assert.equal(t.viewReads[0].assetType, 'domestic_stock');
      assert.equal(t.exists('market', 'watchlist-loading'), true, 'loading is its own state');
      assert.equal(t.hosts('market', (node) => node.type === 'EmptyState').length, 0);

      await t.answerView(0, [beyondFirstPage, firstPage[3]]);
      assert.deepEqual(t.listIds('market'), [beyondFirstPage.id, firstPage[3].id]);
      assert.equal(t.star('market', beyondFirstPage.id).props.accessibilityState.selected, true);
      assert.equal(t.hosts('market', (node) => node.type === 'SortControl').length, 0, 'watchlist order is fixed');
      await t.press(t.one('market', `market-item-${beyondFirstPage.id}`));
      assert.deepEqual(t.navigation.calls, [`AssetDetail:${beyondFirstPage.id}`]);

      await t.press(t.one('market', 'market-tab-us'));
      assert.equal(t.viewReads[1].assetType, 'us_stock');
      await t.answerView(1, []);
      const empty = t.hosts('market', (node) => node.type === 'EmptyState');
      assert.equal(empty.length, 1);
      assert.equal(empty[0].props.title, '미국 주식 관심종목이 없습니다.');

      await t.press(t.one('market', 'market-scope-all'));
      assert.equal(t.hosts('market', (node) => node.type === 'SortControl').length, 1);
    } finally { t.done(); }
  });

  it('tells a failed watchlist read apart from an empty one', async () => {
    const t = setup();
    try {
      await t.flush();
      await t.press(t.one('market', 'market-scope-watchlist'));
      await t.answerView(0, Object.assign(new Error('down'), { response: { status: 503 } }));
      assert.equal(t.exists('market', 'watchlist-error'), true);
      assert.equal(t.hosts('market', (node) => node.type === 'EmptyState').length, 0, 'an error is not an empty list');
      assert.equal(t.exists('market', 'watchlist-loading'), false);
    } finally { t.done(); }
  });

  it('disables the stars and offers a retry when the membership list cannot be read', async () => {
    const t = setup({ listFails: true });
    try {
      await t.flush();
      const star = t.star('market', firstPage[0].id);
      assert.equal(star.props.disabled, true);
      assert.equal(star.props.accessibilityState.selected, false);
      assert.equal(star.props.accessibilityLabel, `${firstPage[0].name} 관심종목 상태 확인 중`);
      assert.equal(t.exists('market', 'watchlist-status-error'), true);
      t.server.listFails = false;
      t.server.watched = [watchItem(firstPage[0])];
      const retry = t.one('market', 'watchlist-status-error')
        .findAll((node: Node) => typeof node.type === 'string' && node.props.accessibilityRole === 'button')[0];
      await t.press(retry);
      assert.equal(t.star('market', firstPage[0].id).props.accessibilityState.selected, true);
      assert.equal(t.exists('market', 'watchlist-status-error'), false);
    } finally { t.done(); }
  });

  it('keeps the Spot watchlist out of the Futures market', async () => {
    const t = setup();
    try {
      await t.flush();
      await t.press(t.one('market', 'market-scope-watchlist'));
      await t.press(t.one('market', 'market-tab-crypto'));
      await t.press(t.one('market', 'crypto-product-futures'));
      assert.equal(t.exists('market', 'market-scope'), false);
      assert.equal(t.hosts('market', (node) => node.type === 'FuturesMarketList').length, 1);
      assert.equal(t.hosts('market', (node) => String(node.props.testID ?? '').startsWith('market-watch-')).length, 0);
      assert.equal(t.viewReads.some((read) => read.assetType !== 'domestic_stock' && read.assetType !== 'crypto'), false);
    } finally { t.done(); }
  });
});

describe('MarketAssetRow star', () => {
  it('renders no star without a watch handler and a separate 44dp target with one', () => {
    const h = interactionHarness();
    const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
      '../../components/states/AdminDiagnosticPanel': { __esModule: true, default: () => null },
    });
    const changes: string[] = [];
    const opened: string[] = [];
    const render = (props: object) => h.render(React.createElement(MarketAssetRow, { item: row('kr-1'), onPress: (id: string) => opened.push(id), ...props }));
    const plain = render({});
    assert.equal(plain.root.findAll((node: Node) => node.props.testID === 'market-watch-kr-1').length, 0);
    act(() => plain.unmount());

    const starred = render({ watched: false, onWatchChange: (id: string, watched: boolean) => changes.push(`${id}:${watched}`) });
    const star = starred.root.findAll((node: Node) => typeof node.type === 'string' && node.props.testID === 'market-watch-kr-1')[0];
    const style = h.native.StyleSheet.flatten(star.props.style);
    assert.equal(style.minWidth >= 44 && style.minHeight >= 44, true);
    act(() => star.props.onPress());
    assert.deepEqual(changes, ['kr-1:true']);
    assert.deepEqual(opened, []);
    act(() => starred.root.findAll((node: Node) => typeof node.type === 'string' && node.props.testID === 'market-item-kr-1')[0].props.onPress());
    assert.deepEqual(opened, ['kr-1']);
    assert.deepEqual(changes, ['kr-1:true']);
    act(() => starred.unmount());
  });

  it('re-renders a row only when its own watch state changes', () => {
    const h = interactionHarness();
    const { MarketAssetRow } = h.load('src/features/market/MarketAssetRow.tsx', {
      '../../components/states/AdminDiagnosticPanel': { __esModule: true, default: () => null },
    });
    const onWatchChange = () => {};
    const props = { item: row('kr-1'), onPress: () => {}, onWatchChange, watched: false, watchPending: false };
    assert.equal(MarketAssetRow.compare(props, { ...props }), true);
    assert.equal(MarketAssetRow.compare(props, { ...props, watched: true }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, watched: null }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, watchPending: true }), false);
    assert.equal(MarketAssetRow.compare(props, { ...props, onWatchChange: () => {} }), false);
  });
});
