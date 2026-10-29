import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
// The module instance the screens load natively: flipping it here is guest browsing.
const guestState = require(resolve('src/features/auth/guestBrowsing.ts'));

const unauthorized = () => Object.assign(new Error('401'), { isAxiosError: true, response: { status: 401, data: { error: { code: 'UNAUTHORIZED' } } } });
const flush = async () => { await act(async () => { await new Promise((done) => setTimeout(done, 30)); }); };
const signInMocks = {
  '../../components/guest/GuestSignIn': { GuestSignInPanel: 'GuestSignInPanel', GuestSignInActions: 'GuestSignInActions' },
};

afterEach(() => guestState.setGuestBrowsing(false));

describe('Market list in guest browsing', () => {
  function marketHarness(result: Record<string, unknown>) {
    const h: any = interactionHarness();
    h.native.SafeAreaView = 'SafeAreaView';
    h.native.FlatList = (props: any) => React.createElement('FlatList', { testID: props.testID }, props.ListHeaderComponent,
      props.data.length ? props.data.map((item: any) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item }))) : props.ListEmptyComponent);
    h.tickers = [];
    h.futures = [];
    h.queries = [];
    const Screen = h.load('src/screens/market/MarketScreen.tsx', {
      ...signInMocks,
      './FuturesMarketList': {
        FuturesMarketControls: 'FuturesMarketControls', FuturesMarketRows: 'FuturesMarketRows', __esModule: true,
        useFuturesMarket: (options: unknown) => { h.futures.push(options); return {}; },
      },
      '@tanstack/react-query': { useInfiniteQuery: (options: any) => {
        h.queries.push(options);
        return { isFetching: false, refetch: async () => {}, isLoading: false, data: undefined, ...result };
      } },
      '../../features/market/api': { getAssets: async () => {} },
      '../../features/market/MarketSortControl': { default: 'SortControl', __esModule: true },
      '../../features/market/MarketAssetRow': { MarketAssetRow: 'AssetRow' },
      '../../features/market/marketPresentation': { getMarketSessionLabel: () => '' },
      '../../features/market/useMarketTickers': { useMarketTickers: (options: any) => {
        h.tickers.push(options.enabled);
        return { tickersByAssetId: new Map(), staleAssetIds: new Set() };
      } },
      '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => false },
      '../../constants/env': { buildWsUrl: () => 'ws://fixture/api/v1/ws' },
      ...Object.fromEntries(['ErrorState', 'EmptyState', 'AdminDiagnosticPanel'].map((name) => ['../../components/states/' + name, { default: name, __esModule: true }])),
    }).default;
    const navigation = { navigate() {}, setParams() {} };
    h.renderer = h.render(React.createElement(Screen, { navigation, route: { params: {} } }));
    h.all = (type: string) => h.renderer.root.findAll((n: any) => n.type === type);
    h.tab = (id: string) => act(() => h.renderer.root.findAll((n: any) => n.type === 'Pressable' && n.props.testID === id)[0].props.onPress());
    return h;
  }

  it('a market the server keeps from guests shows a sign-in panel, never the error state', (t) => {
    guestState.setGuestBrowsing(true);
    const h = marketHarness({ isError: true, error: unauthorized() });
    t.after(() => act(() => h.renderer.unmount()));
    const panels = h.all('GuestSignInPanel');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].props.title, '로그인하면 국내 주식 시세를 확인할 수 있습니다.');
    assert.equal(h.all('ErrorState').length, 0);
    assert.deepEqual(h.tickers.filter(Boolean), [], 'a guest never opens the realtime socket');
    // The 401 is final: the list query does not retry it.
    assert.equal(h.queries.at(-1).retry(0, unauthorized()), false);
  });

  it("선물 needs an account: a sign-in panel replaces the account's contract list", (t) => {
    guestState.setGuestBrowsing(true);
    const h = marketHarness({ data: { pages: [{ assets: [] }] } });
    t.after(() => act(() => h.renderer.unmount()));
    h.tab('market-tab-crypto');
    h.tab('crypto-product-futures');
    assert.equal(h.all('FuturesMarketRows').length, 0);
    assert.equal(h.all('FuturesMarketControls').length, 0);
    const panel = h.renderer.root.findAll((n: any) => n.type === 'GuestSignInPanel' && n.props.testID === 'market-futures-sign-in');
    assert.equal(panel.length, 1);
    assert.equal(h.futures.at(-1).active, false, 'no contract list is read');
  });

  it("members keep the error state, the socket and the account's futures list", (t) => {
    const h = marketHarness({ isError: true, error: unauthorized() });
    t.after(() => act(() => h.renderer.unmount()));
    assert.equal(h.all('ErrorState').length, 1);
    assert.equal(h.all('GuestSignInPanel').length, 0);
    assert.equal(h.queries.at(-1).retry, undefined, 'the default retry policy is untouched');
    h.tab('market-tab-crypto');
    h.tab('crypto-product-futures');
    assert.equal(h.all('FuturesMarketRows').length, 1);
    assert.equal(h.futures.at(-1).active, true);
  });
});

