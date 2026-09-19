import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { createCryptoOrderBookFixture } from './orderBook.fixture.ts';
import * as policy from './assetOrderBookPolicy.ts';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

function setup() {
  const h = interactionHarness();
  const subscriptions: Array<{ spec: { assetId: string }; listener: (event: RealtimeSubscriptionEvent) => void; released: boolean }> = [];
  let appStateListener: (state: string) => void = () => {};
  h.native.AppState = { currentState: 'active', addEventListener: (_: string, listener: typeof appStateListener) => {
    appStateListener = listener; return { remove: () => { appStateListener = () => {}; } };
  } };
  const { useStaleRecheck } = h.load('src/features/asset/useStaleRecheck.ts', {
    './assetTickerPolicy': { STALE_RECHECK_INTERVAL_MS: 5000 },
  });
  const { useAssetOrderBook } = h.load('src/features/asset/useAssetOrderBook.ts', {
    './assetOrderBookPolicy': policy, './useStaleRecheck': { useStaleRecheck },
    '../../services/ws/sharedRealtimeSocket': { getRealtimeSocketManager: () => ({ subscribe: (spec: { assetId: string }, listener: (event: RealtimeSubscriptionEvent) => void) => {
      const entry = { spec, listener, released: false }; subscriptions.push(entry);
      return () => { entry.released = true; };
    } }) },
  });
  let result: any;
  const renders: any[] = [];
  const Probe = (props: any) => { result = useAssetOrderBook({ wsUrl: 'wss://app/api/v1/ws', ...props }); renders.push(result); return null; };
  const renderer = h.render(React.createElement(Probe, { assetId: 'btc' }));
  return { subscriptions, renderer, renders, result: () => result,
    emit: (event: RealtimeSubscriptionEvent, index = subscriptions.length - 1) => act(() => subscriptions[index].listener(event)),
    update: (props: any) => act(() => renderer.update(React.createElement(Probe, props))),
    appState: (state: string) => act(() => appStateListener(state)),
    unmount: () => act(() => renderer.unmount()),
  };
}
function message(assetId = 'btc', base = 'BTC', capturedAt = new Date().toISOString()): RealtimeSubscriptionEvent {
  return { kind: 'message', payload: { type: 'asset_order_book', ...createCryptoOrderBookFixture(assetId, base), capturedAt, effectiveAt: null } };
}
function acknowledged(assetId = 'btc'): RealtimeSubscriptionEvent {
  return { kind: 'message', payload: { type: 'subscribed', channel: 'asset_order_book', assetId } };
}

