import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { MarketTickerStore } from './marketTickerStore.ts';
import {
  RealtimeSocketManager,
  type WebSocketLike,
} from '../../services/ws/realtimeSocketManager.ts';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy.ts';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
  closed: Array<{ code?: number }> = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number) {
    this.closed.push({ code });
  }

  open() {
    this.onopen?.({});
  }

  receive(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

function frames(socket: FakeSocket) {
  return socket.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

function createStore() {
  FakeSocket.instances = [];
  const manager = new RealtimeSocketManager('wss://app.example/api/v1/ws', {
    createSocket: (url) => new FakeSocket(url),
    getToken: async () => 'token-1',
    reconnectDelaysMs: [1, 1, 1],
  });
  let changes = 0;
  const store = new MarketTickerStore(manager, () => {
    changes += 1;
  });
  return { store, manager, getChanges: () => changes };
}

function ticker(
  assetId: string,
  overrides: Partial<AssetTickerMessage> = {},
): AssetTickerMessage {
  return {
    type: 'asset_ticker',
    assetId,
    priceLocal: '100.00000000',
    priceKrw: '140000.00000000',
    priceKrwState: 'available',
    assetPriceSnapshotId: `${assetId}-snap-1`,
    priceCapturedAt: '2026-07-25T03:00:10.000Z',
    priceEffectiveAt: '2026-07-25T03:00:10.000Z',
    freshnessAgeSeconds: 1,
    ...overrides,
  };
}

describe('MarketTickerStore', () => {
  it('subscribes the loaded rows on ONE shared socket', async () => {
    const { store } = createStore();

    store.setAssetIds(['a', 'b', 'c']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();

    assert.equal(FakeSocket.instances.length, 1);
    assert.deepEqual(frames(socket), [
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'a' },
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'b' },
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'c' },
    ]);
  });

  it('subscribes only the NEW ids when another page loads', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.sent.length = 0;

    store.setAssetIds(['a', 'b', 'c', 'd']);

    assert.deepEqual(frames(socket), [
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'c' },
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'd' },
    ]);
    assert.equal(FakeSocket.instances.length, 1);
  });

  it('unsubscribes the previous tab rows when the tab changes', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.sent.length = 0;

    store.setAssetIds(['x']);

    // The new tab is subscribed first so the shared socket is never left
    // without subscribers (which would close it and force a reconnect).
    assert.deepEqual(frames(socket), [
      { type: 'subscribe', channel: 'asset_ticker', assetId: 'x' },
      { type: 'unsubscribe', channel: 'asset_ticker', assetId: 'a' },
      { type: 'unsubscribe', channel: 'asset_ticker', assetId: 'b' },
    ]);
    assert.deepEqual(store.getSubscribedAssetIds(), ['x']);
    assert.equal(socket.closed.length, 0);
    assert.equal(FakeSocket.instances.length, 1);
  });

  it('releases every subscription on dispose but leaves the shared socket to other screens', async () => {
    const { store, manager } = createStore();
    const otherScreen = manager.subscribe(
      { channel: 'asset_candle', assetId: 'z', interval: '5m' },
      () => {},
    );
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.sent.length = 0;

    store.dispose();

    assert.deepEqual(frames(socket), [
      { type: 'unsubscribe', channel: 'asset_ticker', assetId: 'a' },
      { type: 'unsubscribe', channel: 'asset_ticker', assetId: 'b' },
    ]);
    // The other screen still owns the socket.
    assert.equal(socket.closed.length, 0);
    assert.equal(manager.hasOpenSocket(), true);
    otherScreen();
  });

  it('routes a ticker to its own asset only', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();

    socket.receive(ticker('a', { priceLocal: '111.00000000' }));

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.tickersByAssetId.get('a')?.priceLocal, '111.00000000');
    assert.equal(snapshot.tickersByAssetId.has('b'), false);
  });

  it('keeps other rows referentially untouched when one asset ticks', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive(ticker('b'));
    const firstB = store.getSnapshot().tickersByAssetId.get('b');

    socket.receive(ticker('a'));

    assert.equal(store.getSnapshot().tickersByAssetId.get('b'), firstB);
  });

  it('ignores a duplicate snapshot id and an older timestamp', async () => {
    const { store, getChanges } = createStore();
    store.setAssetIds(['a']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive(ticker('a', { priceLocal: '111.00000000' }));
    const changesAfterFirst = getChanges();

    // Same snapshot id.
    socket.receive(ticker('a', { priceLocal: '999.00000000' }));
    // Older timestamp.
    socket.receive(
      ticker('a', {
        assetPriceSnapshotId: 'a-snap-0',
        priceLocal: '888.00000000',
        priceCapturedAt: '2026-07-25T02:59:00.000Z',
        priceEffectiveAt: '2026-07-25T02:59:00.000Z',
      }),
    );

    assert.equal(
      store.getSnapshot().tickersByAssetId.get('a')?.priceLocal,
      '111.00000000',
    );
    assert.equal(getChanges(), changesAfterFirst);
  });

  it('does not let a timestamp-less priced event overwrite the latest price', async () => {
    const { store } = createStore();
    store.setAssetIds(['a']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive(ticker('a', { priceLocal: '111.00000000' }));

    socket.receive(
      ticker('a', {
        assetPriceSnapshotId: null,
        priceLocal: '222.00000000',
        priceCapturedAt: null,
        priceEffectiveAt: null,
      }),
    );

    assert.equal(
      store.getSnapshot().tickersByAssetId.get('a')?.priceLocal,
      '111.00000000',
    );
  });

  it('keeps the last good price while reconnecting and raises one banner', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive(ticker('a', { priceLocal: '111.00000000' }));

    socket.drop();
    await delay(0);

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.showReconnectBanner, true);
    assert.equal(
      snapshot.tickersByAssetId.get('a')?.priceLocal,
      '111.00000000',
    );
  });

  it('flags a stale asset without dropping its price', async () => {
    const { store } = createStore();
    store.setAssetIds(['a']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();

    socket.receive(ticker('a', { freshnessAgeSeconds: 120 }));

    const snapshot = store.getSnapshot();
    assert.equal(snapshot.staleAssetIds.has('a'), true);
    assert.equal(snapshot.tickersByAssetId.get('a')?.priceLocal, '100.00000000');
  });

  it('records a subscription error for the row it belongs to', async () => {
    const { store } = createStore();
    store.setAssetIds(['a', 'b']);
    await delay(0);
    const socket = FakeSocket.instances[0];
    socket.open();

    socket.receive({
      type: 'subscription_error',
      channel: 'asset_ticker',
      assetId: 'b',
      code: 'ASSET_NOT_AVAILABLE',
    });

    const snapshot = store.getSnapshot();
    assert.deepEqual([...snapshot.subscriptionErrorAssetIds], ['b']);
  });
});
