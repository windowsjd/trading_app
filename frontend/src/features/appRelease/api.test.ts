import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { createSessionHarness } = require('../../../test/sessionTestHarness.cjs');

/**
 * The public release manifest over the REAL session boundary (axios
 * interceptors, session ownership, token storage, expiry bridge): only the
 * transport is controlled.
 */
function releaseHarness() {
  const h = createSessionHarness();
  const release = h.load('src/features/appRelease/api.ts');
  const manifest = { android: { packageName: 'com.nanghwa.tradingclass', latestVersion: '1.0.2', notes: null }, ios: null };
  h.setTransport(async (config: unknown) => h.ok(config, manifest));
  return { ...h, release, manifest };
}

describe('GET /app-release (public)', () => {
  it('a signed-out app (no session: ended or browsing as a guest) still reads it, without credentials', async (t) => {
    const h = releaseHarness();
    t.after(h.close);
    h.attachExpiry();
    await h.session.beginGuestBrowsing(h.queryClient);
    assert.equal(h.owner.canUseSessionCredentials(h.owner.getSessionGeneration()), false, 'no usable session');
    // An account read is refused before it is sent, as before.
    await assert.rejects(h.api.get('/me'), { name: 'SessionSupersededError' });

    const parsed = await h.release.getAppRelease();
    assert.deepEqual(parsed.android, h.manifest.android);
    const sent = h.requests.filter((request: { url: string }) => request.url.endsWith('/app-release'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers.Authorization === undefined, true);
    assert.equal(sent[0].skipSessionAuth, true);
    assert.equal(h.expiryCalls, 0);
    assert.deepEqual(h.navigation, []);
  });

  it('signed in, it never attaches, refreshes or ends the session: even a 401 leaves the session as it was', async (t) => {
    const h = releaseHarness();
    t.after(h.close);
    h.attachExpiry();
    await h.install('member');
    const generation = h.owner.getSessionGeneration();

    await h.release.getAppRelease();
    const sent = h.requests.filter((request: { url: string }) => request.url.endsWith('/app-release'));
    assert.equal(sent[0].headers.Authorization === undefined, true, 'no token on a public read');

    h.setTransport(async (config: unknown) => { throw h.unauthorized(config); });
    await assert.rejects(h.release.getAppRelease());
    assert.equal(h.requests.some((request: { url: string }) => request.url.endsWith('/auth/refresh')), false, 'no refresh attempt');
    assert.equal(h.expiryCalls, 0, 'the session is not expired');
    assert.equal(h.owner.getSessionGeneration(), generation);
    assert.equal(h.owner.canUseSessionCredentials(generation), true);
  });
});
