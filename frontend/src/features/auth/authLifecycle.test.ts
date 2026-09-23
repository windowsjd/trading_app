import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const React = require('react');
const {
  createSessionHarness,
  deferred,
} = require('../../../test/sessionTestHarness.cjs');

function screenHarness() {
  const h = createSessionHarness();
  const routes: unknown[] = [];
  let mutation: any;
  h.mocks.set('react', {
    ...React,
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
    useState: (initial: any) => [initial, () => {}],
  });
  h.mocks.set('react-native', {
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    SafeAreaView: 'SafeAreaView',
    StyleSheet: { create: (s: unknown) => s },
  });
  h.mocks.set('@tanstack/react-query', {
    useQueryClient: () => h.queryClient,
    useMutation: (options: any) => {
      mutation = options;
      return { isPending: false };
    },
  });
  h.mocks.set(resolve('src/app/navigation/navigationHooks.ts'), {
    useRootNavigation: () => ({ reset: (r: unknown) => routes.push(r) }),
  });
  h.mocks.set(resolve('src/components/common/ActionPressable.tsx'), {
    default: 'Pressable',
    __esModule: true,
  });
  return { ...h, routes, mutation: () => mutation };
}

describe('real login/signup screens and logout hook', () => {
  for (const kind of ['Login', 'Signup']) {
    it(`${kind} persists before me/account activation and enters mode selection`, async (t) => {
      const h = screenHarness();
      t.after(h.close);
      await h.install('A');
      h.queryClient.setQueryData(['old-financial'], { balance: '100' });
      h.disk.set('selectedTradingAccountId:B', 'old-B-choice');
      let accountReads = 0;
      h.setTransport(async (r: any) => {
        if (r.url === `/auth/${kind.toLowerCase()}`) {
          assert.equal(r.headers.Authorization, undefined);
          return h.ok(r, { user: h.user('B'), tokens: h.credentials('B') });
        }
        assert.equal(r.url, '/trading-accounts');
        assert.equal(r.headers.Authorization, 'Bearer B-access');
        accountReads++;
        return h.ok(r, { accounts: [{ id: 'account-B' }] });
      });
      h.load(`src/screens/auth/${kind}Screen.tsx`).default({ navigation: {} });
      const gate = h.block('tokens.set');
      h.operations.length = 0;
      const pending = h
        .mutation()
        .mutationFn({ email: 'B@example.invalid', password: 'test-only', nickname: 'B' });
      await gate.entered.promise;
      assert.equal(h.queryClient.getQueryData(h.keys.me), undefined);
      assert.equal(h.queryClient.getQueryData(['old-financial']), undefined);
      assert.equal(
        h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
        false,
      );
      assert.equal(accountReads, 0);
      gate.gate.resolve();
      const result = await pending;
      await h.mutation().onSuccess(result);
      assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
      assert.equal(accountReads, 1);
      assert.deepEqual(h.queryClient.getQueryData(h.keys.tradingAccount.list('B')), {
        accounts: [{ id: 'account-B' }],
      });
      assert.deepEqual(h.routes, [{ index: 0, routes: [{ name: 'ModeSelection' }] }]);
      assert.ok(
        !h.operations.includes('get:selectedTradingAccountId:B'),
        'new login must not restore selection',
      );
      assert.equal(h.disk.get('selectedTradingAccountId:B'), 'old-B-choice');
    });
    it(`${kind} save failure does not activate account queries or navigate`, async (t) => {
      const h = screenHarness();
      t.after(h.close);
      h.setTransport(async (r: any) =>
        h.ok(r, { user: h.user('B'), tokens: h.credentials('B') }),
      );
      h.load(`src/screens/auth/${kind}Screen.tsx`).default({ navigation: {} });
      const gate = h.block('tokens.set');
      const pending = h.mutation().mutationFn({});
      const rejected = assert.rejects(pending, /write failed/);
      await gate.entered.promise;
      gate.gate.reject(new Error('write failed'));
      await rejected;
      assert.equal(h.queryClient.getQueryData(h.keys.me), undefined);
      assert.deepEqual(h.routes, []);
      assert.equal(
        h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
        false,
      );
    });
  }
  it('late login HTTP success cannot replace a newer completed login', async (t) => {
    const h = screenHarness();
    t.after(h.close);
    const entered = deferred(),
      reply = deferred();
    let config: any;
    h.setTransport((r: any) => {
      config = r;
      entered.resolve();
      return reply.promise;
    });
    h.load('src/screens/auth/LoginScreen.tsx').default({ navigation: {} });
    const pending = h.mutation().mutationFn({});
    const rejected = assert.rejects(pending, { name: 'SessionSupersededError' });
    await entered.promise;
    await h.install('B');
    reply.resolve(h.ok(config, { user: h.user('A'), tokens: h.credentials('A') }));
    await rejected;
    assert.equal(h.disk.get('accessToken'), 'B-access');
    assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
  });
  it('entry navigation cannot run after its delayed account read belongs to an old session', async (t) => {
    const h = screenHarness();
    t.after(h.close);
    await h.install('A');
    const entered = deferred(),
      reply = deferred();
    let config: any;
    h.setTransport((r: any) => {
      config = r;
      entered.resolve();
      return reply.promise;
    });
    const enter = h.load('src/features/auth/useEnterApp.ts').useEnterApp();
    const pending = enter('A', 'new_login');
    const rejected = assert.rejects(pending);
    await entered.promise;
    await h.install('B');
    reply.resolve(h.ok(config, { accounts: [{ id: 'A-account' }] }));
    await rejected;
    assert.deepEqual(h.routes, []);
    assert.equal(h.queryClient.getQueryData(h.keys.tradingAccount.list('A')), undefined);
  });
  it('useLogout handles failed token read and duplicate taps with one reset', async (t) => {
    const h = screenHarness();
    t.after(h.close);
    await h.install('A');
    const logout = h.load('src/features/auth/useLogout.ts').useLogout();
    const gate = h.block('get:refreshToken');
    const first = logout(),
      second = logout();
    assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
    await gate.entered.promise;
    gate.gate.reject(new Error('read failed'));
    await Promise.all([first, second]);
    assert.deepEqual(h.routes, [
      { index: 0, routes: [{ name: 'AuthStack', params: { screen: 'Login' } }] },
    ]);
    const before = h.requests.length;
    await assert.rejects(h.api.get('/me'));
    assert.equal(h.requests.length, before);
  });
});

