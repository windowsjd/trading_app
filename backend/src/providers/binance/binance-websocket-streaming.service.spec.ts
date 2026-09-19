jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      provider_api: 'provider_api',
    },
    AssetType: {
      crypto: 'crypto',
    },
    CurrencyCode: {
      USD: 'USD',
    },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      provider_api: 'provider_api',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import type { ProviderConfigService } from '../provider-config.service';
import { BinanceRealtimePriceCacheService } from './binance-realtime-price-cache.service';
import { BinanceRealtimePriceEventBus } from './binance-realtime-price-event-bus.service';
import type { BinanceWebSocketIngestionService } from './binance-websocket.ingestion.service';
import { BinanceWebSocketStreamingService } from './binance-websocket-streaming.service';
import { BinanceOrderBookService } from './binance-order-book.service';

describe('Binance WebSocket streaming service', () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalEnv = { ...process.env };
  let service: BinanceWebSocketStreamingService | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as never;
  });

  afterEach(async () => {
    await service?.stop();
    service = null;
    globalThis.WebSocket = originalWebSocket;
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('does not start when streaming is disabled', async () => {
    const ingestionService = createIngestionService();
    service = createService({
      configService: configServiceForTest({
        streamingEnabled: false,
      }),
      ingestionService,
    });

    service.start();
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(ingestionService.ingestParsedMessage).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      running: false,
      state: 'disabled',
      connected: false,
    });
  });

  it('stands down in live-candle Binance mode so a ticker is never fanned out twice', async () => {
    // The live-candle owner connection carries <symbol>@ticker itself; running
    // this standalone socket at the same time would publish every ticker twice.
    process.env.CANDLE_LIVE_STREAMING_ENABLED = 'true';
    process.env.CANDLE_LIVE_BINANCE_ENABLED = 'true';
    const ingestionService = createIngestionService();
    service = createService({ ingestionService });

    service.start();
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(ingestionService.ingestParsedMessage).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      running: false,
      state: 'disabled',
    });
  });

  it('owns the ticker fanout when live-candle Binance mode is off', async () => {
    process.env.CANDLE_LIVE_STREAMING_ENABLED = 'false';
    process.env.CANDLE_LIVE_BINANCE_ENABLED = 'false';
    service = createService();

    service.start();
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      connected: true,
    });
  });

  it('connects and subscribes to lowercase ticker streams when enabled', async () => {
    service = createService();

    service.start();
    await flushAsync();

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://example.test/stream');
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      method: 'SUBSCRIBE',
      params: ['btcusdt@ticker', 'ethusdt@ticker'],
      id: 1,
    });
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      connected: true,
      subscribedSymbolCount: 2,
      lastErrorCode: null,
    });
  });

  it('updates latest price cache and publishes an event when ticker messages arrive', async () => {
    const eventBus = new BinanceRealtimePriceEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
    });
    const cache = new BinanceRealtimePriceCacheService();
    const ingestionService = createIngestionService({
      ingestParsedMessage: jest.fn().mockResolvedValue({
        success: true,
        provider: 'binance',
        dryRun: false,
        received: 1,
        created: 1,
        skipped: 0,
        wouldCreate: 0,
        failed: 0,
        tickers: [
          {
            symbol: 'BTCUSDT',
            state: 'created',
            assetId: 'asset-btc',
            price: '100123.00000000',
            effectiveAt: '2026-06-19T03:00:28.000Z',
          },
        ],
      }),
    });
    service = createService({
      ingestionService,
      latestPriceCache: cache,
      eventBus,
    });

    service.start();
    await flushAsync();
    FakeWebSocket.instances[0].emitMessage(
      tickerFrame({
        symbol: 'BTCUSDT',
        price: '100123',
        eventTime: '2026-06-19T03:00:28.000Z',
      }),
    );
    await flushAsync();

    expect(cache.getBySymbol('BTCUSDT')).toMatchObject({
      providerSymbol: 'BTCUSDT',
      price: '100123.00000000',
      currencyCode: 'USD',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: '2026-06-19T03:00:28.000Z',
    });
    expect(ingestionService.ingestParsedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'ticker',
      }),
      expect.objectContaining({
        dryRun: false,
        requestedBy: 'binance-websocket-streaming',
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'binance_realtime_price',
      assetId: 'asset-btc',
      snapshotState: 'created',
      price: {
        providerSymbol: 'BTCUSDT',
        price: '100123.00000000',
      },
    });
    expect(service.getStatus()).toMatchObject({
      receivedFrames: 1,
      receivedTickers: 1,
      created: 1,
      latestPriceCount: 1,
    });
  });

  it('subscribes active depth on the same socket and keeps combined ticker ingestion separate', async () => {
    const pubsub = { publish: jest.fn().mockResolvedValue(true) };
    const orderBooks = new BinanceOrderBookService(
      {
        asset: {
          findMany: jest
            .fn()
            .mockResolvedValue([{ id: 'btc', symbol: 'BTCUSDT' }]),
        },
      } as never,
      pubsub as never,
    );
    const ingestionService = createIngestionService();
    service = createService({ orderBooks, ingestionService });
    service.start();
    await flushAsync();
    const socket = FakeWebSocket.instances[0];
    expect(JSON.parse(socket.sent[0]).params).toEqual([
      'btcusdt@ticker',
      'ethusdt@ticker',
      'btcusdt@depth10',
    ]);
    socket.emitMessage(
      JSON.stringify({
        stream: 'btcusdt@depth10',
        data: {
          lastUpdateId: 1,
          asks: [['100.10', '0.00125000']],
          bids: [['100.09', '2.5']],
        },
      }),
    );
    await flushAsync();
    expect(pubsub.publish).toHaveBeenCalledTimes(1);
    expect(pubsub.publish.mock.calls[0][0].book).toMatchObject({
      assetId: 'btc',
      effectiveAt: null,
      quantityUnit: 'BTC',
    });
    expect(ingestionService.ingestParsedMessage).not.toHaveBeenCalled();
    socket.emitMessage(
      tickerFrame({
        symbol: 'BTCUSDT',
        price: '100',
        eventTime: '2026-09-19T00:00:00.000Z',
      }),
    );
    await flushAsync();
    expect(ingestionService.ingestParsedMessage).toHaveBeenCalledTimes(1);
    expect(ingestionService.ingestParsedMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'ticker' }),
      expect.anything(),
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(service.getStatus().subscribedSymbolCount).toBe(2);
    await orderBooks.onModuleDestroy();
  });

  it('does not even load depth targets when the live-candle owner is enabled', async () => {
    process.env.CANDLE_LIVE_STREAMING_ENABLED = 'true';
    process.env.CANDLE_LIVE_BINANCE_ENABLED = 'true';
    const orderBooks = { loadTargets: jest.fn(), handleFrame: jest.fn() };
    service = createService({ orderBooks: orderBooks as never });
    service.start();
    await flushAsync();
    expect(orderBooks.loadTargets).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('retries target lookup failures through the existing reconnect path', async () => {
    const orderBooks = {
      loadTargets: jest
        .fn()
        .mockRejectedValueOnce(new Error('metadata unavailable'))
        .mockResolvedValue(new Map()),
      handleFrame: jest.fn().mockReturnValue(false),
    };
    service = createService({
      orderBooks: orderBooks as never,
      configService: configServiceForTest({
        reconnectMinMs: 250,
        reconnectMaxMs: 250,
      }),
    });
    service.start();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(service.getStatus().reconnecting).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(orderBooks.loadTargets).toHaveBeenCalledTimes(2);
  });

  it('keeps latest cache fresh when DB snapshots are throttled', async () => {
    const eventBus = new BinanceRealtimePriceEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
    });
    const cache = new BinanceRealtimePriceCacheService();
    const ingestionService = createIngestionService({
      ingestParsedMessage: jest
        .fn()
        .mockResolvedValueOnce({
          success: true,
          provider: 'binance',
          dryRun: false,
          received: 1,
          created: 1,
          skipped: 0,
          wouldCreate: 0,
          failed: 0,
          tickers: [
            {
              symbol: 'BTCUSDT',
              state: 'created',
              assetId: 'asset-btc',
              price: '100123.00000000',
              effectiveAt: '2026-06-19T03:00:28.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          provider: 'binance',
          dryRun: false,
          received: 1,
          created: 0,
          skipped: 1,
          wouldCreate: 0,
          failed: 0,
          tickers: [
            {
              symbol: 'BTCUSDT',
              state: 'skipped',
              assetId: 'asset-btc',
              price: '100124.00000000',
              effectiveAt: '2026-06-19T03:00:29.000Z',
              reason: 'THROTTLED_PROVIDER_SNAPSHOT',
            },
          ],
        }),
    });
    service = createService({
      ingestionService,
      latestPriceCache: cache,
      eventBus,
    });

    service.start();
    await flushAsync();
    const socket = FakeWebSocket.instances[0];
    socket.emitMessage(
      tickerFrame({
        symbol: 'BTCUSDT',
        price: '100123',
        eventTime: '2026-06-19T03:00:28.000Z',
      }),
    );
    await flushAsync();
    socket.emitMessage(
      tickerFrame({
        symbol: 'BTCUSDT',
        price: '100124',
        eventTime: '2026-06-19T03:00:29.000Z',
      }),
    );
    await flushAsync();

    expect(cache.getBySymbol('BTCUSDT')).toMatchObject({
      price: '100124.00000000',
      effectiveAt: '2026-06-19T03:00:29.000Z',
    });
    expect(events[1]).toMatchObject({
      assetId: 'asset-btc',
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      price: {
        price: '100124.00000000',
      },
    });
    expect(service.getStatus()).toMatchObject({
      created: 1,
      skipped: 1,
      latestPriceCount: 1,
    });
  });

  it('schedules reconnect when the connected socket closes', async () => {
    service = createService({
      configService: configServiceForTest({
        reconnectMinMs: 250,
        reconnectMaxMs: 1000,
      }),
    });

    service.start();
    await flushAsync();
    FakeWebSocket.instances[0].emitClose();

    expect(service.getStatus()).toMatchObject({
      connected: false,
      reconnecting: true,
      reconnectCount: 1,
      nextReconnectDelayMs: 250,
      lastErrorCode: 'BINANCE_WEBSOCKET_CLOSED',
    });
  });

  it('schedules reconnect when Binance sends serverShutdown', async () => {
    service = createService({
      configService: configServiceForTest({
        reconnectMinMs: 250,
        reconnectMaxMs: 1000,
      }),
    });

    service.start();
    await flushAsync();
    FakeWebSocket.instances[0].emitMessage(
      JSON.stringify({
        e: 'serverShutdown',
        E: Date.parse('2026-06-19T03:00:28.000Z'),
      }),
    );
    await flushAsync();

    expect(service.getStatus()).toMatchObject({
      connected: false,
      reconnecting: true,
      reconnectCount: 1,
      nextReconnectDelayMs: 250,
      lastErrorCode: 'BINANCE_SERVER_SHUTDOWN',
    });
  });

  it('responds to server ping frames with pong payloads', async () => {
    service = createService();

    service.start();
    await flushAsync();
    const socket = FakeWebSocket.instances[0];
    const payload = Buffer.from('ping-payload');
    socket.emitPing(payload);

    expect(socket.pongs).toEqual([payload]);
  });
});

