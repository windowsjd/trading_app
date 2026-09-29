import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import type { FriendUser } from './api.ts';
const require = createRequire(import.meta.url);
const React = require('react');
const { QueryClient } = require('@tanstack/react-query');
const { elements, load } = require('../../../test/ledgerTestHarness.cjs');
const user: FriendUser = { userId: 'target', nickname: '아주긴친구닉네임'.repeat(8), profileImageUrl: null, relationship: 'friend', requestId: 'relationship' };
function screenHarness() {
  const slots: unknown[] = []; let index = 0;
  const mutations: any[] = [], navigations: any[] = [], alerts: any[] = [];
  const query: any = { data: { pages: [{ users: [user], pagination: { nextOffset: null } }] }, refetch: async () => {}, hasNextPage: false };
  const h: any = { mutations, navigations, alerts, query, option: null, mutationOption: null };
  const Screen = load(resolve('src/screens/friends/FriendsScreen.tsx'), {
    react: { ...React, useCallback: (fn: any) => fn, useState: (initial: any) => { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value: any) => { slots[i] = value; }]; } },
    'react-native': { FlatList: 'FlatList', View: 'View', Text: 'Text', Image: 'Image', TextInput: 'TextInput', StyleSheet: { create: (value: any) => value }, Alert: { alert: (...args: any[]) => alerts.push(args) } },
    '@react-navigation/native': { useFocusEffect: () => {} },
    '@tanstack/react-query': { useQueryClient: () => ({}), useInfiniteQuery: (option: any) => { h.option = option; return query; }, useMutation: (option: any) => { h.mutationOption = option; return { mutate: (value: any) => mutations.push(value) }; } },
    '../../features/friends/api': { getFriends: (...args: any[]) => args, changeFriendship: () => {} },
    '../../features/friends/cache': { refreshFriendship: async () => {} },
    '../../components/states/InlineEmptyState': { __esModule: true, default: 'InlineEmptyState' },
  }).default;
  h.render = () => { index = 0; return Screen({ navigation: { navigate: (...args: any[]) => navigations.push(args) } }); };
  return h;
}
function pressText(tree: any, text: string) {
  const button = elements(tree, 'Pressable').find((node: any) => elements(node, 'Text').some((child: any) => child.props.children === text));
  assert.ok(button, `Missing button ${text}`); button.props.onPress();
}
describe('friends user flow', () => {
  it('searches the submitted nickname with its own key and server pagination', () => {
    const h = screenHarness(); let tree = h.render();
    pressText(tree.props.ListHeaderComponent, '친구 찾기'); tree = h.render();
    assert.equal(h.option.enabled, false);
    elements(tree.props.ListHeaderComponent, 'TextInput')[0].props.onChangeText('  친구  ');
    tree = h.render(); pressText(tree.props.ListHeaderComponent, '검색'); tree = h.render();
    assert.deepEqual(h.option.queryKey, QUERY_KEYS.friends.search('친구'));
    assert.deepEqual(h.option.queryFn({ pageParam: 30 }), ['search', '친구', 30, undefined]);
    assert.equal(h.option.getNextPageParam({ pagination: { nextOffset: 60 } }), 60);
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
describe('overall menu and server privacy setting', () => {
  it('routes to MY, friends, notices and settings', () => {
    const navigations: string[] = [];
    const Screen = load(resolve('src/screens/my/OverallScreen.tsx'), { 'react-native': { ScrollView: 'ScrollView', Text: 'Text', StyleSheet: { create: (value: any) => value } } }).default;
    const tree = Screen({ navigation: { navigate: (route: string) => navigations.push(route) } });
    elements(tree, 'Pressable').forEach((node: any) => node.props.onPress());
    assert.deepEqual(navigations, ['My', 'Friends', 'Notices', 'Settings']);
  });
  it('renders the persisted Boolean and sends a Boolean change without optimistic disclosure', async () => {
    const mutations: any[] = [], options: any[] = [], saved: any[] = [];
    const data = { id: 'me', nickname: 'me', portfolioPublic: false };
    const Screen = load(resolve('src/screens/my/SettingsScreen.tsx'), {
      react: { ...React, useState: (value: any) => [value, () => {}], useEffect: () => {} },
      'react-native': { View: 'View', Text: 'Text', SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView', Switch: 'Switch', TextInput: 'TextInput', Alert: { alert: () => {} }, StyleSheet: { create: (value: any) => value } },
      '@tanstack/react-query': { useQuery: () => ({ data }), useQueryClient: () => ({ setQueryData: (...args: any[]) => saved.push(args), invalidateQueries: async () => {} }), useMutation: (option: any) => { options.push(option); return { mutate: (value: any) => mutations.push(value) }; } },
      '../../features/me/api': { getMe: () => {}, updateMe: async (value: any) => value },
      '../../features/auth/useLogout': { useLogout: () => () => {} },
      '../../components/states/FullPageLoading': { default: 'Loading' }, '../../components/states/ErrorState': { default: 'Error' },
    }).default;
    const toggle = elements(Screen({}), 'Switch')[0];
    assert.equal(toggle.props.value, false);
    toggle.props.onValueChange(true);
    assert.deepEqual(mutations, [true]); assert.equal(toggle.props.value, false);
    assert.deepEqual(await options[1].mutationFn(true), { portfolioPublic: true });
    await options[1].onSuccess({ ...data, portfolioPublic: true });
    assert.deepEqual(saved[0], [QUERY_KEYS.me, { ...data, portfolioPublic: true }]);
  });
});
