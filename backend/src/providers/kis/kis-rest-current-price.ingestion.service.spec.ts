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
      official_batch: 'official_batch',
      provider_api: 'provider_api',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpError } from '../provider.types';
import { KisAuthClient } from './kis-auth.client';
import { KisQuoteClient } from './kis-quote.client';
import {
  parseKisDomesticCurrentPriceResponse,
  parseKisUsCurrentPriceResponse,
} from './kis-rest-current-price.parser';
import { KisRestCurrentPriceIngestionService } from './kis-rest-current-price.ingestion.service';

const receivedAt = new Date('2026-06-21T01:00:00.000Z');

describe('KIS REST current-price ingestion', () => {
  it('parses domestic current-price fixture', () => {
    expect(
      parseKisDomesticCurrentPriceResponse(
        domesticPriceResponse({ price: '70123' }),
        receivedAt,
        '005930',
      ),
    ).toMatchObject({
      kind: 'domestic_krx_current_price',
      symbol: '005930',
      price: '70123.00000000',
      currencyCode: 'KRW',
      effectiveAt: new Date('2026-06-21T00:30:15.000Z'),
    });
  });

  it('parses US current-price fixture', () => {
    expect(
      parseKisUsCurrentPriceResponse(
        usPriceResponse({ symbol: 'AAPL', last: '190.12' }),
        receivedAt,
        'AAPL',
        'NAS',
      ),
    ).toMatchObject({
      kind: 'us_current_price',
      symbol: 'AAPL',
      marketCode: 'NAS',
      price: '190.12000000',
      currencyCode: 'USD',
    });
  });

  it('dry-run records wouldCreate without DB writes', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const quoteClient = createQuoteClient([
      { state: 'available', response: domesticPriceResponse(), receivedAt },
    ]);
    const service = createService({ prisma, quoteClient });

    const result = await service.ingestCurrentPrices({
      dryRun: true,
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result).toMatchObject({
      success: true,
      received: 1,
      wouldCreate: 1,
      created: 0,
    });
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('non-dry-run creates mapped domestic asset price snapshot', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const quoteClient = createQuoteClient([
      { state: 'available', response: domesticPriceResponse(), receivedAt },
    ]);
    const service = createService({ prisma, quoteClient });

    const result = await service.ingestCurrentPrices({
      dryRun: false,
      domesticSymbols: ['005930'],
      usSymbols: [],
      requestedBy: 'operator-1',
    });

    expect(result.created).toBe(1);
    expect(prisma.assetPriceSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-samsung',
          price: '70123.00000000',
          priceKrw: '70123.00000000',
          currencyCode: 'KRW',
          sourceType: 'provider_api',
          sourceName: 'kis_krx_realtime_trade',
          note: 'provider_api KIS REST current-price ingestion requested by operator-1',
        }),
      }),
    );
  });

  it('skips zero or missing prices without DB writes', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const quoteClient = createQuoteClient([
      {
        state: 'available',
        response: domesticPriceResponse({ price: '0' }),
        receivedAt,
      },
    ]);
    const service = createService({ prisma, quoteClient });

    const result = await service.ingestCurrentPrices({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result.skipped).toBe(1);
    expect(result.snapshots[0].reason).toBe('INVALID_DECIMAL');
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
  });

  it('skips unmapped, inactive, and wrong-currency assets', async () => {
    const unmapped = await runOneDomesticMappingCase([]);
    const inactive = await runOneDomesticMappingCase([
      asset({ id: 'inactive', symbol: '005930', isActive: false }),
    ]);
    const wrongCurrency = await runOneDomesticMappingCase([
      asset({ id: 'usd-stock', symbol: '005930', currencyCode: 'USD' }),
    ]);

    expect(unmapped.snapshots[0].reason).toBe('ASSET_MAPPING_NOT_FOUND');
    expect(inactive.snapshots[0].reason).toBe('ASSET_INACTIVE');
    expect(wrongCurrency.snapshots[0].reason).toBe('WRONG_CURRENCY');
  });

  it('skips duplicate and throttled snapshots', async () => {
    const duplicatePrisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    duplicatePrisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'duplicate',
    });
    const duplicate = await createService({
      prisma: duplicatePrisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticPriceResponse(), receivedAt },
      ]),
    }).ingestCurrentPrices({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    const throttledPrisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    throttledPrisma.assetPriceSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'recent' });
    const throttled = await createService({
      prisma: throttledPrisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticPriceResponse(), receivedAt },
      ]),
    }).ingestCurrentPrices({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(duplicate.snapshots[0].reason).toBe('DUPLICATE_PROVIDER_SNAPSHOT');
    expect(throttled.snapshots[0].reason).toBe('THROTTLED_PROVIDER_SNAPSHOT');
  });

  it('redacts app secrets and access tokens from rawPayloadJson', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const service = createService({
      prisma,
      quoteClient: createQuoteClient([
        {
          state: 'available',
          response: domesticPriceResponse({ extra: 'app-secret access-token' }),
          receivedAt,
        },
      ]),
      appSecret: 'app-secret',
      accessToken: 'access-token',
    });

    await service.ingestCurrentPrices({
      dryRun: false,
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    const rawPayload = JSON.stringify(
      prisma.assetPriceSnapshot.create.mock.calls[0][0].data.rawPayloadJson,
    );
    expect(rawPayload).not.toContain('app-secret');
    expect(rawPayload).not.toContain('access-token');
    expect(rawPayload).toContain('[REDACTED]');
  });

  it('handles provider HTTP errors as failed summaries', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const quoteClient = {
      getMarketDataByExplicitPath: jest
        .fn()
        .mockRejectedValue(
          new ProviderHttpError('kis', 'PROVIDER_TIMEOUT', 'timed out'),
        ),
    } as unknown as KisQuoteClient;
    const service = createService({ prisma, quoteClient });

    const result = await service.ingestCurrentPrices({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result.failed).toBe(1);
    expect(result.snapshots[0].reason).toBe('PROVIDER_TIMEOUT');
  });
});