function createService(
  input: {
    configService?: ProviderConfigService;
    ingestionService?: Partial<BinanceWebSocketIngestionService>;
    latestPriceCache?: BinanceRealtimePriceCacheService;
    eventBus?: BinanceRealtimePriceEventBus;
    orderBooks?: BinanceOrderBookService;
  } = {},
): BinanceWebSocketStreamingService {
  return new BinanceWebSocketStreamingService(
    input.configService ?? configServiceForTest(),
    input.ingestionService ?? createIngestionService(),
    input.latestPriceCache ?? new BinanceRealtimePriceCacheService(),
    input.eventBus ?? new BinanceRealtimePriceEventBus(),
    input.orderBooks ??
      new BinanceOrderBookService(
        { asset: { findMany: jest.fn().mockResolvedValue([]) } } as never,
        { publish: jest.fn().mockResolvedValue(true) } as never,
      ),
  );
}

function createIngestionService(
  overrides: Partial<BinanceWebSocketIngestionService> = {},
): Partial<BinanceWebSocketIngestionService> {
  return {
    ingestParsedMessage: jest.fn().mockResolvedValue({
      success: true,
      provider: 'binance',
      dryRun: false,
      received: 1,
      created: 0,
      skipped: 0,
      wouldCreate: 0,
      failed: 0,
      tickers: [],
    }),
    ...overrides,
  };
}

