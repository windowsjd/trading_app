import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, it } from 'node:test';
import { URL } from 'node:url';
import { questNavigationAllowed, questNavigationRouter, setQuestNavigationGuard } from './questNavigationGuard.ts';

const require = createRequire(import.meta.url);
// The real routers the app's navigators use, wrapped exactly as `UNSTABLE_router` does.
const { CommonActions, StackActions, StackRouter, TabRouter } = require('@react-navigation/routers');

const TABS = ['HomeTab', 'MarketTab', 'QuestTab', 'WalletTab', 'MyTab'];
const MARKET = ['Market', 'MarketSearch', 'AssetDetail', 'Order', 'Futures'];
const WALLET = ['Wallet', 'WalletFx', 'WalletTransactions'];
const ROOT = ['Splash', 'AuthStack', 'ModeSelection', 'MainTabs', 'TradeHistory', 'SeasonJoin', 'AssetChart'];

function navigator(create: (options: object) => any, routeNames: string[], initialRouteName = routeNames[0]) {
  const original = create({ initialRouteName });
  const router = { ...original, ...questNavigationRouter(original) };
  const options = { routeNames, routeParamList: {}, routeGetIdList: {} };
  const n: any = { state: original.getInitialState(options) };
  /** Applies like a navigator: returns the router's answer, keeps what it renders. */
  n.dispatch = (action: unknown) => {
    const next = router.getStateForAction(n.state, action, options);
    if (next) n.state = next.stale === false ? next : original.getRehydratedState(next, options);
    return next;
  };
  n.focused = () => n.state.routes[n.state.index].name;
  return n;
}
const tabs = () => navigator(TabRouter, TABS, 'HomeTab');
const stack = (names: string[]) => navigator(StackRouter, names);

let notices = 0;
const notify = () => { notices += 1; };
const guide = (quest: Parameters<typeof setQuestNavigationGuard>[1]) => setQuestNavigationGuard(notify, quest);
/** The guard tells the guide after the router returns (it may run during a render). */
const heard = async () => { await Promise.resolve(); const count = notices; notices = 0; return count; };

/** A held move returns the very same state: nothing renders, nothing flashes. */
function holds(n: any, action: unknown, message: string) {
  const before = n.state;
  assert.equal(n.dispatch(action) === before, true, message);
  assert.equal(n.state === before, true, message);
}

