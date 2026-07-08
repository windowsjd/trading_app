jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
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
import type { KisAuthClient } from './kis-auth.client';
import { KisRealtimePriceCacheService } from './kis-realtime-price-cache.service';
import { KisRealtimePriceEventBus } from './kis-realtime-price-event-bus.service';
import type { KisWebSocketIngestionService } from './kis-websocket.ingestion.service';
import { KisWebSocketStreamingService } from './kis-websocket-streaming.service';

describe('KIS WebSocket streaming service', () => {
  const originalWebSocket = globalThis.WebSocket;
  let service: KisWebSocketStreamingService | null = null;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket as never;
  });

  afterEach(async () => {
    await service?.stop();
    service = null;
    globalThis.WebSocket = originalWebSocket;
    jest.restoreAllMocks();
  });

  it('does not start when streaming is disabled', async () => {
    const authClient = createAuthClient();
    const ingestionService = createIngestionService();
    service = createService({
      configService: configServiceForTest({
        streamingEnabled: false,
      }),
      authClient,
      ingestionService,
    });

    service.start();
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(
      authClient.requestConfiguredWebSocketApprovalKey,
    ).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      enabled: false,
      running: false,
      state: 'disabled',
      connected: false,
    });
  });

  it('connects and subscribes when streaming is enabled', async () => {
    const authClient = createAuthClient();
    const ingestionService = createIngestionService();
    service = createService({
      authClient,
      ingestionService,
    });

    service.start();
    await flushAsync();

    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://example.test');
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toContain('"tr_type":"1"');
    expect(socket.sent[0]).not.toContain('app-key-for-test');
    expect(socket.sent[0]).not.toContain('app-secret-for-test');
    expect(
      authClient.requestConfiguredWebSocketApprovalKey,
    ).toHaveBeenCalledTimes(1);
    expect(ingestionService.buildSubscriptionTargets).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      enabled: true,
      connected: true,
      subscribedSymbolCount: 1,
      lastErrorCode: null,
    });
  });

  it('updates latest price cache and publishes an event when trade messages arrive', async () => {
    const eventBus = new KisRealtimePriceEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
    });
    const ingestionService = createIngestionService({
      ingestParsedMessage: jest.fn().mockResolvedValue({
        success: true,
        provider: 'kis',
        dryRun: false,
        received: 1,
        acknowledged: 0,
        created: 1,
        skipped: 0,
        wouldCreate: 0,
        failed: 0,
        snapshots: [
          {
            symbol: '005930',
            sourceName: 'kis_krx_realtime_trade',
            state: 'created',
            assetId: 'asset-005930',
            price: '70123.00000000',
            effectiveAt: '2026-05-27T00:30:15.000Z',
          },
        ],
      }),
    });
    const cache = new KisRealtimePriceCacheService();
    service = createService({
      ingestionService,
      latestPriceCache: cache,
      eventBus,
    });

    service.start();
    await flushAsync();
    FakeWebSocket.instances[0].emitMessage(
      domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
        }),
      ]),
    );
    await flushAsync();

    expect(
      cache.getBySymbol({
        kind: 'domestic_krx_realtime_trade',
        symbol: '005930',
      }),
    ).toMatchObject({
      symbol: '005930',
      price: '70123.00000000',
      currencyCode: 'KRW',
      sourceName: 'kis_krx_realtime_trade',
      effectiveAt: '2026-05-27T00:30:15.000Z',
    });
    expect(ingestionService.ingestParsedMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'trades',
      }),
      expect.objectContaining({
        dryRun: false,
        requestedBy: 'kis-websocket-streaming',
        secrets: ['approval-secret-for-test'],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'kis_realtime_price',
      assetId: 'asset-005930',
      snapshotState: 'created',
      price: {
        symbol: '005930',
        price: '70123.00000000',
      },
    });
    expect(service.getStatus()).toMatchObject({
      receivedFrames: 1,
      receivedTrades: 1,
      created: 1,
      latestPriceCount: 1,
    });
  });

  it('keeps latest cache fresh when DB snapshots are throttled', async () => {
    const eventBus = new KisRealtimePriceEventBus();
    const events: unknown[] = [];
    eventBus.subscribe((event) => {
      events.push(event);
    });
    const ingestionService = createIngestionService({
      ingestParsedMessage: jest
        .fn()
        .mockResolvedValueOnce({
          success: true,
          provider: 'kis',
          dryRun: false,
          received: 1,
          acknowledged: 0,
          created: 1,
          skipped: 0,
          wouldCreate: 0,
          failed: 0,
          snapshots: [
            {
              symbol: '005930',
              sourceName: 'kis_krx_realtime_trade',
              state: 'created',
              assetId: 'asset-005930',
              price: '70123.00000000',
              effectiveAt: '2026-05-27T00:30:15.000Z',
            },
          ],
        })
        .mockResolvedValueOnce({
          success: true,
          provider: 'kis',
          dryRun: false,
          received: 1,
          acknowledged: 0,
          created: 0,
          skipped: 1,
          wouldCreate: 0,
          failed: 0,
          snapshots: [
            {
              symbol: '005930',
              sourceName: 'kis_krx_realtime_trade',
              state: 'skipped',
              assetId: 'asset-005930',
              price: '70124.00000000',
              effectiveAt: '2026-05-27T00:30:16.000Z',
              reason: 'THROTTLED_PROVIDER_SNAPSHOT',
            },
          ],
        }),
    });
    const cache = new KisRealtimePriceCacheService();
    service = createService({
      ingestionService,
      latestPriceCache: cache,
      eventBus,
    });

    service.start();
    await flushAsync();
    const socket = FakeWebSocket.instances[0];
    socket.emitMessage(
      domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093015',
          price: '70123',
          businessDate: '20260527',
        }),
      ]),
    );
    await flushAsync();
    socket.emitMessage(
      domesticFrame([
        domesticRecord({
          symbol: '005930',
          time: '093016',
          price: '70124',
          businessDate: '20260527',
        }),
      ]),
    );
    await flushAsync();

    expect(
      cache.getBySymbol({
        kind: 'domestic_krx_realtime_trade',
        symbol: '005930',
      }),
    ).toMatchObject({
      price: '70124.00000000',
      effectiveAt: '2026-05-27T00:30:16.000Z',
    });
    expect(events[1]).toMatchObject({
      assetId: 'asset-005930',
      snapshotState: 'skipped',
      snapshotReason: 'THROTTLED_PROVIDER_SNAPSHOT',
      price: {
        price: '70124.00000000',
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
      lastErrorCode: 'KIS_WEBSOCKET_CLOSED',
    });
  });
});

