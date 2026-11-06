import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { HOME_TAB, MAIN_TABS_BACK_BEHAVIOR, mainTabsRouter } from './tabBackPolicy.ts';
import { openInMarketTab, returnToEntryTab } from './marketTabEntry.ts';
import { setQuestNavigationGuard } from '../../features/quest/questNavigationGuard.ts';

const require = createRequire(import.meta.url);
// The real navigation core (state builder, nested params, routers, back
// handling) the app's native-stack and bottom-tabs navigators are built on.
const React = require('react');
const { act, create } = require('react-test-renderer');
const {
  BaseNavigationContainer, CommonActions, StackRouter, TabRouter,
  createNavigationContainerRef, createNavigatorFactory, useNavigationBuilder,
} = require('@react-navigation/core');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

const Stack = createNavigatorFactory(({ children, screenListeners }: any) => {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children, screenListeners });
  return h(NavigationContent, null, state.routes.map((route: any) => h(React.Fragment, { key: route.key }, descriptors[route.key].render())));
});
// Tabs render a tab once it has been focused (bottom-tabs `lazy`).
const Tabs = createNavigatorFactory(({ children, initialRouteName, backBehavior, UNSTABLE_router }: any) => {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(TabRouter, { children, initialRouteName, backBehavior, UNSTABLE_router });
  const focused = state.routes[state.index].key;
  const [loaded, setLoaded] = React.useState([focused]);
  if (!loaded.includes(focused)) setLoaded([...loaded, focused]);
  return h(NavigationContent, null, state.routes.filter((route: any) => loaded.includes(route.key))
    .map((route: any) => h(React.Fragment, { key: route.key }, descriptors[route.key].render())));
});

const screens: Record<string, { navigation: any; route: any }> = {};
const screen = (name: string) => function Screen(props: any) { screens[name] = props; return null; };
const stack = (names: string[], listeners?: unknown) => function StackScreen() {
  const S = Stack();
  return h(S.Navigator, { screenListeners: listeners }, ...names.map(name => h(S.Screen, { key: name, name, component: screen(name) })));
};
const HomeStack = stack(['Home', 'Portfolio']);
const MarketStack = stack(['Market', 'MarketSearch', 'AssetDetail', 'Order', 'FuturesDetail', 'Futures'], returnToEntryTab);
const WalletStack = stack(['Wallet', 'WalletTransactions']);
const RankingStack = stack(['Ranking']);
const MyStack = stack(['Overall', 'Friends', 'Notices']);
/** MainTabs as the app wires it; `legacy` is the previous default (`firstRoute`, no router). */
const mainTabs = (legacy = false) => function MainTabs() {
  const T = Tabs();
  return h(T.Navigator, legacy ? { initialRouteName: 'HomeTab' }
    : { initialRouteName: 'HomeTab', backBehavior: MAIN_TABS_BACK_BEHAVIOR, UNSTABLE_router: mainTabsRouter },
  h(T.Screen, { name: 'HomeTab', component: HomeStack }),
  h(T.Screen, { name: 'MarketTab', component: MarketStack }),
  h(T.Screen, { name: 'RankingTab', component: RankingStack }),
  h(T.Screen, { name: 'WalletTab', component: WalletStack }),
  h(T.Screen, { name: 'MyTab', component: MyStack }));
};

let renderer: any = null;
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  setQuestNavigationGuard(noticed, null);
});
let notices = 0;
const noticed = () => { notices += 1; };

function app({ legacy = false, openOn }: { legacy?: boolean; openOn?: string } = {}) {
  for (const name of Object.keys(screens)) delete screens[name];
  const ref = createNavigationContainerRef();
  const Root = Stack();
  act(() => {
    renderer = create(h(BaseNavigationContainer, { ref },
      h(Root.Navigator, null,
        h(Root.Screen, { name: 'MainTabs', component: mainTabs(legacy), initialParams: openOn ? { screen: openOn } : undefined }),
        h(Root.Screen, { name: 'TradeHistory', component: screen('TradeHistory') }))));
  });
  const tabsState = () => ref.getRootState().routes[0].state;
  const tab = (name: string) => tabsState().routes.find((route: any) => route.name === name);
  return {
    ref,
    run: (step: () => void) => act(step),
    at: () => {
      const focused = tabsState().routes[tabsState().index];
      return `${focused.name}/${focused.state ? focused.state.routes[focused.state.index].name : focused.name}`;
    },
    stack: (name: string) => tab(name).state?.routes.map((route: any) => route.name) ?? null,
    /** Android back: NavigationContainer's hardware back handler. False when the app would be left. */
    back: () => {
      if (!ref.canGoBack()) return false;
      act(() => ref.goBack());
      return true;
    },
    /** A bottom-tab press, as BottomTabBar dispatches it. */
    tabPress: (name: string) => act(() => {
      ref.dispatch({ ...CommonActions.navigate(tab(name)), target: tabsState().key });
    }),
  };
}