describe('quest navigation guard', () => {
  afterEach(async () => { guide(null); await heard(); });

  it('changes nothing without an active guide (general and season accounts, a beginner between quests)', async () => {
    const n = tabs();
    for (const tab of ['MyTab', 'QuestTab', 'HomeTab']) {
      n.dispatch(CommonActions.navigate(tab));
      assert.equal(n.focused(), tab);
    }
    const market = stack(MARKET);
    market.dispatch(CommonActions.navigate('Futures', { accountId: 'a' }));
    assert.equal(market.focused(), 'Futures');
    assert.equal(questNavigationAllowed('WalletTransfer'), true);
    assert.equal(await heard(), 0);
  });

  it('holds other tabs, the quest list and Android Back out of the practice tab', async () => {
    const n = tabs();
    n.dispatch(CommonActions.navigate('MarketTab'));
    guide('marketBuy');
    for (const tab of ['HomeTab', 'MyTab', 'QuestTab', 'WalletTab']) holds(n, CommonActions.navigate(tab), `${tab} is held`);
    // A tab press dispatches navigate; hardware Back on a stack root falls back to the first tab.
    holds(n, CommonActions.goBack(), 'Back to Home is held');
    assert.equal(n.focused(), 'MarketTab');
    assert.equal(await heard(), 5, 'each held move is reported; the guide shows one notice');
    n.dispatch(CommonActions.navigate('MarketTab'));
    assert.equal(n.focused(), 'MarketTab');
    assert.equal(await heard(), 0, 'the practice tab itself is never held');
  });

  it('lets futures funding use the Wallet tab, never an unrelated screen behind an allowed tab', async () => {
    const n = tabs();
    n.dispatch(CommonActions.navigate('MarketTab', { screen: 'Futures', params: { accountId: 'a' } }));
    guide('futuresLong');
    n.dispatch(CommonActions.navigate('WalletTab'));
    assert.equal(n.focused(), 'WalletTab', 'topping up the futures wallet');
    assert.equal(await heard(), 0);
    // Checked as one move: never the Market tab first and the held screen after.
    holds(n, CommonActions.navigate('MarketTab', { screen: 'AssetDetail', params: { assetId: 'BTC' } }), 'a spot detail from a Wallet position');
    holds(n, CommonActions.navigate('MarketTab', { screen: 'Order', params: { assetId: 'BTC', accountId: 'a' } }), 'a spot order');
    assert.equal(await heard(), 2);
    n.dispatch(CommonActions.navigate('MarketTab', { screen: 'Futures', params: { accountId: 'a' } }));
    assert.equal(n.focused(), 'MarketTab', 'back to the futures screen');
    const wallet = stack(WALLET);
    holds(wallet, CommonActions.navigate('WalletTransactions'), 'the ledger is not funding');
    wallet.dispatch(CommonActions.navigate('WalletFx'));
    assert.equal(wallet.focused(), 'WalletFx', 'USD for the futures wallet may need 환전 first');
    assert.equal(questNavigationAllowed('WalletTransfer'), true, '이체 tops up the futures wallet');
    assert.equal(await heard(), 1);
  });

  it('holds unrelated screens inside the practice tab, keeps any listed asset and every way back open', async () => {
    const market = stack(MARKET);
    guide('marketBuy');
    for (const [name, params] of [['MarketSearch', undefined], ['AssetDetail', { assetId: 'ETH' }], ['Order', { assetId: 'ETH', accountId: 'a' }]] as const) {
      market.dispatch(CommonActions.navigate(name, params));
      assert.equal(market.focused(), name, `${name} is part of the spot practice`);
    }
    holds(market, CommonActions.navigate('Futures', { accountId: 'a' }), 'futures is another practice');
    holds(market, StackActions.push('Futures', { accountId: 'a' }), 'pushed the same');
    assert.equal(await heard(), 2);
    market.dispatch(StackActions.popToTop());
    assert.equal(market.focused(), 'Market', 'a tab re-press returns to the list');
    // A screen that is already open is never refused: native gestures pop before JS hears of them.
    guide(null);
    const open = stack(MARKET);
    for (const name of ['AssetDetail', 'Futures']) open.dispatch(CommonActions.navigate(name, { assetId: 'BTC', accountId: 'a' }));
    guide('futuresShort');
    open.dispatch(StackActions.pop());
    assert.equal(open.focused(), 'AssetDetail');
    assert.equal(await heard(), 0);
  });

  it('holds wallet screens of the other wallet practice', async () => {
    const wallet = stack(WALLET);
    guide('transfer');
    holds(wallet, CommonActions.navigate('WalletFx'), '환전 is QUEST 01');
    assert.equal(questNavigationAllowed('WalletTransfer'), true);
    guide('exchange');
    assert.equal(questNavigationAllowed('WalletTransfer'), false, '이체 is QUEST 02');
    wallet.dispatch(CommonActions.navigate('WalletFx'));
    assert.equal(wallet.focused(), 'WalletFx');
    assert.equal(await heard(), 2);
  });

  it('holds pushes over the tabs, never sign-in or account entry', async () => {
    const root = stack(ROOT);
    root.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'MainTabs' }] }));
    guide('marketBuy');
    holds(root, CommonActions.navigate('TradeHistory', { accountId: 'a' }), 'order history');
    holds(root, CommonActions.navigate('SeasonJoin'), 'season entry');
    holds(root, CommonActions.reset({ index: 0, routes: [{ name: 'MainTabs', params: { screen: 'HomeTab', params: { screen: 'Home' } } }] }),
      "an order receipt's 홈으로");
    assert.equal(await heard(), 3);
    root.dispatch(CommonActions.navigate('AssetChart', { assetId: 'BTC' }));
    assert.equal(root.focused(), 'AssetChart', 'the chart is part of exploring an asset');
    root.dispatch(CommonActions.goBack());
    guide('futuresLong');
    holds(root, CommonActions.navigate('AssetChart', { assetId: 'BTC' }), 'no spot chart in a futures practice');
    assert.equal(await heard(), 1);
    // Logout and session expiry reset to sign-in; account entry resets to mode selection.
    for (const reset of [{ name: 'AuthStack', params: { screen: 'Login' } }, { name: 'ModeSelection' }]) {
      root.dispatch(CommonActions.reset({ index: 0, routes: [{ name: 'MainTabs' }] }));
      root.dispatch(CommonActions.reset({ index: 0, routes: [reset] }));
      assert.equal(root.focused(), reset.name);
    }
    assert.equal(await heard(), 0);
  });

  it('is lifted by its own guide only', async () => {
    const n = tabs();
    n.dispatch(CommonActions.navigate('WalletTab'));
    guide('exchange');
    setQuestNavigationGuard(() => undefined, null);
    holds(n, CommonActions.navigate('HomeTab'), "another (unmounted) guide's release lifts nothing");
    guide(null);
    n.dispatch(CommonActions.navigate('HomeTab'));
    assert.equal(n.focused(), 'HomeTab');
    assert.equal(await heard(), 1);
  });

  it('guards exactly the navigators users move through', () => {
    for (const file of ['RootNavigator', 'MainTabs', 'MarketStack', 'WalletStack']) {
      const source = readFileSync(new URL(`../../app/navigation/${file}.tsx`, import.meta.url), 'utf8');
      assert.match(source, /UNSTABLE_router=\{questNavigationRouter\}/, file);
    }
  });
});
