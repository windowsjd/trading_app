import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  bootstrapNotificationPermission,
  permissionAction,
  shouldRequestOnFirstLaunch,
  toDevicePermission,
  type PermissionBootstrapDeps,
  type PermissionSnapshot,
} from './pushPermission.ts';

const undetermined: PermissionSnapshot = { status: 'undetermined', granted: false, canAskAgain: true };
const granted: PermissionSnapshot = { status: 'granted', granted: true, canAskAgain: true };
const denied: PermissionSnapshot = { status: 'denied', granted: false, canAskAgain: false };

function deps(initial: PermissionSnapshot, answer: PermissionSnapshot, requested = false) {
  const calls: string[] = [];
  let flag = requested;
  const d: PermissionBootstrapDeps = {
    ensureChannel: async () => { calls.push('channel'); },
    getPermission: async () => { calls.push('get'); return initial; },
    requestPermission: async () => { calls.push('request'); return answer; },
    readRequested: async () => flag,
    writeRequested: async () => { calls.push('mark'); flag = true; },
  };
  return { d, calls };
}

describe('first-launch notification permission', () => {
  it('asks once on a fresh install, after creating the Android channel', async () => {
    const { d, calls } = deps(undetermined, granted);
    assert.equal(await bootstrapNotificationPermission(d), 'granted');
    assert.deepEqual(calls, ['channel', 'get', 'mark', 'request']);
    // The next launch does not ask again, whatever was answered.
    calls.length = 0;
    const again = deps(undetermined, granted, true);
    assert.equal(await bootstrapNotificationPermission(again.d), 'undetermined');
    assert.equal(again.calls.includes('request'), false);
  });

  it('never re-asks an allowed or denied permission', async () => {
    for (const current of [granted, denied, { ...denied, canAskAgain: true }]) {
      const { d, calls } = deps(current, granted);
      await bootstrapNotificationPermission(d);
      assert.equal(calls.includes('request'), false);
    }
  });

  it('treats Android 12 and below (granted at install) as nothing to ask', async () => {
    const { d, calls } = deps(granted, denied);
    assert.equal(await bootstrapNotificationPermission(d), 'granted');
    assert.equal(calls.includes('request'), false);
  });

  it('reports a denial without throwing, so sign-in is never blocked', async () => {
    const { d } = deps(undetermined, denied);
    assert.equal(await bootstrapNotificationPermission(d), 'denied');
    const broken: PermissionBootstrapDeps = {
      ...d,
      getPermission: async () => { throw new Error('native module missing'); },
    };
    assert.equal(await bootstrapNotificationPermission(broken), 'unavailable');
  });

  it('still asks when the channel or the storage flag fails', async () => {
    const { d, calls } = deps(undetermined, granted);
    await bootstrapNotificationPermission({
      ...d,
      ensureChannel: async () => { throw new Error('channel'); },
      readRequested: async () => { throw new Error('storage'); },
      writeRequested: async () => { throw new Error('storage'); },
    });
    assert.equal(calls.includes('request'), true);
  });

  it('reads iOS through its authorization status', () => {
    assert.equal(toDevicePermission({ ...denied, iosStatus: 0 }), 'undetermined');
    assert.equal(toDevicePermission({ ...granted, iosStatus: 1 }), 'denied');
    assert.equal(toDevicePermission({ ...denied, iosStatus: 3 }), 'granted');
    assert.equal(shouldRequestOnFirstLaunch({ ...undetermined, canAskAgain: false }, false), false);
  });

  it('offers a request only while the OS can still ask, otherwise its settings', () => {
    assert.equal(permissionAction('undetermined', true), 'request');
    assert.equal(permissionAction('undetermined', false), 'open_settings');
    assert.equal(permissionAction('denied', true), 'open_settings');
    assert.equal(permissionAction('granted', false), 'none');
    assert.equal(permissionAction('unsupported', true), 'none');
  });
});
