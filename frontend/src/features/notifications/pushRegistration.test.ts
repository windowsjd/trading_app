import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createPushRegistrar,
  REGISTRATION_REFRESH_MS,
  type PushRegistrationDeps,
} from './pushRegistration.ts';

function setup(overrides: Partial<PushRegistrationDeps> = {}) {
  const log: string[] = [];
  const state = { stored: null as string | null, token: 'ExponentPushToken[t1]', granted: true, now: 0 };
  const deps: PushRegistrationDeps = {
    supported: true,
    platform: 'android',
    isPermissionGranted: async () => state.granted,
    getToken: async () => state.token,
    register: async (token) => { log.push(`register ${token}`); },
    release: async (token) => { log.push(`release ${token}`); },
    readStoredToken: async () => state.stored,
    writeStoredToken: async (token) => { state.stored = token; },
    now: () => state.now,
    ...overrides,
  };
  return { registrar: createPushRegistrar(deps), log, state };
}

describe('push token registration', () => {
  it('registers only after sign-in, for the signed-in user', async () => {
    const { registrar, log, state } = setup();
    assert.equal(await registrar.reconcile({ userId: 'a' }), 'registered');
    assert.deepEqual(log, ['register ExponentPushToken[t1]']);
    assert.equal(state.stored, 'ExponentPushToken[t1]');
  });

  it('does not repeat an unchanged registration, but refreshes it later', async () => {
    const { registrar, log, state } = setup();
    await registrar.reconcile({ userId: 'a' });
    assert.equal(await registrar.reconcile({ userId: 'a' }), 'unchanged');
    state.now = REGISTRATION_REFRESH_MS;
    assert.equal(await registrar.reconcile({ userId: 'a' }), 'registered');
    assert.equal(log.length, 2);
  });

  it('releases on logout before the next user registers', async () => {
    const { registrar, log } = setup();
    await registrar.reconcile({ userId: 'a' });
    // Logout and B's login fire back to back; the queue keeps their order.
    const logout = registrar.reconcile(null);
    const login = registrar.reconcile({ userId: 'b' });
    assert.equal(await logout, 'released');
    assert.equal(await login, 'registered');
    assert.deepEqual(log, [
      'register ExponentPushToken[t1]',
      'release ExponentPushToken[t1]',
      'register ExponentPushToken[t1]',
    ]);
  });

  it('re-registers the same token for a different user (account switch)', async () => {
    const { registrar, log } = setup();
    await registrar.reconcile({ userId: 'a' });
    assert.equal(await registrar.reconcile({ userId: 'b' }), 'registered');
    assert.equal(log.filter((line) => line.startsWith('register')).length, 2);
  });

  it('releases when the OS permission is turned off, and registers when back on', async () => {
    const { registrar, log, state } = setup();
    await registrar.reconcile({ userId: 'a' });
    state.granted = false;
    assert.equal(await registrar.reconcile({ userId: 'a' }), 'released');
    assert.equal(log.at(-1), 'release ExponentPushToken[t1]');
    assert.equal(state.stored, null);
    state.granted = true;
    assert.equal(await registrar.reconcile({ userId: 'a' }), 'registered');
  });

  it('moves the registration to a rotated token', async () => {
    const { registrar, log, state } = setup();
    await registrar.reconcile({ userId: 'a' });
    state.token = 'ExponentPushToken[t2]';
    await registrar.reconcile({ userId: 'a' });
    assert.deepEqual(log.slice(1), ['release ExponentPushToken[t1]', 'register ExponentPushToken[t2]']);
  });

  it('keeps an unreleased token for the next try and never throws', async () => {
    let fail = true;
    const { registrar, state } = setup({
      release: async () => { if (fail) throw new Error('offline'); },
    });
    state.stored = 'ExponentPushToken[old]';
    assert.equal(await registrar.reconcile(null), 'release_failed');
    assert.equal(state.stored, 'ExponentPushToken[old]');
    fail = false;
    assert.equal(await registrar.reconcile(null), 'released');
    assert.equal(state.stored, null);
  });

  it('releases a signed-out device token once per launch (reinstall case)', async () => {
    const { registrar, log } = setup();
    await registrar.reconcile(null);
    await registrar.reconcile(null);
    assert.deepEqual(log, ['release ExponentPushToken[t1]']);
  });

  it('does nothing visible when no token is available or registration fails', async () => {
    const noToken = setup({ getToken: async () => { throw new Error('simulator'); } });
    assert.equal(await noToken.registrar.reconcile({ userId: 'a' }), 'token_unavailable');
    const failing = setup({ register: async () => { throw new Error('500'); } });
    assert.equal(await failing.registrar.reconcile({ userId: 'a' }), 'register_failed');
    assert.equal(failing.state.stored, null);
    const web = setup({ supported: false });
    assert.equal(await web.registrar.reconcile({ userId: 'a' }), 'unsupported');
    assert.deepEqual(web.log, []);
  });
});
