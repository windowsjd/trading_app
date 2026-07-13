jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  UserStatus: { active: 'active' },
}));
jest.mock('../assets/live-candle-overlay.service', () => ({
  LiveCandleOverlayService: class LiveCandleOverlayService {},
}));
jest.mock('./live-candle-pubsub.service', () => ({
  LiveCandlePubSubService: class LiveCandlePubSubService {},
}));
jest.mock('../assets/assets.service', () => ({
  AssetsService: class AssetsService {},
}));

import { BinanceRealtimePriceEventBus } from '../providers/binance/binance-realtime-price-event-bus.service';
import { KisRealtimePriceEventBus } from '../providers/kis/kis-realtime-price-event-bus.service';
import type { AssetCandleSnapshotEvent } from '../assets/live-candle.types';
import { AssetTickerGateway } from './asset-ticker.gateway';

describe('AssetTickerGateway asset_candle channel', () => {
  const setup = (limit = 2) => {
    const prisma = {
      asset: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: 'asset-1', isActive: true }),
      },
      user: { findUnique: jest.fn() },
    };
    const jwt = { verifyAsync: jest.fn() };
    const config = { get: jest.fn().mockReturnValue('secret') };
    const overlay = { getCurrentSnapshot: jest.fn().mockResolvedValue(null) };
    const gateway = new AssetTickerGateway(
      prisma as never,
      jwt as never,
      config as never,
      { getAssetPriceForTicker: jest.fn() } as never,
      new KisRealtimePriceEventBus(),
      new BinanceRealtimePriceEventBus(),
      undefined,
      overlay as never,
      {
        maxSubscriptionsPerClient: limit,
        websocketBackpressureBytes: 10,
      } as never,
    );
    return { gateway, prisma, jwt, config, overlay };
  };

  it('requires authentication before registering a socket', async () => {
    const { gateway, config } = setup();
    config.get.mockReturnValue(undefined);
    const client = fakeClient();
    await gateway.handleConnection(
      client as never,
      { headers: { host: 'localhost' }, url: '/api/v1/ws?token=x' } as never,
    );
    expect(client.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    expect(messages(client)[0]).toMatchObject({
      type: 'error',
      code: 'UNAUTHORIZED',
    });
  });

  it('validates interval/asset, makes duplicate subscribe idempotent, and enforces a per-client limit', async () => {
    const { gateway, prisma } = setup(1);
    const client = fakeClient();
    register(gateway, client);
    await handle(gateway, client, {
      type: 'subscribe',
      channel: 'asset_candle',
      assetId: 'asset-1',
      interval: '1d',
    });
    expect(messages(client).at(-1)).toMatchObject({
      type: 'subscription_error',
      code: 'INVALID_INTERVAL',
    });

    await handle(gateway, client, subscription('asset-1', '5m'));
    await handle(gateway, client, subscription('asset-1', '5m'));
    expect(prisma.asset.findUnique).toHaveBeenCalledTimes(1);
    expect(
      messages(client).filter((message) => message.type === 'subscribed'),
    ).toHaveLength(2);

    await handle(gateway, client, subscription('asset-1', '15m'));
    expect(messages(client).at(-1)).toMatchObject({
      type: 'subscription_error',
      code: 'SUBSCRIPTION_LIMIT',
    });
  });

  it('fans out only to the matching room and ignores sequence/revision regressions', async () => {
    const { gateway } = setup();
    const matching = fakeClient();
    const other = fakeClient();
    register(gateway, matching, '5m');
    register(gateway, other, '15m');
    push(gateway, snapshot({ sequence: 10, revision: 5 }));
    push(gateway, snapshot({ sequence: 9, revision: 99 }));
    push(gateway, snapshot({ sequence: 0, revision: 999 }));

    expect(messages(matching)).toHaveLength(1);
    expect(messages(matching)[0]).toMatchObject({ sequence: 10, revision: 5 });
    expect(messages(other)).toHaveLength(0);
  });

  it('keeps only the latest pending snapshot for a slow client and cleans up on disconnect', () => {
    const { gateway } = setup();
    const client = fakeClient(100);
    register(gateway, client, '5m');
    push(gateway, snapshot({ sequence: 10, revision: 1 }));
    push(gateway, snapshot({ sequence: 11, revision: 2 }));
    push(gateway, snapshot({ sequence: 10, revision: 999 }));
    expect(messages(client)).toHaveLength(0);

    client.bufferedAmount = 0;
    flush(gateway);
    expect(messages(client)).toHaveLength(1);
    expect(messages(client)[0]).toMatchObject({ sequence: 11, revision: 2 });

    gateway.handleDisconnect(client as never);
    expect(clientCount(gateway)).toBe(0);
  });

  it('signals stale on Pub/Sub failure and resync after recovery', () => {
    const { gateway } = setup();
    const client = fakeClient();
    register(gateway, client, '5m');
    status(gateway, 'unavailable');
    status(gateway, 'connected');
    expect(messages(client).map((message) => message.type)).toEqual([
      'candle_stale',
      'resync_required',
    ]);
  });
});

