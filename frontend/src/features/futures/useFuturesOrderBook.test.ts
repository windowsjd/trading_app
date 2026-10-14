import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as policy from '../asset/assetOrderBookPolicy.ts';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

type Subscription = { spec: Record<string, string>; listener: (event: RealtimeSubscriptionEvent) => void; released: boolean };

function setup() {
  const h = interactionHarness();
  const subscriptions: Subscription[] = [];
  h.native.AppState = { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
  const { useStaleRecheck } = h.load('src/features/asset/useStaleRecheck.ts', {
    './assetTickerPolicy': { STALE_RECHECK_INTERVAL_MS: 5000 },
  });
  const stream = h.load('src/features/asset/orderBookStream.ts', {
    './assetOrderBookPolicy': policy, './useStaleRecheck': { useStaleRecheck },
    '../../services/ws/sharedRealtimeSocket': { getRealtimeSocketManager: () => ({
      subscribe: (spec: Record<string, string>, listener: Subscription['listener']) => {
        const entry = { spec, listener, released: false }; subscriptions.push(entry);
        return () => { entry.released = true; };
      },
    }) },
  });
  const { useFuturesOrderBook } = h.load('src/features/futures/useFuturesOrderBook.ts', {
    '../asset/orderBookStream': stream,
  });
  let result: any;
  const Probe = (props: any) => { result = useFuturesOrderBook({ wsUrl: 'wss://app/api/v1/ws', ...props }); return null; };
  const renderer = h.render(React.createElement(Probe, { instrumentId: 'inst-btc' }));
  return { subscriptions, result: () => result,
    emit: (event: RealtimeSubscriptionEvent, index = subscriptions.length - 1) => act(() => subscriptions[index].listener(event)),
    update: (props: any) => act(() => renderer.update(React.createElement(Probe, props))),
    unmount: () => act(() => renderer.unmount()),
  };
}

const book = (instrumentId = 'inst-btc', base = 'BTC') => ({
  kind: 'message' as const,
  payload: {
    type: 'futures_order_book', instrumentId, symbol: `${base}USDT`, priceUnit: 'USDT', quantityUnit: base,
    marketLabel: `${base} / USDT 무기한`,
    asks: [{ price: '62000.5', quantity: '1' }], bids: [{ price: '62000.1', quantity: '2' }],
    capturedAt: new Date().toISOString(), effectiveAt: null,
  },
});

describe('useFuturesOrderBook', () => {
  it('subscribes by instrument and accepts only that contract book', () => {
    const h = setup();
    assert.deepEqual(h.subscriptions[0].spec, { channel: 'futures_order_book', instrumentId: 'inst-btc' });
    h.emit({ kind: 'status', status: 'connected' });
    // A Spot ACK or book carrying the same id is not this ladder.
    h.emit({ kind: 'message', payload: { type: 'subscribed', channel: 'asset_order_book', assetId: 'inst-btc' } });
    assert.equal(h.result().connectionState, 'subscribing');
    h.emit({ kind: 'message', payload: { type: 'subscribed', channel: 'futures_order_book', instrumentId: 'inst-btc' } });
    assert.equal(h.result().connectionState, 'subscribed');
    h.emit({ kind: 'message', payload: { ...book().payload, type: 'asset_order_book', assetId: 'inst-btc' } });
    assert.equal(h.result().latestOrderBook === null, true);
    h.emit(book());
    assert.equal(h.result().latestOrderBook?.assetId, 'inst-btc');
    assert.equal(h.result().statusMessage, null);
    h.emit({ kind: 'message', payload: { type: 'subscription_error', channel: 'futures_order_book', instrumentId: 'inst-eth', code: 'X' } });
    assert.equal(h.result().connectionState, 'subscribed');
    h.unmount();
    assert.equal(h.subscriptions[0].released, true);
  });

  it('hides the previous contract immediately when the instrument changes', () => {
    const h = setup();
    h.emit({ kind: 'status', status: 'connected' });
    h.emit(book());
    assert.equal(h.result().latestOrderBook?.assetId, 'inst-btc');
    h.update({ instrumentId: 'inst-eth' });
    assert.equal(h.result().latestOrderBook === null, true);
    assert.equal(h.subscriptions[0].released, true);
    assert.deepEqual(h.subscriptions[1].spec, { channel: 'futures_order_book', instrumentId: 'inst-eth' });
    // A late frame of the old contract cannot reappear on the new one.
    h.emit(book('inst-btc'), 1);
    assert.equal(h.result().latestOrderBook === null, true);
    h.emit(book('inst-eth', 'ETH'), 1);
    assert.equal(h.result().latestOrderBook?.quantityUnit, 'ETH');
  });

  it('does not subscribe while disabled', () => {
    const h = setup();
    h.update({ instrumentId: 'inst-btc', enabled: false });
    assert.equal(h.subscriptions[0].released, true);
    assert.equal(h.subscriptions.length, 1);
    assert.equal(h.result().connectionState, 'disconnected');
  });
});
