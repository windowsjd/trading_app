import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { returnToEntryTab } from './marketTabEntry.ts';
import { openCommunityPostFromHome, postDetailId, postDetailOptions } from './communityPostEntry.ts';

const require = createRequire(import.meta.url);
// The real navigation core the app's native-stack and bottom-tabs are built on
// (the same model as marketTabEntry.test.ts).
const React = require('react');
const { act, create } = require('react-test-renderer');
const {
  BaseNavigationContainer, CommonActions, StackActions, StackRouter, TabRouter,
  createNavigationContainerRef, createNavigatorFactory, useNavigationBuilder,
} = require('@react-navigation/core');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const Stack = createNavigatorFactory(({ children, screenListeners }: any) => {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children, screenListeners });
  return h(NavigationContent, null, state.routes.map((route: any) => h(React.Fragment, { key: route.key }, descriptors[route.key].render())));
});
const Tabs = createNavigatorFactory(({ children, initialRouteName }: any) => {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(TabRouter, { children, initialRouteName });
  const focused = state.routes[state.index].key;
  const [loaded, setLoaded] = React.useState([focused]);
  if (!loaded.includes(focused)) setLoaded([...loaded, focused]);
  return h(NavigationContent, null, state.routes.filter((route: any) => loaded.includes(route.key))
    .map((route: any) => h(React.Fragment, { key: route.key }, descriptors[route.key].render())));
});

const screens: Record<string, { navigation: any; route: any }> = {};
const screen = (name: string) => function Screen(props: any) { screens[name] = props; return null; };
const stack = (names: string[], listeners?: unknown, extra: Record<string, object> = {}) => function StackScreen() {
  const S = Stack();
  return h(S.Navigator, { screenListeners: listeners }, ...names.map(name => h(S.Screen, { key: name, name, component: screen(name), ...extra[name] })));
};
// As both app stacks register it: one PostDetail screen per post.
const POST_IDS = { PostDetail: { getId: postDetailId } };
// HomeStack, CommunityStack (beginner/general) and RankingStack (season), by route name.
const HomeStack = stack(['Home', 'Portfolio']);
const CommunityStack = stack(['Community', 'PostDetail', 'PostCompose', 'UserSeasonSummary'], returnToEntryTab, POST_IDS);
const RankingStack = stack(['Ranking', 'UserSeasonSummary', 'PostDetail', 'PostCompose'], returnToEntryTab, POST_IDS);
const tabsFor = (season: boolean) => function MainTabs() {
  const T = Tabs();
  return h(T.Navigator, { initialRouteName: 'HomeTab' },
    h(T.Screen, { name: 'HomeTab', component: HomeStack }),
    h(T.Screen, { name: 'MarketTab', component: screen('Market') }),
    season
      ? h(T.Screen, { name: 'RankingTab', component: RankingStack })
      : h(T.Screen, { name: 'CommunityTab', component: CommunityStack }),
    h(T.Screen, { name: 'WalletTab', component: screen('Wallet') }),
    h(T.Screen, { name: 'MyTab', component: screen('My') }));
};

let renderer: any = null;
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

function app(season: boolean) {
  for (const name of Object.keys(screens)) delete screens[name];
  const ref = createNavigationContainerRef();
  const Root = Stack();
  act(() => {
    renderer = create(h(BaseNavigationContainer, { ref },
      h(Root.Navigator, null, h(Root.Screen, { name: 'MainTabs', component: tabsFor(season) }))));
  });
  const tabsState = () => ref.getRootState().routes[0].state;
  const tab = (name: string) => tabsState().routes.find((route: any) => route.name === name);
  return {
    run: (step: () => void) => act(step),
    at: () => {
      const focused = tabsState().routes[tabsState().index];
      return `${focused.name}/${focused.state ? focused.state.routes[focused.state.index].name : focused.name}`;
    },
    stack: (name: string) => tab(name).state?.routes.map((route: any) => route.name) ?? null,
    posts: (name: string) => tab(name).state?.routes.map((route: any) => (route.params?.postId ? `${route.name}:${route.params.postId}` : route.name)) ?? null,
    keys: (name: string) => tab(name).state?.routes.map((route: any) => route.key) ?? null,
    systemBack: () => { assert.equal(ref.canGoBack(), true); act(() => ref.goBack()); },
    headerBack: (name: string) => act(() => {
      const { navigation, route } = screens[name];
      navigation.dispatch({ ...StackActions.pop(), source: route.key, target: navigation.getState().key });
    }),
    tabPress: (name: string) => act(() => {
      screens.Home.navigation.getParent().dispatch({ ...CommonActions.navigate(tab(name)), target: tabsState().key });
    }),
  };
}

