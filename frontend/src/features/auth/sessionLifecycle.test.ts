import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const {
  createSessionHarness,
  deferred,
} = require('../../../test/sessionTestHarness.cjs');
type H = ReturnType<typeof createSessionHarness>;
const outcome = (p: Promise<unknown>) =>
  p.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
function holdRefresh(h: H) {
  const entered = deferred(),
    reply = deferred();
  let config: any;
  h.setTransport(async (r: any) => {
    if (r.url.endsWith('/auth/refresh')) {
      config = r;
      entered.resolve();
      return reply.promise;
    }
    if (r.url === '/auth/logout') return h.ok(r, { revoked: true });
    throw h.unauthorized(r);
  });
  return { entered: entered.promise, reply, config: () => config };
}
function assertB(h: H) {
  assert.equal(h.disk.get('accessToken'), 'B-access');
  assert.equal(h.disk.get('refreshToken'), 'B-refresh');
  assert.equal(h.queryClient.getQueryData(h.keys.me)?.id, 'B');
  assert.deepEqual(h.queryClient.getQueryData(['B-financial']), { balance: '200' });
  assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), true);
}
const missingGenerationGuard = (file: string, source: string) =>
  file.endsWith('/sessionOwnership.ts')
    ? source.replace('owner === generation', 'true')
    : source;
const stopOnRemoveFailure = (file: string, source: string) => {
  if (file.endsWith('/session.ts'))
    return source.replace(
      "reportSessionStorageFailure('remove tokens')",
      "(() => { throw new Error('injected teardown abort'); })()",
    );
  if (file.endsWith('/sessionTeardown.ts'))
    return source.replace('} finally {', '} catch (error) { throw error; } {');
  return source;
};
async function staleSuccess(mutateSource?: (file: string, source: string) => string) {
  const h = createSessionHarness({ mutateSource });
  try {
    h.attachExpiry();
    await h.install('A');
    const gate = holdRefresh(h);
    const old = outcome(h.api.get('/private'));
    await gate.entered;
    await h.logout();
    await h.install('B');
    h.queryClient.setQueryData(['B-financial'], { balance: '200' });
    const resets = h.navigation.length;
    gate.reply.resolve(h.ok(gate.config(), { tokens: h.credentials('A-rotated') }));
    assert.ok((await old).error);
    assertB(h);
    assert.equal(h.expiryCalls, 0);
    assert.equal(h.navigation.length, resets);
    assert.equal(h.requests.filter((r: any) => r.url === '/private').length, 1);
  } finally {
    h.close();
  }
}

