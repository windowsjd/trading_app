import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { restartBackgroundTabs, withBackgroundTabsRestarted } from './accountSwitchTabs.ts';

// The saved root state after a general account opened an order and the user
// went back to Home to switch accounts (the reported 초보모드 quest case).
const saved = () => ({
  key: 'root', index: 0, stale: false as const, routeNames: ['MainTabs', 'AssetChart'],
  routes: [{
    key: 'MainTabs-1', name: 'MainTabs',
    state: {
      key: 'tabs', index: 0, stale: false as const, type: 'tab', history: [{ type: 'route', key: 'MarketTab-1' }, { type: 'route', key: 'HomeTab-1' }],
      routes: [
        { key: 'HomeTab-1', name: 'HomeTab', state: { key: 'home', index: 1, routes: [{ key: 'Home-1', name: 'Home' }, { key: 'Portfolio-1', name: 'Portfolio' }] } },
        { key: 'MarketTab-1', name: 'MarketTab', params: { screen: 'Order', params: { assetId: 'BTC', accountId: 'general', side: 'buy' }, initial: false },
          state: { key: 'market', index: 2, routes: [{ key: 'Market-1', name: 'Market' }, { key: 'AssetDetail-1', name: 'AssetDetail', params: { assetId: 'BTC' } },
            { key: 'Order-1', name: 'Order', params: { assetId: 'BTC', accountId: 'general', side: 'buy' } }] } },
        { key: 'WalletTab-1', name: 'WalletTab', state: { key: 'wallet', index: 1, routes: [{ key: 'Wallet-1', name: 'Wallet' }, { key: 'WalletTransactions-1', name: 'WalletTransactions' }] } },
        { key: 'MyTab-1', name: 'MyTab' },
      ],
    },
  }],
});

describe('account switch restarts the tabs the user is not looking at', () => {
  it('drops the other tabs’ saved screens and replayable nested params, keeps the focused tab and every key', () => {
    const root = saved();
    const next = withBackgroundTabsRestarted(root)!;
    const tabs = next.routes[0].state!;
    // The focused tab (where the switcher is) keeps 내 자산 open.
    assert.equal(tabs.routes[0], root.routes[0].state.routes[0]);
    // The old account's order form is gone, and nothing would replay it.
    assert.deepEqual(tabs.routes[1], { key: 'MarketTab-1', name: 'MarketTab' });
    assert.deepEqual(tabs.routes[2], { key: 'WalletTab-1', name: 'WalletTab' });
    assert.equal(tabs.routes[3], root.routes[0].state.routes[3], 'a never-opened tab is untouched');
    // Same navigator and route identities: only the saved screens change.
    assert.equal(tabs.key, 'tabs');
    assert.equal(tabs.index, 0);
    assert.deepEqual(tabs.history, root.routes[0].state.history);
    assert.equal(next.routes[0].key, 'MainTabs-1');
    // Pure: the input is not modified.
    assert.equal(root.routes[0].state.routes[1].state?.routes.length, 3);
  });

  it('changes nothing when the other tabs hold no screens, or there are no tabs yet', () => {
    const fresh = { index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'WalletTab', state: { routes: [{ name: 'Wallet' }] } }] } }] };
    assert.equal(withBackgroundTabsRestarted(fresh), null, 'only the focused tab has screens');
    assert.equal(withBackgroundTabsRestarted({ index: 0, routes: [{ name: 'Splash' }] }), null);
    assert.equal(withBackgroundTabsRestarted({ index: 0, routes: [{ name: 'MainTabs' }] }), null);
  });

  it('resets the ROOT navigator reached from a nested screen’s navigation, once', () => {
    const resets: unknown[] = [];
    const state = saved();
    const root = { getParent: () => undefined, getState: () => state, reset: (value: unknown) => { resets.push(value); } };
    const tabs = { getParent: () => root, getState: () => { throw new Error('not the root'); }, reset: () => { throw new Error('not the root'); } };
    const homeStack = { getParent: () => tabs, getState: () => { throw new Error('not the root'); }, reset: () => { throw new Error('not the root'); } };
    restartBackgroundTabs(homeStack);
    assert.equal(resets.length, 1);
    assert.deepEqual(resets[0], withBackgroundTabsRestarted(state));
    // Harness stand-ins without a navigator are left alone.
    assert.doesNotThrow(() => restartBackgroundTabs({}));
    assert.doesNotThrow(() => restartBackgroundTabs(null));
  });
});
