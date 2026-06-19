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
import { KoreaEximExchangeClient } from './korea-exim-exchange.client';
import {
  formatKstSearchDate,
  KoreaEximExchangeIngestionService,
  kstSearchDateToUtcMidnight,
  parseKoreaEximUsdKrwRate,
} from './korea-exim-exchange.ingestion.service';

describe('KoreaEximExchangeIngestionService', () => {
  it('parses lowercase response fields and comma-formatted USD DEAL_BAS_R', () => {
    const parsed = parseKoreaEximUsdKrwRate(
      [
        {
          result: '1',
          cur_unit: 'usd',
          cur_nm: '미국 달러',
          deal_bas_r: '1,389.50',
        },
      ],
      '20260619',
    );

    expect(parsed).toEqual({
      fromCurrency: CurrencyCode.USD,
      toCurrency: CurrencyCode.KRW,
      rate: '1389.50000000',
      searchDate: '20260619',
      effectiveAt: new Date('2026-06-18T15:00:00.000Z'),
      curUnit: 'usd',
      curName: '미국 달러',
      dealBasR: '1,389.50',
    });
  });

  it('parses uppercase response fields and USD-prefixed CUR_UNIT values', () => {
    const parsed = parseKoreaEximUsdKrwRate(
      [
        {
          RESULT: 1,
          CUR_UNIT: 'JPY(100)',
          CUR_NM: '일본 엔',
          DEAL_BAS_R: '960.00',
        },
        {
          RESULT: 1,
          CUR_UNIT: 'USD(미국 달러)',
          CUR_NM: '미국 달러',
          DEAL_BAS_R: '1400',
        },
      ],
      '20260619',
    );

    expect(parsed).toMatchObject({
      rate: '1400.00000000',
      curUnit: 'USD(미국 달러)',
      curName: '미국 달러',
      dealBasR: '1400',
    });
  });

  it('maps Korea EXIM RESULT error codes', () => {
    expectProviderCode(
      () => parseKoreaEximUsdKrwRate([{ RESULT: 2 }], '20260619'),
      'KOREA_EXIM_DATA_CODE_ERROR',
    );
    expectProviderCode(
      () => parseKoreaEximUsdKrwRate([{ RESULT: 3 }], '20260619'),
      'KOREA_EXIM_AUTH_CODE_ERROR',
    );
    expectProviderCode(
      () => parseKoreaEximUsdKrwRate([{ RESULT: 4 }], '20260619'),
      'KOREA_EXIM_DAILY_LIMIT_EXCEEDED',
    );
  });

  it('returns unavailable for a date when no USD row exists', () => {
    expect(
      parseKoreaEximUsdKrwRate(
        [
          {
            RESULT: 1,
            CUR_UNIT: 'EUR',
            DEAL_BAS_R: '1600.00',
          },
        ],
        '20260619',
      ),
    ).toBeNull();
  });

  it('formats KST search dates and effectiveAt timestamps', () => {
    const now = new Date('2026-06-18T15:30:00.000Z');

    expect(formatKstSearchDate(now)).toBe('20260619');
    expect(formatKstSearchDate(now, 1)).toBe('20260618');
    expect(kstSearchDateToUtcMidnight('20260619')).toEqual(
      new Date('2026-06-18T15:00:00.000Z'),
    );
  });

  it('looks back after today has no USD row and stores the previous available rate', async () => {
    const prisma = createPrismaMock();
    const client = {
      fetchDailyExchangeRates: jest
        .fn()
        .mockResolvedValueOnce({
          receivedAt: new Date('2026-06-19T00:00:10.000Z'),
          rows: [{ RESULT: 1, CUR_UNIT: 'EUR', DEAL_BAS_R: '1600.00' }],
        })
        .mockResolvedValueOnce({
          receivedAt: new Date('2026-06-19T00:00:20.000Z'),
          rows: [
            {
              RESULT: 1,
              CUR_UNIT: 'USD',
              CUR_NM: '미국 달러',
              DEAL_BAS_R: '1,389.50',
            },
          ],
        }),
    } as unknown as KoreaEximExchangeClient;
    const service = new KoreaEximExchangeIngestionService(
      prisma as never,
      createConfigService(),
      client,
    );

    const result = await service.ensureFreshUsdKrwSnapshot({
      now: new Date('2026-06-19T01:00:00.000Z'),
      maxAgeSeconds: 300,
      lookbackDays: 2,
    });

    expect(client.fetchDailyExchangeRates).toHaveBeenNthCalledWith(1, {
      searchDate: '20260619',
    });
    expect(client.fetchDailyExchangeRates).toHaveBeenNthCalledWith(2, {
      searchDate: '20260618',
    });
    expect(result).toMatchObject({
      snapshotId: 'fx-korea-exim-1',
      rate: '1389.50000000',
      sourceName: 'korea_exim_exchange_rate',
      searchDate: '20260618',
      effectiveAt: new Date('2026-06-17T15:00:00.000Z'),
      capturedAt: new Date('2026-06-19T00:00:20.000Z'),
      reused: false,
    });
    expect(prisma.fxRateSnapshot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          baseCurrency: 'USD',
          quoteCurrency: 'KRW',
          rate: '1389.50000000',
          sourceType: 'provider_api',
          sourceName: 'korea_exim_exchange_rate',
          effectiveAt: new Date('2026-06-17T15:00:00.000Z'),
          capturedAt: new Date('2026-06-19T00:00:20.000Z'),
          approvedByUserId: null,
          rawPayloadJson: {
            provider: 'korea_exim_exchange_rate',
            searchDate: '20260618',
            curUnit: 'USD',
            curName: '미국 달러',
            dealBasR: '1,389.50',
          },
        }),
      }),
    );
  });

  it('reuses an existing fresh Korea EXIM snapshot without calling the external API', async () => {
    const prisma = createPrismaMock();
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'fx-korea-exim-existing',
      rate: new Prisma.Decimal('1389.50000000'),
      effectiveAt: new Date('2026-06-18T15:00:00.000Z'),
      capturedAt: new Date('2026-06-19T00:00:30.000Z'),
    });
    const client = {
      fetchDailyExchangeRates: jest.fn(),
    } as unknown as KoreaEximExchangeClient;
    const service = new KoreaEximExchangeIngestionService(
      prisma as never,
      createConfigService(),
      client,
    );

    await expect(
      service.ensureFreshUsdKrwSnapshot({
        now: new Date('2026-06-19T00:01:00.000Z'),
        maxAgeSeconds: 60,
      }),
    ).resolves.toMatchObject({
      snapshotId: 'fx-korea-exim-existing',
      rate: '1389.50000000',
      reused: true,
    });
    expect(client.fetchDailyExchangeRates).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.create).not.toHaveBeenCalled();
  });
});

function expectProviderCode(callback: () => unknown, code: string) {
  try {
    callback();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected provider error ${code}`);
}

function createConfigService(): ProviderConfigService {
  return {
    getConfig: () => ({
      common: {
        providerIngestionEnabled: true,
        httpTimeoutMs: 5000,
        rawPayloadMaxBytes: 12000,
      },
      exchangeRateApi: {
        enabled: false,
        baseUrl: 'https://example.test/v6',
      },
      koreaEximExchange: {
        enabled: true,
        authKey: 'test-auth-key',
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
        enabled: false,
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
      create: jest.fn().mockResolvedValue({
        id: 'fx-korea-exim-1',
        rate: new Prisma.Decimal('1389.50000000'),
        effectiveAt: new Date('2026-06-17T15:00:00.000Z'),
        capturedAt: new Date('2026-06-19T00:00:20.000Z'),
      }),
    },
  };
}