describe('Market search in guest browsing', () => {
  function searchHarness(searchQuery: Record<string, unknown>) {
    const h: any = interactionHarness();
    h.native.SafeAreaView = 'SafeAreaView';
    h.native.TextInput = 'TextInput';
    h.native.KeyboardAvoidingView = 'KeyboardAvoidingView';
    h.native.FlatList = (props: any) => React.createElement('FlatList', {}, props.ListHeaderComponent, props.ListEmptyComponent);
    h.tickers = [];
    const Screen = h.load('src/screens/market/MarketSearchScreen.tsx', {
      ...signInMocks,
      '@react-navigation/elements': { useHeaderHeight: () => 56 },
      '../../features/market/useMarketAssetSearch': {
        MARKET_SEARCH_SCOPES: [{ key: 'all', label: '전체' }],
        useMarketAssetSearch: () => ({ searchQuery: { isLoading: false, data: undefined, ...searchQuery }, items: [], hasPriceErrors: false, trimmedSearchText: 'ab', refreshSort: { current: false } }),
      },
      '../../features/market/MarketSortControl': { default: 'SortControl', __esModule: true },
      '../../features/market/MarketAssetRow': { default: 'AssetRow', __esModule: true },
      '../../features/market/useMarketTickers': { useMarketTickers: (options: any) => { h.tickers.push(options.enabled); return { tickersByAssetId: new Map(), staleAssetIds: new Set() }; } },
      '../../constants/env': { buildWsUrl: () => 'ws://fixture/api/v1/ws' },
      ...Object.fromEntries(['ErrorState', 'EmptyState', 'AdminDiagnosticPanel'].map((name) => ['../../components/states/' + name, { default: name, __esModule: true }])),
    }).default;
    h.renderer = h.render(React.createElement(Screen, { navigation: { navigate() {} }, route: { params: {} } }));
    h.all = (type: string) => h.renderer.root.findAll((n: any) => n.type === type);
    return h;
  }

  it('keeps the search field and shows a sign-in panel for a refused market', (t) => {
    guestState.setGuestBrowsing(true);
    const h = searchHarness({ isError: true, error: unauthorized() });
    t.after(() => act(() => h.renderer.unmount()));
    assert.equal(h.all('ErrorState').length, 0);
    assert.equal(h.all('TextInput').length, 1, 'the field is not replaced');
    assert.equal(h.all('GuestSignInPanel').length, 1);
    assert.deepEqual(h.tickers.filter(Boolean), []);
  });

  it('a member keeps the full-screen error state', (t) => {
    const h = searchHarness({ isError: true, error: unauthorized() });
    t.after(() => act(() => h.renderer.unmount()));
    assert.equal(h.all('ErrorState').length, 1);
    assert.equal(h.all('GuestSignInPanel').length, 0);
  });

  it('Korean-name matches skip a market the server keeps from guests instead of failing the search', async (t) => {
    guestState.setGuestBrowsing(true);
    const h: any = interactionHarness();
    const reads: any[] = [];
    const btc = { id: 'btc', symbol: 'BTC', name: 'Bitcoin', market: 'BINANCE', assetType: 'crypto' };
    const api = { getAssets: async (params: any) => {
      reads.push(params);
      // The server: crypto is guest-readable, stock lists are not.
      if (params.assetType === 'us_stock' || params.assetType === 'domestic_stock') throw unauthorized();
      return { assets: [btc], pagination: { offset: 0, limit: 20, total: 1, returned: 1, nextOffset: null }, priceErrors: [] };
    } };
    const { useMarketAssetSearch } = h.load('src/features/market/useMarketAssetSearch.ts', { './api': api });
    let result: any;
    function Probe() {
      result = useMarketAssetSearch({ scope: 'all', searchText: '애플', sort: 'turnover_desc', enabled: true });
      return result.searchQuery.isError ? 'error' : null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderer = h.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    t.after(() => { act(() => renderer.unmount()); client.clear(); });
    await flush();
    assert.equal(result.searchQuery.isError, false);
    assert.deepEqual(result.items.map((item: any) => item.id), ['btc']);
    assert.equal(reads.some((params) => params.assetType === 'us_stock'), true, 'the Korean-name list was asked for');
  });
});

describe('asset detail in guest browsing', () => {
  const { inlineTradingHarness } = require('../../../test/inlineTradingHarness.cjs');

  it('매수하기/매도하기 open the sign-in sheet; no order screen, quote or account read', async (t) => {
    guestState.setGuestBrowsing(true);
    const h = inlineTradingHarness();
    h.accountId = null;
    h.Screen = h.Detail;
    await h.mount();
    t.after(h.close);
    const requestsBefore = h.requests.length;

    assert.equal(h.node('asset-sign-in') === undefined, true, 'closed until pressed');
    assert.equal(JSON.stringify(h.renderer.toJSON()).includes('계정이 없습니다.'), false);
    for (const id of [TEST_IDS.assetDetail.openBuyOrder, TEST_IDS.assetDetail.openSellOrder]) {
      assert.equal(h.node(id).props.state, 'enabled', id);
      await h.press(id);
      assert.equal(h.node('asset-sign-in') !== undefined, true, id);
      assert.equal(JSON.stringify(h.renderer.toJSON()).includes('매수·매도 주문은 로그인한 뒤 나의 가상투자 계정으로 할 수 있습니다.'), true);
      await h.press('asset-sign-in-close');
      await h.flush();
    }
    assert.deepEqual(h.navigation.filter((args: unknown[]) => args[0] === 'Order'), []);
    assert.equal(h.requests.length, requestsBefore, 'no order or account request');
  });

  it('a member without an account keeps the disabled buttons and their notice', async (t) => {
    const h = inlineTradingHarness();
    h.accountId = null;
    h.Screen = h.Detail;
    await h.mount();
    t.after(h.close);
    assert.equal(JSON.stringify(h.renderer.toJSON()).includes('계정이 없습니다.'), true);
    // The harness draws CTAButton as a host: its `state` is the contract.
    assert.equal(h.node(TEST_IDS.assetDetail.openBuyOrder).props.state, 'disabled');
    assert.equal(h.node(TEST_IDS.assetDetail.openSellOrder).props.state, 'disabled');
    assert.equal(h.node('asset-sign-in') === undefined, true);
  });
});
