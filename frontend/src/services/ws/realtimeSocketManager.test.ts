import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  RealtimeSocketManager,
  type RealtimeSubscriptionEvent,
  type WebSocketLike,
} from "./realtimeSocketManager.ts";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  url: string;
  sent: string[] = [];
  closed: Array<{ code?: number; reason?: string }> = [];
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

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
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

function createManager(overrides: { token?: string | null } = {}) {
  FakeSocket.instances = [];
  const manager = new RealtimeSocketManager("wss://app.example/api/v1/ws", {
    createSocket: (url) => new FakeSocket(url),
    getToken: async () => overrides.token ?? "token-1",
    reconnectDelaysMs: [1, 1, 1],
  });
  return manager;
}

function collect(): {
  events: RealtimeSubscriptionEvent[];
  listener: (event: RealtimeSubscriptionEvent) => void;
} {
  const events: RealtimeSubscriptionEvent[] = [];
  return { events, listener: (event) => events.push(event) };
}

function sentFrames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((frame) => JSON.parse(frame));
}

describe("RealtimeSocketManager", () => {
  it('shares and restores reference-counted order book subscriptions without disturbing ticker/candle', async () => {
    const manager = createManager();
    const book = collect(); const other = collect(); const ticker = collect(); const candle = collect();
    const offTicker = manager.subscribe({ channel: 'asset_ticker', assetId: 'btc' }, ticker.listener);
    const offCandle = manager.subscribe({ channel: 'asset_candle', assetId: 'btc', interval: '5m' }, candle.listener);
    const offBook = manager.subscribe({ channel: 'asset_order_book', assetId: 'btc' }, book.listener);
    const offOther = manager.subscribe({ channel: 'asset_order_book', assetId: 'eth' }, other.listener);
    await delay(5); const first = FakeSocket.instances[0]; first.open();
    first.receive({ type: 'subscribed', channel: 'asset_order_book', assetId: 'btc' });
    const late = collect(); const offLate = manager.subscribe({ channel: 'asset_order_book', assetId: 'btc' }, late.listener);
    assert.ok(late.events.some(e => e.kind === 'message' && e.payload.type === 'subscribed'));
    assert.equal(sentFrames(first).filter(f => f.channel === 'asset_order_book' && f.assetId === 'btc').length, 1);
    first.receive({ type: 'asset_order_book', assetId: 'btc', asks: [], bids: [] });
    first.receive({ type: 'asset_order_book', asks: [], bids: [] });
    assert.equal(book.events.filter(e => e.kind === 'message' && e.payload.type === 'asset_order_book').length, 1);
    assert.equal(other.events.filter(e => e.kind === 'message').length, 0);
    assert.equal(ticker.events.filter(e => e.kind === 'message').length, 0);
    assert.equal(candle.events.filter(e => e.kind === 'message').length, 0);
    assert.equal(FakeSocket.instances.length, 1);
    first.drop(); await delay(10); const second = FakeSocket.instances[1]; second.open();
    assert.deepEqual(sentFrames(second).map(f => f.channel).sort(), ['asset_candle', 'asset_order_book', 'asset_order_book', 'asset_ticker']);
    assert.ok(book.events.some(e => e.kind === 'restored'));
    offBook(); assert.equal(sentFrames(second).filter(f => f.type === 'unsubscribe').length, 0);
    offLate(); assert.equal(sentFrames(second).filter(f => f.type === 'unsubscribe' && f.assetId === 'btc' && f.channel === 'asset_order_book').length, 1);
    assert.equal(second.closed.length, 0);
    second.receive({ type: 'asset_ticker', assetId: 'btc' });
    second.receive({ type: 'asset_candle', assetId: 'btc', interval: '5m' });
    assert.equal(ticker.events.filter(e => e.kind === 'message').length, 1);
    assert.equal(candle.events.filter(e => e.kind === 'message').length, 1);
    offOther(); offTicker(); offCandle(); assert.equal(second.closed.length, 1);
  });

  it("shares FX with price channels, isolates pairs and restores the FX subscription", async () => {
    const manager = createManager();
    const fx = collect();
    const ticker = collect();
    const offPrice = manager.subscribe({ channel: 'asset_ticker', assetId: 'a1' }, ticker.listener);
    const offFx = manager.subscribe({ channel: 'fx_rate', pair: 'USD/KRW' }, fx.listener);
    await delay(5);
    assert.equal(FakeSocket.instances.length, 1);
    const first = FakeSocket.instances[0];
    first.open();
    first.receive({ type: 'subscribed', channel: 'fx_rate', pair: 'USD/KRW' });
    first.receive({ type: 'fx_rate_updated', channel: 'fx_rate', pair: 'EUR/KRW' });
    first.receive({ type: 'fx_rate_updated', channel: 'fx_rate', pair: 'USD/KRW' });
    assert.equal(fx.events.filter(e => e.kind === 'message').length, 2);
    assert.equal(ticker.events.filter(e => e.kind === 'message').length, 0);
    const late = collect();
    const offLate = manager.subscribe({ channel: 'fx_rate', pair: 'USD/KRW' }, late.listener);
    assert.ok(late.events.some(e => e.kind === 'message' && e.payload.type === 'subscribed'));
    assert.equal(sentFrames(first).filter(f => f.channel === 'fx_rate').length, 1);
    first.drop();
    await delay(10);
    const second = FakeSocket.instances[1];
    second.open();
    assert.ok(sentFrames(second).some(f => f.channel === 'fx_rate' && f.pair === 'USD/KRW' && !('assetId' in f)));
    assert.ok(fx.events.some(e => e.kind === 'restored'));
    offFx(); offLate(); offPrice();
    assert.ok(sentFrames(second).some(f => f.channel === 'fx_rate' && f.type === 'unsubscribe'));
    assert.equal(second.closed.length, 1);
  });

  it("shares ONE socket between ticker and candle subscriptions", async () => {
    const manager = createManager();
    const ticker = collect();
    const candle = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "5m" },
      candle.listener,
    );
    await delay(5);
    assert.equal(FakeSocket.instances.length, 1);
    const socket = FakeSocket.instances[0];
    assert.ok(socket.url.includes("token=token-1"));
    socket.open();
    const frames = sentFrames(socket);
    assert.deepEqual(frames, [
      { type: "subscribe", channel: "asset_ticker", assetId: "a1" },
      { type: "subscribe", channel: "asset_candle", assetId: "a1", interval: "5m" },
    ]);
  });

  it("reference-counts duplicate subscriptions and unsubscribes on the last release", async () => {
    const manager = createManager();
    const first = collect();
    const second = collect();
    const off1 = manager.subscribe(
      { channel: "asset_ticker", assetId: "a1" },
      first.listener,
    );
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({ type: "subscribed", channel: "asset_ticker", assetId: "a1" });

    const off2 = manager.subscribe(
      { channel: "asset_ticker", assetId: "a1" },
      second.listener,
    );
    await delay(5);
    // No duplicate subscribe frame; the late joiner gets a replayed ack.
    assert.equal(
      sentFrames(socket).filter((frame) => frame.type === "subscribe").length,
      1,
    );
    assert.ok(
      second.events.some(
        (event) =>
          event.kind === "message" &&
          (event.payload as { type?: string }).type === "subscribed",
      ),
    );

    off1();
    assert.equal(
      sentFrames(socket).filter((frame) => frame.type === "unsubscribe").length,
      0,
    );
    off2();
    assert.equal(
      sentFrames(socket).filter((frame) => frame.type === "unsubscribe").length,
      1,
    );
    // Last subscription gone: the shared socket closes.
    assert.equal(socket.closed.length, 1);
  });

  it("keeps the socket alive while another hook still subscribes", async () => {
    const manager = createManager();
    const ticker = collect();
    const candle = collect();
    const offTicker = manager.subscribe(
      { channel: "asset_ticker", assetId: "a1" },
      ticker.listener,
    );
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "5m" },
      candle.listener,
    );
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    offTicker();
    assert.equal(socket.closed.length, 0);
    assert.equal(manager.getSubscriptionCount(), 1);
  });

  it("routes ticker and candle messages only to their own subscriptions", async () => {
    const manager = createManager();
    const ticker = collect();
    const candle = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "5m" },
      candle.listener,
    );
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({ type: "asset_ticker", assetId: "a1", priceLocal: "1" });
    socket.receive({
      type: "asset_candle",
      assetId: "a1",
      interval: "5m",
      candle: {},
    });
    socket.receive({ type: "asset_candle", assetId: "a1", interval: "15m" });

    const tickerMessages = ticker.events.filter((event) => event.kind === "message");
    const candleMessages = candle.events.filter((event) => event.kind === "message");
    assert.equal(tickerMessages.length, 1);
    assert.equal(
      (tickerMessages[0] as { payload: { type: string } }).payload.type,
      "asset_ticker",
    );
    // The 15m snapshot must not reach the 5m subscription.
    assert.equal(candleMessages.length, 1);
    assert.equal(
      (candleMessages[0] as { payload: { interval: string } }).payload.interval,
      "5m",
    );
  });

  it("restores every active subscription after a reconnect and emits restored", async () => {
    const manager = createManager();
    const ticker = collect();
    const candle = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "5m" },
      candle.listener,
    );
    await delay(5);
    const first = FakeSocket.instances[0];
    first.open();
    first.drop(1006);
    await delay(10);
    assert.equal(FakeSocket.instances.length, 2);
    const second = FakeSocket.instances[1];
    second.open();
    const frames = sentFrames(second);
    assert.equal(frames.filter((frame) => frame.type === "subscribe").length, 2);
    assert.ok(ticker.events.some((event) => event.kind === "restored"));
    assert.ok(candle.events.some((event) => event.kind === "restored"));
  });

  it("stops reconnecting after an auth failure (1008) and reports auth_failed", async () => {
    const manager = createManager();
    const ticker = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.drop(1008);
    await delay(10);
    assert.equal(FakeSocket.instances.length, 1);
    assert.ok(
      ticker.events.some(
        (event) => event.kind === "status" && event.status === "auth_failed",
      ),
    );
  });

  it("treats an UNAUTHORIZED error message as terminal auth failure", async () => {
    const manager = createManager();
    const ticker = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({ type: "error", code: "UNAUTHORIZED" });
    await delay(10);
    assert.equal(FakeSocket.instances.length, 1);
    assert.ok(
      ticker.events.some(
        (event) => event.kind === "status" && event.status === "auth_failed",
      ),
    );
  });

  it("routes channel control messages (resync_required) to the matching subscription", async () => {
    const manager = createManager();
    const candle5m = collect();
    const candle15m = collect();
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "5m" },
      candle5m.listener,
    );
    manager.subscribe(
      { channel: "asset_candle", assetId: "a1", interval: "15m" },
      candle15m.listener,
    );
    await delay(5);
    const socket = FakeSocket.instances[0];
    socket.open();
    socket.receive({
      type: "resync_required",
      channel: "asset_candle",
      assetId: "a1",
      interval: "5m",
    });
    const got5m = candle5m.events.filter(
      (event) =>
        event.kind === "message" &&
        (event.payload as { type?: string }).type === "resync_required",
    );
    const got15m = candle15m.events.filter(
      (event) =>
        event.kind === "message" &&
        (event.payload as { type?: string }).type === "resync_required",
    );
    assert.equal(got5m.length, 1);
    assert.equal(got15m.length, 0);
  });

  it("reconnects with a fresh token on demand without dropping subscriptions", async () => {
    let token = "token-1";
    FakeSocket.instances = [];
    const manager = new RealtimeSocketManager("wss://app.example/api/v1/ws", {
      createSocket: (url) => new FakeSocket(url),
      getToken: async () => token,
      reconnectDelaysMs: [1],
    });
    const ticker = collect();
    manager.subscribe({ channel: "asset_ticker", assetId: "a1" }, ticker.listener);
    await delay(5);
    FakeSocket.instances[0].open();
    token = "token-2";
    manager.reconnectWithFreshToken();
    await delay(5);
    assert.equal(FakeSocket.instances.length, 2);
    assert.ok(FakeSocket.instances[1].url.includes("token=token-2"));
    assert.equal(manager.getSubscriptionCount(), 1);
    FakeSocket.instances[1].open();
    assert.equal(
      sentFrames(FakeSocket.instances[1]).filter(
        (frame) => frame.type === "subscribe",
      ).length,
      1,
    );
  });
});
