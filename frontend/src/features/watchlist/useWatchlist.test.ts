import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { WatchlistDto, WatchlistItemDto } from './api';
import { clearSessionCache } from '../auth/sessionCache.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

type Deferred = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
type WatchState = { watched: boolean | null; pending: boolean };
type Watchlist = {
  query: { isError: boolean };
  watchStateOf: (assetId: string) => WatchState;
  setWatched: (assetId: string, watched: boolean) => void;
};

const item = (assetId: string, addedAt = '2026-10-13T01:00:00.000Z'): WatchlistItemDto => ({
  assetId, symbol: assetId.toUpperCase(), name: assetId, market: 'KRX',
  assetType: 'domestic_stock', isActive: true, addedAt,
});
const list = (...items: WatchlistItemDto[]): WatchlistDto => ({ items, limit: 50 });
const apiError = (code: string, status: number) =>
  Object.assign(new Error(code), { response: { status, data: { success: false, error: { code, message: code } } } });

/** A fake server whose every request waits until the test answers it. */
function setup() {
  const h = interactionHarness();
  const gets: Array<{ signal?: AbortSignal } & Deferred> = [];
  const changes: Array<{ method: 'PUT' | 'DELETE'; assetId: string } & Deferred> = [];
  const pending = <T,>(record: T) => new Promise((resolve, reject) => Object.assign(record as object, { resolve, reject }));
  const alerts: string[][] = [];
  const foreground = new Set<(state: string) => void>();
  const session = { userId: 'user-a', generation: 1 };
  const { useWatchlist } = h.load('src/features/watchlist/useWatchlist.tsx', {
    'react-native': {
      ...h.native,
      Alert: { alert: (...args: string[]) => alerts.push(args) },
      AppState: {
        addEventListener: (_: string, listener: (state: string) => void) => {
          foreground.add(listener);
          return { remove: () => foreground.delete(listener) };
        },
      },
    },
    '../me/api': { getMe: async () => ({ id: session.userId }) },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => session.generation },
    './api': {
      getWatchlist: (signal?: AbortSignal) => { const record = { signal }; gets.push(record as never); return pending(record); },
      getWatchlistAssets: () => new Promise(() => {}),
      addToWatchlist: (assetId: string) => { const record = { method: 'PUT', assetId }; changes.push(record as never); return pending(record); },
      removeFromWatchlist: (assetId: string) => { const record = { method: 'DELETE', assetId }; changes.push(record as never); return pending(record); },
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const views: Record<string, Watchlist> = {};
  // Reads `query.isError` during render like the screens' notices do, so the
  // tracked query result re-renders on a status change.
  function Probe({ name }: { name: string }) {
    const watchlist = useWatchlist();
    views[name] = { ...watchlist, query: { isError: watchlist.query.isError } };
    return null;
  }
  const tree = (names: string[]) => React.createElement(QueryClientProvider, { client },
    names.map((name) => React.createElement(Probe, { key: name, name })));
  const renderer = h.render(tree([]));
  const flush = async () => {
    for (let tick = 0; tick < 6; tick++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  return {
    client, gets, changes, alerts, session, views, flush,
    mount: async (...names: string[]) => { act(() => renderer.update(tree(names))); await flush(); },
    /** Answers the oldest unanswered list read. */
    answerGet: async (data: WatchlistDto | Error, index = gets.findIndex((get) => !(get as { done?: boolean }).done)) => {
      const get = gets[index] as (typeof gets)[number] & { done?: boolean };
      get.done = true;
      if (data instanceof Error) get.reject(data); else get.resolve(data);
      await flush();
    },
    answerChange: async (index: number, result: unknown) => {
      if (result instanceof Error) changes[index].reject(result); else changes[index].resolve(result);
      await flush();
    },
    foreground: async () => { act(() => foreground.forEach((listener) => listener('active'))); await flush(); },
    unmount: () => act(() => renderer.unmount()),
  };
}

describe('useWatchlist', () => {
  it('shows a change as pending in every screen, ignores repeated taps, and confirms without flicker', async () => {
    const t = setup();
    try {
      await t.mount('market', 'search');
      assert.equal(t.gets.length, 1, 'both screens share one list read');
      await t.answerGet(list());
      assert.deepEqual(t.views.search.watchStateOf('a'), { watched: false, pending: false });

      act(() => t.views.market.setWatched('a', true));
      act(() => t.views.market.setWatched('a', true));
      act(() => t.views.search.setWatched('a', false));
      await t.flush();
      assert.equal(t.changes.length, 1, 'one request per asset until it is answered');
      assert.equal(t.changes[0].method, 'PUT');
      assert.deepEqual(t.views.search.watchStateOf('a'), { watched: true, pending: true });

      await t.answerChange(0, { item: item('a'), created: true });
      // The re-read is still unanswered: the confirmed state shows, not the old list.
      assert.equal(t.gets.length, 2);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
      assert.deepEqual(t.views.search.watchStateOf('a'), { watched: true, pending: false });
      await t.answerGet(list(item('a')));
      assert.deepEqual(t.views.search.watchStateOf('a'), { watched: true, pending: false });

      act(() => t.views.search.setWatched('a', false));
      await t.flush();
      assert.equal(t.changes[1].method, 'DELETE');
      await t.answerChange(1, { assetId: 'a', removed: true });
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: false, pending: false });
      assert.equal(t.alerts.length, 0);
    } finally { t.unmount(); t.client.clear(); }
  });

  it('leaves the server state after a failed change, explains it once, and re-reads', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list());
      act(() => t.views.market.setWatched('a', true));
      await t.flush();
      await t.answerChange(0, apiError('WATCHLIST_LIMIT_EXCEEDED', 409));
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: false, pending: false });
      assert.equal(t.alerts.length, 1);
      assert.equal(t.alerts[0][0], '관심종목 추가 실패');
      assert.match(t.alerts[0][1], /최대 50개/u);
      assert.equal(t.gets.length, 2, 'a failure re-reads in case the lost answer had committed');
      // The lost answer had in fact committed: the re-read shows it.
      await t.answerGet(list(item('a')));
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('never lets a list read that started before a confirmed change overwrite it', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list());
      await t.foreground();
      assert.equal(t.gets.length, 2, 'foreground starts a re-read');
      act(() => t.views.market.setWatched('a', true));
      await t.flush();
      await t.answerChange(0, { item: item('a'), created: true });
      assert.equal(t.gets[1].signal?.aborted, true, 'the older read is cancelled');
      assert.equal(t.gets.length, 3);
      await t.answerGet(list(), 1); // the stale answer arrives late
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
      await t.answerGet(list(item('a')), 2);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('keeps the confirmed state when a stale read is answered in the same tick as the change', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list());
      await t.foreground();
      act(() => t.views.market.setWatched('a', true));
      await t.flush();
      act(() => {
        t.changes[0].resolve({ item: item('a'), created: true });
        t.gets[1].resolve(list());
      });
      await t.flush();
      // The re-read after the change is still unanswered.
      assert.equal(t.gets.length, 3);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('re-reads after a change confirmed while the first list read is still loading', async () => {
    const t = setup();
    try {
      await t.mount('market');
      assert.equal(t.gets.length, 1);
      act(() => t.views.market.setWatched('a', true));
      await t.flush();
      await t.answerChange(0, { item: item('a'), created: true });
      // The first read began before the commit: it is dropped, not reused.
      assert.equal(t.gets[0].signal?.aborted, true);
      assert.equal(t.gets.length, 2);
      await t.answerGet(list(), 0);
      await t.answerGet(list(item('a')), 1);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('settles rapid changes of different assets to the final server state in any answer order', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list(item('a')));
      act(() => t.views.market.setWatched('b', true));
      act(() => t.views.market.setWatched('a', false));
      await t.flush();
      assert.deepEqual(t.changes.map((change) => `${change.method}:${change.assetId}`), ['PUT:b', 'DELETE:a']);
      await t.answerChange(1, { assetId: 'a', removed: true });
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: false, pending: false });
      assert.deepEqual(t.views.market.watchStateOf('b'), { watched: true, pending: true });
      await t.answerChange(0, { item: item('b', '2026-10-13T02:00:00.000Z'), created: true });
      assert.equal(t.gets[1].signal?.aborted, true);
      await t.answerGet(list(item('a')), 1); // pre-change answer, discarded
      await t.answerGet(list(item('b', '2026-10-13T02:00:00.000Z')), 2);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: false, pending: false });
      assert.deepEqual(t.views.market.watchStateOf('b'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('applies an answer that arrives after the screen was left', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list());
      act(() => t.views.market.setWatched('a', true));
      await t.flush();
      await t.mount();
      await t.answerChange(0, { item: item('a'), created: true });
      await t.mount('search');
      assert.deepEqual(t.views.search.watchStateOf('a'), { watched: true, pending: false });
      assert.equal(t.alerts.length, 0);
    } finally { t.unmount(); t.client.clear(); }
  });

  it("keeps a previous user's late answers out of the next user's list and reports nothing", async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list());
      act(() => t.views.market.setWatched('x', true));
      act(() => t.views.market.setWatched('z', true));
      await t.flush();
      // Logout + login of another user: screens unmount, the session cache is
      // cleared and `me` is seeded for the new user (sessionCache.ts).
      await t.mount();
      clearSessionCache(t.client);
      t.session.userId = 'user-b';
      t.session.generation += 1;
      t.client.setQueryData(QUERY_KEYS.me, { id: 'user-b' });
      await t.mount('market');
      await t.answerGet(list(item('y')));
      await t.answerChange(0, { item: item('x'), created: true });
      await t.answerChange(1, apiError('INTERNAL_SERVER_ERROR', 500));
      assert.deepEqual(t.views.market.watchStateOf('y'), { watched: true, pending: false });
      assert.deepEqual(t.views.market.watchStateOf('x'), { watched: false, pending: false });
      assert.deepEqual(t.views.market.watchStateOf('z'), { watched: false, pending: false });
      assert.equal(t.client.getQueryData(QUERY_KEYS.watchlist.items('user-a')) === undefined, true);
      assert.equal(t.alerts.length, 0);
    } finally { t.unmount(); t.client.clear(); }
  });

  it('reports an unreadable list as unknown rather than as an empty watchlist', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(apiError('INTERNAL_SERVER_ERROR', 500));
      assert.equal(t.views.market.query.isError, true);
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: null, pending: false });
      await t.foreground();
      await t.answerGet(list(item('a')));
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
    } finally { t.unmount(); t.client.clear(); }
  });

  it('re-reads once on returning to the app even with two screens mounted', async () => {
    const t = setup();
    try {
      await t.mount('market', 'search');
      await t.answerGet(list());
      await t.foreground();
      assert.equal(t.gets.length, 2);
    } finally { t.unmount(); t.client.clear(); }
  });

  it('survives a trading-account switch and is removed by the session clear', async () => {
    const t = setup();
    try {
      await t.mount('market');
      await t.answerGet(list(item('a')));
      // TradingAccountContext's switch cancels only account-scoped queries.
      await t.client.cancelQueries({ queryKey: QUERY_KEYS.tradingAccount.all });
      await t.flush();
      assert.deepEqual(t.views.market.watchStateOf('a'), { watched: true, pending: false });
      assert.equal(t.gets.length, 1, 'an account switch does not re-read a user-owned list');
      await t.mount();
      clearSessionCache(t.client);
      assert.equal(t.client.getQueryData(QUERY_KEYS.watchlist.items('user-a')) === undefined, true);
    } finally { t.unmount(); t.client.clear(); }
  });
});
