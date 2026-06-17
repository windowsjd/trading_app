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
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { ProviderConfigService } from '../provider-config.service';
import { KisAuthClient } from './kis-auth.client';
import { KisWebSocketClient } from './kis-websocket.client';
import { KisWebSocketIngestionService } from './kis-websocket.ingestion.service';

describe('KIS WebSocket client', () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    jest.restoreAllMocks();
  });

  it('registers the message listener before sending subscribe requests', async () => {
    const events: string[] = [];
    const FakeWebSocket = createFakeWebSocket(events);
    globalThis.WebSocket = FakeWebSocket as never;
    const client = new KisWebSocketClient(
      configServiceForTest(),
      {
        requestConfiguredWebSocketApprovalKey: jest.fn().mockResolvedValue({
          state: 'available',
          response: {
            approvalKey: 'approval-for-test',
          },
          receivedAt: new Date('2026-05-27T00:00:00.000Z'),
        }),
      } as unknown as KisAuthClient,
      {
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
      } as unknown as KisWebSocketIngestionService,
    );

    const result = await client.runTradePriceIngestion({
      dryRun: true,
      durationMs: 1,
    });

    expect(result.success).toBe(true);
    expect(events.indexOf('add:message')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('send:subscribe')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('add:message')).toBeLessThan(
      events.indexOf('send:subscribe'),
    );
  });
});

function configServiceForTest(): ProviderConfigService {
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
        wsBaseUrl: 'ws://example.test',
        wsCustType: 'P',
        wsDomesticTrId: 'H0STCNT0',
        wsOverseasDelayedTrId: 'HDFSCNT0',
        wsSnapshotThrottleMs: 5000,
        wsMaxRuntimeMs: 30000,
        wsAllowUsDelayed: true,
        maxWatchlistSize: 41,
        domesticSymbols: [],
        usSymbols: [],
        allSymbols: [],
        canCallRestLive: true,
        canCallWebSocketLive: true,
      },
    }),
  } as unknown as ProviderConfigService;
}

function createFakeWebSocket(events: string[]) {
  return class FakeWebSocket {
    static readonly instances: FakeWebSocket[] = [];

    readyState = 1;
    private readonly listeners = new Map<
      string,
      Set<(event: unknown) => void>
    >();

    constructor(readonly url: string) {
      events.push(`construct:${url}`);
      FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
      const parsed = JSON.parse(data) as {
        header?: { tr_type?: string };
      };
      events.push(
        parsed.header?.tr_type === '2' ? 'send:unsubscribe' : 'send:subscribe',
      );
    }

    close(): void {
      this.readyState = 3;
      events.push('close');
      queueMicrotask(() => this.emit('close', {}));
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
      events.push(`add:${type}`);
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: (event: unknown) => void,
    ): void {
      events.push(`remove:${type}`);
      this.listeners.get(type)?.delete(listener);
    }

    private emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener(event);
      }
    }
  };
}
