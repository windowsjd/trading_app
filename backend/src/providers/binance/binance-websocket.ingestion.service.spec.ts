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

import { Prisma } from '../../generated/prisma/client';
import type { ProviderConfigService } from '../provider-config.service';
import { parseBinanceWebSocketMessage } from './binance-websocket.parser';
import { BinanceWebSocketIngestionService } from './binance-websocket.ingestion.service';

describe('Binance WebSocket ingestion service', () => {
  const receivedAt = new Date('2026-06-19T03:00:30.000Z');

  it('creates provider_api USD snapshots with Binance WebSocket source metadata', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
      fxRate: '1400.00000000',
    });
    const service = createService({ prisma });
    const message = tickerMessage({
      symbol: 'BTCUSDT',
      price: '100.00000000',
      receivedAt,
    });

    const result = await service.ingestParsedMessage(message, {
      requestedBy: 'binance-stream-test',
    });

    expect(result).toMatchObject({
      success: true,
      provider: 'binance',
      received: 1,
      created: 1,
      skipped: 0,
      failed: 0,
      tickers: [
        {
          symbol: 'BTCUSDT',
          state: 'created',
          assetId: 'asset-btc',
          price: '100.00000000',
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-btc',
          price: '100.00000000',
          priceKrw: '140000.00000000',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'binance_spot_ws_ticker',
          capturedAt: receivedAt,
          effectiveAt: new Date('2026-06-19T03:00:28.000Z'),
          note: 'provider_api Binance WebSocket ticker ingestion requested by binance-stream-test',
        }),
      }),
    );
    expect(
      JSON.stringify(
        prisma.assetPriceSnapshot.create.mock.calls[0][0].data.rawPayloadJson,
      ),
    ).not.toMatch(/api[-_]?key|secret|signature/i);
  });

  it('skips DB writes when a recent snapshot is inside the throttle window', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-eth', symbol: 'ETH' }],
      duplicateSnapshot: null,
      recentSnapshot: { id: 'recent-price' },
    });
    const service = createService({ prisma });
    const message = tickerMessage({
      symbol: 'ETHUSDT',
      price: '3500.00000000',
      receivedAt,
    });

    const result = await service.ingestParsedMessage(message);

    expect(result).toMatchObject({
      success: true,
      received: 1,
      created: 0,
      skipped: 1,
      tickers: [
        {
          symbol: 'ETHUSDT',
          state: 'skipped',
          assetId: 'asset-eth',
          reason: 'THROTTLED_PROVIDER_SNAPSHOT',
        },
      ],
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('returns failed result when provider ingestion is disabled', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const service = createService({
      prisma,
      providerIngestionEnabled: false,
    });

    const result = await service.ingestParsedMessage(
      tickerMessage({
        symbol: 'BTCUSDT',
        price: '100.00000000',
        receivedAt,
      }),
    );

    expect(result).toMatchObject({
      success: false,
      provider: 'binance',
      errorCode: 'PROVIDER_INGESTION_DISABLED',
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });
});

function tickerMessage(input: {
  symbol: string;
  price: string;
  receivedAt: Date;
}) {
  const parsed = parseBinanceWebSocketMessage({
    frame: JSON.stringify({
      stream: `${input.symbol.toLowerCase()}@ticker`,
      data: {
        e: '24hrTicker',
        E: Date.parse('2026-06-19T03:00:28.000Z'),
        s: input.symbol,
        P: '1.500',
        c: input.price,
        b: input.price,
        a: input.price,
      },
    }),
    receivedAt: input.receivedAt,
  });

  if (parsed.state !== 'ticker') {
    throw new Error('expected ticker message');
  }

  return parsed;
}

function createService(input: {
  prisma: ReturnType<typeof createPrismaMock>;
  providerIngestionEnabled?: boolean;
  binanceEnabled?: boolean;
}) {
  const configService = {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: input.providerIngestionEnabled ?? true,
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
        enabled: input.binanceEnabled ?? true,
        restBaseUrl: 'https://api.binance.com',
        wsMarketDataBaseUrl: 'wss://stream.binance.com:9443',
        symbols: ['BTCUSDT', 'ETHUSDT'],
        usdtAsUsdEquivalent: true,
        wsStreamingEnabled: true,
        wsStreamingReconnectMinMs: 1000,
        wsStreamingReconnectMaxMs: 30000,
        wsStreamingHeartbeatTimeoutMs: 60000,
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

  return new BinanceWebSocketIngestionService(
    input.prisma as never,
    configService,
  );
}

function createPrismaMock(input: {
  assets: Array<{ id: string; symbol: string }>;
  fxRate?: string;
  duplicateSnapshot?: unknown;
  recentSnapshot?: unknown;
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
    },
    assetPriceSnapshot: {
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(input.duplicateSnapshot ?? null)
        .mockResolvedValueOnce(input.recentSnapshot ?? null),
      create: jest.fn().mockResolvedValue({ id: 'price-provider-1' }),
    },
    fxRateSnapshot: {
      findFirst: jest.fn().mockResolvedValue(
        input.fxRate
          ? {
              rate: new Prisma.Decimal(input.fxRate),
            }
          : null,
      ),
    },
  };
}
