import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { clearSessionCache, seedSessionCache } from '../auth/sessionCache.ts';
import { invalidateAfterOrderCreate } from '../tradingAccount/invalidation.ts';

const require = createRequire(import.meta.url);
const { createRecordCacheHarness, elements } = require('../../../test/recordCacheHarness.cjs');
const { QueryClient, QueryObserver, InfiniteQueryObserver } = require('@tanstack/react-query');

function assertMyCount(tree: any, count: number) {
  const row = elements(tree, 'Text').find((n: any) =>
    Array.isArray(n.props.children) && n.props.children[0] === '참여 시즌 수 ');
  assert.ok(row, 'MY should render the participation count');
  assert.equal(row.props.children[1], count);
}

function assertCacheShapes(h: any) {
  const page = h.client.getQueryData(QUERY_KEYS.record.seasons({ limit: 20, offset: 0 }));
  const infinite = h.client.getQueryData(QUERY_KEYS.record.infiniteSeasons({ limit: 20, offset: 0 }));
  assert.equal(page.items.length, Math.min(h.total, 20));
  assert.equal(page.pagination.total, h.total);
  assert.equal(page.pages, undefined);
  assert.ok(Array.isArray(infinite.pages));
  assert.deepEqual(infinite.pageParams, infinite.pages.map((p: any) => p.pagination.offset));
  assert.equal(infinite.items, undefined);
}

describe('record/MY real query cache regression', () => {
  it('reproduces both failures when a page and InfiniteData deliberately share a key', async () => {
    const c = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
    const queryKey = ['collision-reproduction'];
    const page = { items: [], pagination: { nextOffset: null } };
    const options = { queryKey, queryFn: async () => page, initialPageParam: 0,
      getNextPageParam: (p: typeof page) => p.pagination.nextOffset ?? undefined };
    try {
      await c.fetchInfiniteQuery(options);
      const observer = new QueryObserver(c, options);
      assert.throws(() => observer.getCurrentResult().data.items.length, /reading 'length'/);
      observer.destroy(); c.clear();
      await c.fetchQuery({ queryKey, queryFn: async () => page });
      assert.throws(() => new InfiniteQueryObserver(c, options), /reading 'length'/);
    } finally { c.clear(); }
  });

  for (const order of [['my', 'record'], ['record', 'my']]) {
    it(`keeps both shapes through ${order.join(' → ')} and 20 repeated visits`, async (t) => {
      const h = createRecordCacheHarness(); t.after(h.close);
      for (const screen of order) await h.fetch(screen);
      assertCacheShapes(h);
      for (let i = 0; i < 20; i++) {
        assertMyCount(h.render('my'), 23);
        assert.equal(elements(h.render('record'), 'FlatList')[0].props.data.length, 20);
        assertCacheShapes(h);
      }
      assert.equal(h.requests.length, 2, 'visits reuse cache without forced refetch/clear');
      const observer = h.observers.find((o: any) => o instanceof InfiniteQueryObserver);
      await observer.fetchNextPage();
      assert.equal(elements(h.render('record'), 'FlatList')[0].props.data.length, 23);
      assert.equal(h.observers.at(-1).getCurrentResult().hasNextPage, false);
      assertMyCount(h.render('my'), 23);
      assertCacheShapes(h);
      assert.deepEqual(h.requests, [
        '/records/me/seasons?limit=20&offset=0',
        '/records/me/seasons?limit=20&offset=0',
        '/records/me/seasons?limit=20&offset=20',
      ]);
    });
  }

  for (const count of [0, 3, 23]) {
    it(`opens MY directly and displays the server total (${count})`, async (t) => {
      const h = createRecordCacheHarness(count); t.after(h.close);
      assertMyCount(await h.fetch('my'), count);
    });
  }

  it('keeps cached shapes through home → market → ranking → record → MY → home', async (t) => {
    const h = createRecordCacheHarness(); t.after(h.close);
    // Cache-level tab cycle: native navigation/WS are not simulated. MY and
    // record execute real screens; the other tabs use their query shapes/keys.
    // queryUsage.test also checks every production hook's factory assignment.
    const home = {
      queryKey: QUERY_KEYS.tradingAccount.portfolio('account-a'),
      queryFn: async () => ({ summary: { totalAssetKrw: '10000000' } }),
    };
    const market = {
      queryKey: QUERY_KEYS.market.assets({ assetType: 'domestic_stock', withPrice: true, limit: 20, offset: 0 }),
      queryFn: async () => ({ assets: [{ id: 'asset-a' }], pagination: { nextOffset: null } }),
      initialPageParam: 0, getNextPageParam: () => undefined,
    };
    const ranking = {
      queryKey: QUERY_KEYS.ranking.infiniteList({ scope: 'all', limit: 50, offset: 0 }),
      queryFn: async () => ({ rankings: [{ userId: 'user-a', rank: 7 }], pagination: { nextOffset: null } }),
      initialPageParam: { offset: 0, rankingDate: null, capturedAt: null },
      getNextPageParam: () => undefined,
    };
    await h.client.fetchQuery(home);
    await h.client.fetchInfiniteQuery(market);
    await h.client.fetchInfiniteQuery(ranking);
    await h.fetch('record'); await h.fetch('my');
    for (let i = 0; i < 20; i++) {
      for (const [Observer, options, read] of [
        [QueryObserver, home, (d: any) => d.summary.totalAssetKrw],
        [InfiniteQueryObserver, market, (d: any) => d.pages[0].assets[0].id],
        [InfiniteQueryObserver, ranking, (d: any) => d.pages[0].rankings[0].rank],
      ] as const) {
        const observer = new Observer(h.client, options);
        assert.ok(read(observer.getCurrentResult().data));
        observer.destroy();
      }
      assert.equal(elements(h.render('record'), 'FlatList')[0].props.data.length, 20);
      assertMyCount(h.render('my'), 23);
      assertCacheShapes(h);
      assert.equal(h.client.getQueryData(home.queryKey).summary.totalAssetKrw, '10000000');
    }
    assert.equal(h.requests.length, 2);
  });

  it('leaves ordinary server/query failures in each screen ErrorState', async (t) => {
    const h = createRecordCacheHarness(); t.after(h.close);
    h.failure = new Error('HTTP 500');
    h.client.setDefaultOptions({ queries: { retry: false, retryOnMount: false } });
    for (const screen of ['my', 'record']) {
      await assert.rejects(h.fetch(screen), /HTTP 500/);
      const error = elements(h.render(screen), 'ErrorState')[0];
      assert.ok(error);
      assert.equal(typeof error.props.onRetry, 'function');
    }
  });

  it('mutation invalidation and session clear still cover both record shapes', async (t) => {
    const h = createRecordCacheHarness(); t.after(h.close);
    await h.fetch('my'); await h.fetch('record');
    await invalidateAfterOrderCreate(h.client, 'account-a', { seasonUi: true });
    for (const q of h.client.getQueryCache().findAll({ queryKey: QUERY_KEYS.record.all })) {
      assert.equal(q.state.isInvalidated, true);
    }
    clearSessionCache(h.client);
    assert.equal(h.client.getQueryCache().getAll().length, 0);
    await seedSessionCache(h.client, { id: 'user-b', nickname: '사용자 B', email: 'b@example.test', role: 'user', status: 'active' });
    assert.equal(h.client.getQueryCache().findAll({ queryKey: QUERY_KEYS.record.all }).length, 0);
    assert.equal(h.client.getQueryData(QUERY_KEYS.me).id, 'user-b');
  });
});
