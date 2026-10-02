import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import type { GetAssetsParams } from './api.ts';
const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const {
  interactionHarness,
  React,
  act,
} = require('../../../test/interactionTestHarness.cjs');

for (const screen of ['MarketScreen', 'MarketSearchScreen']) {
  it(`${screen} refreshes the first page and carries the new token through real infinite Query`, async () => {
    const h = interactionHarness('android');
    Object.assign(h.native, {
      SafeAreaView: 'SafeAreaView',
      FlatList: 'FlatList',
      TextInput: 'TextInput',
    });
    h.native.FlatList = (props: { ListHeaderComponent?: unknown }) =>
      React.createElement('FlatList', props, props.ListHeaderComponent);
    const requests: GetAssetsParams[] = [];
    let token = 'initial-order';
    const Screen = h.load(`src/screens/market/${screen}.tsx`, {
      '../../features/market/MarketSortControl': {
        __esModule: true,
        default: 'SortControl',
      },
      '../../features/market/MarketAssetRow': {
        __esModule: true,
        default: 'AssetRow',
        MarketAssetRow: 'AssetRow',
      },
      '../../features/auth/useAdminDiagnostics': {
        useAdminDiagnostics: () => false,
      },
      '../../features/market/useMarketTickers': {
        useMarketTickers: () => ({
          tickersByAssetId: {},
          staleAssetIds: new Set(),
          showReconnectBanner: false,
        }),
      },
      '../../constants/env': { buildWsUrl: () => undefined },
      ...Object.fromEntries(
        [
          'FullPageLoading',
          'ErrorState',
          'EmptyState',
          'AdminDiagnosticPanel',
        ].map((name) => [
          '../../components/states/' + name,
          { __esModule: true, default: name },
        ]),
      ),
      '../../features/market/api': {
        getAssets: async (params: GetAssetsParams) => {
          requests.push(params);
          if (params.sortRefresh) token = 'refreshed-order';
          const offset = params.offset ?? 0;
          return {
            assets: [{ id: `${token}-${offset}` }],
            priceErrors: [],
            sortSnapshot: token,
            pagination: {
              offset,
              limit: 20,
              returned: 20,
              total: 60,
              nextOffset: offset < 40 ? offset + 20 : null,
            },
          };
        },
      },
    }).default;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const renderer = h.render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Screen, {
          navigation: { navigate() {} },
          route: { params: {} },
        }),
      ),
    );
    const flush = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    };
    const list = () => renderer.root.findByType('FlatList');
    try {
      if (screen === 'MarketSearchScreen')
        act(() =>
          renderer.root
            .findByProps({ testID: 'market-search-input' })
            .props.onChangeText('SAM'),
        );
      await flush();
      act(() => list().props.onEndReached());
      await flush();
      assert.equal(requests[1].sortSnapshot, 'initial-order');
      act(() => list().props.onRefresh());
      await flush();
      assert.equal(requests[2].sortRefresh, true);
      assert.equal(requests[2].offset, 0);
      assert.equal(requests[2].sortSnapshot, undefined);
      assert.equal(requests[3].sortSnapshot, 'refreshed-order');
      assert.equal(requests[3].sortRefresh, false);
      assert.deepEqual(
        list().props.data.map((item: { id: string }) => item.id),
        ['refreshed-order-0', 'refreshed-order-20'],
      );
      act(() => list().props.onEndReached());
      await flush();
      assert.equal(requests[4].sortRefresh, false);
      assert.equal(requests[4].sortSnapshot, 'refreshed-order');
    } finally {
      act(() => renderer.unmount());
      client.clear();
    }
  });
}

it('serializes an explicit fresh request through the existing Assets API', async () => {
  const { load } = require('../../../test/ledgerTestHarness.cjs');
  let path = '';
  const api = load(require.resolve('./api.ts'), {
    '../../services/api/client': {
      apiClient: {
        get: async (url: string) => {
          path = url;
          return {
            data: { data: { assets: [], pagination: { nextOffset: null } } },
          };
        },
      },
    },
  });
  await api.getAssets({ sortBy: 'volume', sortRefresh: true, offset: 0 });
  assert.equal(
    new URL(path, 'https://fixture.invalid').searchParams.get('sortRefresh'),
    'true',
  );
});
