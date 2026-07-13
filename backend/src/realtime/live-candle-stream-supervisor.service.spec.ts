jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  };
});
jest.mock('../assets/live-candle-pipeline.service', () => ({
  LiveCandlePipelineService: class LiveCandlePipelineService {},
}));

import { EventEmitter } from 'node:events';
import { readLiveCandleConfig } from '../assets/live-candle.config';
import { LiveCandleHealthService } from '../assets/live-candle-health.service';
import { LiveCandleStreamSupervisorService } from './live-candle-stream-supervisor.service';

describe('LiveCandleStreamSupervisorService', () => {
  it('opens one Binance owner connection, subscribes native 5m klines, handles ping, and restores pipeline continuity', async () => {
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    const context = ownerContext();
    const connected = connectBinance(fixture.service, context);
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit('ping', Buffer.from('heartbeat'));
    socket.emit('message', binanceFrame());
    await Promise.resolve();
    socket.close(1000, 'fixture done');
    await connected;
    await Promise.resolve();

    expect(fixture.factory).toHaveBeenCalledWith('wss://stream.example/ws');
    expect(JSON.parse(socket.sent[0])).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@kline_5m'],
      id: 1,
    });
    expect(socket.pong).toHaveBeenCalledWith(Buffer.from('heartbeat'));
    expect(fixture.pipeline.markProviderConnected).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'binance',
        ownerGeneration: 'owner-1',
      }),
    );
    expect(fixture.pipeline.process).toHaveBeenCalledTimes(1);
    expect(fixture.pricePubSub.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'binance_realtime_price',
        assetId: 'btc',
        price: expect.objectContaining({ price: '105.00000000' }),
      }),
    );
    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'connected',
      subscriptionsActive: 1,
      delayed: false,
    });
  });

  it('uses bounded exponential reconnect without overlapping connection attempts', async () => {
    const fixture = setup(() => new FakeSocket());
    const service = fixture.service as unknown as {
      stopping: boolean;
      connectBinance(context: unknown): Promise<void>;
      runOwnedConnections(context: unknown): Promise<void>;
      sleep(ms: number): Promise<void>;
    };
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const connect = jest
      .spyOn(service, 'connectBinance')
      .mockRejectedValueOnce(new Error('disconnect-1'))
      .mockRejectedValueOnce(new Error('disconnect-2'))
      .mockImplementationOnce(async () => {
        service.stopping = true;
      });
    const sleep = jest.spyOn(service, 'sleep').mockResolvedValue();

    await service.runOwnedConnections(ownerContext());

    expect(connect).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
    expect(fixture.pipeline.markProviderContinuityLost).toHaveBeenCalledTimes(
      2,
    );
    jest.restoreAllMocks();
  });

  it('reports assets beyond the bounded shard capacity as failed subscriptions', async () => {
    const socket = new FakeSocket();
    const fixture = setup(
      () => socket,
      [cryptoAsset('btc', 'BTC'), cryptoAsset('eth', 'ETH')],
      1,
    );
    const connected = connectBinance(fixture.service, ownerContext());
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.close(1000, 'fixture done');
    await connected;

    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'degraded',
      subscriptionsRequested: 2,
      subscriptionsActive: 1,
      subscriptionsFailed: 1,
      lastErrorCode: 'SUBSCRIPTION_SHARD_CAP',
    });
  });

  it('closes and degrades a stream when the provider rejects its subscription', async () => {
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    const connected = connectBinance(fixture.service, ownerContext());
    socket.open();
    await new Promise((resolve) => setImmediate(resolve));
    socket.emit(
      'message',
      JSON.stringify({ id: 1, code: 2, msg: 'subscription rejected' }),
    );
    await connected;

    expect(socket.closeCalls.at(-1)).toEqual([1011, 'subscription rejected']);
    expect(fixture.health.snapshot().providers.binance).toMatchObject({
      state: 'degraded',
      subscriptionsActive: 0,
      subscriptionsFailed: 1,
      lastErrorCode: 'SUBSCRIPTION_REJECTED',
    });
  });

  it('closes the provider socket immediately after owner lease renewal is lost', async () => {
    jest.useFakeTimers();
    const socket = new FakeSocket();
    const fixture = setup(() => socket);
    fixture.locks.extend.mockResolvedValue(false);
    const context = ownerContext(socket);
    startLeaseRenewal(fixture.service, context);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(context.lost).toBe(true);
    expect(socket.closeCalls.at(-1)).toEqual([4003, 'owner lease lost']);
    if (context.renewTimer) clearInterval(context.renewTimer);
    jest.useRealTimers();
  });
});

