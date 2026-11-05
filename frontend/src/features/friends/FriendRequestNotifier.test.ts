import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it, type TestContext } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const React = require('react');
const { QueryClient, QueryClientProvider, InfiniteQueryObserver, environmentManager } = require('@tanstack/react-query');
const { interactionHarness, act } = require('../../../test/interactionTestHarness.cjs');

/**
 * 친구 요청 in-app banner (2026-11-06) over a real QueryClient and the real
 * TopNoticeBanner; only the API, navigation and session boundaries are
 * fixtures. Assertions read small strings/numbers only.
 */
type Row = { userId: string; nickname: string; profileImageUrl: null; relationship: 'received'; requestId: string };
const row = (id: string): Row => ({ userId: `user-${id}`, nickname: id.toUpperCase(), profileImageUrl: null, relationship: 'received', requestId: `request-${id}` });
const switches = (friendRequest: boolean, allEnabled: boolean | null = true) => ({
  allEnabled,
  preferences: { tradeFill: true, futuresLiquidation: true, orderFailure: true, friendRequest, importantNotice: true, seasonFinalResult: true, seasonEndingSoon: true },
});
const safeArea = { 'react-native-safe-area-context': { SafeAreaInsetsContext: React.createContext(null), initialWindowMetrics: null } };

function harness(t: TestContext) {
  const ui = interactionHarness('android');
  const h: any = {
    ui, userId: 'u1' as string | null, route: 'MainTabs', generation: 1, incoming: [] as Row[], reads: 0, settings: switches(true),
    settingsFailure: null, settingsReads: 0, navigations: [] as unknown[], navReady: true, questAllowed: true, appListeners: [] as Array<(state: string) => void>,
    fill: null as null | { id: string; title: string; detail: string | null },
  };
  ui.native.AppState = { currentState: 'active', addEventListener: (_: string, listener: (state: string) => void) => {
    h.appListeners.push(listener);
    return { remove: () => { h.appListeners = h.appListeners.filter((item: unknown) => item !== listener); } };
  } };
  ui.native.AccessibilityInfo = { announceForAccessibility: () => {} };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // One TopNoticeBanner module: its single top place is shared with a fill banner below.
  const Banner = ui.load('src/components/common/TopNoticeBanner.tsx', safeArea);
  const Notifier = ui.load('src/features/friends/FriendRequestNotifier.tsx', {
    ...safeArea,
    '../../components/common/TopNoticeBanner': Banner,
    '../notifications/PushNotificationsHost': {
      MAIN_ROUTES: new Set(['MainTabs', 'TradeHistory']),
      useSessionUserId: () => h.userId,
      useRootRouteName: () => h.route,
      navigateTo: (intent: unknown) => { h.navigations.push(intent); },
    },
    '../../app/navigation/navigationRef': { rootNavigationRef: { isReady: () => h.navReady } },
    '../quest/questNavigationGuard': { questNavigationAllowed: () => h.questAllowed },
    '../notifications/api': { getNotificationPreferences: async () => {
      h.settingsReads++;
      if (h.settingsFailure) throw h.settingsFailure;
      return h.settings;
    } },
    './api': { getFriends: async (kind: string) => {
      assert.equal(kind, 'requests');
      h.reads++;
      const users = [...h.incoming];
      return { users, pagination: { limit: 30, offset: 0, total: users.length, returned: users.length, nextOffset: null } };
    } },
    './usePendingFriendRequests': { FRIEND_REQUESTS_POLL_MS: 30_000 },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => h.generation, isCurrentSession: (owner: number) => owner === h.generation },
  });
  const fillProps = () => ({
    channel: 'order-fill', notice: h.fill, visibleMs: 4000, heldMs: 10_000, icon: { glyph: '✓', tone: 'success' }, actionLabel: '내역 보기',
    actionTestID: 'order-fill-banner-history', notOpened: { held: 'h', unavailable: 'u' }, testID: 'order-fill-banner',
    onAction: () => 'opened', onDone: () => { h.fill = null; },
  });
  const tree = () => React.createElement(QueryClientProvider, { client: h.client },
    React.createElement(Banner.default, fillProps()), React.createElement(Notifier.default));
  h.flush = async () => { for (let i = 0; i < 3; i++) await act(async () => { await new Promise((done) => setTimeout(done, 5)); }); };
  h.mount = async () => { h.renderer = ui.render(tree()); await h.flush(); };
  h.update = async () => { await act(async () => { h.renderer.update(tree()); }); await h.flush(); };
  /** Another read of 받은 요청 (a push refresh, the dot, the 30 s pace). */
  h.read = async () => { await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.friends.requests }); }); await h.flush(); };
  h.app = async (state: string) => { await act(async () => { h.appListeners.forEach((listener: (value: string) => void) => listener(state)); }); await h.flush(); };
  const host = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id)[0];
  const text = (id: string) => { const node = host(id); return node === undefined ? null : [node.props.children].flat().join(''); };
  h.banner = () => (host('friend-request-banner') === undefined ? null : { title: text('friend-request-banner-title'), detail: text('friend-request-banner-detail') });
  h.fillShown = () => host('order-fill-banner') !== undefined;
  /** 받은 요청 보기, then the exit motion. */
  h.open = async () => {
    await act(async () => host('friend-request-banner-open').props.onPress());
    h.ui.finish(); await h.flush();
  };
  h.notOpened = () => text('friend-request-banner-not-opened');
  h.interval = () => h.client.getQueryCache().find({ queryKey: QUERY_KEYS.friends.requests })?.observers[0]?.options.refetchInterval;
  t.after(async () => { if (h.renderer) await act(async () => h.renderer.unmount()); h.client.clear(); });
  return h;
}