function configServiceForTest(
  overrides: Partial<{
    streamingEnabled: boolean;
    providerIngestionEnabled: boolean;
    binanceEnabled: boolean;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    heartbeatTimeoutMs: number;
    symbols: string[];
  }> = {},
): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: overrides.providerIngestionEnabled ?? true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test',
      },
      koreaEximExchange: {
        enabled: false,
        baseUrl: 'https://example.test',
        data: 'AP01',
        lookbackDays: 7,
      },
      binance: {
        enabled: overrides.binanceEnabled ?? true,
        restBaseUrl: 'https://api.binance.com',
        wsMarketDataBaseUrl: 'ws://example.test',
        symbols: overrides.symbols ?? ['BTCUSDT', 'ETHUSDT'],
        usdtAsUsdEquivalent: true,
        wsStreamingEnabled: overrides.streamingEnabled ?? true,
        wsStreamingReconnectMinMs: overrides.reconnectMinMs ?? 1000,
        wsStreamingReconnectMaxMs: overrides.reconnectMaxMs ?? 30000,
        wsStreamingHeartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 60000,
        wsSnapshotThrottleMs: 5000,
      },
      kis: {
        enabled: false,
        maxWatchlistSize: 41,
        domesticSymbols: [],
        usSymbols: [],
        allSymbols: [],
        canCallRestLive: false,
        canCallWebSocketLive: false,
      },
    }),
  } as unknown as ProviderConfigService;
}

function tickerFrame(input: {
  symbol: string;
  price: string;
  eventTime: string;
}): string {
  return JSON.stringify({
    stream: `${input.symbol.toLowerCase()}@ticker`,
    data: {
      e: '24hrTicker',
      E: Date.parse(input.eventTime),
      s: input.symbol,
      P: '1.750',
      c: input.price,
      b: input.price,
      a: input.price,
    },
  });
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly pongs: Buffer[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly nodeListeners = new Map<string, Set<(data?: Buffer) => void>>();
  readyState = 1;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emitClose();
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  on(type: string, listener: (data?: Buffer) => void): void {
    const listeners = this.nodeListeners.get(type) ?? new Set();
    listeners.add(listener);
    this.nodeListeners.set(type, listeners);
  }

  pong(data?: Buffer): void {
    this.pongs.push(data ?? Buffer.alloc(0));
  }

  emitMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  emitPing(data: Buffer): void {
    for (const listener of this.nodeListeners.get('ping') ?? []) {
      listener(data);
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) {
      listener({});
    }
  }
}
