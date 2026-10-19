import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { clearSessionCache } from '../auth/sessionCache.ts';
import type { FriendUser } from './api.ts';
const require = createRequire(import.meta.url);
const React = require('react');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { create, act } = require('react-test-renderer');
const { elements, load } = require('../../../test/ledgerTestHarness.cjs');
const user: FriendUser = { userId: 'target', nickname: '아주긴친구닉네임'.repeat(8), profileImageUrl: null, relationship: 'friend', requestId: 'relationship' };
function screenHarness() {
  const slots: unknown[] = []; let index = 0;
  const mutations: any[] = [], navigations: any[] = [], alerts: any[] = [];
  const query: any = { data: { pages: [{ users: [user], pagination: { nextOffset: null } }] }, refetch: async () => {}, hasNextPage: false };
  const h: any = { mutations, navigations, alerts, query, option: null, mutationOption: null };
  const Screen = load(resolve('src/screens/friends/FriendsScreen.tsx'), {
    react: { ...React, useRef: (value: any) => ({ current: value }), useEffect() {}, useCallback: (fn: any) => fn, useState: (initial: any) => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = value; }]; } },
    '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
    'react-native': { FlatList: 'FlatList', View: 'View', Text: 'Text', Image: 'Image', TextInput: 'TextInput', StyleSheet: { create: (value: any) => value }, Alert: { alert: (...args: any[]) => alerts.push(args) } },
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
    '@react-navigation/native': { useFocusEffect: () => {} },
    '@tanstack/react-query': { useQueryClient: () => ({}), useInfiniteQuery: (option: any) => { h.option = option; return query; }, useMutation: (option: any) => { h.mutationOption = option; return { reset() {}, mutate: (value: any) => mutations.push(value) }; } },
    '../../features/friends/api': { getFriends: (...args: any[]) => args, changeFriendship: () => {} },
    '../../features/friends/cache': { refreshFriendship: async () => {} },
    '../../components/states/InlineEmptyState': { __esModule: true, default: 'InlineEmptyState' },
  }).default;
  h.render = (route?: unknown) => { index = 0; return Screen({ navigation: { navigate: (...args: any[]) => navigations.push(args) }, route }); };
  return h;
}
function pressText(tree: any, text: string) {
  const button = elements(tree, 'Pressable').find((node: any) => elements(node, 'Text').some((child: any) => child.props.children === text));
  assert.ok(button, `Missing button ${text}`); button.props.onPress();
}
describe('friends user flow', () => {
  it('a friend-request push opens 받은 요청; without it the list opens', () => {
    const pushed = screenHarness();
    const tree = pushed.render({ params: { tab: 'requests' } });
    assert.deepEqual(pushed.option.queryKey, QUERY_KEYS.friends.requests);
    const tabs = elements(tree.props.ListHeaderComponent, 'Pressable').filter((node: any) => node.props.accessibilityRole === 'tab');
    assert.deepEqual(tabs.map((node: any) => node.props['aria-selected']), [false, true, false]);
    const plain = screenHarness();
    plain.render();
    assert.deepEqual(plain.option.queryKey, QUERY_KEYS.friends.list);
  });
  it('searches the submitted nickname with its own key and server pagination', () => {
    const h = screenHarness(); let tree = h.render();
    pressText(tree.props.ListHeaderComponent, '친구 찾기'); tree = h.render();
    assert.equal(h.option.enabled, false);
    elements(tree.props.ListHeaderComponent, 'TextInput')[0].props.onChangeText('  친구  ');
    tree = h.render();
    elements(tree.props.ListHeaderComponent, 'Pressable').find(node => node.props.accessibilityLabel === '친구 검색').props.onPress();
    tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.search('친구'));
    assert.deepEqual(h.option.queryFn({ pageParam: 30 }), ['search', '친구', 30, undefined]);
    assert.equal(h.option.getNextPageParam({ pagination: { nextOffset: 60 } }), 60);
  });
  it('shares trimmed keyboard/icon search, ignores blanks and hides only the search-before empty state', () => {
    const h = screenHarness();
    pressText(h.render().props.ListHeaderComponent, '친구 찾기');
    let tree = h.render();
    assert.equal(tree.props.ListEmptyComponent, null);
    const input = () => elements(tree.props.ListHeaderComponent, 'TextInput')[0];
    const search = () => elements(tree.props.ListHeaderComponent, 'Pressable').find(node => node.props.accessibilityLabel === '친구 검색');
    assert.equal(input().props.returnKeyType, 'search');
    assert.equal(search().props.disabled, true);
    input().props.onChangeText('   '); tree = h.render(); input().props.onSubmitEditing(); tree = h.render();
    assert.equal(h.option.enabled, false);
    input().props.onChangeText('  검색어  '); tree = h.render(); input().props.onSubmitEditing(); tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.search('검색어'));
    assert.equal(tree.props.ListEmptyComponent.props.title, '검색 결과가 없습니다.');
    input().props.onChangeText(''); tree = h.render(); input().props.onSubmitEditing(); tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.search('검색어'), 'blank submit keeps the previous search');
    const tabs = elements(tree.props.ListHeaderComponent, 'Pressable').filter(node => node.props.accessibilityRole === 'tab');
    assert.deepEqual(tabs.map(node => node.props['aria-selected']), [false, false, true]);
    pressText(tree.props.ListHeaderComponent, '친구 목록'); tree = h.render();
    assert.equal(tree.props.ListEmptyComponent.props.title, '아직 친구가 없습니다.');
  });
  it('sends requests, accepts/rejects incoming requests and disables pending requests', () => {
    const h = screenHarness(), tree = h.render();
    for (const [relationship, labels] of [['none', ['친구 요청']], ['received', ['수락', '거절']], ['sent', []]] as const) {
      const row = tree.props.renderItem({ item: { ...user, relationship } });
      const buttons = elements(row).filter((node: any) => node.props.label);
      assert.deepEqual(buttons.map((node: any) => node.props.label), labels);
      buttons.forEach((node: any) => node.props.onPress());
    }
    assert.deepEqual(h.mutations.map((change: any) => change.action), ['request', 'accept', 'reject']);
  });
  it('opens a friend portfolio and removes only after the delete action', () => {
    const h = screenHarness(), tree = h.render(), row = tree.props.renderItem({ item: user });
    elements(row, 'Pressable')[0].props.onPress();
    assert.deepEqual(h.navigations, [['UserSeasonSummary', { userId: 'target' }]]);
    elements(row).find((node: any) => node.props.label === '친구 삭제').props.onPress();
    assert.equal(h.mutations.length, 0);
    h.alerts[0][2].find((button: any) => button.text === '삭제').onPress();
    assert.equal(h.mutations[0].action, 'remove');
    const inactive = tree.props.renderItem({ item: { ...user, active: false } });
    assert.equal(elements(inactive, 'Pressable')[0].props.disabled, true);
    assert.ok(elements(row, 'Text').some((node: any) => node.props.children === user.nickname));
    assert.ok(elements(row, 'Text').every((node: any) => node.props.numberOfLines === undefined));
  });
  it('uses separate incoming/list keys and distinguishes error from empty', () => {
    const h = screenHarness(); let tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.list);
    pressText(tree.props.ListHeaderComponent, '받은 요청'); tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.requests);
    h.query.isError = true; tree = h.render();
    assert.equal(tree.props.ListEmptyComponent, null);
  });
});
describe('friend API and targeted cache updates', () => {
  it('uses only v1-relative friend operations with no account or email payload', async () => {
    const calls: any[] = [];
    const client = Object.fromEntries(['get', 'post', 'delete'].map((method) => [method, async (...args: any[]) => { calls.push([method, ...args]); return { data: { data: { users: [] } } }; }]));
    const api = load(resolve('src/features/friends/api.ts'), { '../../services/api/client': { apiClient: client } });
    await api.getFriends('search', '친구', 30);
    await api.changeFriendship({ action: 'request', user });
    await api.changeFriendship({ action: 'accept', user });
    await api.changeFriendship({ action: 'reject', user });
    await api.changeFriendship({ action: 'remove', user });
    assert.deepEqual(calls.slice(1), [['post', '/friends/requests', { userId: 'target' }], ['post', '/friends/requests/relationship/accept'], ['post', '/friends/requests/relationship/reject'], ['delete', '/friends/relationship']]);
    assert.ok(calls[0][1].includes('offset=30'));
    assert.doesNotMatch(JSON.stringify(calls), /email|tradingAccount|api\/v2/);
  });
  it('revokes cached portfolio and friend ranking without clearing other accounts/rankings', async () => {
    const client = new QueryClient();
    const cache = load(resolve('src/features/friends/cache.ts'), {});
    const own = ['tradingAccount', 'portfolio', 'mine'];
    const all = QUERY_KEYS.ranking.list({ scope: 'all' });
    const friends = QUERY_KEYS.ranking.infiniteList({ scope: 'friends' });
    const summary = QUERY_KEYS.ranking.userSeasonSummary('target');
    for (const key of [own, all, friends, summary, QUERY_KEYS.friends.list]) client.setQueryData(key, { private: true });
    await cache.refreshFriendship(client, { action: 'remove', user });
    assert.equal(client.getQueryData(summary), undefined);
    assert.equal(client.getQueryData(friends), undefined);
    assert.deepEqual(client.getQueryData(own), { private: true });
    assert.deepEqual(client.getQueryData(all), { private: true });
    assert.equal(client.getQueryState(QUERY_KEYS.friends.list).isInvalidated, true);
    client.clear();
  });
});
/** MY 전체 with the pending-request answer the hook would give. */
function overallMenu(pending: boolean) {
  const navigations: string[] = [];
  const Screen = load(resolve('src/screens/my/OverallScreen.tsx'), {
    'react-native': { ScrollView: 'ScrollView', Text: 'Text', View: 'View', Platform: { OS: 'android' }, StyleSheet: { create: (value: any) => value } },
    '../../features/friends/usePendingFriendRequests': { usePendingFriendRequests: () => pending },
  }).default;
  const tree = Screen({ navigation: { navigate: (route: string) => navigations.push(route) } });
  const rows = elements(tree, 'Pressable');
  const dots = (row: any) => elements(row, 'View').filter((node: any) => node.props.testID === 'overall-Friends-request-dot');
  return { navigations, rows, dots, row: (route: string) => rows.find((node: any) => node.props.testID === `overall-${route}`) };
}