function fakeClient(bufferedAmount = 0) {
  return {
    readyState: 1,
    bufferedAmount,
    send: jest.fn(),
    close: jest.fn(),
    on: jest.fn(),
  };
}

function register(
  gateway: AssetTickerGateway,
  client: ReturnType<typeof fakeClient>,
  interval?: '5m' | '15m',
) {
  const candleSubscriptions = new Map();
  if (interval) {
    candleSubscriptions.set(`asset-1\u0000${interval}`, {
      lastSequence: 0,
      lastRevision: -1,
    });
  }
  clients(gateway).set(client, {
    userId: 'user-1',
    subscriptions: new Map(),
    candleSubscriptions,
    pendingCandles: new Map(),
  });
}

async function handle(
  gateway: AssetTickerGateway,
  client: ReturnType<typeof fakeClient>,
  message: unknown,
) {
  await (
    gateway as unknown as {
      handleMessage(client: unknown, raw: string): Promise<void>;
    }
  ).handleMessage(client, JSON.stringify(message));
}

function push(gateway: AssetTickerGateway, event: AssetCandleSnapshotEvent) {
  (
    gateway as unknown as {
      pushLiveCandleEvent(event: AssetCandleSnapshotEvent): void;
    }
  ).pushLiveCandleEvent(event);
}

function flush(gateway: AssetTickerGateway) {
  (gateway as unknown as { flushPendingCandles(): void }).flushPendingCandles();
}

function status(
  gateway: AssetTickerGateway,
  value: 'connected' | 'unavailable',
) {
  (
    gateway as unknown as {
      handleLiveCandlePubSubStatus(value: string): void;
    }
  ).handleLiveCandlePubSubStatus(value);
}

function clients(gateway: AssetTickerGateway): Map<unknown, unknown> {
  return (gateway as unknown as { clients: Map<unknown, unknown> }).clients;
}

function clientCount(gateway: AssetTickerGateway): number {
  return clients(gateway).size;
}

function messages(client: ReturnType<typeof fakeClient>) {
  return client.send.mock.calls.map(([message]) => JSON.parse(message));
}

function subscription(assetId: string, interval: string) {
  return { type: 'subscribe', channel: 'asset_candle', assetId, interval };
}

function snapshot(
  overrides: Partial<AssetCandleSnapshotEvent> = {},
): AssetCandleSnapshotEvent {
  return {
    type: 'asset_candle',
    assetId: 'asset-1',
    interval: '5m',
    candle: {
      time: '2026-07-13T00:00:00.000Z',
      openTime: '2026-07-13T00:00:00.000Z',
      closeTime: '2026-07-13T00:05:00.000Z',
      open: '100.00000000',
      high: '110.00000000',
      low: '90.00000000',
      close: '105.00000000',
      volume: '10.00000000',
      amount: null,
    },
    revision: 1,
    sequence: 1,
    provisional: true,
    complete: true,
    delayed: false,
    sourceUpdatedAt: '2026-07-13T00:04:00.000Z',
    final: false,
    ...overrides,
  };
}
