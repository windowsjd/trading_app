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

import { CurrencyCode } from '../../generated/prisma/client';
import { ProviderConfigService } from '../provider-config.service';
import { BinancePublicClient } from './binance-public.client';
import {
  BinancePriceIngestionService,
  parseBinanceTickerPrice,
  parseBinanceUsdEquivalentSymbol,
} from './binance-price.ingestion.service';

describe('Binance price ingestion', () => {
  const receivedAt = new Date('2026-05-26T00:00:10.000Z');
  const ticker = {
    symbol: 'BTCUSDT',
    lastPrice: '109000.123456789',
    closeTime: Date.parse('2026-05-26T00:00:03.000Z'),
  };

  it('parses public ticker lastPrice and closeTime', () => {
    const parsed = parseBinanceTickerPrice(ticker, receivedAt, 'BTCUSDT');

    expect(parsed).toEqual({
      providerSymbol: 'BTCUSDT',
      internalCurrencyCode: CurrencyCode.USD,
      price: '109000.12345679',
      effectiveAt: new Date('2026-05-26T00:00:03.000Z'),
      sourceTimestamp: new Date('2026-05-26T00:00:03.000Z'),
    });
  });

  it('normalizes USDT quote symbols to internal USD-equivalent policy', () => {
    expect(parseBinanceUsdEquivalentSymbol('btcusdt', true)).toEqual({
      supported: true,
      providerSymbol: 'BTCUSDT',
      baseSymbol: 'BTC',
    });
  });

  it('dry-run skips DB writes for mapped assets', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const service = createService({ prisma, ticker });

    const result = await service.ingestPrices({
      dryRun: true,
      symbols: ['BTCUSDT'],
    });

    expect(result.success).toBe(true);
    expect(result.wouldCreate).toBe(1);
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('non-dry-run creates provider_api USD asset price snapshots for mapped assets', async () => {
    const prisma = createPrismaMock({
      assets: [{ id: 'asset-btc', symbol: 'BTC' }],
    });
    const service = createService({ prisma, ticker });

    const result = await service.ingestPrices({
      symbols: ['BTCUSDT'],
      requestedBy: 'operator',
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(1);
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-btc',
          price: '109000.12345679',
          currencyCode: 'USD',
          sourceType: 'provider_api',
          sourceName: 'binance_public_rest_24hr_ticker',
        }),
      }),
    );
  });

  it('skips unmapped symbols without creating fake assets', async () => {
    const prisma = createPrismaMock({ assets: [] });
    const service = createService({ prisma, ticker });

    const result = await service.ingestPrices({
      symbols: ['BTCUSDT'],
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(1);
    expect(result.symbols[0].reason).toBe('ASSET_MAPPING_NOT_FOUND');
    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });
});

function createService(input: {
  prisma: ReturnType<typeof createPrismaMock>;
  ticker: unknown;
}) {
  const configService = {
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
        enabled: true,
        restBaseUrl: 'https://api.binance.com',
        wsMarketDataBaseUrl: 'wss://data-stream.binance.vision',
        symbols: ['BTCUSDT'],
        usdtAsUsdEquivalent: true,
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
  const client = {
    fetchTicker24hr: jest.fn().mockResolvedValue({
      response: input.ticker,
      receivedAt: new Date('2026-05-26T00:00:10.000Z'),
    }),
  } as unknown as BinancePublicClient;

  return new BinancePriceIngestionService(
    input.prisma as never,
    configService,
    client,
  );
}

function createPrismaMock(input: {
  assets: Array<{ id: string; symbol: string }>;
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
      create: jest.fn(),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'price-provider-1' }),
    },
  };
}