describe("Home's community card opens the post itself (2026-11-07 (3))", () => {
  for (const season of [false, true]) {
    const tabName = season ? 'RankingTab' : 'CommunityTab';
    const list = season ? 'Ranking' : 'Community';
    it(`${season ? 'season (리그)' : 'beginner/general (커뮤니티)'}: the post on its stack's list, and back returns to Home`, () => {
      for (const back of ['system', 'header'] as const) {
        const a = app(season);
        a.run(() => screens.Home.navigation.navigate('MainTabs', openCommunityPostFromHome('post-1', season)));
        assert.equal(a.at(), `${tabName}/PostDetail`);
        assert.equal(screens.PostDetail.route.params.postId, 'post-1');
        // A stack never opened before still has its list underneath (a back button, no orphan detail).
        assert.deepEqual(a.stack(tabName), [list, 'PostDetail']);
        if (back === 'system') a.systemBack(); else a.headerBack('PostDetail');
        assert.equal(a.at(), 'HomeTab/Home', back);
        assert.deepEqual(a.stack(tabName), [list], 'the detail left the community stack');
        // The tab later opens its own list, never a leftover post.
        a.tabPress(tabName);
        assert.equal(a.at(), `${tabName}/${list}`);
      }
    });
  }

  for (const season of [false, true]) {
    const tabName = season ? 'RankingTab' : 'CommunityTab';
    const list = season ? 'Ranking' : 'Community';
    it(`${season ? '리그' : '커뮤니티'}: a post already open there keeps its own screen; the card's post gets another, and back returns to Home`, () => {
      const a = app(season);
      a.tabPress(tabName);
      a.run(() => screens[list].navigation.navigate('PostDetail', { postId: 'x' }));
      const xKey = a.keys(tabName)[1];
      a.tabPress('HomeTab');
      a.run(() => screens.Home.navigation.navigate('MainTabs', openCommunityPostFromHome('y', season)));
      assert.equal(a.at(), `${tabName}/PostDetail`);
      // Never post x's screen (its comment draft, reply target, sheet) showing post y.
      assert.deepEqual(a.posts(tabName), [list, 'PostDetail:x', 'PostDetail:y']);
      assert.equal(a.keys(tabName)[1], xKey);
      a.systemBack();
      assert.equal(a.at(), 'HomeTab/Home');
      assert.deepEqual(a.posts(tabName), [list, 'PostDetail:x']);
      // The post already open is brought back, not stacked twice.
      a.run(() => screens.Home.navigation.navigate('MainTabs', openCommunityPostFromHome('x', season)));
      assert.deepEqual(a.posts(tabName), [list, 'PostDetail:x']);
      assert.equal(a.keys(tabName)[1], xKey);
    });
  }

  it('a post opened from the list itself still goes back to the list', () => {
    const a = app(false);
    a.tabPress('CommunityTab');
    a.run(() => screens.Community.navigation.navigate('PostDetail', { postId: 'post-2' }));
    a.systemBack();
    assert.equal(a.at(), 'CommunityTab/Community');
  });

  it('the cross-tab post header shows the arrow alone (뒤로 for screen readers); the list entry keeps its default', () => {
    assert.deepEqual(postDetailOptions({ returnTab: 'HomeTab' }), { title: '커뮤니티', headerBackTitle: '뒤로', headerBackButtonDisplayMode: 'minimal' });
    assert.deepEqual(postDetailOptions({}), { title: '커뮤니티' });
    assert.deepEqual(postDetailOptions(undefined), { title: '커뮤니티' });
  });
});