describe('useAssetOrderBook shared subscription and states', () => {
  it('loads, accepts 10+10 exact levels and releases only its own subscription', () => {
    const h = setup();
    assert.equal(h.result().latestOrderBook, null);
    assert.match(h.result().statusMessage, /불러오는 중/);
    h.emit({ kind: 'status', status: 'connected' });
    assert.equal(h.result().connectionState, 'subscribing');
    h.emit({ kind: 'message', payload: { type: 'subscribed', channel: 'asset_order_book', assetId: 'btc' } });
    assert.equal(h.result().connectionState, 'subscribed');
    h.emit(message());
    assert.equal(h.result().latestOrderBook.asks.length, 10);
    assert.equal(h.result().latestOrderBook.bids.length, 10);
    assert.equal(h.result().latestOrderBook.asks[1].quantity, '0.00125000');
    assert.equal(h.result().statusMessage, null);
    h.unmount(); assert.equal(h.subscriptions[0].released, true);
  });

  it('starts the ten-second wait only on its ACK, ignores duplicate ACKs and invalid frames, then recovers', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup();
    act(() => t.mock.timers.tick(20000));
    assert.equal(h.result().isUnavailable, false, 'connecting is not a provider timeout');
    h.emit({ kind: 'status', status: 'connected' });
    h.emit(acknowledged('eth'));
    act(() => t.mock.timers.tick(20000));
    assert.equal(h.result().connectionState, 'subscribing');
    assert.equal(h.result().isUnavailable, false, 'no timeout before this subscription ACK');
    h.emit(acknowledged());
    act(() => t.mock.timers.tick(9000));
    h.emit(acknowledged());
    h.emit({ kind: 'message', payload: { type: 'asset_order_book', assetId: 'btc', asks: null } });
    h.emit(message('eth', 'ETH'));
    act(() => t.mock.timers.tick(750));
    assert.match(h.result().statusMessage, /불러오는 중/);
    act(() => t.mock.timers.tick(250));
    assert.equal(h.result().isUnavailable, true);
    assert.equal(h.result().isStale, false);
    assert.equal(h.result().latestOrderBook, null);
    assert.equal(h.result().statusMessage, '호가 정보를 현재 수신할 수 없습니다.');
    const renders = h.renders.length;
    act(() => t.mock.timers.tick(20000));
    assert.equal(h.renders.length, renders, 'a timed-out empty book no longer needs polling');
    h.emit(message());
    assert.equal(h.result().isUnavailable, false);
    assert.equal(h.result().statusMessage, null);
    assert.equal(h.result().latestOrderBook.asks.length, 10);
    assert.equal(h.result().latestOrderBook.bids.length, 10);
    h.unmount();
  });

  it('cancels the first wait after a normal one-second delivery, including valid empty books', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup(); h.emit(acknowledged());
    act(() => t.mock.timers.tick(1000));
    const event = message();
    if (event.kind === 'message') event.payload = { ...event.payload, asks: [], bids: [] };
    h.emit(event);
    assert.equal(h.result().statusMessage, null);
    assert.deepEqual(h.result().latestOrderBook.asks, []);
    act(() => t.mock.timers.tick(11000));
    assert.equal(h.result().isUnavailable, false);
    assert.match(h.result().statusMessage, /지연/);
    h.unmount();
  });

  for (const serverTime of [1000, 300000]) {
    it(`uses local receipt freshness while preserving server ordering (capturedAt=${serverTime})`, (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 20000 });
      const h = setup(); h.emit(message('btc', 'BTC', new Date(serverTime).toISOString()));
      assert.equal(h.result().statusMessage, null);
      act(() => t.mock.timers.tick(5000)); assert.equal(h.result().isStale, false);
      act(() => t.mock.timers.tick(250)); assert.equal(h.result().isStale, true);
      const book = h.result().latestOrderBook;
      h.emit(message('btc', 'BTC', new Date(serverTime - 1).toISOString()));
      assert.equal(h.result().latestOrderBook, book);
      assert.equal(h.result().isStale, true, 'rejected old frames cannot refresh receivedAt');
      h.emit(message('btc', 'BTC', new Date(serverTime + 1).toISOString()));
      assert.equal(h.result().statusMessage, null);
      h.unmount();
    });
  }

  it('cancels an empty-book wait during reconnect and starts a new window only on the restored ACK', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup(); h.emit(acknowledged());
    act(() => t.mock.timers.tick(9000));
    h.emit({ kind: 'status', status: 'reconnecting' });
    act(() => t.mock.timers.tick(20000));
    assert.equal(h.result().isUnavailable, false);
    assert.match(h.result().statusMessage, /복구/);
    h.emit({ kind: 'status', status: 'connected' }); h.emit({ kind: 'restored' });
    act(() => t.mock.timers.tick(20000));
    assert.equal(h.result().isUnavailable, false);
    h.emit(acknowledged());
    act(() => t.mock.timers.tick(9750)); assert.equal(h.result().isUnavailable, false);
    act(() => t.mock.timers.tick(250)); assert.equal(h.result().isUnavailable, true);
    h.emit({ kind: 'status', status: 'disconnected' });
    assert.equal(h.result().isUnavailable, false); assert.match(h.result().statusMessage, /복구/);
    h.unmount();
  });

  it('retains a received book across reconnect and shows stale rather than a new first-snapshot timeout', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup(); h.emit(message());
    const book = h.result().latestOrderBook;
    h.emit({ kind: 'status', status: 'reconnecting' });
    act(() => t.mock.timers.tick(11000));
    assert.equal(h.result().latestOrderBook, book); assert.match(h.result().statusMessage, /복구/);
    h.emit({ kind: 'status', status: 'connected' }); h.emit(acknowledged());
    act(() => t.mock.timers.tick(11000));
    assert.equal(h.result().latestOrderBook, book);
    assert.equal(h.result().isUnavailable, false); assert.match(h.result().statusMessage, /지연/);
    h.emit(message()); assert.equal(h.result().statusMessage, null);
    h.unmount();
  });

  it('isolates ACK deadlines on asset/URL changes, stops on blur/unmount and ignores released callbacks', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const clear = t.mock.method(globalThis, 'clearInterval');
    const h = setup(); h.emit(acknowledged());
    act(() => t.mock.timers.tick(9000));
    h.update({ assetId: 'eth' });
    assert.ok(clear.mock.callCount() > 0, 'asset change clears the waiting timer');
    h.emit(acknowledged(), 0); h.emit(message(), 0);
    h.emit(acknowledged('eth'));
    act(() => t.mock.timers.tick(1000));
    assert.equal(h.result().isUnavailable, false, 'BTC deadline cannot time out ETH');
    act(() => t.mock.timers.tick(8750)); assert.equal(h.result().isUnavailable, false);
    act(() => t.mock.timers.tick(250)); assert.equal(h.result().isUnavailable, true);
    h.update({ assetId: 'eth', wsUrl: 'wss://other/api/v1/ws' });
    assert.equal(h.result().isUnavailable, false);
    h.emit(acknowledged('eth')); act(() => t.mock.timers.tick(9000));
    h.update({ assetId: 'eth', enabled: false });
    const blurred = h.renders.length;
    act(() => t.mock.timers.tick(20000)); h.emit(message('eth', 'ETH'));
    assert.equal(h.renders.length, blurred); assert.equal(h.result().latestOrderBook, null);
    h.update({ assetId: 'eth', enabled: true }); h.emit(acknowledged('eth'));
    const before = clear.mock.callCount();
    h.unmount(); assert.ok(clear.mock.callCount() > before, 'unmount clears the waiting timer');
    const unmounted = h.renders.length;
    act(() => t.mock.timers.tick(20000)); h.emit(message('eth', 'ETH'));
    assert.equal(h.renders.length, unmounted);
    assert.ok(h.subscriptions.every((entry) => entry.released));
  });

  it('rechecks the ACK deadline on foreground return without waking the background app', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup(); h.emit(acknowledged()); h.appState('background');
    const renders = h.renders.length;
    act(() => t.mock.timers.tick(11000)); assert.equal(h.renders.length, renders);
    h.appState('active'); assert.equal(h.result().isUnavailable, true);
    h.emit(message()); assert.equal(h.result().statusMessage, null);
    h.unmount();
  });

  for (const elapsed of [9000, 10000]) {
    it(`cancels the timeout for subscription/auth errors at ${elapsed}ms and preserves error priority`, (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
      const h = setup(); h.emit(acknowledged()); act(() => t.mock.timers.tick(elapsed));
      h.emit({ kind: 'message', payload: { type: 'subscription_error', channel: 'asset_order_book', assetId: 'btc', code: 'ORDER_BOOK_UNAVAILABLE' } });
      const renders = h.renders.length;
      act(() => t.mock.timers.tick(20000)); assert.equal(h.renders.length, renders);
      assert.equal(h.result().isUnavailable, false); assert.match(h.result().statusMessage, /구독할 수 없/);
      h.emit({ kind: 'status', status: 'auth_failed' });
      act(() => t.mock.timers.tick(20000));
      assert.equal(h.result().isUnavailable, false); assert.match(h.result().statusMessage, /로그인/);
      h.unmount();
    });
  }

  it('advances stale with the clock, rechecks foreground and clears it only on a valid fresh frame', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10000 });
    const h = setup(); h.emit(message());
    act(() => t.mock.timers.tick(5000)); assert.equal(h.result().isStale, false);
    act(() => t.mock.timers.tick(250)); assert.equal(h.result().isStale, true);
    assert.match(h.result().statusMessage, /지연/);
    h.emit({ kind: 'message', payload: { type: 'asset_order_book', assetId: 'btc', asks: null } });
    assert.equal(h.result().isStale, true);
    h.emit(message()); assert.equal(h.result().isStale, false);
    h.appState('background'); act(() => t.mock.timers.tick(6000));
    h.appState('active'); assert.equal(h.result().isStale, true);
    h.emit(message('btc', 'BTC', new Date(10000).toISOString()));
    assert.equal(h.result().isStale, true, 'older snapshot never replaces the book');
    h.unmount();
  });

  it('keeps the last book during reconnect and restores normal state after a fresh frame', () => {
    const h = setup(); h.emit(message());
    h.emit({ kind: 'status', status: 'reconnecting' });
    assert.match(h.result().statusMessage, /복구/); assert.ok(h.result().latestOrderBook);
    h.emit({ kind: 'status', status: 'connected' }); h.emit({ kind: 'restored' }); h.emit(message());
    assert.equal(h.result().statusMessage, null);
    h.unmount();
  });

  it('isolates assets synchronously on change, ignores old callbacks and releases on blur', () => {
    const h = setup(); h.emit(message());
    const before = h.renders.length; h.update({ assetId: 'eth' });
    assert.ok(h.renders.slice(before).every((state) => state.latestOrderBook === null));
    assert.equal(h.subscriptions[0].released, true);
    h.emit(message(), 0); assert.equal(h.result().latestOrderBook, null);
    h.emit(message('eth', 'ETH')); assert.equal(h.result().latestOrderBook.quantityUnit, 'ETH');
    h.update({ assetId: 'eth', enabled: false });
    assert.equal(h.result().latestOrderBook, null); assert.equal(h.subscriptions[1].released, true);
    h.unmount();
  });

  it('displays subscription/auth errors, ignores errors for other assets and accepts empty/partial books', () => {
    const h = setup();
    h.emit({ kind: 'message', payload: { type: 'subscription_error', channel: 'asset_order_book', assetId: 'eth', code: 'UNSUPPORTED_ASSET' } });
    assert.equal(h.result().errorCode, null);
    h.emit({ kind: 'message', payload: { type: 'subscription_error', channel: 'asset_order_book', assetId: 'btc', code: 'UNSUPPORTED_ASSET' } });
    assert.match(h.result().statusMessage, /구독할 수 없/); assert.equal(h.result().errorCode, 'UNSUPPORTED_ASSET');
    h.emit({ kind: 'status', status: 'auth_failed' }); assert.match(h.result().statusMessage, /로그인/);
    const event = message();
    if (event.kind === 'message') event.payload = { ...event.payload, asks: [], bids: [{ price: '1', quantity: '0' }] };
    h.emit(event); assert.equal(h.result().latestOrderBook.asks.length, 0); assert.equal(h.result().latestOrderBook.bids.length, 1);
    h.unmount();
  });
});