function setup(
  socketFactory: () => FakeSocket,
  assets = [cryptoAsset('btc', 'BTC')],
  maxProviderSubscriptionsPerShard = 200,
) {
  const prisma = {
    asset: {
      findMany: jest.fn().mockResolvedValue(assets),
    },
  };
  const locks = {
    acquire: jest.fn(),
    extend: jest.fn().mockResolvedValue(true),
    release: jest.fn(),
  };
  const providerConfig = {
    getConfig: jest.fn().mockReturnValue({
      common: { providerIngestionEnabled: true },
      binance: {
        enabled: true,
        wsMarketDataBaseUrl: 'wss://stream.example',
      },
      kis: {},
    }),
  };
  const normalizer = {
    normalizeBinance: jest.fn().mockReturnValue({
      price: '105.00000000',
      source: 'binance_spot_ws_5m_kline',
      eventTime: new Date(299_000),
      receivedAt: new Date(300_000),
    }),
  };
  const pipeline = {
    markProviderConnected: jest.fn(),
    markProviderContinuityLost: jest.fn().mockResolvedValue(undefined),
    process: jest.fn().mockResolvedValue({ status: 'updated' }),
  };
  const pricePubSub = { publish: jest.fn().mockResolvedValue(true) };
  const health = new LiveCandleHealthService();
  const factory = jest.fn(socketFactory);
  const service = new LiveCandleStreamSupervisorService(
    prisma as never,
    locks as never,
    providerConfig as never,
    {} as never,
    pricePubSub as never,
    normalizer as never,
    pipeline as never,
    health,
    {
      ...readLiveCandleConfig({}),
      enabled: true,
      binanceEnabled: true,
      maxProviderSubscriptionsPerShard,
    },
    factory,
  );
  return {
    service,
    locks,
    pipeline,
    pricePubSub,
    health,
    factory,
  };
}

function cryptoAsset(id: string, symbol: string) {
  return {
    id,
    symbol,
    assetType: 'crypto',
    market: 'BINANCE',
    isActive: true,
  };
}

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  pong = jest.fn();

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', code, reason);
  }
}

function ownerContext(socket: FakeSocket | null = null) {
  return {
    provider: 'binance' as const,
    lock: { key: 'lease', token: 'owner-1' },
    leaseKey: 'lease',
    lost: false,
    socket,
    renewTimer: null as NodeJS.Timeout | null,
  };
}

function connectBinance(
  service: LiveCandleStreamSupervisorService,
  context: ReturnType<typeof ownerContext>,
) {
  return (
    service as unknown as {
      connectBinance(context: unknown): Promise<void>;
    }
  ).connectBinance(context);
}

function startLeaseRenewal(
  service: LiveCandleStreamSupervisorService,
  context: ReturnType<typeof ownerContext>,
) {
  return (
    service as unknown as {
      startLeaseRenewal(context: unknown): void;
    }
  ).startLeaseRenewal(context);
}

function binanceFrame(): string {
  return JSON.stringify({
    e: 'kline',
    E: 299_000,
    s: 'BTCUSDT',
    k: {
      t: 0,
      T: 299_999,
      s: 'BTCUSDT',
      i: '5m',
      f: 1,
      L: 2,
      o: '100',
      h: '110',
      l: '90',
      c: '105',
      v: '10',
      n: 2,
      x: false,
      q: '1050',
    },
  });
}
