/** TC-E01: actual Gateway, actual sockets, strict Node child; no global rejection handler. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { AssetTickerGateway } from '../src/realtime/asset-ticker.gateway';
import { Logger } from '@nestjs/common';

const secret = 'synthetic_DB_password_and_query';
const logs: unknown[] = [];
Logger.overrideLogger({
  log() {},
  error() {},
  warn(value: unknown) {
    logs.push(value);
  },
});
const pause = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const turn = () => new Promise((r) => setImmediate(r));
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('protocol deadline');
}
let fail = true;
let tickerWait: ReturnType<typeof pause> | undefined;
let candleWait: ReturnType<typeof pause> | undefined;
let tickerReads = 0;
let candleReads = 0;
const selection = {
  asset: {
    id: 'asset',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    assetType: 'crypto',
    priceCurrency: 'USD',
  },
  price: {
    state: 'available',
    currentPrice: '100',
    priceKrw: '140000',
    priceKrwState: 'available',
    priceCurrency: 'USD',
    assetPriceSnapshotId: 'price',
    priceCapturedAt: new Date().toISOString(),
  },
};
const gateway = new AssetTickerGateway(
  {
    user: { findUnique: async () => ({ status: 'active' }) },
    asset: {
      findUnique: async () => {
        candleReads++;
        if (candleWait) return candleWait.promise;
        if (fail) throw new Error(secret);
        return {
          id: 'asset',
          isActive: true,
          assetType: 'crypto',
          market: 'BINANCE',
          symbol: 'BTCUSDT',
        };
      },
    },
  } as never,
  { verifyAsync: async () => ({ sub: 'test-user' }) } as never,
  { get: () => 'test-secret' } as never,
  {
    getAssetPriceForTicker: async () => {
      tickerReads++;
      if (tickerWait) return tickerWait.promise;
      if (fail) throw new Error(secret);
      return selection;
    },
  } as never,
  {} as never,
  {} as never,
  undefined,
  { getCurrentSnapshot: async () => null } as never,
  undefined,
  undefined,
  {} as never,
  { loadTarget: async () => ({ assetId: 'asset' }) } as never,
);
const serverSockets: WebSocket[] = [];
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
wss.on('connection', (socket, request) => {
  serverSockets.push(socket);
  socket.on('close', () => gateway.handleDisconnect(socket));
  void gateway.handleConnection(socket, request);
});
async function main() {
  await once(wss, 'listening');
  const address = wss.address();
  assert.equal(typeof address === 'object' && address !== null, true);
  const url = `ws://127.0.0.1:${(address as { port: number }).port}/?token=test`;
  const messages: any[][] = [[], []];
  const clients = [new WebSocket(url), new WebSocket(url)];
  clients.forEach((c, i) =>
    c.on('message', (raw) => messages[i].push(JSON.parse(raw.toString()))),
  );
  await Promise.all(clients.map((c) => once(c, 'open')));
  await turn();
  const send = (i: number, type = 'subscribe', channel = 'asset_ticker') =>
    clients[i].send(
      JSON.stringify({
        type,
        channel,
        assetId: 'asset',
        interval: '5m',
        pair: 'USD/KRW',
      }),
    );
  const internal = gateway as unknown as {
    clients: Map<
      WebSocket,
      {
        subscriptions: Map<string, unknown>;
        candleSubscriptions: Map<string, unknown>;
      }
    >;
  };
  send(0);
  await until(() => messages[0].some((m) => m.code === 'SUBSCRIPTION_FAILED'));
  assert.equal(internal.clients.get(serverSockets[0])!.subscriptions.size, 0);
  assert.equal(clients[1].readyState, WebSocket.OPEN);
  assert.equal(JSON.stringify([messages, logs]).includes(secret), false);
  assert.equal(logs.length, 1);
  fail = false;
  send(1);
  await until(() => messages[1].some((m) => m.type === 'asset_ticker'));
  send(0);
  await until(() => messages[0].some((m) => m.type === 'asset_ticker'));
  send(0, 'unsubscribe');
  await until(() => messages[0].some((m) => m.type === 'unsubscribed'));
  tickerWait = pause();
  const before = tickerReads;
  send(0);
  await until(() => tickerReads > before);
  send(0, 'unsubscribe');
  await until(
    () => messages[0].filter((m) => m.type === 'unsubscribed').length === 2,
  );
  tickerWait.resolve(selection);
  await turn();
  await turn();
  tickerWait = undefined;
  assert.equal(internal.clients.get(serverSockets[0])!.subscriptions.size, 0);
  for (const channel of ['asset_candle', 'asset_order_book', 'fx_rate']) {
    send(0, 'subscribe', channel);
    await until(() =>
      messages[0].some((m) => m.type === 'subscribed' && m.channel === channel),
    );
    send(0, 'unsubscribe', channel);
    await until(() =>
      messages[0].some(
        (m) => m.type === 'unsubscribed' && m.channel === channel,
      ),
    );
  }
  fail = true;
  send(0, 'subscribe', 'asset_candle');
  await until(() => logs.length === 2);
  assert.equal(
    internal.clients.get(serverSockets[0])!.candleSubscriptions.size,
    0,
  );
  fail = false;
  candleWait = pause();
  const reads = candleReads;
  send(0, 'subscribe', 'asset_candle');
  await until(() => candleReads > reads);
  send(0, 'unsubscribe', 'asset_candle');
  await until(
    () =>
      messages[0].filter(
        (m) => m.type === 'unsubscribed' && m.channel === 'asset_candle',
      ).length === 2,
  );
  candleWait.resolve({
    isActive: true,
    symbol: 'BTCUSDT',
    market: 'BINANCE',
    assetType: 'crypto',
  });
  await turn();
  await turn();
  assert.equal(
    internal.clients.get(serverSockets[0])!.candleSubscriptions.size,
    0,
  );
  tickerWait = pause();
  const closingReads = tickerReads;
  send(0);
  await until(() => tickerReads > closingReads);
  clients[0].close();
  await once(serverSockets[0], 'close');
  tickerWait.resolve(selection);
  await turn();
  await turn();
  assert.equal(internal.clients.has(serverSockets[0]), false);
  assert.equal(
    internal.clients.get(serverSockets[1])!.subscriptions.has('asset'),
    true,
  );
  assert.equal(JSON.stringify([messages, logs]).includes(secret), false);
  clients[1].close();
  await once(serverSockets[1], 'close');
  console.log(
    'websocket message rejection process survived; protocols and cancellation ok',
  );
}
main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.stack : 'websocket regression failed',
    );
    process.exitCode = 1;
  })
  .finally(() => {
    gateway.onModuleDestroy();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  });
