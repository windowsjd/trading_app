import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const { createSessionHarness, deferred } = require('../../../test/sessionTestHarness.cjs');

/**
 * 「로그인 없이 둘러보기」 over the REAL session boundary: axios interceptors,
 * session ownership, token storage, expiry bridge and session teardown.
 * Only transport, native storage, navigation and React hooks are controlled.
 */
function guestHarness() {
  const h = createSessionHarness();
  const routes: unknown[] = [];
  h.mocks.set('react', {
    ...React,
    useCallback: (fn: unknown) => fn,
    useState: (initial: unknown) => [initial, () => {}],
    useRef: (initial: unknown) => ({ current: initial }),
  });
  h.mocks.set('@tanstack/react-query', { useQueryClient: () => h.queryClient });
  h.mocks.set(resolve('src/app/navigation/navigationHooks.ts'), {
    useRootNavigation: () => ({ reset: (route: unknown) => routes.push(route) }),
  });
  const guest = h.load('src/features/auth/guestBrowsing.ts');
  const market = h.load('src/features/market/api.ts');
  const page = { assets: [], pagination: { nextOffset: null } };
  const refreshes = () => h.requests.filter((request: { url: string }) => request.url.endsWith('/auth/refresh')).length;
  return { ...h, routes, guest, market, page, refreshes };
}

const HOME = { index: 0, routes: [{ name: 'MainTabs', params: { screen: 'HomeTab', params: { screen: 'Home' } } }] };

describe('guest browsing entry', () => {
  it('opens Home creating nothing: no request, token, user or account', async (t) => {
    const h = guestHarness();
    t.after(h.close);
    const browse = h.load('src/features/auth/useBrowseAsGuest.ts').useBrowseAsGuest();

    await browse.start();

    assert.deepEqual(h.routes, [HOME]);
    assert.equal(h.guest.isGuestBrowsing(), true);
    assert.equal(h.requests.length, 0, 'entry sends nothing to the server');
    assert.equal(h.disk.size, 0, 'no token, selection or guest marker is stored');
    assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), false);
  });

  it("a cold start's pre-login /me 401 cannot expire the guest back to login", async (t) => {
    const h = guestHarness();
    t.after(h.close);
    h.attachExpiry();
    const entered = deferred();
    const reply = deferred();
    let pending: any;
    h.setTransport((config: any) => {
      pending = config;
      entered.resolve();
      return reply.promise;
    });
    // The account provider's /me, sent while the app was still restoring.
    const me = h.api.get('/me');
    const rejected = assert.rejects(me, { name: 'SessionSupersededError' });
    await entered.promise;

    await h.load('src/features/auth/useBrowseAsGuest.ts').useBrowseAsGuest().start();
    reply.reject(h.unauthorized(pending));
    await rejected;
    await h.waitForExpiry();

    assert.equal(h.expiryCalls, 0);
    assert.deepEqual(h.navigation, [], 'never reset to Login');
    assert.deepEqual(h.routes, [HOME]);
    assert.equal(h.refreshes(), 0);
  });

  it('an expiry already tearing down finishes its reset to login before browsing begins', async (t) => {
    const h = guestHarness();
    t.after(h.close);
    h.attachExpiry();
    await h.install('A');
    h.setTransport(async (config: any) => { throw h.unauthorized(config); });
    const gate = h.block('tokens.remove');
    void h.api.get('/me').catch(() => undefined);
    await gate.entered.promise;

    const order: string[] = [];
    const entry = h.session.beginGuestBrowsing(h.queryClient).then(() => order.push('guest'));
    await new Promise((done) => setTimeout(done, 10));
    assert.deepEqual(order, [], 'browsing waits for the running teardown');
    gate.gate.resolve();
    await entry;

    assert.deepEqual(h.navigation, ['Login']);
    assert.deepEqual(order, ['guest']);
    assert.equal(h.disk.get('accessToken'), undefined);
  });

  it("a signed-out member's cache and tokens do not survive into browsing", async (t) => {
    const h = guestHarness();
    t.after(h.close);
    await h.install('A');
    h.queryClient.setQueryData(['tradingAccount', 'portfolio', 'account-A'], { totalAssetKrw: '1' });
    await h.logout();
    // Anything cached after the logout itself (a stale observer's write).
    h.queryClient.setQueryData(['wallet', 'account-A'], { balance: '1' });

    await h.session.beginGuestBrowsing(h.queryClient);

    assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(h.disk.get('accessToken'), undefined);
    assert.equal(h.disk.get('refreshToken'), undefined);
  });
});

describe('requests while browsing', () => {
  it('market reads go out without credentials; account reads never leave the device', async (t) => {
    const h = guestHarness();
    t.after(h.close);
    h.attachExpiry();
    h.disk.set('accessToken', 'stale-access');
    await h.session.beginGuestBrowsing(h.queryClient);
    h.setTransport(async (config: any) => h.ok(config, h.page));

    await h.market.getAssets({ assetType: 'crypto', withPrice: true });
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].headers.Authorization === undefined, true);
    assert.equal(h.requests[0].skipSessionAuth, true);

    for (const path of ['/me', '/trading-accounts', '/trading-accounts/account-A/portfolio', '/trading-accounts/account-A/positions']) {
      await assert.rejects(h.api.get(path), { name: 'SessionSupersededError' });
    }
    assert.equal(h.requests.length, 1, 'no account-scoped request was sent');
    assert.equal(h.expiryCalls, 0);
    assert.deepEqual(h.navigation, []);
  });

  it("a market the server keeps from guests is a plain 401: no refresh, expiry or reset", async (t) => {
    const h = guestHarness();
    t.after(h.close);
    h.attachExpiry();
    await h.session.beginGuestBrowsing(h.queryClient);
    h.setTransport(async (config: any) => { throw h.unauthorized(config); });

    await assert.rejects(
      h.market.getAssets({ assetType: 'domestic_stock' }),
      (error: any) => error?.response?.status === 401,
    );
    assert.equal(h.refreshes(), 0);
    assert.equal(h.expiryCalls, 0);
    assert.deepEqual(h.navigation, []);
    assert.equal(h.guest.isGuestBrowsing(), true);
  });

  it('signing in from browsing ends it and drops what the guest had cached', async (t) => {
    const h = guestHarness();
    t.after(h.close);
    await h.session.beginGuestBrowsing(h.queryClient);
    h.queryClient.setQueryData(['market', 'assets', { assetType: 'crypto' }], h.page);

    await h.install('B');

    assert.equal(h.guest.isGuestBrowsing(), false);
    assert.equal(h.queryClient.getQueryData(['market', 'assets', { assetType: 'crypto' }]) === undefined, true);
    assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
    // The member's own reads carry their credentials again.
    h.setTransport(async (config: any) => h.ok(config, h.page));
    await h.market.getAssets({ assetType: 'crypto' });
    assert.equal(h.requests.at(-1).headers.Authorization, 'Bearer B-access');
  });

  it('a sign-in begun during entry owns the next screen', async (t) => {
    const h = guestHarness();
    t.after(h.close);
    h.disk.set('accessToken', 'stale');
    const gate = h.block('tokens.remove');
    const start = h.load('src/features/auth/useBrowseAsGuest.ts').useBrowseAsGuest().start();
    await gate.entered.promise;
    const signIn = h.install('B');
    gate.gate.resolve();
    await start;
    await signIn;

    assert.deepEqual(h.routes, [], 'no reset to the guest tabs over the new session');
    assert.equal(h.guest.isGuestBrowsing(), false);
    assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B', "the new session's cache is kept");
  });
});