function createService(
  input: {
    configService?: ProviderConfigService;
    authClient?: Partial<KisAuthClient>;
    ingestionService?: Partial<KisWebSocketIngestionService>;
    latestPriceCache?: KisRealtimePriceCacheService;
    eventBus?: KisRealtimePriceEventBus;
  } = {},
): KisWebSocketStreamingService {
  return new KisWebSocketStreamingService(
    input.configService ?? configServiceForTest(),
    input.authClient ?? createAuthClient(),
    input.ingestionService ?? createIngestionService(),
    input.latestPriceCache ?? new KisRealtimePriceCacheService(),
    input.eventBus ?? new KisRealtimePriceEventBus(),
  );
}

function createAuthClient(): Partial<KisAuthClient> {
  return {
    requestConfiguredWebSocketApprovalKey: jest.fn().mockResolvedValue({
      state: 'available',
      response: {
        approvalKey: 'approval-secret-for-test',
      },
      receivedAt: new Date('2026-05-27T00:00:00.000Z'),
    }),
  };
}

function createIngestionService(
  overrides: Partial<KisWebSocketIngestionService> = {},
): Partial<KisWebSocketIngestionService> {
  return {
    buildSubscriptionTargets: jest.fn().mockResolvedValue({
      targets: [
        {
          kind: 'domestic_krx_realtime_trade',
          trId: 'H0STCNT0',
          trKey: '005930',
          symbol: '005930',
          marketCode: 'KRX',
        },
      ],
      skipped: [],
    }),
    ingestParsedMessage: jest.fn().mockResolvedValue({
      success: true,
      provider: 'kis',
      dryRun: false,
      received: 1,
      acknowledged: 0,
      created: 0,
      skipped: 0,
      wouldCreate: 0,
      failed: 0,
      snapshots: [],
    }),
    ...overrides,
  };
}

function configServiceForTest(
  overrides: Partial<{
    streamingEnabled: boolean;
    reconnectMinMs: number;
    reconnectMaxMs: number;
    heartbeatTimeoutMs: number;
  }> = {},
): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
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
        enabled: false,
        restBaseUrl: 'https://example.test',
        wsMarketDataBaseUrl: 'wss://example.test',
        symbols: [],
        usdtAsUsdEquivalent: true,
      },
      kis: {
        enabled: true,
        appKey: 'app-key-for-test',
        appSecret: 'app-secret-for-test',
        restBaseUrl: 'https://example.test',
        restDomesticCurrentPricePath: '/domestic-price',
        restDomesticCurrentPriceTrId: 'DOMPRICE',
        restUsCurrentPricePath: '/us-price',
        restUsCurrentPriceTrId: 'USPRICE',
        restDomesticHogaPath: '/domestic-hoga',
        restDomesticHogaTrId: 'DOMHOGA',
        restUsHogaPath: '/us-hoga',
        restUsHogaTrId: 'USHOGA',
        wsBaseUrl: 'ws://example.test',
        wsCustType: 'P',
        wsDomesticTrId: 'H0STCNT0',
        wsOverseasDelayedTrId: 'HDFSCNT0',
        wsSnapshotThrottleMs: 5000,
        wsMaxRuntimeMs: 30000,
        wsAllowUsDelayed: true,
        wsStreamingEnabled: overrides.streamingEnabled ?? true,
        wsStreamingReconnectMinMs: overrides.reconnectMinMs ?? 1000,
        wsStreamingReconnectMaxMs: overrides.reconnectMaxMs ?? 30000,
        wsStreamingHeartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 60000,
        maxWatchlistSize: 41,
        domesticSymbols: ['005930'],
        usSymbols: [],
        allSymbols: ['005930'],
        canCallRestLive: true,
        canCallWebSocketLive: true,
      },
    }),
  } as unknown as ProviderConfigService;
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
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

  emitMessage(data: string): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data });
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.listeners.get('close') ?? []) {
      listener({});
    }
  }
}

function domesticFrame(records: string[][]): string {
  return `0|H0STCNT0|${String(records.length).padStart(3, '0')}|${records
    .flat()
    .join('^')}`;
}

function domesticRecord(input: {
  symbol: string;
  time: string;
  price: string;
  businessDate: string;
}): string[] {
  const fields = Array.from({ length: 46 }, () => '');
  fields[0] = input.symbol;
  fields[1] = input.time;
  fields[2] = input.price;
  fields[33] = input.businessDate;
  fields[35] = 'N';
  return fields;
}
