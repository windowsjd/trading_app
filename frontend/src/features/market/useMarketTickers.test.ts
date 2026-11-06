import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager.ts';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy.ts';
import * as store from './marketTickerStore.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

function setup(t: { after: (fn: () => void) => void }, props: Record<string, unknown> = {}) {
  const h = interactionHarness();
  const listeners = new Map<string, (event: RealtimeSubscriptionEvent) => void>();
  const released: string[] = [];
  const frames = new Map<number, () => void>();
  let nextFrame = 0;
  const previousRaf = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: () => void) => { frames.set(++nextFrame, callback); return nextFrame; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => { frames.delete(id); }) as typeof cancelAnimationFrame;
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel; });
  const { useMarketTickers } = h.load('src/features/market/useMarketTickers.ts', {
    './marketTickerStore': store,
    '../asset/useStaleRecheck': { useStaleRecheck: () => {} },
    '../../services/ws/sharedRealtimeSocket': { getRealtimeSocketManager: () => ({
      subscribe: (spec: { assetId: string }, listener: (event: RealtimeSubscriptionEvent) => void) => {
        listeners.set(spec.assetId, listener);
        return () => { released.push(spec.assetId); listeners.delete(spec.assetId); };
      },
    }) },
  });
  let renders = 0;
  let result: any;
  const Probe = (next: Record<string, unknown>) => {
    renders += 1;
    result = useMarketTickers({ assetIds: ['btc', 'eth'], wsUrl: 'wss://app/api/v1/ws', ...next });
    return null;
  };
  const renderer = h.render(React.createElement(Probe, props));
  return {
    result: () => result,
    renders: () => renders,
    frames: () => frames.size,
    released,
    emit: (assetId: string, event: RealtimeSubscriptionEvent) => act(() => listeners.get(assetId)?.(event)),
    flush: () => act(() => { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); }),
    update: (next: Record<string, unknown>) => act(() => renderer.update(React.createElement(Probe, next))),
    unmount: () => act(() => renderer.unmount()),
  };
}

function tick(assetId: string, priceLocal: string, second: number): RealtimeSubscriptionEvent {
  const at = new Date(Date.now() - 1000 + second).toISOString();
  const ticker: AssetTickerMessage = {
    type: 'asset_ticker', assetId, priceLocal, priceKrw: null, priceKrwState: 'unavailable',
    assetPriceSnapshotId: `${assetId}-${priceLocal}`, priceCapturedAt: at, priceEffectiveAt: at, freshnessAgeSeconds: 0,
  } as AssetTickerMessage;
  return { kind: 'message', payload: ticker as unknown as Record<string, unknown> } as RealtimeSubscriptionEvent;
}

describe('useMarketTickers rendering follows the list on screen', () => {
  it('a burst of tickers renders once, on the next frame, with the newest price of every row', (t) => {
    const h = setup(t);
    h.flush();
    const before = h.renders();
    h.emit('btc', tick('btc', '100', 1));
    h.emit('eth', tick('eth', '10', 2));
    h.emit('btc', tick('btc', '101', 3));
    assert.equal(h.renders(), before, 'no render per message');
    assert.equal(h.frames(), 1, 'one frame scheduled for the burst');
    h.flush();
    assert.equal(h.renders(), before + 1);
    assert.equal(h.result().tickersByAssetId.get('btc').priceLocal, '101');
    assert.equal(h.result().tickersByAssetId.get('eth').priceLocal, '10');
  });

  it('hidden (a pushed detail, another tab): still subscribed, no render; shown again: the newest prices at once', (t) => {
    const h = setup(t);
    h.emit('btc', tick('btc', '100', 1));
    h.flush();
    h.update({ visible: false });
    const hidden = h.renders();
    h.emit('btc', tick('btc', '105', 2));
    h.emit('eth', tick('eth', '11', 3));
    assert.equal(h.frames(), 0, 'nothing scheduled while hidden');
    h.flush();
    assert.equal(h.renders(), hidden);
    assert.deepEqual(h.released, [], 'the rows stay subscribed');
    h.update({ visible: true });
    assert.equal(h.result().tickersByAssetId.get('btc').priceLocal, '105', 'no older price shown on return');
    assert.equal(h.result().tickersByAssetId.get('eth').priceLocal, '11');
  });

  it('runtime-only changes (acks, diagnostics) render only for admin diagnostics', (t) => {
    for (const diagnostics of [false, true]) {
      const h = setup(t, { diagnostics });
      h.flush();
      const before = h.renders();
      h.emit('btc', { kind: 'runtime', runtime: { socket: {}, subscription: { subscriptionAcked: true } } } as unknown as RealtimeSubscriptionEvent);
      h.flush();
      assert.equal(h.renders(), before + (diagnostics ? 1 : 0), String(diagnostics));
      h.unmount();
    }
  });

  it('unmounting cancels a pending frame and releases only its own rows', (t) => {
    const h = setup(t);
    h.emit('btc', tick('btc', '100', 1));
    assert.equal(h.frames(), 1);
    h.unmount();
    assert.equal(h.frames(), 0);
    assert.deepEqual(h.released.sort(), ['btc', 'eth']);
  });
});