describe('actual Axios client and session ownership', () => {
  it('A refresh success after logout/B login cannot write, retry, expire or navigate', async () => {
    await staleSuccess();
  });
  it('A refresh failure after logout/B login cannot expire B', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    h.attachExpiry();
    await h.install('A');
    const gate = holdRefresh(h);
    const old = outcome(h.api.get('/private'));
    await gate.entered;
    await h.logout();
    await h.install('B');
    h.queryClient.setQueryData(['B-financial'], { balance: '200' });
    gate.reply.reject(new Error('A refresh failed'));
    assert.ok((await old).error);
    assertB(h);
    assert.equal(h.expiryCalls, 0);
    assert.deepEqual(h.navigation, ['Login']);
  });
  for (const status of [200, 401])
    it(`late A original ${status} cannot reach B cache or refresh`, async (t) => {
      const h = createSessionHarness();
      t.after(h.close);
      await h.install('A');
      h.attachExpiry();
      const entered = deferred(),
        reply = deferred();
      let original: any;
      h.setTransport((r: any) => {
        original = r;
        entered.resolve();
        return reply.promise;
      });
      const old = outcome(
        h.api
          .get('/me')
          .then((r: any) => h.queryClient.setQueryData(h.keys.me, r.data.data)),
      );
      await entered.promise;
      await h.install('B');
      h.queryClient.setQueryData(['B-financial'], { balance: '200' });
      if (status === 200) reply.resolve(h.ok(original, h.user('A')));
      else reply.reject(h.unauthorized(original));
      assert.ok((await old).error);
      assertB(h);
      assert.equal(h.requests.length, 1);
      assert.equal(h.expiryCalls, 0);
    });
  it('six concurrent 401s refresh once and retry with current rotated credentials', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    const started = deferred(),
      reply = deferred();
    let refreshes = 0,
      originals = 0,
      retries = 0;
    h.setTransport(async (r: any) => {
      if (r.url.endsWith('/auth/refresh')) {
        refreshes++;
        await reply.promise;
        return h.ok(r, { tokens: h.credentials('rotated') });
      }
      if (r.headers.Authorization === 'Bearer A-access') {
        if (++originals === 6) started.resolve();
        throw h.unauthorized(r);
      }
      assert.equal(r.headers.Authorization, 'Bearer rotated-access');
      retries++;
      return h.ok(r, {});
    });
    const requests = Array.from({ length: 6 }, () => h.api.get('/private'));
    await started.promise;
    reply.resolve();
    await Promise.all(requests);
    assert.equal(refreshes, 1);
    assert.equal(retries, 6);
    assert.equal(h.expiryCalls, 0);
  });
  it('a late same-session 401 reuses a completed rotation', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    const entered = deferred(),
      late = deferred();
    let held: any,
      count = 0;
    h.setTransport(async (r: any) => {
      if (r.url.endsWith('/auth/refresh')) {
        count++;
        return h.ok(r, { tokens: h.credentials('rotated') });
      }
      if (r.headers.Authorization === 'Bearer rotated-access') return h.ok(r, {});
      if (r.url === '/late') {
        held = r;
        entered.resolve();
        return late.promise;
      }
      throw h.unauthorized(r);
    });
    const second = h.api.get('/late');
    await entered.promise;
    await h.api.get('/first');
    late.reject(h.unauthorized(held));
    await second;
    assert.equal(count, 1);
  });
  it('B owns a separate refresh; late A completion cannot clear B single-flight', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    const aEntered = deferred(),
      aReply = deferred(),
      bEntered = deferred(),
      bReply = deferred();
    const seen: string[] = [];
    h.setTransport(async (r: any) => {
      if (r.url.endsWith('/auth/refresh')) {
        const token = JSON.parse(r.data).refreshToken;
        seen.push(token);
        if (token === 'A-refresh') {
          aEntered.resolve();
          await aReply.promise;
          throw new Error('old failure');
        }
        bEntered.resolve();
        await bReply.promise;
        return h.ok(r, { tokens: h.credentials('B-rotated') });
      }
      if (r.headers.Authorization === 'Bearer B-rotated-access') return h.ok(r, {});
      throw h.unauthorized(r);
    });
    const old = outcome(h.api.get('/A'));
    await aEntered.promise;
    await h.install('B');
    const current = h.api.get('/B');
    await bEntered.promise;
    aReply.resolve();
    await old;
    const another = h.api.get('/B2');
    bReply.resolve();
    await Promise.all([current, another]);
    assert.deepEqual(seen, ['A-refresh', 'B-refresh']);
    assert.equal(h.disk.get('accessToken'), 'B-rotated-access');
    assert.equal(h.expiryCalls, 0);
  });
  it('A→B→A uses a new generation even for the same user id', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    const owner = h.owner.getSessionGeneration();
    const gate = holdRefresh(h);
    const old = outcome(h.api.get('/private'));
    await gate.entered;
    await h.install('B');
    await h.install('A');
    gate.reply.resolve(h.ok(gate.config(), { tokens: h.credentials('old-A') }));
    assert.ok((await old).error);
    assert.equal(h.disk.get('accessToken'), 'A-access');
    assert.notEqual(h.owner.getSessionGeneration(), owner);
  });
  it('logout intent defeats refresh completion while its storage read is pending', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    const gate = holdRefresh(h);
    const old = outcome(h.api.get('/private'));
    await gate.entered;
    const read = h.block('get:refreshToken');
    const ending = h.logout();
    assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), false);
    assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
    await read.entered.promise;
    gate.reply.resolve(h.ok(gate.config(), { tokens: h.credentials('old-A') }));
    assert.ok((await old).error);
    read.gate.resolve();
    await ending;
    assert.equal(h.disk.has('accessToken'), false);
    assert.deepEqual(h.navigation, ['Login']);
    assert.equal(h.expiryCalls, 0);
  });
  for (const operation of ['tokens.set', 'tokens.remove'])
    it(`already-started A ${operation} cannot finish after B install`, async (t) => {
      const h = createSessionHarness();
      t.after(h.close);
      await h.install('A');
      const gate = h.block(operation);
      const old = outcome(
        operation === 'tokens.set'
          ? h.tokens.saveTokens(
              'late-A-access',
              'late-A-refresh',
              h.owner.getSessionGeneration(),
            )
          : h.logout(),
      );
      await gate.entered.promise;
      const installing = h.install('B');
      assert.equal(
        h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
        false,
      );
      gate.gate.resolve();
      await old;
      await installing;
      assert.equal(h.disk.get('accessToken'), 'B-access');
      assert.equal(h.disk.get('refreshToken'), 'B-refresh');
      assert.equal(h.queryClient.getQueryData(h.keys.me).id, 'B');
      assert.equal(h.navigation.length, 0);
    });
  it('new login discards expiry pending before handler registration', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    h.disk.set('accessToken', 'dead');
    h.disk.set('refreshToken', 'dead-refresh');
    h.setTransport(async (r: any) => {
      throw h.unauthorized(r);
    });
    await assert.rejects(h.api.get('/me'));
    await h.install('B');
    h.attachExpiry();
    assert.equal(h.expiryCalls, 0);
    assert.equal(h.navigation.length, 0);
  });
  it('mutation: removing generation comparison makes stale-success assertions fail', async () => {
    await assert.rejects(staleSuccess(missingGenerationGuard), {
      name: 'AssertionError',
    });
  });
});