describe('친구 요청 배너', () => {
  it('existing requests are a baseline; a new one shows 친구 요청 / {닉네임}님이 친구 요청을 보냈어요. once, and opens 받은 요청', async (t) => {
    const h = harness(t);
    h.incoming = [row('old')];
    await h.mount();
    assert.equal(h.reads > 0, true, 'reads 받은 요청 while active');
    assert.equal(h.banner(), null, 'nothing already pending is announced');
    assert.equal(h.interval(), 30_000, "the MY dot's pace on the same entry");
    h.incoming = [row('new'), row('old')];
    await h.read();
    assert.deepEqual(h.banner(), { title: '친구 요청', detail: 'NEW님이 친구 요청을 보냈어요.' });
    // The shared 받은 요청 entry (the 친구 screen, the MY dot) holds the new request.
    assert.equal(h.client.getQueryData(QUERY_KEYS.friends.requests).pages[0].users.length, 2);
    await h.read();
    await h.open();
    assert.deepEqual(h.navigations, [{ kind: 'friend_requests', type: 'friend_request', uid: 'u1' }]);
    assert.equal(h.banner(), null, 'left after opening');
    await h.read();
    assert.equal(h.banner(), null, 'the same request is never announced again');
  });

  it('a held or unready open stays with the reason and moves nowhere', async (t) => {
    const h = harness(t);
    await h.mount();
    h.incoming = [row('a')];
    h.questAllowed = false;
    await h.read();
    await act(async () => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === 'friend-request-banner-open')[0].props.onPress());
    assert.equal(h.notOpened(), '학습 안내 중이라 받은 요청을 열지 않았어요. 안내를 종료한 뒤 다시 눌러 주세요.');
    assert.deepEqual(h.navigations, []);
    assert.equal(h.banner() === null, false, 'still showing');
  });

  it('back from the background: what arrived meanwhile is the OS push\'s (no banner); a request while active is announced', async (t) => {
    const h = harness(t);
    h.incoming = [row('a')];
    await h.mount();
    await h.app('background');
    assert.equal(h.interval(), false, 'nothing is read in the background');
    const before = h.reads;
    h.incoming = [row('away'), row('a')];
    await h.read();
    assert.equal(h.reads, before, 'no read while away');
    await h.app('active');
    assert.equal(h.reads > before, true, 'read at once on return');
    assert.equal(h.banner(), null, 'arrived while away: a baseline');
    h.incoming = [row('now'), row('away'), row('a')];
    await h.read();
    assert.deepEqual(h.banner(), { title: '친구 요청', detail: 'NOW님이 친구 요청을 보냈어요.' });
  });

  it('sign-out and another user: nothing of the previous session shows, and the new user starts from a baseline', async (t) => {
    const h = harness(t);
    await h.mount();
    h.incoming = [row('a')];
    await h.read();
    assert.equal(h.banner() === null, false);
    // Sign-out: no user, the cache cleared (clearSessionCache).
    h.userId = null; h.generation = 2; h.client.clear();
    await h.update();
    assert.equal(h.banner(), null);
    const reads = h.reads;
    h.incoming = [row('b'), row('c')];
    await h.read();
    assert.equal(h.reads, reads, 'signed out: nothing is read');
    // Another member signs in: their own pending requests are a baseline, not news.
    h.userId = 'u2';
    await h.update();
    assert.equal(h.banner(), null);
    h.incoming = [row('d'), row('b'), row('c')];
    await h.read();
    assert.deepEqual(h.banner(), { title: '친구 요청', detail: 'D님이 친구 요청을 보냈어요.' });
  });

  it("follows the member's 친구 요청 / 전체 알림 switches; unreadable settings show nothing; only on the main screens", async (t) => {
    const h = harness(t);
    h.settings = switches(false);
    await h.mount();
    assert.deepEqual([h.reads, h.interval()], [0, false], 'switched off: no reads for the banner');
    h.incoming = [row('a')];
    await h.read();
    assert.equal(h.banner(), null);
    // Turned on in 설정 > 알림 (the saved settings land in the same entry).
    await act(async () => { h.client.setQueryData(QUERY_KEYS.notifications.preferences('u1'), switches(true)); });
    await h.flush();
    assert.equal(h.banner(), null, 'what is pending when it is turned on is a baseline');
    h.incoming = [row('b'), row('a')];
    await h.read();
    assert.deepEqual(h.banner()?.detail, 'B님이 친구 요청을 보냈어요.');
    await act(async () => { h.client.setQueryData(QUERY_KEYS.notifications.preferences('u1'), switches(true, false)); });
    await h.flush();
    assert.equal(h.interval(), false, '전체 알림 off');

    const failed = harness(t);
    failed.settingsFailure = Object.assign(new Error('network'), { code: 'ERR_NETWORK' });
    await failed.mount();
    failed.incoming = [row('a')];
    await failed.read();
    assert.deepEqual([failed.banner(), failed.interval()], [null, false]);

    const entry = harness(t);
    entry.route = 'ModeSelection';
    await entry.mount();
    assert.deepEqual([entry.reads, entry.banner()], [0, null], 'before the main screens');
  });

  it('a burst is one banner (외 N명); more while it shows wait as one; a request handled elsewhere is dropped from the wait', async (t) => {
    const h = harness(t);
    await h.mount();
    h.incoming = [row('c'), row('b'), row('a')];
    await h.read();
    assert.deepEqual(h.banner()?.detail, 'A님 외 2명이 친구 요청을 보냈어요.');
    h.incoming = [row('e'), row('d'), ...h.incoming];
    await h.read();
    // Accepted on another device before its turn.
    h.incoming = h.incoming.filter((item: Row) => item.requestId !== 'request-d');
    await h.read();
    await h.open();
    assert.deepEqual(h.banner()?.detail, 'E님이 친구 요청을 보냈어요.');
    await h.open();
    assert.equal(h.banner(), null);
  });

  it('shares the one top place with the fill banner: it waits while a fill shows, then appears', async (t) => {
    const h = harness(t);
    h.fill = { id: 'general:o-1', title: '삼성전자 매수 체결 완료', detail: null };
    await h.mount();
    h.incoming = [row('a')];
    await h.read();
    assert.deepEqual([h.fillShown(), h.banner()], [true, null], 'never two banners at once');
    h.fill = null;
    await h.update();
    assert.deepEqual([h.fillShown(), h.banner()?.detail], [false, 'A님이 친구 요청을 보냈어요.']);
    // And the reverse: a fill waits for the friend banner.
    h.fill = { id: 'general:o-2', title: '삼성전자 매도 체결 완료', detail: null };
    await h.update();
    assert.deepEqual([h.fillShown(), h.banner() === null], [false, false]);
    await h.open();
    assert.deepEqual([h.fillShown(), h.banner()], [true, null]);
  });
});