describe('AppProviders expiry bridge with real session teardown', () => {
  for (const replace of [false, true])
    it(`pending storage cleanup cannot lose expiry or reset a new login (replace=${replace})`, async (t) => {
      const h = screenHarness();
      t.after(h.close);
      h.disk.set('accessToken', 'dead');
      h.disk.set('refreshToken', 'dead-refresh');
      h.setTransport(async (r: any) => {
        throw h.unauthorized(r);
      });
      await assert.rejects(h.api.get('/me')); // Before the bridge's effect registers.
      h.queryClient.setQueryData(['old-cache'], { balance: '100' });
      const navigated = deferred();
      let resets = 0;
      const reactMock = h.mocks.get('react');
      h.mocks.set('react', { ...reactMock, useEffect: (effect: any) => effect() });
      h.mocks.set('@tanstack/react-query', {
        ...h.mocks.get('@tanstack/react-query'),
        QueryClient: class {
          constructor() {
            return h.queryClient;
          }
        },
        QueryClientProvider: 'QueryClientProvider',
      });
      h.mocks.set(resolve('src/features/tradingAccount/TradingAccountContext.tsx'), {
        TradingAccountProvider: 'Accounts',
      });
      h.mocks.set(resolve('src/app/navigation/navigationRef.ts'), {
        resetToLoginFromRef: () => {
          resets++;
          navigated.resolve();
        },
      });
      const gate = h.block('tokens.remove');
      const providers = h.load('src/app/AppProviders.tsx').default({ children: null });
      const bridge = providers.props.children;
      bridge.type(bridge.props);
      assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
      await gate.entered.promise;
      if (replace) {
        const installing = h.install('B');
        gate.gate.reject(new Error('removal failed'));
        await installing;
        assert.equal(resets, 0);
        assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
      } else {
        gate.gate.reject(new Error('removal failed'));
        await navigated.promise;
        assert.equal(resets, 1);
        assert.equal(h.disk.get('accessToken'), 'dead');
        assert.equal(
          h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
          false,
        );
      }
    });
});