describe('overall menu and server privacy setting', () => {
  it('routes to MY, friends, records, notices, inquiry and settings', () => {
    const menu = overallMenu(false);
    menu.rows.forEach((node: any) => node.props.onPress());
    assert.deepEqual(menu.navigations, ['My', 'Friends', 'Record', 'Notices', 'Inquiry', 'Settings']);
  });
  it('marks 친구 with a small red dot (not a count) only while received requests wait, without moving the box', () => {
    const none = overallMenu(false);
    assert.equal(none.rows.some((row: any) => none.dots(row).length > 0), false, 'no dot without pending requests');
    assert.equal(none.row('Friends').props.accessibilityLabel === undefined, true);
    const pending = overallMenu(true);
    const friends = pending.row('Friends');
    const [dot] = pending.dots(friends);
    assert.equal(dot === undefined, false);
    assert.deepEqual(pending.rows.filter((row: any) => pending.dots(row).length > 0).map((row: any) => row.props.testID), ['overall-Friends']);
    // Top-right corner, inside the box: absolutely placed, so the box keeps its size and the label its place.
    const { position, top, right, width, height, borderRadius, backgroundColor } = dot.props.style;
    assert.deepEqual([position, top, right, width, height, borderRadius, backgroundColor], ['absolute', 10, 10, 8, 8, 4, '#F04452']);
    assert.deepEqual(friends.props.style, none.row('Friends').props.style);
    assert.equal(elements(dot, 'Text').length, 0, 'a plain dot, no number');
    assert.equal(dot.props.pointerEvents, 'none');
    assert.equal(dot.props.importantForAccessibility, 'no-hide-descendants');
    assert.equal(friends.props.accessibilityLabel, '친구, 받은 친구 요청 있음');
  });
  it('renders the persisted Boolean and updates /me cache before PATCH resolves', async () => {
    const mutations: any[] = [], options: any[] = [], saved: any[] = [];
    const data = { id: 'me', nickname: 'me', portfolioPublic: false };
    let cached = data;
    const Screen = load(resolve('src/screens/my/SettingsScreen.tsx'), {
      react: { ...React, useState: (value: any) => [value, () => {}], useEffect: () => {}, useRef: (value: any) => ({ current: value }) },
      '../../components/states/AdminDiagnosticPanel': { default: 'AdminDiagnosticPanel', __esModule: true },
      'react-native': { View: 'View', Text: 'Text', SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView', Switch: 'Switch', Platform: { OS: 'android' }, TextInput: 'TextInput', Alert: { alert: () => {} }, StyleSheet: { create: (value: any) => value } },
      '@tanstack/react-query': {
        useQuery: () => ({ data }),
        useQueryClient: () => ({
          getQueryData: () => cached,
          setQueryData: (...args: any[]) => { cached = typeof args[1] === 'function' ? args[1](cached) : args[1]; saved.push(args); },
          cancelQueries: async () => {},
          invalidateQueries: async () => {},
        }),
        useMutation: (option: any) => { options.push(option); return { isPending: false, mutate: (value: any) => mutations.push(value) }; },
      },
      '../../features/me/api': { getMe: () => {}, updateMe: async (value: any) => value },
      '../../features/me/profileImage': { selectProfileImage: async () => null },
      '../../features/me/profileImageCache': { applyProfileImageResponse: async () => {} },
      '../../features/auth/useLogout': { useLogout: () => () => {} },
      '../../components/states/FullPageLoading': { default: 'Loading' }, '../../components/states/ErrorState': { default: 'Error' },
      '../../features/notifications/NotificationSettingsSection': { default: 'NotificationSettingsSection', __esModule: true },
    }).default;
    const toggle = elements(Screen({}), 'Switch')[0];
    assert.equal(toggle.props.value, false);
    toggle.props.onValueChange(true);
    assert.deepEqual(mutations, [true]);
    const privacy = options.find(option => option.onSettled);
    const context = await privacy.onMutate(true);
    assert.equal(cached.portfolioPublic, true);
    assert.equal(cached.nickname, 'me');
    assert.deepEqual(await privacy.mutationFn(true), { portfolioPublic: true });
    await privacy.onSuccess({ ...data, portfolioPublic: true }, true, context);
    assert.deepEqual(cached, { ...data, portfolioPublic: true });
    assert.equal(saved.at(-1)[0], QUERY_KEYS.me);
  });
});

/** usePendingFriendRequests over a real QueryClient and the real friends API module. */
function pendingHarness(t: TestContext) {
  const h: any = { reads: [] as string[], incoming: [] as FriendUser[], failure: null as unknown, values: [] as boolean[] };
  h.client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const api = load(resolve('src/features/friends/api.ts'), { '../../services/api/client': { apiClient: { get: async (path: string) => {
    h.reads.push(path);
    if (h.gate) await h.gate;
    if (h.failure) throw h.failure;
    const users = h.incoming;
    return { data: { data: { users, pagination: { limit: 30, offset: 0, total: users.length, returned: users.length, nextOffset: null } } } };
  } } } });
  let focusEffect: () => void = () => {};
  const { usePendingFriendRequests } = load(resolve('src/features/friends/usePendingFriendRequests.ts'), {
    './api': api,
    // Focus = mount; `h.focus()` is a return to the screen.
    '@react-navigation/native': { useFocusEffect: (effect: () => void) => { focusEffect = effect; React.useEffect(() => effect(), [effect]); } },
  });
  function Probe() { h.values.push(usePendingFriendRequests()); return null; }
  const settle = () => act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  h.value = () => h.values.at(-1);
  h.mount = async () => { await act(async () => { h.renderer = create(React.createElement(QueryClientProvider, { client: h.client }, React.createElement(Probe))); }); };
  h.settle = settle;
  h.focus = async () => { await act(async () => focusEffect()); await settle(); };
  h.unmount = async () => { if (h.renderer) await act(async () => h.renderer.unmount()); h.renderer = null; };
  t.after(async () => { await h.unmount(); h.client.clear(); });
  return h;
}
const request = (id: string): FriendUser => ({ ...user, userId: id, nickname: id, relationship: 'received', requestId: `request-${id}` });

describe('MY 전체 친구 dot: pending received requests', () => {
  it("reads the server's 받은 요청 list and is true only once it holds a request", async (t) => {
    const h = pendingHarness(t);
    h.incoming = [request('a')];
    let release = () => {};
    h.gate = new Promise<void>((done) => { release = done; });
    await h.mount();
    await h.settle();
    assert.equal(h.reads.length > 0, true, 'the read is out');
    assert.equal(h.value(), false, 'unknown while the first read is out');
    h.gate = null;
    release();
    await h.settle();
    assert.equal(h.value(), true);
    assert.equal(h.reads.every((path: string) => path.startsWith('/friends/requests?')), true, h.reads.join());
    // The 친구 screen's 받은 요청 entry: one cache entry for both.
    assert.equal(h.client.getQueryData(QUERY_KEYS.friends.requests).pages[0].users.length, 1);
  });

  it('stays off with no received request', async (t) => {
    const h = pendingHarness(t);
    await h.mount();
    await h.settle();
    assert.equal(h.value(), false);
  });

  it('clears after the last request is accepted or rejected, and comes back on return when a new one arrives', async (t) => {
    const cache = load(resolve('src/features/friends/cache.ts'), {});
    for (const action of ['accept', 'reject'] as const) {
      const h = pendingHarness(t);
      h.incoming = [request('a')];
      await h.mount();
      await h.settle();
      assert.equal(h.value(), true, action);
      // The 친구 screen's answer refreshes the shared entries (refreshFriendship).
      h.incoming = [];
      await act(async () => { await cache.refreshFriendship(h.client, { action, user: request('a') }); });
      await h.settle();
      assert.equal(h.value(), false, `${action}: no request left`);
      // Someone sends a new one while the member is elsewhere: shown on return.
      h.incoming = [request('b')];
      await h.focus();
      assert.equal(h.value(), true, `${action}: a new request on return`);
      await h.unmount();
    }
  });

  it('a failed read never shows a dot', async (t) => {
    const h = pendingHarness(t);
    h.failure = Object.assign(new Error('network'), { code: 'ERR_NETWORK' });
    h.incoming = [request('a')];
    await h.mount();
    await h.settle();
    assert.equal(h.value(), false, 'first read failed');
    h.failure = null;
    await h.focus();
    assert.equal(h.value(), true);
    h.failure = Object.assign(new Error('network'), { code: 'ERR_NETWORK' });
    await h.focus();
    assert.equal(h.value(), false, 'the latest read failed: not confirmed');
  });

  it("another member signing in never sees the previous member's requests", async (t) => {
    const h = pendingHarness(t);
    h.incoming = [request('a')];
    await h.mount();
    await h.settle();
    assert.equal(h.value(), true);
    // Sign-out leaves the tabs and clears every cached read; the next member starts over.
    await h.unmount();
    clearSessionCache(h.client);
    h.incoming = [];
    h.values.length = 0;
    await h.mount();
    assert.equal(h.value(), false, 'nothing carried over while the new read is out');
    await h.settle();
    assert.deepEqual([...new Set(h.values)], [false]);
  });
});
