import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import type { WatchlistItem } from './api.ts';
import type { WatchlistState } from './useWatchlist.ts';
const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider, onlineManager } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

const item = (
  assetId = 'a',
  assetType: WatchlistItem['assetType'] = 'domestic_stock',
): WatchlistItem => ({
  assetId,
  assetType,
  name: '아주 긴 한국어 관심종목 이름 Long English Company Name',
  symbol: assetId.toUpperCase(),
  market: assetType === 'domestic_stock' ? 'KRX' : 'NASDAQ',
  isActive: true,
  createdAt: '2026-10-13T00:00:00Z',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

function harness() {
  const ui = interactionHarness();
  const listeners = new Set<(state: string) => void>();
  ui.native.AppState = {
    currentState: 'active',
    addEventListener: (_: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
  let userId = 'A',
    generation = 1;
  const lists = new Map<string, WatchlistItem[]>([
    ['A', []],
    ['B', []],
  ]);
  const calls: Array<{ assetId: string; registered: boolean; owner: number; userId: string }> = [];
  let reads = 0;
  const transport = {
    getMe: async () => ({ id: userId }),
    getWatchlist: async (_: number, _signal?: AbortSignal) => {
      reads++;
      return [...lists.get(userId)!];
    },
    setWatchlist: async (assetId: string, registered: boolean, owner: number) => {
      calls.push({ assetId, registered, owner, userId });
      const current = lists.get(userId)!;
      lists.set(
        userId,
        registered
          ? [...current.filter((row) => row.assetId !== assetId), item(assetId)]
          : current.filter((row) => row.assetId !== assetId),
      );
    },
  };
  const focus = { useFocusEffect: (callback) => React.useEffect(callback, [callback]) };
  const hook = ui.load('src/features/watchlist/useWatchlist.ts', {
    '../../theme/native': ui.native,
    '@react-navigation/native': focus,
    '../me/api': { getMe: () => transport.getMe() },
    '../../services/api/sessionOwnership': {
      getSessionGeneration: () => generation,
      isCurrentSession: (owner) => owner === generation,
      canUseSessionCredentials: (owner) => owner === generation,
    },
    './api': transport,
  });
  client.setQueryData(['me'], { id: userId });
  const states: Record<string, WatchlistState> = {};
  function Probe({ label }: { label: string }) {
    states[label] = hook.useWatchlist();
    return React.createElement('Probe', { label, queryStatus: states[label].query.status });
  }
  const render = (
    children = [
      React.createElement(Probe, { key: 'market', label: 'market' }),
      React.createElement(Probe, { key: 'search', label: 'search' }),
    ],
  ) => ui.render(React.createElement(QueryClientProvider, { client }, ...children));
  return {
    ui,
    client,
    hook,
    states,
    lists,
    calls,
    transport,
    listeners,
    render,
    get reads() {
      return reads;
    },
    switchUser(next = 'B') {
      generation++;
      userId = next;
      client.clear();
      client.setQueryData(['me'], { id: userId });
    },
    cleanup(renderer) {
      act(() => renderer.unmount());
      client.clear();
      onlineManager.setOnline(true);
    },
  };
}

it('shares confirmed state across screens, blocks same-frame duplicate/contrary touches, then removes', async () => {
  const h = harness();
  const gate = deferred<void>();
  const original = h.transport.setWatchlist;
  h.transport.setWatchlist = async (...args) => {
    await gate.promise;
    await original(...args);
  };
  const renderer = h.render();
  try {
    await flush();
    assert.equal(h.states.market.ready, true);
    act(() => {
      h.states.market.change('a', true);
      h.states.market.change('a', true);
      h.states.search.change('a', false);
    });
    await flush();
    assert.equal(h.states.market.registeredIds.has('a'), false);
    assert.equal(h.states.search.pendingIds.has('a'), true);
    await act(async () => {
      gate.resolve();
    });
    await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(h.states.market.registeredIds.has('a'), true);
    assert.equal(h.states.search.registeredIds.has('a'), true);
    act(() => h.states.search.change('a', false));
    await flush();
    assert.equal(h.calls.length, 2);
    assert.equal(h.states.market.registeredIds.has('a'), false);
    assert.equal(h.states.search.pendingIds.has('a'), false);
  } finally {
    h.cleanup(renderer);
  }
});

it('failed registration never leaves an optimistic star; a lost committed response reconciles too', async () => {
  const h = harness();
  const original = h.transport.setWatchlist;
  h.transport.setWatchlist = async () => {
    throw new Error('offline');
  };
  const renderer = h.render();
  try {
    await flush();
    act(() => h.states.market.change('a', true));
    await flush();
    assert.equal(h.states.market.registeredIds.has('a'), false);
    assert.equal(h.states.market.error instanceof Error, true);
    h.transport.setWatchlist = async (...args) => {
      await original(...args);
      throw new Error('response lost');
    };
    act(() => h.states.search.change('a', true));
    await flush();
    assert.equal(h.states.market.registeredIds.has('a'), true);
    assert.equal(h.states.market.pendingIds.has('a'), false);
    await act(async () => h.states.market.retry());
    await flush();
    assert.equal(h.states.market.error === null, true);
    assert.equal(h.states.search.error === null, true);
  } finally {
    h.cleanup(renderer);
  }
});

it('owner-read failures hide cached preferences and explicit retry recovers the same user', async () => {
  const h = harness();
  h.lists.set('A', [item('a')]);
  const getMe = h.transport.getMe;
  const renderer = h.render();
  try {
    await flush();
    h.transport.getMe = async () => {
      throw new Error('owner unavailable');
    };
    await act(async () => h.client.invalidateQueries({ queryKey: ['me'], exact: true }));
    await flush();
    assert.equal(h.states.market.userError instanceof Error, true);
    assert.equal(h.states.market.ready, false);
    assert.equal(h.states.market.items === undefined, true);
    h.transport.getMe = getMe;
    await act(async () => h.states.market.retry());
    await flush();
    assert.equal(h.states.market.ready, true);
    assert.equal(h.states.market.registeredIds.has('a'), true);
  } finally {
    h.cleanup(renderer);
  }
});

it('cancels a pre-mutation GET so its late result cannot overwrite confirmed server state', async () => {
  const h = harness();
  h.client.setQueryData(['watchlist', 'A'], []);
  const stale = deferred<WatchlistItem[]>();
  const original = h.transport.getWatchlist;
  let first = true,
    cancelled = false;
  h.transport.getWatchlist = async (...args) => {
    if (first) {
      first = false;
      args[1]?.addEventListener('abort', () => {
        cancelled = true;
      });
      return stale.promise;
    }
    return original(...args);
  };
  const renderer = h.render();
  try {
    await flush();
    act(() => h.states.market.change('a', true));
    await flush();
    assert.equal(cancelled, true);
    assert.equal(h.states.search.registeredIds.has('a'), true);
    await act(async () => stale.resolve([]));
    await flush();
    assert.equal(h.states.market.registeredIds.has('a'), true);
  } finally {
    stale.resolve([]);
    h.cleanup(renderer);
  }
});

it('late mutation after session/user replacement cannot refetch or populate either old/new cache', async () => {
  const h = harness();
  const gate = deferred<void>();
  let requests = 0;
  h.transport.setWatchlist = async () => {
    requests++;
    await gate.promise;
  };
  const renderer = h.render();
  try {
    await flush();
    act(() => h.states.market.change('a', true));
    await flush();
    const oldChange = h.states.market.change;
    act(() => h.switchUser());
    // Login replaces the outgoing screen tree after synchronously clearing cache.
    const Next = () => {
      h.states.market = h.hook.useWatchlist();
      return null;
    };
    act(() =>
      renderer.update(
        React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Next)),
      ),
    );
    await flush();
    act(() => oldChange('other', true));
    const before = h.reads;
    await act(async () => gate.resolve());
    await flush();
    assert.equal(requests, 1);
    assert.equal(h.reads, before);
    assert.equal(h.states.market.items?.length, 0);
    assert.equal(h.states.market.registeredIds.has('a'), false);
    assert.equal(h.client.getQueryData(['watchlist', 'A']) === undefined, true);
    assert.equal(h.states.market.error === null, true);
  } finally {
    gate.resolve();
    h.cleanup(renderer);
  }
});

it('unmounted requests settle safely; account changes retain the same user cache', async () => {
  const h = harness();
  h.lists.set('A', [item('a')]);
  const gate = deferred<void>();
  const original = h.transport.setWatchlist;
  h.transport.setWatchlist = async (...args) => {
    await gate.promise;
    await original(...args);
  };
  let renderer = h.render();
  try {
    await flush();
    const data = h.client.getQueryData(['watchlist', 'A']);
    act(() =>
      renderer.update(
        React.createElement(
          QueryClientProvider,
          { client: h.client },
          React.createElement('AccountSwitch', { accountId: 'season' }),
        ),
      ),
    );
    assert.equal(h.client.getQueryData(['watchlist', 'A']) === data, true);
    h.cleanup(renderer);
    renderer = h.render();
    await flush();
    act(() => h.states.market.change('a', false));
    await flush();
    act(() => renderer.unmount());
    await act(async () => gate.resolve());
    await flush();
    assert.equal(h.lists.get('A')?.length, 0);
    renderer = h.render();
    await flush();
    assert.equal(h.states.market.registeredIds.has('a'), false);
  } finally {
    gate.resolve();
    h.cleanup(renderer);
  }
});

it('read errors remain errors, and reconnect/foreground/focus refresh the server list', async () => {
  const h = harness();
  const original = h.transport.getWatchlist;
  h.transport.getWatchlist = async () => {
    throw new Error('network');
  };
  const renderer = h.render();
  try {
    await flush();
    await flush();
    assert.equal(h.states.market.query.isError, true);
    assert.equal(h.states.market.items === undefined, true);
    assert.equal(h.states.market.ready, false);
    act(() => h.states.market.change('a', true));
    assert.equal(h.calls.length, 0);
    act(() => onlineManager.setOnline(false));
    h.transport.getWatchlist = original;
    h.lists.set('A', [item('off-page')]);
    act(() => onlineManager.setOnline(true));
    await flush();
    assert.equal(h.states.market.ready, true);
    assert.equal(h.states.market.registeredIds.has('off-page'), true);
    h.lists.set('A', []);
    act(() => {
      for (const listener of h.listeners) listener('active');
    });
    await flush();
    assert.equal(h.states.market.items?.length, 0);
    assert.equal(h.states.market.query.isError, false);
  } finally {
    h.cleanup(renderer);
  }
});

it('API sends authenticated explicit PUT/DELETE and a cancellable list request, with no user/account payload', async () => {
  const { load } = require('../../../test/ledgerTestHarness.cjs');
  const requests: Array<{
    method: string;
    url: string;
    body: unknown;
    config: { _sessionGeneration: number; signal?: AbortSignal };
  }> = [];
  const api = load(require.resolve('./api.ts'), {
    '../../services/api/client': {
      apiClient: {
        get: async (url, config) => {
          requests.push({ method: 'GET', url, body: undefined, config });
          return { data: { data: { items: [item()] } } };
        },
        put: async (url, body, config) => {
          requests.push({ method: 'PUT', url, body, config });
        },
        delete: async (url, config) => {
          requests.push({ method: 'DELETE', url, body: undefined, config });
        },
      },
    },
  });
  const controller = new AbortController();
  assert.equal((await api.getWatchlist(4, controller.signal)).length, 1);
  await api.setWatchlist('a/b', true, 4);
  await api.setWatchlist('a/b', false, 4);
  assert.deepEqual(
    requests.map((row) => [row.method, row.url, row.body, row.config._sessionGeneration]),
    [
      ['GET', '/watchlist', undefined, 4],
      ['PUT', '/watchlist/a%2Fb', undefined, 4],
      ['DELETE', '/watchlist/a%2Fb', undefined, 4],
    ],
  );
  assert.equal(requests[0].config.signal === controller.signal, true);
});

function screens(h: ReturnType<typeof harness>, marketFailure = false) {
  h.ui.native.SafeAreaView = 'SafeAreaView';
  h.ui.native.TextInput = 'TextInput';
  h.ui.native.FlatList = (props) =>
    React.createElement(
      'FlatList',
      props,
      props.ListHeaderComponent,
      props.data.length
        ? props.data.map((row) =>
            React.createElement(
              React.Fragment,
              { key: row.id ?? row.assetId },
              props.renderItem({ item: row }),
            ),
          )
        : props.ListEmptyComponent,
    );
  const marketApi = {
    getAssets: async () => {
      if (marketFailure) throw new Error('market unavailable');
      return {
        assets: [
          {
            id: 'a',
            name: 'Long 한국어 종목 이름',
            symbol: 'ABC',
            assetType: 'domestic_stock',
            market: 'KRX',
            isActive: true,
            priceCurrency: 'KRW',
            settlementCurrency: 'KRW',
            marketStatus: 'open',
            tradable: true,
          },
        ],
        pagination: { nextOffset: null },
        priceErrors: [],
      };
    },
  };
  const notice = h.ui.load('src/features/watchlist/WatchlistNotice.tsx', {
    '../../components/states/ErrorNotice': {
      __esModule: true,
      default: (props) => React.createElement('Text', {}, props.message),
    },
  });
  const mocks = {
    '../../features/watchlist/useWatchlist': h.hook,
    '../../features/watchlist/WatchlistNotice': notice,
    '../../features/auth/useAdminDiagnostics': { useAdminDiagnostics: () => false },
    '../../features/market/api': marketApi,
    '../../features/market/useMarketAssetSearch': h.ui.load(
      'src/features/market/useMarketAssetSearch.ts',
      { './api': marketApi },
    ),
    '../../features/market/useMarketTickers': {
      useMarketTickers: () => ({
        tickersByAssetId: new Map(),
        staleAssetIds: new Set(),
        connectionState: 'connected',
      }),
    },
    '../../features/market/MarketSortControl': { __esModule: true, default: 'SortControl' },
    '../../constants/env': { buildWsUrl: () => '' },
    '../../theme/safeArea': { SafeAreaView: 'SafeAreaView' },
    './FuturesMarketList': { __esModule: true, default: 'FuturesMarketList' },
    ...Object.fromEntries(
      ['FullPageLoading', 'EmptyState', 'ErrorState', 'AdminDiagnosticPanel'].map((name) => [
        '../../components/states/' + name,
        { __esModule: true, default: name },
      ]),
    ),
  };
  return Object.fromEntries(
    ['MarketScreen', 'MarketSearchScreen', 'WatchlistScreen'].map((name) => [
      name,
      h.ui.load(`src/screens/market/${name}.tsx`, mocks).default,
    ]),
  );
}

it('a market API failure still permits opening the independent server watchlist', async () => {
  const h = harness();
  const Screen = screens(h, true).MarketScreen;
  const navigation: unknown[][] = [];
  const renderer = h.render([
    React.createElement(Screen, {
      key: 'market',
      navigation: { navigate: (...args) => navigation.push(args) },
      route: { params: {} },
    }),
  ]);
  try {
    await flush();
    await flush();
    assert.equal(renderer.root.findAllByType('ErrorState').length, 1);
    const entry = renderer.root
      .findAllByType('Pressable')
      .find((node) => node.props.testID === 'watchlist-entry');
    assert.equal(entry !== undefined, true);
    act(() => entry!.props.onPress());
    assert.deepEqual(navigation.at(-1), ['Watchlist', { assetType: 'domestic_stock' }]);
  } finally {
    h.cleanup(renderer);
  }
});

it('real market/search rows share stars and keep distinct detail navigation; Futures has no Spot controls', async () => {
  const h = harness();
  const components = screens(h);
  const navigation: unknown[][] = [];
  const props = {
    navigation: { navigate: (...args) => navigation.push(args), setParams() {} },
    route: { params: {} },
  };
  const renderer = h.render([
    React.createElement(components.MarketScreen, { ...props, key: 'market' }),
    React.createElement(components.MarketSearchScreen, { ...props, key: 'search' }),
  ]);
  const buttons = () =>
    renderer.root
      .findAllByType('Pressable')
      .filter((node) => node.props.testID === 'watchlist-button-a');
  try {
    await flush();
    act(() =>
      renderer.root.findByProps({ testID: 'market-search-input' }).props.onChangeText('ABC'),
    );
    await flush();
    assert.equal(buttons().length, 2);
    assert.equal(buttons()[0].props.accessibilityState.selected, false);
    act(() => buttons()[0].props.onPress());
    await flush();
    assert.equal(h.calls.length, 1);
    assert.equal(navigation.length, 0);
    assert.equal(
      buttons().every((node) => node.props.accessibilityState.selected === true),
      true,
    );
    act(() => buttons()[1].props.onPress());
    await flush();
    assert.equal(
      buttons().every((node) => node.props.accessibilityState.selected === false),
      true,
    );
    const detail = renderer.root
      .findAllByType('Pressable')
      .find((node) => node.props.testID === 'market-item-a');
    assert.equal(detail !== undefined, true);
    act(() => detail!.props.onPress());
    assert.deepEqual(navigation.at(-1), ['AssetDetail', { assetId: 'a' }]);
    act(() =>
      renderer.root
        .findAllByType('Pressable')
        .find((node) => node.props.testID === 'watchlist-entry')!
        .props.onPress(),
    );
    assert.deepEqual(navigation.at(-1), ['Watchlist', { assetType: 'domestic_stock' }]);
    act(() =>
      renderer.root
        .findAllByType('Pressable')
        .find((node) => node.props.testID === 'market-tab-crypto')!
        .props.onPress(),
    );
    await flush();
    const futuresButton = renderer.root
      .findAllByType('Pressable')
      .find((node) => node.props.testID === 'crypto-product-futures');
    assert.equal(futuresButton !== undefined, true);
    act(() => futuresButton!.props.onPress());
    assert.equal(renderer.root.findAllByType('FuturesMarketList').length, 1);
    assert.equal(
      renderer.root
        .findAllByType('Pressable')
        .filter((node) => node.props.testID === 'watchlist-entry').length,
      0,
    );
    assert.equal(buttons().length, 1, 'only the independent Spot search row remains');
  } finally {
    h.cleanup(renderer);
  }
});

it('real watchlist uses off-page server rows, filters market, labels inactive and navigates/removes', async () => {
  const h = harness();
  h.lists.set('A', [{ ...item('off-page'), isActive: false }, item('us', 'us_stock')]);
  const Screen = screens(h).WatchlistScreen;
  const navigation: unknown[][] = [];
  const renderer = h.render([
    React.createElement(Screen, {
      key: 'list',
      navigation: { navigate: (...args) => navigation.push(args) },
      route: { params: { assetType: 'domestic_stock' } },
    }),
  ]);
  try {
    await flush();
    const rows = renderer.root.findByType('FlatList').props.data;
    assert.deepEqual(
      rows.map((row) => row.assetId),
      ['off-page'],
    );
    const texts = renderer.root
      .findAllByType('Text')
      .flatMap((node) => node.props.children)
      .filter((value) => typeof value === 'string');
    assert.equal(texts.includes('비활성 · 거래 불가'), true);
    assert.equal(
      texts.some((text) => /₩|\$|%/.test(text)),
      false,
    );
    act(() =>
      renderer.root
        .findAllByType('Pressable')
        .find((node) => node.props.testID === 'watchlist-item-off-page')!
        .props.onPress(),
    );
    assert.deepEqual(navigation.at(-1), ['AssetDetail', { assetId: 'off-page' }]);
    act(() =>
      renderer.root
        .findAllByType('Pressable')
        .find((node) => node.props.testID === 'watchlist-button-off-page')!
        .props.onPress(),
    );
    await flush();
    assert.equal(renderer.root.findByType('FlatList').props.data.length, 0);
    assert.equal(renderer.root.findAllByType('EmptyState').length, 1);
    assert.equal(h.lists.get('A')?.length, 1, 'other market remains registered');
  } finally {
    h.cleanup(renderer);
  }
});

it('real watchlist presents loading/error independently from an empty successful list', async () => {
  const h = harness();
  const gate = deferred<WatchlistItem[]>();
  h.transport.getWatchlist = () => gate.promise;
  const Screen = screens(h).WatchlistScreen;
  const renderer = h.render([
    React.createElement(Screen, {
      key: 'list',
      navigation: {},
      route: { params: { assetType: 'domestic_stock' } },
    }),
  ]);
  try {
    assert.equal(renderer.root.findAllByType('EmptyState').length, 0);
    assert.equal(renderer.root.findAllByProps({ testID: 'watchlist-loading' }).length > 0, true);
    await act(async () => gate.reject(new Error('network')));
    await flush();
    assert.equal(renderer.root.findAllByProps({ testID: 'watchlist-error' }).length > 0, true);
    assert.equal(renderer.root.findAllByType('EmptyState').length, 0);
    h.transport.getWatchlist = async () => [];
    act(() =>
      renderer.root
        .findAllByType('Pressable')
        .find((node) => node.props.accessibilityRole === 'button')!
        .props.onPress(),
    );
    await flush();
    assert.equal(renderer.root.findAllByProps({ testID: 'watchlist-error' }).length, 0);
    assert.equal(renderer.root.findAllByType('EmptyState').length, 1);
  } finally {
    gate.resolve([]);
    h.cleanup(renderer);
  }
});
