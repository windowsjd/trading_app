import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as policy from '../asset/assetOrderBookPolicy.ts';
import {
  RealtimeSocketManager,
  type RealtimeSubscriptionEvent,
  type WebSocketLike,
} from '../../services/ws/realtimeSocketManager.ts';

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

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  receive(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }); }
}

/** Two hook instances over the REAL shared manager (fake socket only). */
function sharedSetup() {
  const h = interactionHarness();
  const sockets: FakeSocket[] = [];
  const manager = new RealtimeSocketManager('wss://app/api/v1/ws', {
    createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    getToken: async () => 'token-1',
    reconnectDelaysMs: [1],
  });
  h.native.AppState = { currentState: 'active', addEventListener: () => ({ remove: () => {} }) };
  const { useStaleRecheck } = h.load('src/features/asset/useStaleRecheck.ts', {
    './assetTickerPolicy': { STALE_RECHECK_INTERVAL_MS: 5000 },
  });
  const stream = h.load('src/features/asset/orderBookStream.ts', {
    './assetOrderBookPolicy': policy, './useStaleRecheck': { useStaleRecheck },
    '../../services/ws/sharedRealtimeSocket': { getRealtimeSocketManager: () => manager },
  });
  const { useFuturesOrderBook } = h.load('src/features/futures/useFuturesOrderBook.ts', {
    '../asset/orderBookStream': stream,
  });
  const results: Record<string, any> = {};
  const Probe = ({ name, instrumentId }: { name: string; instrumentId: string }) => {
    results[name] = useFuturesOrderBook({ wsUrl: 'wss://app/api/v1/ws', instrumentId });
    return null;
  };
  const Pair = ({ late }: { late: string | null }) => React.createElement(React.Fragment, null,
    React.createElement(Probe, { name: 'first', instrumentId: 'inst-btc' }),
    late ? React.createElement(Probe, { name: 'late', instrumentId: late }) : null);
  const renderer = h.render(React.createElement(Pair, { late: null }));
  return { sockets, result: (name: string) => results[name],
    update: (props: { late: string | null }) => act(() => renderer.update(React.createElement(Pair, props))),
    unmount: () => act(() => renderer.unmount()),
    // The manager loads its token asynchronously and reconnects on a real timer.
    settle: (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }),
    subscribeFrames: (socket: FakeSocket) => socket.sent.map((f) => JSON.parse(f))
      .filter((f) => f.type === 'subscribe' && f.channel === 'futures_order_book')
      .map((f) => [f.instrumentId, 'assetId' in f]),
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

  it('gives a late joiner of an ACKed contract its own ten-second wait through the shared manager', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = sharedSetup();
    await h.settle();
    const first = h.sockets[0];
    act(() => first.onopen?.({}));
    act(() => first.receive({ type: 'subscribed', channel: 'futures_order_book', instrumentId: 'inst-btc' }));
    assert.equal(h.result('first').connectionState, 'subscribed');
    act(() => t.mock.timers.tick(4000));
    h.update({ late: 'inst-btc' });
    // The replayed ACK names the contract, so the late joiner starts waiting at once.
    assert.equal(h.result('late').connectionState, 'subscribed');
    assert.equal(h.result('late').runtime.subscribedAt !== null, true);
    assert.equal(h.result('late').runtime.instrumentId, 'inst-btc');
    assert.deepEqual(h.subscribeFrames(first), [['inst-btc', false]]);
    act(() => t.mock.timers.tick(6000));
    assert.equal(h.result('first').isUnavailable, true);
    assert.equal(h.result('late').isUnavailable, false);
    act(() => t.mock.timers.tick(3750));
    assert.equal(h.result('late').isUnavailable, false);
    act(() => t.mock.timers.tick(250));
    assert.equal(h.result('late').isUnavailable, true);
    assert.equal(h.result('late').statusMessage, '호가 정보를 현재 수신할 수 없습니다.');
    // Another contract's ACK or book changes nothing here.
    act(() => first.receive({ type: 'subscribed', channel: 'futures_order_book', instrumentId: 'inst-eth' }));
    act(() => first.receive(book('inst-eth', 'ETH').payload));
    assert.equal(h.result('late').latestOrderBook === null, true);
    assert.equal(h.result('late').isUnavailable, true);
    act(() => first.receive(book().payload));
    for (const name of ['first', 'late']) {
      assert.equal(h.result(name).latestOrderBook?.assetId, 'inst-btc');
      assert.equal(h.result(name).isUnavailable, false);
      assert.equal(h.result(name).statusMessage, null);
    }
    // One holder leaves: the contract stays subscribed; a reconnect restores it once by instrument.
    h.update({ late: null });
    assert.equal(first.sent.filter(f => JSON.parse(f).type === 'unsubscribe').length, 0);
    act(() => first.onclose?.({ code: 1006 }));
    assert.match(h.result('first').statusMessage, /복구/);
    await h.settle(10);
    const second = h.sockets[1];
    act(() => second.onopen?.({}));
    assert.deepEqual(h.subscribeFrames(second), [['inst-btc', false]]);
    act(() => second.receive({ type: 'subscribed', channel: 'futures_order_book', instrumentId: 'inst-btc' }));
    assert.equal(h.result('first').connectionState, 'subscribed');
    h.unmount();
    assert.equal(second.closed, true);
  });

  it('does not subscribe while disabled', () => {
    const h = setup();
    h.update({ instrumentId: 'inst-btc', enabled: false });
    assert.equal(h.subscriptions[0].released, true);
    assert.equal(h.subscriptions.length, 1);
    assert.equal(h.result().connectionState, 'disconnected');
  });
});