async function failedRemoval(mutateSource?: (file: string, source: string) => string) {
  const h = createSessionHarness({ mutateSource });
  try {
    await h.install('A');
    const gate = h.block('tokens.remove');
    const ending = outcome(h.logout());
    await gate.entered.promise;
    gate.gate.reject(new Error('native removal failed'));
    const result = await ending;
    assert.equal(result.error, undefined, 'logout must handle storage failure');
    assert.deepEqual(h.navigation, ['Login']);
    assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
    assert.equal(
      h.disk.get('accessToken'),
      'A-access',
      'physical removal did not succeed',
    );
    assert.equal((result.value as any).tokensRemoved, false);
    const before = h.requests.length;
    await assert.rejects(h.api.get('/private'));
    assert.equal(h.requests.length, before);
  } finally {
    h.close();
  }
}
describe('storage failures at real logout/expiry boundaries', () => {
  it('getRefreshToken failure cannot block invalidation, cache/storage cleanup or Login', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    const gate = h.block('get:refreshToken');
    h.operations.length = 0;
    const ending = h.logout();
    assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), false);
    assert.deepEqual(h.operations, ['cache.clear']);
    await gate.entered.promise;
    gate.gate.reject(new Error('read failed'));
    await ending;
    assert.deepEqual(h.operations, [
      'cache.clear',
      'get:refreshToken',
      'tokens.remove',
      'remove:selectedTradingAccountId:A',
      'navigation.login',
    ]);
    assert.equal(h.requests.length, 0);
    await assert.rejects(h.api.get('/private'));
  });
  it('clearTokens failure completes logout but reports unconfirmed disk removal', async () => {
    await failedRemoval();
  });
  it('clearSelectedAccountId failure does not prevent Login', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.disk.set('selectedTradingAccountId:A', 'account-A');
    const gate = h.block('remove:selectedTradingAccountId:A');
    const ending = h.logout();
    await gate.entered.promise;
    gate.gate.reject(new Error('selection failure'));
    const result = await ending;
    assert.equal(result.tokensRemoved, true);
    assert.equal(result.selectionRemoved, false);
    assert.equal(h.disk.get('selectedTradingAccountId:A'), 'account-A');
    assert.deepEqual(h.navigation, ['Login']);
  });
  it('cold-start dead-token burst + removal failure delivers expiry once and keeps selection', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    h.disk.set('accessToken', 'dead');
    h.disk.set('refreshToken', 'dead-refresh');
    h.disk.set('selectedTradingAccountId:A', 'account-A');
    h.setTransport(async (r: any) => {
      throw h.unauthorized(r);
    });
    await Promise.all(Array.from({ length: 6 }, () => outcome(h.api.get('/private'))));
    assert.equal(h.expiryCalls, 0);
    assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), false);
    const gate = h.block('tokens.remove');
    h.attachExpiry();
    await gate.entered.promise;
    gate.gate.reject(new Error('removal failure'));
    await h.waitForExpiry();
    h.attachExpiry();
    h.expiry.notifySessionExpired();
    assert.equal(h.expiryCalls, 1);
    assert.deepEqual(h.navigation, ['Login']);
    assert.equal(h.disk.get('accessToken'), 'dead');
    assert.equal(h.disk.get('selectedTradingAccountId:A'), 'account-A');
    const before = h.requests.length;
    await assert.rejects(h.api.get('/private'));
    assert.equal(h.requests.length, before);
  });
  for (const read of ['accessToken', 'refreshToken'])
    it(`${read} read failure in a protected request expires once`, async (t) => {
      const h = createSessionHarness();
      t.after(h.close);
      await h.install('A');
      h.attachExpiry();
      h.setTransport(async (r: any) => {
        throw h.unauthorized(r);
      });
      const gate = h.block(`get:${read}`);
      const request = outcome(h.api.get('/private'));
      await gate.entered.promise;
      gate.gate.reject(new Error('read failure'));
      await request;
      await h.waitForExpiry();
      assert.equal(h.expiryCalls, 1);
      assert.deepEqual(h.navigation, ['Login']);
    });
  for (const kind of ['login', 'refresh'])
    it(`partial token save failure in ${kind} cannot install an authenticated cache`, async (t) => {
      const h = createSessionHarness();
      t.after(h.close);
      await h.install('A');
      h.attachExpiry();
      h.storage.multiSet = async (pairs: string[][]) => {
        h.disk.set(pairs[0][0], pairs[0][1]);
        throw new Error('partial multiSet');
      };
      if (kind === 'login') await assert.rejects(h.install('B'));
      else {
        h.setTransport(async (r: any) => {
          if (r.url.endsWith('/auth/refresh'))
            return h.ok(r, { tokens: h.credentials('rotated') });
          throw h.unauthorized(r);
        });
        await assert.rejects(h.api.get('/private'));
        await h.waitForExpiry();
      }
      assert.equal(h.queryClient.getQueryCache().getAll().length, 0);
      assert.equal(
        h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()),
        false,
      );
      assert.equal(h.disk.has('accessToken'), false);
      assert.equal(h.disk.has('refreshToken'), false);
    });
  it('pending or failing server revoke does not delay local completion', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    const revoke = deferred();
    h.setTransport(() => revoke.promise);
    await h.logout();
    assert.deepEqual(h.navigation, ['Login']);
    assert.equal(h.disk.has('accessToken'), false);
    revoke.reject(new Error('server failed'));
  });
  it('mutation: removing storage failure protection makes logout assertions fail', async () => {
    await assert.rejects(failedRemoval(stopOnRemoveFailure), { name: 'AssertionError' });
  });
});

