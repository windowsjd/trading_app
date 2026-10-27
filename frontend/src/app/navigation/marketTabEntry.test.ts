import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { openInMarketTab, returnToEntryTab } from './marketTabEntry.ts';

const require = createRequire(import.meta.url);
// The real navigation core (state builder, nested params, routers, back
// handling) the app's native-stack and bottom-tabs navigators are built on.
const React = require('react');
const { act, create } = require('react-test-renderer');
const {
  BaseNavigationContainer, CommonActions, StackActions, StackRouter, TabRouter,
  createNavigationContainerRef, createNavigatorFactory, useNavigationBuilder,
} = require('@react-navigation/core');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;

// A stack renders every route (native-stack keeps them mounted); tabs render
// a tab once it has been focused (bottom-tabs `lazy`), with the default
// `firstRoute` back behavior.
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
const stack = (names: string[], listeners?: unknown) => function StackScreen() {
  const S = Stack();
  return h(S.Navigator, { screenListeners: listeners }, ...names.map(name => h(S.Screen, { key: name, name, component: screen(name) })));
};
// The app's tabs and stacks (MainTabs, HomeStack, MarketStack, WalletStack), by route name.
const HomeStack = stack(['Home', 'Portfolio']);
const MarketStack = stack(['Market', 'MarketSearch', 'AssetDetail', 'Order', 'FuturesDetail', 'Futures'], returnToEntryTab);
const WalletStack = stack(['Wallet', 'WalletTransactions']);
function MainTabs() {
  const T = Tabs();
  return h(T.Navigator, { initialRouteName: 'HomeTab' },
    h(T.Screen, { name: 'HomeTab', component: HomeStack }),
    h(T.Screen, { name: 'MarketTab', component: MarketStack }),
    h(T.Screen, { name: 'GuideTab', component: screen('Guide') }),
    h(T.Screen, { name: 'WalletTab', component: WalletStack }),
    h(T.Screen, { name: 'MyTab', component: screen('My') }));
}

let renderer: any = null;
afterEach(() => { act(() => renderer?.unmount()); renderer = null; });

function app() {
  for (const name of Object.keys(screens)) delete screens[name];
  const ref = createNavigationContainerRef();
  const Root = Stack();
  act(() => {
    renderer = create(h(BaseNavigationContainer, { ref },
      h(Root.Navigator, null, h(Root.Screen, { name: 'MainTabs', component: MainTabs }))));
  });
  const tabsState = () => ref.getRootState().routes[0].state;
  const tab = (name: string) => tabsState().routes.find((route: any) => route.name === name);
  const run = (step: () => void) => act(step);
  return {
    run,
    /** The focused tab and the screen shown in it. */
    at: () => {
      const focused = tabsState().routes[tabsState().index];
      return `${focused.name}/${focused.state ? focused.state.routes[focused.state.index].name : focused.name}`;
    },
    /** Route names of a tab's stack (null before the tab was ever opened). */
    stack: (name: string) => tab(name).state?.routes.map((route: any) => route.name) ?? null,
    /** Android back: what NavigationContainer's hardware back handler does. */
    systemBack: () => {
      assert.equal(ref.canGoBack(), true, 'back is handled inside the app');
      act(() => ref.goBack());
    },
    /** The native-stack header back button: a pop of the detail's stack. */
    headerBack: (name: string) => act(() => {
      const { navigation, route } = screens[name];
      navigation.dispatch({ ...StackActions.pop(), source: route.key, target: navigation.getState().key });
    }),
    /** A bottom-tab press, as BottomTabBar dispatches it. */
    tabPress: (name: string) => act(() => {
      screens.Home.navigation.getParent().dispatch({ ...CommonActions.navigate(tab(name)), target: tabsState().key });
    }),
  };
}

