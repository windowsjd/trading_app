import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { realtimeHookHarness } = require('../../../test/realtimeHookHarness.cjs');

function ticker(overrides = {}) {
  return { type: 'asset_ticker', assetId: 'btc', priceLocal: '100', priceKrw: '140000', priceKrwState: 'available',
    assetPriceSnapshotId: 'snap-1', priceCapturedAt: new Date(Date.now()).toISOString(), ...overrides };
}
describe('ticker observed runtime', () => {
  it('separates actual socket state, ACK, freshness, policy rejection and last good receipt', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
    const h = await realtimeHookHarness('useAssetTicker'); h.open();
    h.send({ type: 'subscribed', channel: 'asset_ticker', assetId: 'btc' });
    h.send(ticker({ snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT' }));
    assert.equal(h.result().runtime.socketStatus, 'connected');
    assert.equal(h.result().runtime.subscriptionAcked, true);
    assert.equal(h.result().runtime.tickerDataState, 'available');
    assert.equal(h.result().runtime.lastServerSnapshotCode, 'THROTTLED_PROVIDER_SNAPSHOT');
    assert.equal(h.result().runtime.tickerCapturedAt, new Date(100000).toISOString());
    assert.equal(h.result().runtime.tickerFreshnessEvaluatedAt, new Date(100000).toISOString());
    await h.tick(t, 65000);
    const acceptedAt = h.result().runtime.lastTickerAcceptedAt;
    assert.equal(h.result().isStale, true);
    assert.equal(h.result().runtime.tickerStaleReason, 'freshness_timeout');
    h.send(ticker({ priceLocal: '999' }));
    assert.equal(h.result().runtime.lastTickerRejectionReason, 'duplicate_snapshot');
    assert.equal(h.result().runtime.lastTickerAcceptedAt, acceptedAt);
    assert.notEqual(h.result().runtime.lastTickerReceivedAt, acceptedAt);
    h.send(ticker({ assetPriceSnapshotId: 'old', priceCapturedAt: new Date(99999).toISOString() }));
    assert.equal(h.result().runtime.lastTickerRejectionReason, 'older_event');
    h.drop(1006);
    assert.equal(h.result().runtime.socketStatus, 'disconnected');
    assert.equal(h.result().runtime.lastCloseCode, 1006);
    assert.equal(h.result().showReconnectBanner, true);
    await h.tick(t, 1000);
    assert.equal(h.result().runtime.socketStatus, 'reconnecting');
    h.open();
    h.send({ type: 'subscription_error', channel: 'asset_ticker', assetId: 'btc', code: 'SUBSCRIPTION_LIMIT' });
    assert.equal(h.result().runtime.socketStatus, 'connected');
    assert.equal(h.result().connectionState, 'subscription_error');
    assert.equal(h.result().runtime.lastSubscriptionErrorCode, 'SUBSCRIPTION_LIMIT');
    h.drop(1008);
    assert.equal(h.result().runtime.socketStatus, 'auth_failed');
    assert.equal(h.result().runtime.tickerStale, true);
    assert.doesNotMatch(JSON.stringify(h.result().runtime), /private-token|wss:/);
    h.unmount();
  });

  it('accepts server-unavailable and closed-market observations with the existing policy', async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
    const h = await realtimeHookHarness('useAssetTicker'); h.open();
    assert.equal(h.result().runtime.tickerDataState, 'no_accepted_message');
    h.send(ticker({ priceLocal: null, priceKrw: null, priceKrwState: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE' }));
    assert.equal(h.result().runtime.tickerDataState, 'server_unavailable');
    assert.equal(h.result().runtime.lastServerTickerCode, 'ASSET_PRICE_UNAVAILABLE');
    h.send(ticker({ realtime: false, marketStatus: 'closed', marketEvaluatedAt: new Date(101000).toISOString(), priceCapturedAt: new Date(1).toISOString() }));
    await h.tick(t, 65000);
    assert.equal(h.result().runtime.tickerDataState, 'closed_market_snapshot');
    assert.equal(h.result().isStale, false);
    h.unmount();
  });
});
