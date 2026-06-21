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
import { ProviderHttpError } from '../provider.types';
import { KisAuthClient } from './kis-auth.client';
import { KisQuoteClient } from './kis-quote.client';
import {
  parseKisDomesticHogaResponse,
  parseKisUsHogaResponse,
} from './kis-rest-hoga.parser';
import { KisRestHogaIngestionService } from './kis-rest-hoga.ingestion.service';

const receivedAt = new Date('2026-06-21T01:00:00.000Z');

describe('KIS REST hoga ingestion', () => {
  it('parses domestic hoga fixture and spread bps', () => {
    expect(
      parseKisDomesticHogaResponse(
        domesticHogaResponse({ bidPrice: '70100', askPrice: '70200' }),
        receivedAt,
        '005930',
      ),
    ).toMatchObject({
      kind: 'domestic_krx_hoga',
      symbol: '005930',
      bidPrice: '70100.00000000',
      askPrice: '70200.00000000',
      spreadBps: '14.25516750',
      currencyCode: 'KRW',
    });
  });

  it('parses US hoga fixture', () => {
    expect(
      parseKisUsHogaResponse(
        usHogaResponse({
          symbol: 'AAPL',
          bidPrice: '190.10',
          askPrice: '190.12',
        }),
        receivedAt,
        'AAPL',
        'NAS',
      ),
    ).toMatchObject({
      kind: 'us_hoga',
      symbol: 'AAPL',
      marketCode: 'NAS',
      bidPrice: '190.10000000',
      askPrice: '190.12000000',
      currencyCode: 'USD',
    });
  });

  it('skips invalid bid/ask data without DB writes', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const service = createService({
      prisma,
      quoteClient: createQuoteClient([
        {
          state: 'available',
          response: domesticHogaResponse({
            bidPrice: '70200',
            askPrice: '70100',
          }),
          receivedAt,
        },
      ]),
    });

    const result = await service.ingestHogaSnapshots({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result.skipped).toBe(1);
    expect(result.snapshots[0].reason).toBe('INVALID_ORDERBOOK_SPREAD');
    expect(prisma.assetOrderbookSnapshot.create).not.toHaveBeenCalled();
  });

  it('dry-run records wouldCreate without DB writes', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const service = createService({
      prisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticHogaResponse(), receivedAt },
      ]),
    });

    const result = await service.ingestHogaSnapshots({
      dryRun: true,
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result.wouldCreate).toBe(1);
    expect(prisma.assetOrderbookSnapshot.create).not.toHaveBeenCalled();
  });

  it('non-dry-run creates mapped orderbook snapshot row', async () => {
    const prisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    const service = createService({
      prisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticHogaResponse(), receivedAt },
      ]),
    });

    const result = await service.ingestHogaSnapshots({
      dryRun: false,
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    expect(result.created).toBe(1);
    expect(prisma.assetOrderbookSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-samsung',
          sourceType: 'provider_api',
          sourceName: 'kis_krx_realtime_hoga',
          bidPrice: '70100.00000000',
          askPrice: '70200.00000000',
          currencyCode: 'KRW',
        }),
      }),
    );
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

  it('skips duplicate and throttled hoga snapshots', async () => {
    const duplicatePrisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    duplicatePrisma.assetOrderbookSnapshot.findFirst.mockResolvedValueOnce({
      id: 'duplicate',
    });
    const duplicate = await createService({
      prisma: duplicatePrisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticHogaResponse(), receivedAt },
      ]),
    }).ingestHogaSnapshots({
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    const throttledPrisma = createPrismaMock({
      assets: [asset({ id: 'asset-samsung', symbol: '005930' })],
    });
    throttledPrisma.assetOrderbookSnapshot.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'recent' });
    const throttled = await createService({
      prisma: throttledPrisma,
      quoteClient: createQuoteClient([
        { state: 'available', response: domesticHogaResponse(), receivedAt },
      ]),
    }).ingestHogaSnapshots({
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
          response: domesticHogaResponse({ extra: 'app-secret access-token' }),
          receivedAt,
        },
      ]),
      appSecret: 'app-secret',
      accessToken: 'access-token',
    });

    await service.ingestHogaSnapshots({
      dryRun: false,
      domesticSymbols: ['005930'],
      usSymbols: [],
    });

    const rawPayload = JSON.stringify(
      prisma.assetOrderbookSnapshot.create.mock.calls[0][0].data.rawPayloadJson,
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

    const result = await service.ingestHogaSnapshots({
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
      { state: 'available', response: domesticHogaResponse(), receivedAt },
    ]),
  });

  return service.ingestHogaSnapshots({
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

  return new KisRestHogaIngestionService(
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
    assetOrderbookSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'orderbook-1' }),
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

function domesticHogaResponse(
  input: {
    bidPrice?: string;
    askPrice?: string;
    extra?: string;
  } = {},
) {
  return {
    rt_cd: '0',
    output1: {
      stck_shrn_iscd: '005930',
      bidp1: input.bidPrice ?? '70100',
      askp1: input.askPrice ?? '70200',
      bidp_rsqn1: '100',
      askp_rsqn1: '120',
      stck_bsop_date: '20260621',
      stck_cntg_hour: '093015',
      note: input.extra,
    },
  };
}

function usHogaResponse(input: {
  symbol: string;
  bidPrice: string;
  askPrice: string;
}) {
  return {
    rt_cd: '0',
    output1: {
      symb: input.symbol,
      mtyp: 'NAS',
      pbid: input.bidPrice,
      pask: input.askPrice,
      vbid: '100',
      vask: '120',
      kymd: '20260621',
      khms: '093015',
    },
  };
}
