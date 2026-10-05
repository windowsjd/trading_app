import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { realtimeHookHarness } = require('../../../test/realtimeHookHarness.cjs');

function snapshot(overrides = {}) {
  return { type: 'asset_candle', assetId: 'btc', interval: '5m',
    candle: { time: '1970-01-01T00:00:00Z', closeTime: '1970-01-01T00:05:00Z',
      open: '100', high: '110', low: '90', close: '105', volume: '1' },
    sequence: 1, revision: 1, provisional: true, complete: false, final: false,
    delayed: false, sourceUpdatedAt: new Date(Date.now()).toISOString(), ...overrides };
}
const control = (type: string, code?: string) => ({ type, channel: 'asset_candle', assetId: 'btc', interval: '5m', code });
describe('candle direct stale/resync runtime', () => {
  it('keeps valid receipt/source times and does not extend stale timers for diagnostic notifications', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const h = await realtimeHookHarness('useAssetCandle'); h.open(); h.send(control('subscribed'));
    h.send(snapshot());
    const acceptedAt = h.result().runtime.lastSnapshotAcceptedAt;
    assert.equal(h.result().runtime.subscriptionAcked, true);
    assert.equal(h.result().runtime.freshnessBasis, 'source_updated_at');
    await h.tick(t, 20000);
    const otherOff = h.manager.subscribe({ channel: 'asset_ticker', assetId: 'btc' }, () => {});
    await h.tick(t, 10000);
    assert.equal(h.result().isStale, true);
    assert.equal(h.result().runtime.staleReason, 'freshness_timeout');
    h.send(snapshot());
    assert.equal(h.result().runtime.lastSnapshotAcceptedAt, acceptedAt);
    assert.equal(h.result().runtime.lastRejectionReason, 'duplicate_or_older_sequence_revision');
    assert.equal(h.result().isStale, true);
    h.send(snapshot({ sequence: 0, revision: 100 }));
    assert.equal(h.result().runtime.lastSnapshotAcceptedAt, acceptedAt);
    h.send(snapshot({ sequence: 2 }));
    assert.equal(h.result().isStale, false);
    assert.equal(h.result().runtime.staleReason, null);
    assert.equal(h.result().runtime.lastSourceUpdatedAt, new Date(130000).toISOString());
    assert.equal(h.result().resyncVersion, 0);
    otherOff(); h.unmount();
  });

  for (const [type, reason, code] of [
    ['candle_stale', 'server_candle_stale', 'CANDLE_PUBSUB_UNAVAILABLE'],
    ['subscription_error', 'subscription_error', 'SUBSCRIPTION_LIMIT'],
    ['resync_required', 'resync_required', 'CANDLE_PUBSUB_RECOVERED'],
  ]) it(`records ${type} safe control cause and clears stale on valid snapshot`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const h = await realtimeHookHarness('useAssetCandle'); h.open(); h.send(snapshot());
    h.send(control(type, code));
    assert.equal(h.result().isStale, true);
    assert.equal(h.result().runtime.staleReason, reason);
    assert.equal(h.result().runtime.lastControlType, type);
    assert.equal(h.result().runtime.lastControlCode, code);
    assert.equal(h.result().runtime.lastControlAt, new Date(100000).toISOString());
    assert.equal(h.result().resyncVersion, type === 'resync_required' ? 1 : 0);
    if (type === 'resync_required') assert.equal(h.result().runtime.lastResyncReason, 'resync_required');
    await h.tick(t, 30000);
    assert.equal(h.result().runtime.staleReason, reason, 'old timer cannot replace the direct cause');
    h.send(snapshot({ sequence: 2 })); assert.equal(h.result().isStale, false);
    assert.equal(h.result().runtime.staleReason, null);
    h.unmount();
  });

  it('distinguishes disconnect, reconnect, restored HTTP resync and auth failure', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const h = await realtimeHookHarness('useAssetCandle'); h.open(); h.send(snapshot({ sequence: 20 }));
    h.drop(1006);
    assert.equal(h.result().runtime.staleReason, 'socket_disconnected');
    await h.tick(t, 1000);
    assert.equal(h.result().runtime.staleReason, 'socket_reconnecting');
    h.open();
    assert.equal(h.result().resyncVersion, 1);
    assert.equal(h.result().runtime.staleReason, 'reconnect_restored_resync');
    assert.equal(h.result().runtime.lastResyncReason, 'reconnect_restored_resync');
    assert.equal(h.result().runtime.lastResyncAt, new Date(101000).toISOString());
    h.send(snapshot({ sequence: 1 }));
    assert.equal(h.result().isStale, false, 'new socket ordering space still resets');
    h.drop(1008);
    assert.equal(h.result().runtime.staleReason, 'auth_failed');
    assert.equal(h.result().runtime.socketStatus, 'auth_failed');
    await h.tick(t, 30000);
    assert.equal(h.sockets.length, 2);
    h.unmount();
  });

  it('keeps delayed freshness based on local receipt and 1d/1w HTTP-only', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    const h = await realtimeHookHarness('useAssetCandle'); h.open();
    h.send(snapshot({ delayed: true, sourceUpdatedAt: new Date(1).toISOString() }));
    assert.equal(h.result().runtime.delayed, true);
    assert.equal(h.result().runtime.freshnessBasis, 'client_receipt');
    await h.tick(t, 29999); assert.equal(h.result().isStale, false);
    await h.tick(t, 1); assert.equal(h.result().runtime.staleReason, 'freshness_timeout');
    h.update({ interval: '1d' });
    assert.equal(h.result().liveEnabled, false);
    assert.equal(h.manager.getSubscriptionCount(), 0);
    h.update({ interval: '1w' }); assert.equal(h.manager.getSubscriptionCount(), 0);
    h.unmount();
  });
});
