jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
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

import { CurrencyCode, Prisma } from '../../generated/prisma/client';
import { ProviderConfigService } from '../provider-config.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ExchangeRateClient } from './exchange-rate.client';
import {
  ExchangeRateIngestionService,
  parseUsdKrwExchangeRateResponse,
} from './exchange-rate.ingestion.service';

describe('ExchangeRate ingestion', () => {
  const receivedAt = new Date('2026-05-26T00:00:10.000Z');
  const response = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: 1779753600,
    conversion_rates: {
      KRW: 1365.123456789,
    },
  };

  it('parses conversion_rates.KRW into a decimal string rate', () => {
    const parsed = parseUsdKrwExchangeRateResponse(response, receivedAt);

    expect(parsed).toEqual({
      fromCurrency: CurrencyCode.USD,
      toCurrency: CurrencyCode.KRW,
      rate: '1365.12345679',
      effectiveAt: new Date('2026-05-26T00:00:00.000Z'),
      sourceTimestamp: new Date('2026-05-26T00:00:00.000Z'),
    });
  });

  it('dry-run fetches and parses without writing DB rows', async () => {
    const prisma = createPrismaMock();
    const service = createService({
      prisma,
      clientResponse: response,
      receivedAt,
    });

    const result = await service.ingestUsdKrw({
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(result.success).toBe(true);
    expect(result.wouldCreate).toBe(1);
    expect(prisma.fxRateSnapshot.create).not.toHaveBeenCalled();
  });

  it('non-dry-run creates a provider_api fx_rate_snapshots row', async () => {
    const prisma = createPrismaMock();
    const service = createService({
      prisma,
      clientResponse: response,
      receivedAt,
    });

    const result = await service.ingestUsdKrw({
      requestedBy: 'operator',
    });

    expect(result.success).toBe(true);
    expect(result.created).toBe(1);
    expect(prisma.fxRateSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          baseCurrency: 'USD',
          quoteCurrency: 'KRW',
          rate: '1365.12345679',
          sourceType: 'provider_api',
          sourceName: 'exchange_rate_api',
          approvedByUserId: null,
        }),
      }),
    );
  });

  it('redacts API key values from stored rawPayloadJson', async () => {
    const prisma = createPrismaMock();
    const service = createService({
      prisma,
      clientResponse: {
        ...response,
        echoedApiKey: 'secret-api-key',
      },
      receivedAt,
      apiKey: 'secret-api-key',
    });

    await service.ingestUsdKrw();

    const createArg = prisma.fxRateSnapshot.create.mock.calls[0][0];
    expect(JSON.stringify(createArg.data.rawPayloadJson)).not.toContain(
      'secret-api-key',
    );
    expect(JSON.stringify(createArg.data.rawPayloadJson)).toContain(
      '[REDACTED]',
    );
  });

  it('redacts API key from HTTP error messages even though it is in the request URL', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'invalid secret-api-key',
    } as Response);
    const configService = configServiceFor('secret-api-key');
    const client = new ExchangeRateClient(
      configService,
      new ProviderHttpClient(),
    );

    await expect(client.fetchLatestUsd()).rejects.toMatchObject({
      message: expect.not.stringContaining('secret-api-key'),
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/secret-api-key/latest/USD'),
      expect.any(Object),
    );
    fetchSpy.mockRestore();
  });
});

function createService(input: {
  prisma: ReturnType<typeof createPrismaMock>;
  clientResponse: unknown;
  receivedAt: Date;
  apiKey?: string;
}) {
  const configService = configServiceFor(input.apiKey ?? 'test-api-key');
  const client = {
    fetchLatestUsd: jest.fn().mockResolvedValue({
      response: input.clientResponse,
      receivedAt: input.receivedAt,
    }),
  } as unknown as ExchangeRateClient;

  return new ExchangeRateIngestionService(
    input.prisma as never,
    configService,
    client,
  );
}

function configServiceFor(apiKey: string): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: true,
        apiKey,
        baseUrl: 'https://example.test/v6',
      },
      binance: {
        enabled: false,
        restBaseUrl: 'https://example.test',
        wsMarketDataBaseUrl: 'wss://example.test',
        symbols: [],
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
}

function createPrismaMock() {
  return {
    fxRateSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'fx-provider-1' }),
    },
    Prisma,
  };
}