describe('Android back on a tab first screen (tabBackPolicy)', () => {
  it('root cause: the previous default sent every tab to Home, whatever tab the user came from', () => {
    const a = app({ legacy: true });
    a.tabPress('MarketTab');
    a.tabPress('WalletTab');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'HomeTab/Home', 'Market, the tab before Wallet, was skipped');
  });

  it('returns through the tabs in the order they were visited; only Home with nothing before it leaves', () => {
    const a = app();
    a.tabPress('MarketTab');
    a.tabPress('WalletTab');
    a.tabPress('MyTab');
    for (const expected of ['WalletTab/Wallet', 'MarketTab/Market', 'HomeTab/Home']) {
      assert.equal(a.back(), true);
      assert.equal(a.at(), expected);
    }
    assert.equal(a.back(), false, 'Home: the app is left (after AndroidExitConfirm asks)');
  });

  it('a tab visited again counts once, at its latest visit, and Back never loops between two tabs', () => {
    const a = app();
    a.tabPress('MarketTab');
    a.tabPress(HOME_TAB);
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'MarketTab/Market', 'the tab seen before Home');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'HomeTab/Home', 'no tab left before Market: Home');
    assert.equal(a.back(), false, 'Home again leaves: the step to Home kept no way back to Market');
  });

  it('tabs opened on another tab (a push, a deep link): Back goes to Home, then leaves', () => {
    const a = app({ openOn: 'WalletTab' });
    assert.equal(a.at(), 'WalletTab/Wallet');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'HomeTab/Home');
    assert.equal(a.back(), false);
  });

  it("a tab's own screens pop first; the tab history continues after its first screen", () => {
    const a = app();
    a.tabPress('MarketTab');
    a.tabPress('WalletTab');
    a.run(() => screens.Wallet.navigation.navigate('WalletTransactions'));
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'WalletTab/Wallet');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'MarketTab/Market');
  });

  it('a detail opened from Home returns there and leaves no Market visit behind', () => {
    const a = app();
    a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'X', returnTab: 'HomeTab' })));
    assert.equal(a.at(), 'MarketTab/AssetDetail');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'HomeTab/Home');
    assert.deepEqual(a.stack('MarketTab'), ['Market']);
    assert.equal(a.back(), false, 'Home leaves instead of opening the Market list the user never chose');
  });

  it('a detail opened from Wallet returns to Wallet, and the tabs before it stay in order', () => {
    const a = app();
    a.tabPress('RankingTab');
    a.tabPress('WalletTab');
    a.run(() => screens.Wallet.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'W', returnTab: 'WalletTab' })));
    a.run(() => screens.AssetDetail.navigation.navigate('Order', { assetId: 'W', accountId: 'a' }));
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'MarketTab/AssetDetail');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'WalletTab/Wallet');
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'RankingTab/Ranking');
  });

  it('a Market-list link from another tab returns to the open list instead of stacking a second one', () => {
    for (const pop of [false, true]) {
      const a = app();
      a.tabPress('MarketTab');
      a.run(() => screens.Market.navigation.navigate('AssetDetail', { assetId: 'M' }));
      a.run(() => screens.AssetDetail.navigation.navigate('Order', { assetId: 'M', accountId: 'a' }));
      a.tabPress('WalletTab');
      // WalletScreen's 마켓으로 이동 (Home/Portfolio's links are the same call).
      a.run(() => screens.Wallet.navigation.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Market', ...(pop ? { pop: true } : {}) } }));
      assert.equal(a.at(), 'MarketTab/Market');
      assert.deepEqual(a.stack('MarketTab'), pop ? ['Market'] : ['Market', 'AssetDetail', 'Order', 'Market'],
        pop ? 'the open list' : 'root cause: React Navigation 7 pushes a second list');
    }
  });

  it("Ranking's 친구 찾기 opens 친구 over MY's 전체 even before MY was opened", () => {
    for (const initial of [undefined, false]) {
      const a = app();
      a.tabPress('RankingTab');
      a.run(() => screens.Ranking.navigation.navigate('MyTab', { screen: 'Friends', ...(initial === false ? { initial } : {}) }));
      assert.deepEqual(a.stack('MyTab'), initial === false ? ['Overall', 'Friends'] : ['Friends'],
        initial === false ? 'back returns to 전체' : 'root cause: 친구 alone in MY (no header back, MY keeps showing it)');
    }
  });

  it('a push or banner tap over the tabs (거래 내역, a chart) returns to the tabs, never a second MainTabs', () => {
    for (const pop of [false, true]) {
      const a = app();
      a.run(() => a.ref.navigate('TradeHistory'));
      // PushNotificationsHost's 받은 요청 / 공지 / 시즌 기록 (the friend banner opens it the same way).
      a.run(() => a.ref.navigate('MainTabs', { screen: 'MyTab', params: { screen: 'Friends', initial: false } }, pop ? { pop: true } : undefined));
      assert.deepEqual(a.ref.getRootState().routes.map((route: any) => route.name), pop ? ['MainTabs'] : ['MainTabs', 'TradeHistory', 'MainTabs'],
        pop ? 'the tabs the user had' : 'root cause: a second set of tabs (and quest guide) mounted over the first');
      if (pop) assert.equal(a.at(), 'MyTab/Friends');
    }
  });

  it('an active beginner quest still holds a Back that would leave its practice', async () => {
    const a = app();
    a.tabPress('WalletTab');
    setQuestNavigationGuard(noticed, 'exchange');
    notices = 0;
    assert.equal(a.back(), true, 'handled: the guide shows its notice instead');
    assert.equal(a.at(), 'WalletTab/Wallet');
    await Promise.resolve();
    // Told at least once (the container's canGoBack and goBack each ask the router, as before).
    assert.ok(notices >= 1);
    setQuestNavigationGuard(noticed, null);
    assert.equal(a.back(), true);
    assert.equal(a.at(), 'HomeTab/Home');
  });
});
