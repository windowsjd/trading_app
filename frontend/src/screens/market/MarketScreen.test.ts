import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';

function read(sourcePath: string) {
  return readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
}

const marketScreen = read('screens/market/MarketScreen.tsx');
const marketSearch = read('screens/market/MarketSearchScreen.tsx');
const marketApi = read('features/market/api.ts');
const marketRow = read('features/market/MarketAssetRow.tsx');
const viewStates = read('models/enums/viewState.ts');

describe('MarketScreen partial-price warning policy', () => {
  it('keeps API price errors without rendering the main-market warning', () => {
    assert.match(marketApi, /priceErrors\?: AssetPriceErrorDto\[\]/u);
    assert.doesNotMatch(marketScreen, /hasPriceErrors/u);
    assert.doesNotMatch(marketScreen, /market_partial_price_unavailable/u);
    assert.doesNotMatch(
      marketScreen,
      /일부 종목 시세를 아직 불러오지 못했습니다\./u,
    );
    assert.doesNotMatch(viewStates, /market_partial_price_unavailable/u);
  });

  it('continues to render every API item through the existing price policy', () => {
    assert.match(marketScreen, /data=\{futuresMarket \? \[\] : items\}/u);
    assert.match(marketScreen, /renderItem=\{\(\{ item \}\) =>/u);
    assert.match(marketScreen, /<MarketAssetRow/u);
    assert.match(marketRow, /getAssetPriceText\(displayItem\)/u);
  });

  it('keeps the realtime reconnect warning', () => {
    assert.match(marketScreen, /\{isAdmin && showReconnectBanner \? \(/u);
    assert.match(
      marketScreen,
      /실시간 연결이 불안정합니다\. 마지막 수신 가격을 표시하고\s+있습니다\./u,
    );
    assert.match(marketScreen, /style=\{styles\.inlineWarning\}/u);
  });

  it('keeps normal pagination and does not add an account-mode warning branch', () => {
    assert.match(marketScreen, /marketQuery\.hasNextPage/u);
    assert.match(marketScreen, /marketQuery\.fetchNextPage\(\)/u);
    assert.doesNotMatch(marketScreen, /selectedAccount\?\.mode\s*===/u);
  });

  it('leaves the separate search-result warning unchanged', () => {
    assert.match(
      marketSearch,
      /일부 검색 결과의 시세를 아직 불러오지 못했습니다\./u,
    );
  });
});

it('uses the shared socket for market and search session transitions without per-client REST polling', () => {
  assert.match(marketScreen, /useMarketTickers/u);
  assert.match(marketSearch, /useMarketTickers/u);
  const detailChart = read('screens/asset/AssetChartScreen.tsx');
  assert.match(detailChart, /applyTickerMarketState/u);
  assert.match(detailChart, /latestTicker: ticker/u);
  // A member is never polled here: the only re-read is guest browsing's (no
  // socket), and guestRefetchInterval is false for members (guestBrowsing.test).
  for (const source of [marketScreen, marketSearch, detailChart]) {
    const polls = source.match(/refetchInterval\b[^\n]*/gu) ?? [];
    assert.equal(polls.length > 0, true);
    for (const poll of polls) assert.match(poll, /^refetchInterval: guestRefetchInterval\(/u, poll);
  }
});

describe('MarketScreen market switching', () => {
  const require = createRequire(import.meta.url);
  const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
  const row = (assetType: string, id: string) => ({ id, assetType });
  const ready = (assetType: string) => ({ data: { pages: [{ assets: [row(assetType, `${assetType}-1`), row(assetType, `${assetType}-2`)] }] }, isLoading: false, isError: false });

  function marketHarness() {
    const h = interactionHarness();
    h.native.SafeAreaView = 'SafeAreaView';
    // Renders the header, then the rows or the empty/loading/error slot.
    h.native.FlatList = (props: any) => React.createElement('FlatList', { testID: props.testID }, props.ListHeaderComponent,
      props.data.length ? props.data.map((item: any) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))) : props.ListEmptyComponent);
    const results: Record<string, any> = {};
    const keys: string[] = [], refetches: string[] = [], subscribed: string[][] = [];
    const Screen = h.load('src/screens/market/MarketScreen.tsx', {
      '@react-navigation/native': { useIsFocused: () => true },
      './FuturesMarketList': { FuturesMarketControls: 'FuturesMarketControls', FuturesMarketRows: 'FuturesMarketRows', useFuturesMarket: () => ({}), __esModule: true },
      '@tanstack/react-query': { useInfiniteQuery: (options: any) => {
        const assetType = options.queryKey[2];
        keys.push(assetType);
        // A market never fetched before is pending; each key owns its result.
        return { isFetching: false, refetch: async () => { refetches.push(assetType); }, ...(results[assetType] ?? { data: undefined, isLoading: true, isError: false }) };
      } },
      '../../features/market/api': { getAssets: async () => {} },
      '../../features/market/MarketSortControl': { default: 'SortControl', __esModule: true },
      '../../features/market/MarketAssetRow': { MarketAssetRow: 'AssetRow' },
      '../../features/market/marketPresentation': { getMarketSessionLabel: () => '' },
      '../../features/market/useMarketTickers': { useMarketTickers: ({ assetIds }: any) => {
        subscribed.push(assetIds);
        return { tickersByAssetId: new Map(), staleAssetIds: new Set() };
      } },
      '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => false },
      '../../constants/env': { buildWsUrl: () => null },
      ...Object.fromEntries(['ErrorState', 'EmptyState', 'AdminDiagnosticPanel'].map(name => ['../../components/states/' + name, { default: name, __esModule: true }])),
    }).default;
    let rerender: () => void = () => {};
    function Fixture() {
      const [, setTick] = React.useState(0);
      rerender = () => setTick((tick: number) => tick + 1);
      const navigation = React.useMemo(() => ({ navigate() {}, setParams() {} }), []);
      return React.createElement(Screen, { navigation, route: { params: {} } });
    }
    results.domestic_stock = ready('domestic_stock');
    const renderer = h.render(React.createElement(Fixture));
    const find = (predicate: (n: any) => boolean) => renderer.root.findAll(predicate);
    return {
      h, results, keys, refetches, subscribed, renderer,
      refresh: () => act(() => rerender()),
      tab: (id: string) => act(() => find((n: any) => n.type === 'Pressable' && n.props.testID === id)[0].props.onPress()),
      selected: (id: string) => find((n: any) => n.type === 'Pressable' && n.props.testID === id)[0].props.accessibilityState.selected,
      has: (id: string) => find((n: any) => typeof n.type === 'string' && n.props.testID === id).length > 0,
      rows: () => find((n: any) => n.type === 'AssetRow').map((n: any) => n.props.item.id),
      errors: () => find((n: any) => n.type === 'ErrorState'),
      slides: () => h.animations.filter((a: any) => a.type === 'spring').map((a: any) => a.options.toValue),
    };
  }

  it('a first visit keeps the market tabs mounted and slides, showing only the new market\'s loading state', (t) => {
    const m = marketHarness();
    t.after(() => act(() => m.renderer.unmount()));
    assert.deepEqual(m.rows(), ['domestic_stock-1', 'domestic_stock-2']);
    m.tab('market-tab-us');
    assert.equal(m.keys.at(-1), 'us_stock');
    assert.equal(m.has('market-tabs'), true, 'the segment is not replaced by a full-page loader');
    assert.deepEqual(m.slides(), [1], 'the pill slides on a first visit (a remount would land without motion)');
    assert.equal(m.selected('market-tab-us'), true);
    assert.equal(m.has('market-list-loading'), true);
    assert.deepEqual(m.rows(), [], 'the previous market\'s rows are never shown under the new tab');
    assert.deepEqual(m.subscribed.at(-1), [], 'live prices are released with the rows');
    m.results.us_stock = ready('us_stock');
    m.refresh();
    assert.equal(m.has('market-list-loading'), false);
    assert.deepEqual(m.rows(), ['us_stock-1', 'us_stock-2']);
    assert.deepEqual(m.subscribed.at(-1), ['us_stock-1', 'us_stock-2']);
    assert.deepEqual(m.slides(), [1], 'data arrival does not move the pill again');
  });

  it('선물 rows sit below the header card, where Spot rows are; the card and its pills stay mounted', (t) => {
    const m = marketHarness();
    t.after(() => act(() => m.renderer.unmount()));
    m.tab('market-tab-crypto');
    m.tab('crypto-product-futures');
    assert.deepEqual(m.slides(), [2, 1], 'the product pill slides: nothing above it was remounted');
    const all = (type: string, root = m.renderer.root) => root.findAll((n: any) => n.type === type);
    // The header card: the nearest view around the market tabs with the card's corner.
    let card = m.renderer.root.findAll((n: any) => n.props.testID === 'market-tabs')[0];
    while (card && card.props.style?.borderRadius !== 14) card = card.parent;
    assert.equal(all('FuturesMarketControls', card).length, 1, 'search and sort stay in the card, like Spot');
    assert.equal(all('FuturesMarketRows', card).length, 0, 'the rows are not inside the padded card');
    assert.equal(all('FuturesMarketRows').length, 1);
    const header = card.parent;
    assert.deepEqual(header.children.map((n: any) => n === card ? 'card' : n.type), ['card', 'FuturesMarketRows'],
      'rows follow the card at the list content width');
    m.tab('crypto-product-spot');
    assert.deepEqual(m.slides(), [2, 1, 0]);
    assert.equal(all('FuturesMarketRows').length + all('FuturesMarketControls').length, 0);
  });

  it('rapid switches end on the last market; a late answer never replaces it and errors retry in place', (t) => {
    const m = marketHarness();
    t.after(() => act(() => m.renderer.unmount()));
    m.tab('market-tab-us');
    m.tab('market-tab-crypto');
    assert.deepEqual(m.slides(), [1, 2]);
    assert.equal(m.keys.at(-1), 'crypto');
    assert.equal(m.has('crypto-product'), true);
    m.results.us_stock = ready('us_stock');
    m.refresh();
    assert.deepEqual(m.rows(), [], 'a late answer for an earlier tab is not shown');
    assert.equal(m.has('market-list-loading'), true);
    m.results.crypto = { data: undefined, isLoading: false, isError: true, error: new Error('fixture') };
    m.refresh();
    assert.equal(m.errors().length, 1);
    assert.equal(m.errors()[0].props.title, '종목 목록을 불러오지 못했습니다.');
    assert.equal(m.has('market-tabs') && m.has('crypto-product'), true, 'selection stays usable beside the error');
    act(() => m.errors()[0].props.onRetry());
    assert.deepEqual(m.refetches, ['crypto']);
    m.tab('market-tab-domestic');
    assert.deepEqual(m.slides(), [1, 2, 0]);
    assert.deepEqual(m.rows(), ['domestic_stock-1', 'domestic_stock-2'], 'a cached market shows at once');
    assert.equal(m.errors().length, 0);
  });
});