async function runOneDomesticMappingCase(
  assets: Array<ReturnType<typeof asset>>,
) {
  const prisma = createPrismaMock({ assets });
  const service = createService({
    prisma,
    quoteClient: createQuoteClient([
      { state: 'available', response: domesticPriceResponse(), receivedAt },
    ]),
  });

  return service.ingestCurrentPrices({
    domesticSymbols: ['005930'],
    usSymbols: [],
  });
}

function createService(input: {
  prisma: ReturnType<typeof createPrismaMock>;
  quoteClient: KisQuoteClient;
  appSecret?: string;
  accessToken?: string;
}) {
  const configService = {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: { enabled: false, baseUrl: 'https://example.test' },
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
        appKey: 'app-key',
        appSecret: input.appSecret ?? 'app-secret',
        restBaseUrl: 'https://example.test',
        restDomesticCurrentPricePath: '/domestic-price',
        restDomesticCurrentPriceTrId: 'FHKST01010100',
        restUsCurrentPricePath: '/us-price',
        restUsCurrentPriceTrId: 'HHDFS00000300',
        restDomesticHogaPath: '/domestic-hoga',
        restDomesticHogaTrId: 'FHKST01010200',
        restUsHogaPath: '/us-hoga',
        restUsHogaTrId: 'HHDFS76200100',
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
  const authClient = {
    requestConfiguredRestToken: jest.fn().mockResolvedValue({
      state: 'available',
      response: {
        accessToken: input.accessToken ?? 'access-token',
      },
      receivedAt,
    }),
  } as unknown as KisAuthClient;

  return new KisRestCurrentPriceIngestionService(
    input.prisma as never,
    configService,
    authClient,
    input.quoteClient,
  );
}

function createPrismaMock(input: {
  assets: Array<{
    id: string;
    market: string;
    symbol: string;
    currencyCode: string;
    assetType: string;
    isActive: boolean;
  }>;
}) {
  return {
    asset: {
      findMany: jest.fn().mockResolvedValue(input.assets),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'snapshot-1' }),
    },
    fxRateSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

function createQuoteClient(results: unknown[]): KisQuoteClient {
  return {
    getMarketDataByExplicitPath: jest
      .fn()
      .mockImplementation(() => Promise.resolve(results.shift())),
  } as unknown as KisQuoteClient;
}

function asset(overrides: {
  id: string;
  symbol: string;
  market?: string;
  currencyCode?: string;
  assetType?: string;
  isActive?: boolean;
}) {
  return {
    id: overrides.id,
    symbol: overrides.symbol,
    market: overrides.market ?? 'KRX',
    currencyCode: overrides.currencyCode ?? 'KRW',
    assetType: overrides.assetType ?? 'domestic_stock',
    isActive: overrides.isActive ?? true,
  };
}

function domesticPriceResponse(input: { price?: string; extra?: string } = {}) {
  return {
    rt_cd: '0',
    output: {
      stck_shrn_iscd: '005930',
      stck_prpr: input.price ?? '70123',
      stck_bsop_date: '20260621',
      stck_cntg_hour: '093015',
      note: input.extra,
    },
  };
}

function usPriceResponse(input: { symbol: string; last: string }) {
  return {
    rt_cd: '0',
    output: {
      symb: input.symbol,
      mtyp: 'NAS',
      last: input.last,
      kymd: '20260621',
      khms: '093015',
    },
  };
}