it('two screens watching 받은 요청 at the same 30 s pace share one read per period (no double polling)', async (t) => {
  // Node is a "server" to React Query (no intervals there); the app is not.
  const server = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  t.after(() => environmentManager.setIsServer(() => server));
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const settle = async () => { for (let i = 0; i < 20; i++) { t.mock.timers.tick(0); await Promise.resolve(); } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let reads = 0;
  const options = () => ({
    queryKey: QUERY_KEYS.friends.requests,
    queryFn: async () => { reads++; return { users: [], pagination: { nextOffset: null } }; },
    initialPageParam: 0,
    getNextPageParam: () => undefined,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  // The banner's watcher, then the MY dot a little later.
  const banner = new InfiniteQueryObserver(client, options());
  const stopBanner = banner.subscribe(() => {});
  await settle();
  t.mock.timers.tick(7_000); await settle();
  const dot = new InfiniteQueryObserver(client, options());
  const stopDot = dot.subscribe(() => {});
  await settle();
  const start = reads;
  // Second by second, so a read finishes before the next timer (a second poller would show).
  for (let second = 0; second < 120; second++) { t.mock.timers.tick(1_000); await settle(); }
  assert.equal(reads - start, 4, `one read per 30 s with both watching (got ${reads - start})`);
  stopBanner(); stopDot(); client.clear();
});