describe('Market-tab screens opened from another tab', () => {
  it('root cause: a plain nested navigate into an unopened Market tab leaves the detail alone in its stack', () => {
    const a = app();
    a.run(() => screens.Home.navigation.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'AssetDetail', params: { assetId: 'X' } } }));
    // Nothing under it: native-stack draws no back button, and the 마켓 tab keeps this detail.
    assert.deepEqual(a.stack('MarketTab'), ['AssetDetail']);
  });

  it('Home → holding: the detail has a screen under it, and back (system or header) returns to Home', () => {
    for (const back of ['system', 'header'] as const) {
      const a = app();
      a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'X', returnTab: 'HomeTab' })));
      assert.equal(a.at(), 'MarketTab/AssetDetail');
      assert.deepEqual(a.stack('MarketTab'), ['Market', 'AssetDetail'], 'a previous screen, so the header shows back');
      if (back === 'system') a.systemBack(); else a.headerBack('AssetDetail');
      assert.equal(a.at(), 'HomeTab/Home', back);
      assert.deepEqual(a.stack('MarketTab'), ['Market'], 'the detail left the Market stack');
      // The 마켓 tab opens its list again, never a leftover detail.
      a.tabPress('MarketTab');
      assert.equal(a.at(), 'MarketTab/Market');
    }
  });

  it('Wallet and Portfolio holdings return to the screen they were opened from', () => {
    const wallet = app();
    wallet.tabPress('WalletTab');
    wallet.run(() => screens.Wallet.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'W', returnTab: 'WalletTab' })));
    wallet.systemBack();
    assert.equal(wallet.at(), 'WalletTab/Wallet', 'not the first tab');

    const portfolio = app();
    portfolio.run(() => screens.Home.navigation.navigate('Portfolio'));
    portfolio.run(() => screens.Portfolio.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'P', returnTab: 'HomeTab' })));
    portfolio.systemBack();
    assert.equal(portfolio.at(), 'HomeTab/Portfolio');
    assert.deepEqual(portfolio.stack('HomeTab'), ['Home', 'Portfolio']);
  });

  it('detail → order → detail keeps working, and the next back still returns to the origin', () => {
    const a = app();
    a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'X', returnTab: 'HomeTab' })));
    a.run(() => screens.AssetDetail.navigation.navigate('Order', { assetId: 'X', accountId: 'a', side: 'buy' }));
    a.systemBack();
    assert.equal(a.at(), 'MarketTab/AssetDetail');
    // The order screen's in-place asset change returns to the traded asset's detail.
    a.run(() => screens.AssetDetail.navigation.navigate('Order', { assetId: 'X', accountId: 'a', side: 'buy' }));
    a.run(() => screens.Order.navigation.popTo('AssetDetail', { assetId: 'Y' }, { merge: true }));
    assert.equal(a.at(), 'MarketTab/AssetDetail');
    assert.equal(screens.AssetDetail.route.params.assetId, 'Y');
    a.systemBack();
    assert.equal(a.at(), 'HomeTab/Home');
  });

  it('the Market tab keeps what the user left open there', () => {
    const a = app();
    a.tabPress('MarketTab');
    a.run(() => screens.Market.navigation.navigate('MarketSearch'));
    a.tabPress('HomeTab');
    a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'S', returnTab: 'HomeTab' })));
    a.headerBack('AssetDetail');
    assert.equal(a.at(), 'HomeTab/Home', 'not the earlier search screen');
    assert.deepEqual(a.stack('MarketTab'), ['Market', 'MarketSearch']);
  });

  it('inside the Market tab, back is unchanged: detail → list, and the list → Home (the top level)', () => {
    const a = app();
    a.tabPress('MarketTab');
    a.run(() => screens.Market.navigation.navigate('AssetDetail', { assetId: 'M' }));
    a.systemBack();
    assert.equal(a.at(), 'MarketTab/Market');
    a.systemBack();
    assert.equal(a.at(), 'HomeTab/Home');
  });

  it('a futures position opens the futures screen over the Market list (no tab return)', () => {
    const a = app();
    a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('Futures', { accountId: 'a', instrumentId: 'btc' })));
    assert.deepEqual(a.stack('MarketTab'), ['Market', 'Futures']);
    a.systemBack();
    assert.equal(a.at(), 'MarketTab/Market');
  });

  it('only back returns to the origin: the 마켓 tab pop-to-top and resets leave the tabs alone', () => {
    const a = app();
    a.run(() => screens.Home.navigation.navigate('MainTabs', openInMarketTab('AssetDetail', { assetId: 'X', returnTab: 'HomeTab' })));
    a.run(() => screens.AssetDetail.navigation.navigate('Order', { assetId: 'X', accountId: 'a' }));
    // A press on the focused 마켓 tab (from the order screen) pops the stack to its list.
    a.run(() => screens.Order.navigation.dispatch({ ...StackActions.popToTop(), target: screens.Order.navigation.getState().key }));
    assert.equal(a.at(), 'MarketTab/Market');
  });
});
