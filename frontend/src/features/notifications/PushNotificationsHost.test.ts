import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { act, create } = require('react-test-renderer');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Push = { identifier: string; data: unknown; title?: string | null; body?: string | null };

function harness(t: TestContext, options: {
  supported?: boolean;
  permission?: 'undetermined' | 'granted' | 'denied';
  launchTap?: Push | null;
} = {}) {
  const h = {
    log: [] as string[],
    permission: options.permission ?? 'undetermined',
    route: 'Splash' as string,
    stateListeners: [] as Array<() => void>,
    navigations: [] as Array<{ name: string; params: unknown }>,
    events: [] as Array<Record<string, unknown>>,
    tapped: null as null | ((push: Push) => void),
    received: null as null | ((push: Push) => void),
    account: {
      accounts: [{ id: 'acct-a', mode: 'general' }],
      isLoading: false,
      selectedAccount: { id: 'acct-a', mode: 'general' },
    } as any,
    renderer: null as any,
  };
  const snapshot = () => ({
    status: h.permission,
    granted: h.permission === 'granted',
    canAskAgain: h.permission === 'undetermined',
    iosStatus: null,
  });
  const nativePush = {
    supported: options.supported !== false,
    platform: 'android',
    ensureChannel: async () => { h.log.push('channel'); },
    getPermission: async () => snapshot(),
    requestPermission: async () => { h.log.push('request-permission'); h.permission = 'granted'; return snapshot(); },
    readPermissionRequested: async () => false,
    writePermissionRequested: async () => {},
    clearPermissionRequested: async () => {},
    getToken: async () => 'ExponentPushToken[device]',
    readStoredToken: async () => (h as any).stored ?? null,
    writeStoredToken: async (token: string | null) => { (h as any).stored = token; },
    suppressForegroundPresentation: () => { h.log.push('suppress-foreground'); },
    takeLaunchTap: () => options.launchTap ?? null,
    onTapped: (listener: (push: Push) => void) => { h.tapped = listener; return { remove() {} }; },
    onReceived: (listener: (push: Push) => void) => { h.received = listener; return { remove() {} }; },
    onTokenChanged: () => ({ remove() {} }),
  };
  const rootNavigationRef = {
    isReady: () => true,
    getRootState: () => ({ index: 0, routes: [{ name: h.route }] }),
    addListener: (_: string, listener: () => void) => {
      h.stateListeners.push(listener);
      return () => { h.stateListeners = h.stateListeners.filter((item) => item !== listener); };
    },
    navigate: (name: string, params: unknown) => { h.navigations.push({ name, params }); },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Host = load(resolve('src/features/notifications/PushNotificationsHost.tsx'), {
    'react-native': { AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } },
    './nativePush': { nativePush },
    './api': {
      registerPushDevice: async (token: string, platform: string) => { h.log.push(`register ${token} ${platform}`); },
      releasePushDevice: async (token: string) => { h.log.push(`release ${token}`); },
    },
    '../../app/navigation/navigationRef': { rootNavigationRef },
    '../quest/questNavigationGuard': { questNavigationAllowed: () => true },
    '../order/fillEvents': { emitOrderFillEvent: (event: Record<string, unknown>) => { h.events.push(event); } },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => h.account },
  }).default;
  const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  const settle = async () => { for (let i = 0; i < 4; i++) await flush(); };
  const mount = async () => {
    await act(async () => {
      h.renderer = create(React.createElement(QueryClientProvider, { client }, React.createElement(Host)));
    });
    await settle();
  };
  const go = async (route: string) => {
    h.route = route;
    await act(async () => { h.stateListeners.forEach((listener) => listener()); });
    await settle();
  };
  const signIn = async (userId: string) => {
    await act(async () => { client.setQueryData(QUERY_KEYS.me, { id: userId }); });
    await settle();
  };
  const signOut = async () => {
    await act(async () => { client.clear(); });
    await go('AuthStack');
  };
  t.after(async () => {
    if (h.renderer) await act(async () => h.renderer.unmount());
    client.clear();
  });
  return { h, client, mount, go, signIn, signOut, settle };
}