describe('ownership across pending native I/O and retry dispatch', () => {
  it('refresh already inside multiSet cannot overwrite or retry after B installs', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    const refresh = holdRefresh(h);
    const old = outcome(h.api.get('/private'));
    await refresh.entered;
    const write = h.block('tokens.set');
    refresh.reply.resolve(h.ok(refresh.config(), { tokens: h.credentials('rotated-A') }));
    await write.entered.promise;
    const install = h.install('B');
    write.gate.resolve();
    await install;
    assert.ok((await old).error);
    assert.equal(h.disk.get('accessToken'), 'B-access');
    assert.equal(h.expiryCalls, 0);
    assert.equal(h.requests.filter((r: any) => r.url === '/private').length, 1);
  });
  for (const readNumber of [1, 3])
    it(`session switch during access-token read #${readNumber} blocks old dispatch`, async (t) => {
      const h = createSessionHarness();
      t.after(h.close);
      await h.install('A');
      let reads = 0;
      const entered = deferred(),
        release = deferred();
      const getItem = h.storage.getItem;
      h.storage.getItem = async (key: string) => {
        if (key === 'accessToken' && ++reads === readNumber) {
          entered.resolve();
          await release.promise;
        }
        return getItem(key);
      };
      h.setTransport(async (r: any) => {
        if (r.url.endsWith('/auth/refresh'))
          return h.ok(r, { tokens: h.credentials('rotated-A') });
        throw h.unauthorized(r);
      });
      const old = outcome(h.api.get('/private'));
      await entered.promise;
      const install = h.install('B');
      release.resolve();
      await install;
      assert.ok((await old).error);
      assert.equal(
        h.requests.filter((r: any) => r.url === '/private').length,
        readNumber === 1 ? 0 : 1,
      );
      assert.equal(h.disk.get('accessToken'), 'B-access');
    });
  it('an old per-user selection removal finishes before a new login by that user', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    const gate = h.block('remove:selectedTradingAccountId:A');
    const ending = h.logout();
    await gate.entered.promise;
    const installing = h.install('A');
    gate.gate.resolve();
    await ending;
    await installing;
    h.disk.set('selectedTradingAccountId:A', 'new-account');
    assert.equal(h.disk.get('selectedTradingAccountId:A'), 'new-account');
    assert.equal(h.navigation.length, 0);
  });
});

describe('new session recovery after expiry/storage failures', () => {
  it('a failed cleanup does not poison storage or the next session expiry', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    const gate = h.block('tokens.remove');
    h.expiry.notifySessionExpired();
    await gate.entered.promise;
    gate.gate.reject(new Error('remove failed'));
    await h.waitForExpiry();
    await h.install('B');
    assert.equal(h.disk.get('accessToken'), 'B-access');
    h.expiry.notifySessionExpired();
    await h.waitForExpiry();
    assert.equal(h.expiryCalls, 2);
    assert.deepEqual(h.navigation, ['Login', 'Login']);
    assert.equal(h.disk.has('accessToken'), false);
  });
  it('public login errors neither attach old credentials nor refresh/expire them', async (t) => {
    const h = createSessionHarness();
    t.after(h.close);
    await h.install('A');
    h.attachExpiry();
    h.setTransport(async (r: any) => {
      assert.equal(r.headers.Authorization, undefined);
      throw h.unauthorized(r);
    });
    await assert.rejects(
      h.auth.login({ email: 'wrong@example.invalid', password: 'wrong' }),
    );
    assert.equal(h.requests.length, 1);
    assert.equal(h.expiryCalls, 0);
    assert.equal(h.disk.get('accessToken'), 'A-access');
  });
});
