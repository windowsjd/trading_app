import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const React = require('react');
const { create, act } = require('react-test-renderer');
const { useQuery, useQueryClient } = require('@tanstack/react-query');
const { load, elements } = require('../../../test/ledgerTestHarness.cjs');
const expiry = require('../../services/api/sessionExpiry.ts');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function harness() {
  const native: Record<string, any> = Object.fromEntries(['View', 'Text', 'SafeAreaView', 'Pressable', 'ScrollView'].map(n => [n, n]));
  native.StyleSheet = { create: (s: unknown) => s };
  const diagnostics = load(resolve('src/components/states/AdminDiagnosticPanel.tsx'), {
    'react-native': native, '../../features/me/api': { getMe: async () => ({ id: 'user-a' }) },
  });
  const errorState = load(resolve('src/components/states/ErrorState.tsx'), {
    'react-native': native, './AdminDiagnosticPanel': diagnostics,
  });
  const Boundary = load(resolve('src/components/states/ScreenErrorBoundary.tsx'), {
    './ErrorState': errorState,
  }).default;
  const h: any = { client: null, account: null, providerMounts: 0, navigationMounts: 0, operations: [] };
  function AccountProvider({ children }: any) {
    const [account] = React.useState({ id: 'account-a', mode: 'season' });
    h.account = account;
    h.client = useQueryClient();
    React.useEffect(() => { h.providerMounts++; }, []);
    return children;
  }
  const Providers = load(resolve('src/app/AppProviders.tsx'), {
    '../features/tradingAccount/TradingAccountContext': { TradingAccountProvider: AccountProvider },
    '../features/auth/session': { endSession: (client: any) => {
      client.clear(); h.operations.push('credentials-cleared'); return Promise.resolve();
    } },
    '../services/api/sessionExpiry': expiry,
    './navigation/navigationRef': { resetToLoginFromRef: () => {
      h.operations.push('login'); h.navigate('Login');
    } },
  }).default;
  const rootMocks: any = {
    '@react-navigation/native': { NavigationContainer: 'NavigationContainer' },
    '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    './navigationRef': { rootNavigationRef: {} },
    '../../components/states/ScreenErrorBoundary': { default: Boundary, __esModule: true },
  };
  for (const name of ['./AuthStack', './MainTabs', '../../screens/auth/SplashScreen',
    '../../screens/entry/ModeSelectionScreen', '../../screens/season/SeasonJoinScreen']) {
    rootMocks[name] = { default: name, __esModule: true };
  }
  const Root = load(resolve('src/app/navigation/RootNavigator.tsx'), rootMocks).default;
  const root = Root();
  assert.equal(root.type, 'NavigationContainer');
  const layout = elements(root, 'Navigator')[0].props.screenLayout;
  assert.equal(typeof layout, 'function', 'every root scene must receive the boundary');
  assert.equal(layout({ children: null }).type, Boundary);

  // Native navigation is replaced with a route switch; use the actual root
  // screenLayout and actual AppProviders/SessionExpiryBridge/QueryClient.
  function Navigation({ children }: any) {
    const [route, setRoute] = React.useState('MainTabs');
    h.navigate = setRoute;
    React.useEffect(() => { h.navigationMounts++; }, []);
    return React.createElement('NavigationContainer', null,
      React.createElement(React.Fragment, { key: route }, layout({
        children: route === 'Login' ? React.createElement('Text', null, 'Login') : children,
      })));
  }
  h.mount = async (child: any) => {
    await act(async () => { h.renderer = create(React.createElement(Providers, null,
      React.createElement(Navigation, null, child))); });
  };
  h.close = async () => {
    await act(async () => { h.renderer?.unmount(); });
    h.client?.clear(); expiry.resetSessionExpiryNotice();
  };
  h.retry = async () => {
    const button = h.renderer.root.findAllByType('Pressable').find((n: any) =>
      n.findAllByType('Text').some((text: any) => text.props.children === '화면 다시 열기'));
    assert.ok(button, 'a recoverable error must have an action');
    await act(async () => button.props.onPress());
  };
  h.text = () => JSON.stringify(h.renderer.toJSON());
  h.ErrorState = errorState.default;
  return h;
}

describe('root screen render boundary', () => {
  it('shows the existing ErrorState, reports the stack and retries without resetting providers/cache', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const h = harness(); t.after(h.close);
    let fails = true;
    function Screen() {
      if (fails) throw new Error('intentional render failure');
      return React.createElement('Text', null, 'recovered');
    }
    await h.mount(React.createElement(Screen));
    assert.match(h.text(), /화면을 표시하지 못했습니다/);
    assert.ok(errors.mock.calls.some(call => call.arguments[0] === 'Screen render failed'
      && /Screen/.test(String(call.arguments[2]))));
    const client = h.client;
    const account = h.account;
    client.setQueryData(QUERY_KEYS.tradingAccount.portfolio(account.id), { marker: 'preserved' });
    fails = false;
    await h.retry();
    assert.match(h.text(), /recovered/);
    assert.equal(h.client, client); assert.equal(h.account, account);
    assert.equal(h.providerMounts, 1); assert.equal(h.navigationMounts, 1);
    assert.deepEqual(client.getQueryData(QUERY_KEYS.tradingAccount.portfolio(account.id)), { marker: 'preserved' });
  });

  it('keeps the error UI available if retrying encounters the same bug', async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = harness(); t.after(h.close);
    function Screen() { throw new TypeError('persistent render failure'); }
    await h.mount(React.createElement(Screen));
    await h.retry();
    assert.match(h.text(), /화면을 표시하지 못했습니다/);
    assert.equal(h.providerMounts, 1);
  });

  it('does not catch a normally handled React Query/API rejection', async (t) => {
    const errors = t.mock.method(console, 'error', () => {});
    const h = harness(); t.after(h.close);
    const failure = new Error('HTTP 500');
    function Screen() {
      const query = useQuery({ queryKey: ['api-error-test'], retry: false,
        queryFn: async () => { throw failure; } });
      return query.isError
        ? React.createElement(h.ErrorState, { title: 'API 오류', onRetry: () => void query.refetch() })
        : React.createElement('Text', null, 'loading');
    }
    await h.mount(React.createElement(Screen));
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    assert.equal(h.client.getQueryState(['api-error-test']).error, failure);
    assert.match(h.text(), /API 오류/);
    assert.doesNotMatch(h.text(), /화면을 표시하지 못했습니다/);
    assert.ok(!errors.mock.calls.some(call => call.arguments[0] === 'Screen render failed'));
  });

  for (const renderFailure of [false, true]) {
    it(`session expiry still clears cache/credentials and resets to Login (render failure: ${renderFailure})`, async (t) => {
      t.mock.method(console, 'error', () => {});
      const h = harness(); t.after(h.close);
      function Screen() {
        if (renderFailure) throw new Error('intentional render failure');
        return React.createElement('Text', null, 'ready');
      }
      expiry.resetSessionExpiryNotice();
      await h.mount(React.createElement(Screen));
      h.client.setQueryData(QUERY_KEYS.record.infiniteSeasons(), { pages: [], pageParams: [] });
      await act(async () => {
        expiry.notifySessionExpired();
        assert.equal(h.client.getQueryCache().getAll().length, 0, 'cache clears synchronously');
      });
      assert.deepEqual(h.operations, ['credentials-cleared', 'login']);
      assert.match(h.text(), /Login/);
      assert.doesNotMatch(h.text(), /화면을 표시하지 못했습니다/);
      assert.equal(h.providerMounts, 1); assert.equal(h.navigationMounts, 1);
    });
  }
});