const fillPush = (uid: string, accountId = 'acct-a'): Push => ({
  identifier: `push-${uid}-${accountId}`,
  data: { v: 1, type: 'trade_fill', uid, accountId, market: 'spot' },
});

describe('push notifications host', () => {
  it('asks for permission on first launch before any sign-in, after the Android channel', async (t) => {
    const x = harness(t);
    await x.mount();
    assert.deepEqual(x.h.log.slice(0, 3), ['suppress-foreground', 'channel', 'request-permission']);
    // Restoring (Splash): no server registration in either direction.
    assert.equal(x.h.log.some((line) => line.startsWith('register') || line.startsWith('release')), false);
  });

  it('does not ask again once the permission is decided', async (t) => {
    const x = harness(t, { permission: 'denied' });
    await x.mount();
    assert.equal(x.h.log.includes('request-permission'), false);
    // A denial blocks nothing: sign-in proceeds and nothing registers.
    await x.go('AuthStack');
    await x.signIn('user-a');
    assert.equal(x.h.log.some((line) => line.startsWith('register')), false);
  });

  it('ties the token to a user only after sign-in and releases it on logout', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('AuthStack');
    assert.equal(x.h.log.some((line) => line.startsWith('register')), false);
    await x.signIn('user-a');
    assert.equal(x.h.log.filter((line) => line === 'register ExponentPushToken[device] android').length, 1);
    await x.signOut();
    assert.equal(x.h.log.at(-1), 'release ExponentPushToken[device]');
  });

  it('opens a tapped fill after sign-in and the mode choice, for its own user only', async (t) => {
    const x = harness(t, { launchTap: fillPush('user-a') });
    await x.mount();
    await x.go('AuthStack');
    await x.signIn('user-a');
    // Signed in but still choosing the investment mode: the tap waits.
    await x.go('ModeSelection');
    assert.equal(x.h.navigations.length, 0);
    await x.go('MainTabs');
    assert.equal(x.h.navigations.length, 1);
    const [{ name, params }] = x.h.navigations as Array<{ name: string; params: Record<string, unknown> }>;
    assert.equal(name, 'TradeHistory');
    assert.equal(params.accountId, 'acct-a');
    assert.equal(params.market, 'spot');
    // A per-tap stamp lets an already open history select the view again.
    assert.equal(typeof params.pushAt, 'number');
  });

  it('drops a tap meant for another user or for an account the user does not own', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('MainTabs');
    await x.signIn('user-b');
    await act(async () => x.h.tapped!(fillPush('user-a')));
    await x.settle();
    await act(async () => x.h.tapped!(fillPush('user-b', 'acct-of-someone-else')));
    await x.settle();
    assert.deepEqual(x.h.navigations, []);
  });

  it('routes the other types to their screens and handles a tap only once', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('MainTabs');
    await x.signIn('user-a');
    const notice = { identifier: 'n1', data: { v: 1, type: 'important_notice', uid: 'user-a', noticeId: 'notice-1' } };
    await act(async () => x.h.tapped!(notice));
    await x.settle();
    await act(async () => x.h.tapped!(notice));
    await x.settle();
    await act(async () => x.h.tapped!({ identifier: 'f1', data: { v: 1, type: 'friend_request', uid: 'user-a' } }));
    await x.settle();
    await act(async () => x.h.tapped!({ identifier: 's1', data: { v: 1, type: 'season_final_result', uid: 'user-a', seasonId: 'season-1' } }));
    await x.settle();
    // Strip the per-tap stamp before comparing the destinations.
    const shape = (item: any) => JSON.stringify(item, (key, value) => (key === 'pushAt' ? undefined : value));
    assert.deepEqual(x.h.navigations.map(shape), [
      JSON.stringify({ name: 'MainTabs', params: { screen: 'MyTab', params: { screen: 'Notices', initial: false, params: { noticeId: 'notice-1' } } } }),
      JSON.stringify({ name: 'MainTabs', params: { screen: 'MyTab', params: { screen: 'Friends', initial: false, params: { tab: 'requests' } } } }),
      JSON.stringify({ name: 'MainTabs', params: { screen: 'MyTab', params: { screen: 'Record', initial: false, params: { screen: 'RecordSeasonDetail', initial: false, params: { seasonId: 'season-1' } } } } }),
    ]);
    const stamps = (x.h.navigations as Array<{ params: { params: { params: { pushAt?: number } } } }>)
      .slice(0, 2)
      .map((item) => item.params.params.params.pushAt);
    assert.equal(stamps.every((stamp) => typeof stamp === 'number'), true);
  });

  it('refreshes the event account in the foreground without opening anything', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('MainTabs');
    await x.signIn('user-a');
    const invalidated: string[] = [];
    const original = x.client.invalidateQueries.bind(x.client);
    x.client.invalidateQueries = (filters: { queryKey: unknown[] }) => {
      invalidated.push(JSON.stringify(filters.queryKey));
      return original(filters);
    };
    await act(async () => x.h.received!(fillPush('user-a')));
    assert.equal(invalidated.includes(JSON.stringify(QUERY_KEYS.tradingAccount.ordersAll('acct-a'))), true);
    assert.deepEqual(x.h.navigations, []);
    invalidated.length = 0;
    await act(async () => x.h.received!(fillPush('user-other')));
    assert.deepEqual(invalidated, []);
  });

  it('opens a tapped failure on its own row, never the fill history', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('MainTabs');
    await x.signIn('user-a');
    const failure = (identifier: string, data: Record<string, unknown> = {}) => ({
      identifier,
      data: {
        v: 1, type: 'order_failure', uid: 'user-a', accountId: 'acct-a', market: 'futures',
        failureKind: 'futures_conditional_entry', failureId: 'entry-1', ...data,
      },
    });
    await act(async () => x.h.tapped!(failure('fail-1')));
    await x.settle();
    // Without the row it names, or for an account the user does not own, nothing opens.
    await act(async () => x.h.tapped!(failure('fail-2', { failureKind: undefined, failureId: undefined })));
    await x.settle();
    await act(async () => x.h.tapped!(failure('fail-3', { accountId: 'acct-of-someone-else' })));
    await x.settle();
    assert.equal(x.h.navigations.length, 1);
    const [{ name, params }] = x.h.navigations as Array<{ name: string; params: Record<string, unknown> }>;
    assert.equal(name, 'OrderFailure');
    assert.deepEqual({ ...params, pushAt: undefined }, {
      accountId: 'acct-a', kind: 'futures_conditional_entry', failureId: 'entry-1', pushAt: undefined,
    });
    assert.equal(typeof params.pushAt, 'number');
  });

  it('hands a foreground liquidation of an owned account to the in-app banner', async (t) => {
    const x = harness(t);
    await x.mount();
    await x.go('MainTabs');
    await x.signIn('user-a');
    const liquidation = (uid: string, accountId: string, liquidationId?: string): Push => ({
      identifier: `liq-${uid}-${accountId}-${liquidationId}`,
      title: '선물 강제청산',
      body: '일반모드 · BTC 롱 포지션이 강제청산되었어요.',
      data: { v: 1, type: 'futures_liquidation', uid, accountId, market: 'futures', futuresView: 'liquidations', ...(liquidationId ? { liquidationId } : {}) },
    });
    await act(async () => x.h.received!(liquidation('user-a', 'acct-a', 'liq-1')));
    await act(async () => x.h.received!(liquidation('user-b', 'acct-a', 'liq-2')));
    await act(async () => x.h.received!(liquidation('user-a', 'acct-other', 'liq-3')));
    await act(async () => x.h.received!(fillPush('user-a')));
    assert.deepEqual(x.h.events, [{
      kind: 'liquidation',
      accountId: 'acct-a',
      liquidationId: 'liq-1',
      title: '선물 강제청산',
      detail: '일반모드 · BTC 롱 포지션이 강제청산되었어요.',
    }]);
    // The OS banner stays off and nothing is opened in the foreground.
    assert.deepEqual(x.h.navigations, []);
    assert.equal(x.h.log.includes('suppress-foreground'), true);
  });

  it('does nothing on web', async (t) => {
    const x = harness(t, { supported: false });
    await x.mount();
    assert.deepEqual(x.h.log, []);
  });
});