it('Splash restore cannot seed identity or navigate after B has logged in', async (t) => {
  const h = screenHarness();
  t.after(h.close);
  await h.install('A');
  h.mocks.set('react', { ...h.mocks.get('react'), useEffect: (effect: any) => effect() });
  h.mocks.set(resolve('src/components/states/ErrorState.tsx'), {
    default: 'ErrorState',
    __esModule: true,
  });
  const entered = deferred(),
    reply = deferred();
  let config: any;
  h.setTransport((r: any) => {
    config = r;
    entered.resolve();
    return reply.promise;
  });
  h.load('src/screens/auth/SplashScreen.tsx').default({
    navigation: { reset: (route: unknown) => h.routes.push(route) },
  });
  await entered.promise;
  await h.install('B');
  reply.resolve(h.ok(config, h.user('A')));
  // Drain the mocked HTTP/async bootstrap microtasks; no wall-clock race/sleep.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
  assert.deepEqual(h.routes, []);
});

describe('explicit authentication supersedes cold-start restoring requests', () => {
  for (const kind of ['Login', 'Signup']) {
    for (const oldStatus of [401, 200]) {
      it(`${kind} survives old restoring /me ${oldStatus} while auth HTTP is pending`, async (t) => {
        const h = screenHarness();
        t.after(h.close);
        h.attachExpiry();
        const oldEntered = deferred(),
          oldReply = deferred();
        const authEntered = deferred(),
          authReply = deferred();
        let oldConfig: any, authConfig: any;
        h.setTransport((r: any) => {
          if (r.url === '/me') {
            oldConfig = r;
            oldEntered.resolve();
            return oldReply.promise;
          }
          if (r.url.startsWith('/auth/')) {
            authConfig = r;
            authEntered.resolve();
            return authReply.promise;
          }
          assert.equal(r.url, '/trading-accounts');
          assert.equal(r.headers.Authorization, 'Bearer B-access');
          return Promise.resolve(h.ok(r, { accounts: [{ id: 'account-B' }] }));
        });
        const old = h.api.get('/me').then(
          (r: any) => {
            h.queryClient.setQueryData(h.keys.me, r.data.data);
            return 'accepted';
          },
          () => 'discarded',
        );
        await oldEntered.promise;
        h.load(`src/screens/auth/${kind}Screen.tsx`).default({ navigation: {} });
        const pending = h.mutation().mutationFn({});
        const result = pending.then(
          (value: any) => ({ value }),
          (error: unknown) => ({ error }),
        );
        await authEntered.promise;
        if (oldStatus === 401) oldReply.reject(h.unauthorized(oldConfig));
        else oldReply.resolve(h.ok(oldConfig, h.user('A')));
        await old;
        authReply.resolve(
          h.ok(authConfig, { user: h.user('B'), tokens: h.credentials('B') }),
        );
        const completed = await result;
        assert.equal(
          completed.error,
          undefined,
          'old restoring request must not cancel explicit auth',
        );
        await h.mutation().onSuccess(completed.value);
        assert.equal(await old, 'discarded');
        assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
        assert.equal(h.disk.get('accessToken'), 'B-access');
        assert.equal(h.disk.get('refreshToken'), 'B-refresh');
        assert.deepEqual(h.queryClient.getQueryData(h.keys.tradingAccount.list('B')), {
          accounts: [{ id: 'account-B' }],
        });
        assert.deepEqual(h.routes, [{ index: 0, routes: [{ name: 'ModeSelection' }] }]);
        assert.equal(h.expiryCalls, 0);
        assert.deepEqual(h.navigation, []);
      });
    }
    it(`${kind} HTTP failure never activates old restoring credentials`, async (t) => {
      const h = screenHarness();
      t.after(h.close);
      h.attachExpiry();
      const oldEntered = deferred(),
        oldReply = deferred();
      let oldConfig: any;
      h.setTransport((r: any) => {
        if (r.url === '/me') {
          oldConfig = r;
          oldEntered.resolve();
          return oldReply.promise;
        }
        return Promise.reject(h.unauthorized(r));
      });
      const old = h.api.get('/me').catch(() => undefined);
      await oldEntered.promise;
      h.load(`src/screens/auth/${kind}Screen.tsx`).default({ navigation: {} });
      await assert.rejects(h.mutation().mutationFn({}));
      oldReply.resolve(h.ok(oldConfig, h.user('A')));
      await old;
      assert.equal(
        h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
        false,
      );
      assert.equal(h.queryClient.getQueryData(h.keys.me), undefined);
      assert.equal(h.disk.has('accessToken'), false);
      assert.deepEqual(h.routes, []);
      assert.equal(h.expiryCalls, 0);
    });
  }
});
