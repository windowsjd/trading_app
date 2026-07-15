jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{
    Decimal: typeof import('@prisma/client/runtime/client').Decimal;
  }>('@prisma/client/runtime/client');

  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    MarketCandleSyncMode: {
      initial: 'initial',
      incremental: 'incremental',
      repair: 'repair',
    },
    MarketCandleSyncStatus: {
      pending: 'pending',
      running: 'running',
      completed: 'completed',
      failed: 'failed',
      canceled: 'canceled',
    },
    Prisma: {
      Decimal,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { HttpException } from '@nestjs/common';
import { AssetType, CurrencyCode } from '../generated/prisma/client';
import { ProviderHttpError } from '../providers/provider.types';
import { AssetCandlesService } from './asset-candles.service';
import { CandleResponseBuilder } from './candle-response.builder';

type KisQuoteCall = {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
};

describe('AssetCandlesService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-19T03:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createWritableModel = () => ({
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  });

  const createPrisma = () => ({
    asset: {
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    season: {
      findFirst: jest.fn(),
      ...createWritableModel(),
    },
    assetPriceSnapshot: {
      ...createWritableModel(),
    },
    fxRateSnapshot: {
      ...createWritableModel(),
    },
    order: {
      ...createWritableModel(),
    },
    position: {
      ...createWritableModel(),
    },
    dailyPortfolioSnapshot: {
      ...createWritableModel(),
    },
    seasonRanking: {
      ...createWritableModel(),
    },
    quote: {
      ...createWritableModel(),
    },
    $transaction: jest.fn(),
  });

  const createKisAuthClient = () => ({
    getCachedToken: jest.fn().mockReturnValue({
      accessToken: 'cached-kis-token',
      tokenType: 'Bearer',
      expiresInSeconds: 86400,
      expiresAt: new Date('2026-06-20T00:00:00.000Z'),
    }),
    requestConfiguredRestToken: jest.fn(),
  });

  const createKisQuoteClient = () => ({
    getMarketDataByExplicitPath: jest.fn(),
  });

  const createBinancePublicClient = () => ({
    fetchKlines: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const kisAuthClient = createKisAuthClient();
    const kisQuoteClient = createKisQuoteClient();
    const binancePublicClient = createBinancePublicClient();
    const serving = {
      serve: jest.fn(
        (
          _asset: unknown,
          _query: unknown,
          legacyLoader: () => Promise<unknown>,
        ) => legacyLoader(),
      ),
    };
    const service = new AssetCandlesService(
      prisma as never,
      kisAuthClient as never,
      kisQuoteClient as never,
      binancePublicClient as never,
      serving as never,
      new CandleResponseBuilder(),
    );

    return {
      prisma,
      kisAuthClient,
      kisQuoteClient,
      binancePublicClient,
      serving,
      service,
    };
  };

  const asset = (input: {
    id: string;
    symbol: string;
    name?: string;
    market: string;
    assetType: AssetType;
    currencyCode: CurrencyCode;
    priceCurrency?: CurrencyCode;
    settlementCurrency?: CurrencyCode;
  }) => ({
    id: input.id,
    symbol: input.symbol,
    name: input.name ?? input.symbol,
    market: input.market,
    assetType: input.assetType,
    currencyCode: input.currencyCode,
    priceCurrency: input.priceCurrency ?? input.currencyCode,
    settlementCurrency: input.settlementCurrency ?? input.currencyCode,
    isActive: true,
  });

  function domesticRow(sourceDate: string, sourceTime: string, price: string) {
    return {
      stck_bsop_date: sourceDate,
      stck_cntg_hour: sourceTime,
      stck_oprc: price,
      stck_hgpr: price,
      stck_lwpr: price,
      stck_prpr: price,
      cntg_vol: '1',
    };
  }

  function domesticPeriodRow(
    sourceDate: string,
    values: {
      open?: string;
      high?: string;
      low?: string;
      close?: string;
      volume?: string;
      amount?: string;
    } = {},
  ) {
    return {
      stck_bsop_date: sourceDate,
      stck_oprc: values.open ?? '70000',
      stck_hgpr: values.high ?? '71000',
      stck_lwpr: values.low ?? '69000',
      stck_clpr: values.close ?? '70500',
      acml_vol: values.volume ?? '12345',
      acml_tr_pbmn: values.amount ?? '870000000',
    };
  }

  function compactDateDaysBefore(sourceDate: string, days: number): string {
    const date = new Date(
      Date.UTC(
        Number(sourceDate.slice(0, 4)),
        Number(sourceDate.slice(4, 6)) - 1,
        Number(sourceDate.slice(6, 8)),
      ),
    );
    date.setUTCDate(date.getUTCDate() - days);

    return date.toISOString().slice(0, 10).replace(/-/gu, '');
  }

  function usRow(sourceDate: string, sourceTime: string, price: string) {
    return {
      xymd: sourceDate,
      xhms: sourceTime,
      open: price,
      high: price,
      low: price,
      last: price,
      evol: '1',
      eamt: price,
    };
  }

  const expectApiError = async (
    promise: Promise<unknown>,
    status: number,
    code: string,
  ) => {
    try {
      await promise;
      throw new Error('Expected promise to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(status);
      expect(httpError.getResponse()).toMatchObject({
        success: false,
        error: {
          code,
        },
      });
      return httpError.getResponse();
    }
  };

  const expectNoWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.asset,
      prisma.season,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.order,
      prisma.position,
      prisma.dailyPortfolioSnapshot,
      prisma.seasonRanking,
      prisma.quote,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.updateMany).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
      expect(model.deleteMany).not.toHaveBeenCalled();
    }

    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  const firstKisQuoteCall = (
    kisQuoteClient: ReturnType<typeof createKisQuoteClient>,
  ): KisQuoteCall => {
    expect(kisQuoteClient.getMarketDataByExplicitPath).toHaveBeenCalledTimes(1);
    const call = kisQuoteCalls(kisQuoteClient)[0];

    if (!call) {
      throw new Error('Expected KIS quote client to be called.');
    }

    return call;
  };

  const kisQuoteCalls = (
    kisQuoteClient: ReturnType<typeof createKisQuoteClient>,
  ): KisQuoteCall[] => {
    const calls = kisQuoteClient.getMarketDataByExplicitPath.mock
      .calls as unknown as Array<[KisQuoteCall]>;

    return calls.map(([call]) => call);
  };

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssetCandles(undefined, 'asset-samsung'),
      401,
      'UNAUTHORIZED',
    );
  });

  it('normalizes KIS domestic today 1-minute candles into server-side buckets', async () => {
    const { prisma, kisAuthClient, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung',
        symbol: '005930',
        name: 'Samsung Electronics',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          {
            stck_bsop_date: '20260619',
            stck_cntg_hour: '090400',
            stck_oprc: '104',
            stck_hgpr: '106',
            stck_lwpr: '103',
            stck_prpr: '104',
            cntg_vol: '10',
          },
          {
            stck_bsop_date: '20260619',
            stck_cntg_hour: '090200',
            stck_oprc: '102',
            stck_hgpr: '103',
            stck_lwpr: '101',
            stck_prpr: '102',
            cntg_vol: '10',
          },
          {
            stck_bsop_date: '20260619',
            stck_cntg_hour: '090000',
            stck_oprc: '100',
            stck_hgpr: '101',
            stck_lwpr: '99',
            stck_prpr: '100',
            cntg_vol: '10',
          },
          {
            stck_bsop_date: '20260619',
            stck_cntg_hour: '090300',
            stck_oprc: '103',
            stck_hgpr: '104',
            stck_lwpr: '102',
            stck_prpr: '103',
            cntg_vol: '10',
          },
          {
            stck_bsop_date: '20260619',
            stck_cntg_hour: '090100',
            stck_oprc: '101',
            stck_hgpr: '102',
            stck_lwpr: '100',
            stck_prpr: '101',
            cntg_vol: '10',
          },
        ],
      },
    });

    const response = await service.getAssetCandles('user-1', 'asset-samsung', {
      interval: '5m',
      date: '2026-06-19',
      to: '100000',
    });

    expect(response).toEqual({
      success: true,
      data: {
        state: 'available',
        asset: {
          id: 'asset-samsung',
          symbol: '005930',
          name: 'Samsung Electronics',
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          priceCurrency: CurrencyCode.KRW,
        },
        range: '1d',
        interval: '5m',
        requestedDate: '2026-06-19',
        candles: [
          {
            time: '2026-06-19T00:00:00.000Z',
            open: '100.00000000',
            high: '106.00000000',
            low: '99.00000000',
            close: '104.00000000',
            volume: '50.00000000',
            amount: '5100.00000000',
            sourceDate: '20260619',
            sourceTime: '090000',
          },
        ],
        source: {
          provider: 'kis',
          trId: 'FHKST03010200',
          path: '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
          marketCode: 'J',
          requestedCount: 30,
          returnedCount: 1,
        },
      },
    });
    const kisCall = firstKisQuoteCall(kisQuoteClient);
    expect(kisCall.path).toBe(
      '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
    );
    expect(kisCall.query).toMatchObject({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: '005930',
      FID_INPUT_HOUR_1: '100000',
    });
    expect(kisCall.headers).toEqual({
      authorization: 'Bearer cached-kis-token',
      tr_id: 'FHKST03010200',
      custtype: 'P',
    });
    expect(kisAuthClient.requestConfiguredRestToken).not.toHaveBeenCalled();
    expectNoWrites(prisma);
  });

  it('allows a 1m domestic stock interval as 1-minute server-side buckets', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung-1m',
        symbol: '005930',
        name: 'Samsung Electronics',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          domesticRow('20260619', '090100', '101'),
          domesticRow('20260619', '090000', '100'),
        ],
      },
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-samsung-1m',
      {
        interval: '1m',
        date: '2026-06-19',
        to: '100000',
      },
    );

    expect(response.data.interval).toBe('1m');
    expect(response.data.candles).toMatchObject([
      {
        sourceDate: '20260619',
        sourceTime: '090000',
        close: '100.00000000',
      },
      {
        sourceDate: '20260619',
        sourceTime: '090100',
        close: '101.00000000',
      },
    ]);
  });

  it('uses the domestic daily minute endpoint for past dates', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung',
        symbol: '005930',
        market: 'KOSPI',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          {
            stck_bsop_date: '20260618',
            stck_cntg_hour: '153000',
            stck_oprc: '70000',
            stck_hgpr: '70100',
            stck_lwpr: '69900',
            stck_prpr: '70050',
            cntg_vol: '20',
          },
        ],
      },
    });

    const response = await service.getAssetCandles('user-1', 'asset-samsung', {
      date: '2026-06-18',
      limit: '120',
      to: '153000',
    });

    expect(response.data.source).toMatchObject({
      trId: 'FHKST03010230',
      path: '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice',
      requestedCount: 120,
    });
    const kisCall = firstKisQuoteCall(kisQuoteClient);
    expect(kisCall.query).toMatchObject({
      FID_INPUT_DATE_1: '20260618',
      FID_INPUT_HOUR_1: '153000',
      // includePrevious defaults to true → rows may continue into prior days.
      FID_PW_DATA_INCU_YN: 'Y',
    });
    expect(kisCall.headers).toMatchObject({
      tr_id: 'FHKST03010230',
    });
  });

  it('uses KIS domestic period daily API for domestic 1d candles and maps output2 rows', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung-period-daily',
        symbol: '005930',
        name: 'Samsung Electronics',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          domesticPeriodRow('20260618', {
            open: '70000',
            high: '71300',
            low: '69800',
            close: '70500',
            volume: '12345',
            amount: '870322500',
          }),
          domesticPeriodRow('20260617', {
            open: '69000',
            high: '70100',
            low: '68800',
            close: '70000',
            volume: '23456',
            amount: '1641920000',
          }),
        ],
      },
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-samsung-period-daily',
      {
        range: '1y',
        interval: '1d',
        limit: '400',
      },
    );

    expect(response).toEqual({
      success: true,
      data: {
        state: 'available',
        asset: {
          id: 'asset-samsung-period-daily',
          symbol: '005930',
          name: 'Samsung Electronics',
          assetType: AssetType.domestic_stock,
          market: 'KRX',
          priceCurrency: CurrencyCode.KRW,
        },
        range: '1y',
        interval: '1d',
        requestedDate: '2026-06-19',
        candles: [
          {
            time: '2026-06-16T15:00:00.000Z',
            open: '69000.00000000',
            high: '70100.00000000',
            low: '68800.00000000',
            close: '70000.00000000',
            volume: '23456.00000000',
            amount: '1641920000.00000000',
            sourceDate: '20260617',
            sourceTime: '000000',
          },
          {
            time: '2026-06-17T15:00:00.000Z',
            open: '70000.00000000',
            high: '71300.00000000',
            low: '69800.00000000',
            close: '70500.00000000',
            volume: '12345.00000000',
            amount: '870322500.00000000',
            sourceDate: '20260618',
            sourceTime: '000000',
          },
        ],
        source: {
          provider: 'kis',
          trId: 'FHKST03010100',
          path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
          marketCode: 'J',
          requestedCount: 400,
          returnedCount: 2,
        },
      },
    });
    const kisCall = firstKisQuoteCall(kisQuoteClient);
    expect(kisCall.path).toBe(
      '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    );
    expect(kisCall.query).toMatchObject({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: '005930',
      FID_INPUT_DATE_1: '20250619',
      FID_INPUT_DATE_2: '20260619',
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0',
    });
    expect(kisCall.headers).toMatchObject({
      tr_id: 'FHKST03010100',
    });
  });

  it('uses KIS domestic period weekly API for domestic 1w candles', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung-period-weekly',
        symbol: '005930',
        market: 'KOSPI',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [domesticPeriodRow('20260613')],
      },
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-samsung-period-weekly',
      {
        range: '1y',
        interval: '1w',
        limit: '60',
      },
    );

    expect(response.data).toMatchObject({
      state: 'available',
      range: '1y',
      interval: '1w',
      source: {
        provider: 'kis',
        trId: 'FHKST03010100',
        path: '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
        requestedCount: 60,
        returnedCount: 1,
      },
    });
    const kisCall = firstKisQuoteCall(kisQuoteClient);
    expect(kisCall.query).toMatchObject({
      FID_PERIOD_DIV_CODE: 'W',
      FID_INPUT_DATE_1: '20250619',
      FID_INPUT_DATE_2: '20260619',
    });
  });

  it('returns empty for empty KIS domestic period rows and clamps to the bounded provider cap', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung-period-empty',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [],
      },
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-samsung-period-empty',
      {
        range: '1y',
        interval: '1d',
        limit: '999',
      },
    );

    expect(response.data).toMatchObject({
      state: 'empty',
      candles: [],
      source: {
        provider: 'kis',
        trId: 'FHKST03010100',
        requestedCount: 500,
        returnedCount: 0,
      },
    });
  });

  it('pages KIS domestic daily period rows backwards with a bounded multi-call window', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    const firstPageRows = Array.from({ length: 100 }, (_, index) =>
      domesticPeriodRow(compactDateDaysBefore('20260619', index)),
    );
    const oldestFirstPageDate = compactDateDaysBefore('20260619', 99);
    const secondPageEndDate = compactDateDaysBefore(oldestFirstPageDate, 1);

    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-samsung-period-paged',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath
      .mockResolvedValueOnce({
        state: 'available',
        receivedAt: new Date('2026-06-19T03:00:01.000Z'),
        response: {
          rt_cd: '0',
          output2: firstPageRows,
        },
      })
      .mockResolvedValueOnce({
        state: 'available',
        receivedAt: new Date('2026-06-19T03:00:02.000Z'),
        response: {
          rt_cd: '0',
          output2: [domesticPeriodRow(secondPageEndDate)],
        },
      });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-samsung-period-paged',
      {
        range: '1y',
        interval: '1d',
        limit: '400',
      },
    );

    expect(response.data.source).toMatchObject({
      trId: 'FHKST03010100',
      requestedCount: 400,
      returnedCount: 101,
    });
    const calls = kisQuoteCalls(kisQuoteClient);
    expect(calls).toHaveLength(2);
    expect(calls[0].query).toMatchObject({
      FID_INPUT_DATE_1: '20250619',
      FID_INPUT_DATE_2: '20260619',
      FID_PERIOD_DIV_CODE: 'D',
    });
    expect(calls[1].query).toMatchObject({
      FID_INPUT_DATE_1: '20250619',
      FID_INPUT_DATE_2: secondPageEndDate,
      FID_PERIOD_DIV_CODE: 'D',
    });
  });

  it.each(['5m', '15m', '30m', '1h'] as const)(
    'keeps domestic %s candles on the minute KIS APIs',
    async (interval) => {
      const { prisma, kisQuoteClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-samsung-minute-${interval}`,
          symbol: '005930',
          market: 'KRX',
          assetType: AssetType.domestic_stock,
          currencyCode: CurrencyCode.KRW,
        }),
      );
      kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
        state: 'available',
        receivedAt: new Date('2026-06-19T03:00:01.000Z'),
        response: {
          rt_cd: '0',
          output2: [],
        },
      });

      await service.getAssetCandles(
        'user-1',
        `asset-samsung-minute-${interval}`,
        {
          interval,
          date: '2026-06-19',
          to: '100000',
        },
      );

      const kisCall = firstKisQuoteCall(kisQuoteClient);
      expect(kisCall.path).toBe(
        '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice',
      );
      expect(kisCall.headers).toMatchObject({
        tr_id: 'FHKST03010200',
      });
    },
  );

  it.each([
    {
      label: 'domestic 1d',
      range: '1d',
      fixture: asset({
        id: 'asset-domestic-1d',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      rows: [
        domesticRow('20260618', '115959', '10'),
        domesticRow('20260619', '090000', '20'),
        domesticRow('20260619', '120001', '30'),
      ],
      startAt: Date.parse('2026-06-18T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'domestic 7d',
      range: '7d',
      fixture: asset({
        id: 'asset-domestic-7d',
        symbol: '005930',
        market: 'KOSPI',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      rows: [
        domesticRow('20260612', '115959', '10'),
        domesticRow('20260613', '090000', '20'),
        domesticRow('20260619', '120001', '30'),
      ],
      startAt: Date.parse('2026-06-12T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'domestic 30d',
      range: '30d',
      fixture: asset({
        id: 'asset-domestic-30d',
        symbol: '005930',
        market: 'KOSDAQ',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      rows: [
        domesticPeriodRow('20260520', { close: '10' }),
        domesticPeriodRow('20260601', { close: '20' }),
        domesticPeriodRow('20260619', { close: '30' }),
      ],
      startAt: Date.parse('2026-05-20T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'domestic season',
      range: 'season',
      season: {
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-30T00:00:00.000Z'),
      },
      fixture: asset({
        id: 'asset-domestic-season',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      rows: [
        domesticPeriodRow('20260601', { close: '10' }),
        domesticPeriodRow('20260602', { close: '20' }),
        domesticPeriodRow('20260619', { close: '30' }),
      ],
      startAt: Date.parse('2026-06-01T00:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'US 1d',
      range: '1d',
      fixture: asset({
        id: 'asset-us-1d',
        symbol: 'AAPL',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      rows: [
        usRow('20260617', '225959', '10'),
        usRow('20260618', '093000', '20'),
        usRow('20260618', '230001', '30'),
      ],
      startAt: Date.parse('2026-06-18T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'US 7d',
      range: '7d',
      fixture: asset({
        id: 'asset-us-7d',
        symbol: 'AAPL',
        market: 'NYSE',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      rows: [
        usRow('20260611', '225959', '10'),
        usRow('20260612', '093000', '20'),
        usRow('20260618', '230001', '30'),
      ],
      startAt: Date.parse('2026-06-12T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'US 30d',
      range: '30d',
      fixture: asset({
        id: 'asset-us-30d',
        symbol: 'AAPL',
        market: 'NASDAQ',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      rows: [
        usRow('20260519', '225959', '10'),
        usRow('20260601', '093000', '20'),
        usRow('20260618', '230001', '30'),
      ],
      startAt: Date.parse('2026-05-20T03:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      label: 'US season',
      range: 'season',
      season: {
        startAt: new Date('2026-06-01T00:00:00.000Z'),
        endAt: new Date('2026-06-30T00:00:00.000Z'),
      },
      fixture: asset({
        id: 'asset-us-season',
        symbol: 'AAPL',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      rows: [
        usRow('20260531', '195959', '10'),
        usRow('20260601', '093000', '20'),
        usRow('20260618', '230001', '30'),
      ],
      startAt: Date.parse('2026-06-01T00:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      // Friday now (2026-06-19 12:00 KST) → previous trading day open is
      // Thursday 2026-06-18 09:00 KST.
      label: 'domestic prev_open',
      range: 'prev_open',
      fixture: asset({
        id: 'asset-domestic-prev-open',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      rows: [
        domesticRow('20260617', '153000', '10'),
        domesticRow('20260618', '090000', '20'),
        domesticRow('20260619', '100000', '30'),
      ],
      startAt: Date.parse('2026-06-18T00:00:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
    {
      // "Today" in ET is still Thursday 2026-06-18 (23:00 EDT), so two trading
      // days back is Tuesday 2026-06-16 09:30 ET.
      label: 'US prev2_open',
      range: 'prev2_open',
      fixture: asset({
        id: 'asset-us-prev2-open',
        symbol: 'AAPL',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      rows: [
        usRow('20260616', '092900', '10'),
        usRow('20260616', '093000', '20'),
        usRow('20260618', '150000', '30'),
      ],
      startAt: Date.parse('2026-06-16T13:30:00.000Z'),
      endAt: Date.parse('2026-06-19T03:00:00.000Z'),
    },
  ])(
    'filters $label stock candles to the resolved range window before returning',
    async ({ fixture, range, rows, season, startAt, endAt }) => {
      const { prisma, kisQuoteClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(fixture);
      if (season) {
        prisma.season.findFirst.mockResolvedValueOnce(season);
      }
      kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
        state: 'available',
        receivedAt: new Date('2026-06-19T03:00:01.000Z'),
        response: {
          rt_cd: '0',
          output2: rows,
        },
      });

      const response = await service.getAssetCandles('user-1', fixture.id, {
        range,
        limit: '101',
      });

      expect(response.data.range).toBe(range);
      expect(response.data.source.requestedCount).toBeLessThanOrEqual(101);
      expect(response.data.candles.length).toBeGreaterThan(0);
      expect(response.data.candles.length).toBeLessThanOrEqual(101);
      for (const candle of response.data.candles) {
        const candleTime = Date.parse(candle.time);
        expect(candleTime).toBeGreaterThanOrEqual(startAt);
        expect(candleTime).toBeLessThanOrEqual(endAt);
      }
    },
  );

  it('passes overseas intervals through KIS NMIN and normalizes US market time', async () => {
    const { prisma, kisAuthClient, kisQuoteClient, service } = createService();
    kisAuthClient.getCachedToken.mockReturnValueOnce(null);
    kisAuthClient.requestConfiguredRestToken.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T03:00:00.000Z'),
      response: {
        accessToken: 'fresh-kis-token',
        tokenType: 'Bearer',
        expiresInSeconds: 86400,
        expiresAt: new Date('2026-06-20T00:00:00.000Z'),
      },
    });
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-aapl',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-19T13:30:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          {
            xymd: '20260619',
            xhms: '093000',
            open: '215.23',
            high: '216',
            low: '214.9',
            last: '215.8',
            evol: '12000',
            eamt: '2590000',
          },
        ],
      },
    });

    const response = await service.getAssetCandles('user-1', 'asset-aapl', {
      interval: '15m',
      limit: '999',
      date: '2026-06-19',
      includePrevious: 'false',
      to: '2026-06-19T13:45:00.000Z',
    });

    expect(response.data).toMatchObject({
      asset: {
        id: 'asset-aapl',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        assetType: AssetType.us_stock,
        market: 'NASDAQ',
        priceCurrency: CurrencyCode.USD,
      },
      interval: '15m',
      requestedDate: '2026-06-19',
      candles: [
        {
          time: '2026-06-19T13:30:00.000Z',
          open: '215.23000000',
          high: '216.00000000',
          low: '214.90000000',
          close: '215.80000000',
          volume: '12000.00000000',
          amount: '2590000.00000000',
          sourceDate: '20260619',
          sourceTime: '093000',
        },
      ],
      source: {
        provider: 'kis',
        trId: 'HHDFS76950200',
        path: '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice',
        marketCode: 'NAS',
        // limit 999 is clamped to the KIS overseas NREC cap (120).
        requestedCount: 120,
        returnedCount: 1,
      },
    });
    expect(kisQuoteClient.getMarketDataByExplicitPath).toHaveBeenCalledWith({
      path: '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice',
      query: {
        AUTH: '',
        EXCD: 'NAS',
        SYMB: 'AAPL',
        NMIN: '15',
        PINC: '0',
        NEXT: '',
        NREC: '120',
        FILL: 'Y',
        KEYB: '',
      },
      headers: {
        authorization: 'Bearer fresh-kis-token',
        tr_id: 'HHDFS76950200',
        custtype: 'P',
      },
    });
  });

  it('uses Binance Spot klines for crypto candles and normalizes rows for the chart DTO', async () => {
    const { prisma, kisQuoteClient, binancePublicClient, service } =
      createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc',
        symbol: 'BTC',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-21T04:10:01.000Z'),
      response: [
        [
          Date.parse('2026-06-21T04:05:00.000Z'),
          '65050.00000000',
          '65100.00000000',
          '65000.00000000',
          '65025.00000000',
          '2.00000000',
          Date.parse('2026-06-21T04:09:59.999Z'),
          '130050.00000000',
          10,
          '1.00000000',
          '65025.00000000',
          '0',
        ],
        [
          Date.parse('2026-06-21T04:00:00.000Z'),
          '65000.00000000',
          '65100.00000000',
          '64900.00000000',
          '65050.00000000',
          '12.34567800',
          Date.parse('2026-06-21T04:04:59.999Z'),
          '802000.00000000',
          120,
          '6.00000000',
          '390000.00000000',
          '0',
        ],
      ],
    });

    const response = await service.getAssetCandles('user-1', 'asset-btc', {
      interval: '1m',
      limit: '1500',
      date: '2026-06-21',
      to: '2026-06-21T04:30:00.000Z',
    });

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '1m',
      // limit 1500 is clamped to the Binance klines cap (1000), not to 100.
      limit: 1000,
      startTime: Date.parse('2026-06-21T00:00:00.000Z'),
      endTime: Date.parse('2026-06-21T04:30:00.000Z'),
    });
    expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    expect(response).toEqual({
      success: true,
      data: {
        state: 'available',
        asset: {
          id: 'asset-btc',
          symbol: 'BTC',
          name: 'Bitcoin',
          assetType: AssetType.crypto,
          market: 'BINANCE',
          priceCurrency: CurrencyCode.USD,
        },
        range: '1d',
        interval: '1m',
        requestedDate: '2026-06-21',
        candles: [
          {
            time: '2026-06-21T04:00:00.000Z',
            open: '65000.00000000',
            high: '65100.00000000',
            low: '64900.00000000',
            close: '65050.00000000',
            volume: '12.34567800',
            amount: '802000.00000000',
            sourceDate: '2026-06-21',
            sourceTime: '2026-06-21T04:00:00.000Z',
          },
          {
            time: '2026-06-21T04:05:00.000Z',
            open: '65050.00000000',
            high: '65100.00000000',
            low: '65000.00000000',
            close: '65025.00000000',
            volume: '2.00000000',
            amount: '130050.00000000',
            sourceDate: '2026-06-21',
            sourceTime: '2026-06-21T04:05:00.000Z',
          },
        ],
        source: {
          provider: 'binance',
          endpoint: '/api/v3/klines',
          symbol: 'BTCUSDT',
          interval: '1m',
          requestedCount: 1000,
          returnedCount: 2,
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain('access_token');
    expect(JSON.stringify(response)).not.toContain('ignore');
    expectNoWrites(prisma);
  });

  it('defaults omitted range to 1d and omitted interval to 5m', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-default-range',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: [],
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-btc-default-range',
    );

    expect(response.data.range).toBe('1d');
    expect(response.data.interval).toBe('5m');
    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '5m',
      limit: 100,
      startTime: Date.parse('2026-06-18T18:40:00.000Z'),
      endTime: Date.parse('2026-06-19T03:00:00.000Z'),
    });
  });

  it.each([
    [undefined, 100],
    ['100', 100],
    ['101', 101],
    ['1000', 1000],
    ['1500', 1000],
  ])('clamps candle limit %s to %s', async (limit, expectedLimit) => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: `asset-btc-limit-${limit ?? 'default'}`,
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: [],
    });

    const response = await service.getAssetCandles(
      'user-1',
      `asset-btc-limit-${limit ?? 'default'}`,
      limit === undefined ? {} : { limit },
    );

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: expectedLimit,
      }),
    );
    expect(response.data.source.requestedCount).toBe(expectedLimit);
    expect(response.data.candles.length).toBeLessThanOrEqual(expectedLimit);
  });

  it.each([
    ['1d', '5m', Date.parse('2026-06-18T03:00:00.000Z')],
    ['7d', '1h', Date.parse('2026-06-12T03:00:00.000Z')],
    ['30d', '1d', Date.parse('2026-05-20T03:00:00.000Z')],
    // Crypto trades 24/7: prev_open anchors to 09:00 KST calendar days back.
    ['prev_open', '5m', Date.parse('2026-06-18T00:00:00.000Z')],
    ['prev2_open', '30m', Date.parse('2026-06-17T00:00:00.000Z')],
    ['1y', '1d', Date.parse('2025-06-19T03:00:00.000Z')],
  ])(
    'uses %s range default interval %s for crypto candles',
    async (range, interval, startTime) => {
      const { prisma, binancePublicClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-btc-${range}`,
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
        }),
      );
      binancePublicClient.fetchKlines.mockResolvedValueOnce({
        receivedAt: new Date('2026-06-19T03:00:01.000Z'),
        response: [],
      });

      const response = await service.getAssetCandles(
        'user-1',
        `asset-btc-${range}`,
        { range, limit: '1000' },
      );

      expect(response.data.range).toBe(range);
      expect(response.data.interval).toBe(interval);
      expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        interval,
        limit: 1000,
        startTime,
        endTime: Date.parse('2026-06-19T03:00:00.000Z'),
      });
    },
  );

  it('uses current season start and 1d default interval for season range', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-season',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    prisma.season.findFirst.mockResolvedValueOnce({
      startAt: new Date('2026-06-01T00:00:00.000Z'),
      endAt: new Date('2026-06-30T00:00:00.000Z'),
    });
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: [],
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-btc-season',
      { range: 'season' },
    );

    expect(response.data.range).toBe('season');
    expect(response.data.interval).toBe('1d');
    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '1d',
      limit: 100,
      startTime: Date.parse('2026-06-01T00:00:00.000Z'),
      endTime: Date.parse('2026-06-19T03:00:00.000Z'),
    });
  });

  it('anchors domestic prev_open across a weekend to the previous trading day', async () => {
    // Monday 2026-06-22 12:00 KST → previous trading day open is Friday
    // 2026-06-19 09:00 KST (2026-06-19T00:00:00.000Z), not Sunday.
    jest.setSystemTime(new Date('2026-06-22T03:00:00.000Z'));

    const { prisma, kisAuthClient, kisQuoteClient, service } = createService();
    // The default cached token expires 2026-06-20; keep it valid for this now.
    kisAuthClient.getCachedToken.mockReturnValue({
      accessToken: 'cached-kis-token',
      tokenType: 'Bearer',
      expiresInSeconds: 86400,
      expiresAt: new Date('2026-06-23T00:00:00.000Z'),
    });
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-domestic-weekend',
        symbol: '005930',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
      state: 'available',
      receivedAt: new Date('2026-06-22T03:00:01.000Z'),
      response: {
        rt_cd: '0',
        output2: [
          domesticRow('20260619', '085900', '10'),
          domesticRow('20260619', '090000', '20'),
          domesticRow('20260622', '100000', '30'),
        ],
      },
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-domestic-weekend',
      { range: 'prev_open' },
    );

    const anchor = Date.parse('2026-06-19T00:00:00.000Z');
    expect(response.data.candles.length).toBeGreaterThan(0);
    for (const candle of response.data.candles) {
      expect(Date.parse(candle.time)).toBeGreaterThanOrEqual(anchor);
    }
  });

  it('keeps Binance startTime unchanged when the expected candle count fits the request limit', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-not-truncated',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: [],
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-btc-not-truncated',
      { range: 'prev_open', interval: '5m', limit: '600' },
    );

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '5m',
      limit: 600,
      startTime: Date.parse('2026-06-18T00:00:00.000Z'),
      endTime: Date.parse('2026-06-19T03:00:00.000Z'),
    });
    expect(response.data.source).toMatchObject({
      provider: 'binance',
      requestedCount: 600,
    });
    expect(response.data.source).not.toHaveProperty('truncated');
  });

  it('shifts truncated Binance startTime so the latest requestLimit candles are preserved', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-truncated',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-19T03:00:01.000Z'),
      response: [],
    });

    // 1y of 5m candles ≈ 105k rows — far beyond one 1000-row klines call.
    const response = await service.getAssetCandles(
      'user-1',
      'asset-btc-truncated',
      { range: '1y', interval: '5m', limit: '1500' },
    );

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '5m',
      limit: 1000,
      startTime: Date.parse('2026-06-15T15:40:00.000Z'),
      endTime: Date.parse('2026-06-19T03:00:00.000Z'),
    });
    expect(response.data.source).toMatchObject({
      provider: 'binance',
      requestedCount: 1000,
      truncated: true,
    });
  });

  it.each([
    ['BTC', 'BTCUSDT'],
    ['ETH', 'ETHUSDT'],
    ['BTCUSDT', 'BTCUSDT'],
    ['BTC/USD', 'BTCUSDT'],
    ['BTC-USD', 'BTCUSDT'],
    ['BTC_USD', 'BTCUSDT'],
  ])('normalizes crypto symbol %s to %s', async (symbol, expectedSymbol) => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: `asset-${symbol}`,
        symbol,
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-21T04:10:01.000Z'),
      response: [],
    });

    await service.getAssetCandles('user-1', `asset-${symbol}`, {
      interval: '15m',
    });

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: expectedSymbol,
        interval: '15m',
        limit: 100,
      }),
    );
  });

  it.each(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])(
    'allows canonical crypto interval %s',
    async (interval) => {
      const { prisma, binancePublicClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-btc-${interval}`,
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
        }),
      );
      binancePublicClient.fetchKlines.mockResolvedValueOnce({
        receivedAt: new Date('2026-06-21T04:10:01.000Z'),
        response: [],
      });

      await service.getAssetCandles('user-1', `asset-btc-${interval}`, {
        interval,
      });

      expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith(
        expect.objectContaining({ interval }),
      );
    },
  );

  it.each(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])(
    'allows canonical stock interval %s',
    async (interval) => {
      const { prisma, kisQuoteClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-aapl-${interval}`,
          symbol: 'AAPL',
          market: 'NAS',
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
        }),
      );
      kisQuoteClient.getMarketDataByExplicitPath.mockResolvedValueOnce({
        state: 'available',
        receivedAt: new Date('2026-06-19T13:30:01.000Z'),
        response: {
          rt_cd: '0',
          output2: [],
        },
      });

      const response = await service.getAssetCandles(
        'user-1',
        `asset-aapl-${interval}`,
        {
          interval,
        },
      );

      expect(response.data.interval).toBe(interval);
      expect(kisQuoteClient.getMarketDataByExplicitPath).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.objectContaining({
            NMIN:
              interval === '1h' ||
              interval === '4h' ||
              interval === '1d' ||
              interval === '1w'
                ? '30'
                : String(Number.parseInt(interval, 10)),
          }) as unknown,
        }),
      );
    },
  );

  it.each(['3m', '2m', '10m', '1M'])(
    'rejects unsupported candle interval %s',
    async (interval) => {
      const { prisma, kisQuoteClient, binancePublicClient, service } =
        createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-btc-${interval}`,
          symbol: 'BTC',
          market: 'BINANCE',
          assetType: AssetType.crypto,
          currencyCode: CurrencyCode.USD,
        }),
      );

      await expectApiError(
        service.getAssetCandles('user-1', `asset-btc-${interval}`, {
          interval,
        }),
        400,
        'ASSET_CANDLES_INVALID_INTERVAL',
      );
      expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
      expect(binancePublicClient.fetchKlines).not.toHaveBeenCalled();
    },
  );

  it('includes 1m in the unsupported interval validation message', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-invalid-interval-message',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );

    const response = await expectApiError(
      service.getAssetCandles('user-1', 'asset-btc-invalid-interval-message', {
        interval: '3m',
      }),
      400,
      'ASSET_CANDLES_INVALID_INTERVAL',
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        message: 'interval must be one of 1m, 5m, 15m, 30m, 1h, 4h, 1d, or 1w.',
      },
    });
  });

  it('rejects unsupported candle range before calling providers', async () => {
    const { prisma, kisQuoteClient, binancePublicClient, service } =
      createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-invalid-range',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );

    await expectApiError(
      service.getAssetCandles('user-1', 'asset-btc-invalid-range', {
        range: '90d',
      }),
      400,
      'ASSET_CANDLES_INVALID_RANGE',
    );
    expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    expect(binancePublicClient.fetchKlines).not.toHaveBeenCalled();
  });

  it.each(['2m', '3m', '10m'])(
    'rejects unsupported stock interval %s before calling KIS',
    async (interval) => {
      const { prisma, kisQuoteClient, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({
          id: `asset-aapl-${interval}`,
          symbol: 'AAPL',
          market: 'NAS',
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
        }),
      );

      await expectApiError(
        service.getAssetCandles('user-1', `asset-aapl-${interval}`, {
          interval,
        }),
        400,
        'ASSET_CANDLES_INVALID_INTERVAL',
      );
      expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
    },
  );

  it('returns empty state for empty Binance rows', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-empty',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-21T04:10:01.000Z'),
      response: [],
    });

    const response = await service.getAssetCandles(
      'user-1',
      'asset-btc-empty',
      { interval: '1h' },
    );

    expect(response.data).toMatchObject({
      state: 'empty',
      candles: [],
      source: {
        provider: 'binance',
        endpoint: '/api/v3/klines',
        symbol: 'BTCUSDT',
        interval: '1h',
        requestedCount: 100,
        returnedCount: 0,
      },
    });
    expectNoWrites(prisma);
  });

  it.each([
    ['non-array response', { bad: true }],
    ['malformed row', [[Date.parse('2026-06-21T04:00:00.000Z'), '65000']]],
  ])('rejects Binance %s as malformed', async (_caseName, response) => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-malformed',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockResolvedValueOnce({
      receivedAt: new Date('2026-06-21T04:10:01.000Z'),
      response,
    });

    await expectApiError(
      service.getAssetCandles('user-1', 'asset-btc-malformed', {
        interval: '5m',
      }),
      502,
      'ASSET_CANDLES_PROVIDER_MALFORMED_RESPONSE',
    );
  });

  it('sanitizes Binance provider failures', async () => {
    const { prisma, binancePublicClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc-provider-error',
        symbol: 'BTC',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    binancePublicClient.fetchKlines.mockRejectedValueOnce(
      new ProviderHttpError(
        'binance',
        'PROVIDER_HTTP_ERROR',
        'raw payload access_token secret',
      ),
    );

    try {
      await service.getAssetCandles('user-1', 'asset-btc-provider-error', {
        interval: '5m',
      });
      throw new Error('Expected promise to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse();

      expect(response).toMatchObject({
        success: false,
        error: {
          code: 'ASSET_CANDLES_PROVIDER_ERROR',
          message: 'Binance candle provider is unavailable.',
        },
      });
      expect(JSON.stringify(response)).not.toContain('access_token');
      expect(JSON.stringify(response)).not.toContain('raw payload');
    }
  });

  it('rejects invalid query values before calling KIS', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValue(
      asset({
        id: 'asset-aapl',
        symbol: 'AAPL',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    );

    await expectApiError(
      service.getAssetCandles('user-1', 'asset-aapl', {
        interval: '4m',
      }),
      400,
      'ASSET_CANDLES_INVALID_INTERVAL',
    );
    await expectApiError(
      service.getAssetCandles('user-1', 'asset-aapl', {
        limit: '0',
      }),
      400,
      'INVALID_CANDLE_LIMIT',
    );
    await expectApiError(
      service.getAssetCandles('user-1', 'asset-aapl', {
        date: '2026-02-31',
      }),
      400,
      'INVALID_CANDLE_DATE',
    );
    await expectApiError(
      service.getAssetCandles('user-1', 'asset-aapl', {
        to: '250000',
      }),
      400,
      'INVALID_CANDLE_TO',
    );
    expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
  });

  it('sanitizes provider failures instead of exposing KIS payload details', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-aapl',
        symbol: 'AAPL',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    );
    kisQuoteClient.getMarketDataByExplicitPath.mockRejectedValueOnce(
      new ProviderHttpError(
        'kis',
        'PROVIDER_HTTP_ERROR',
        'raw payload access_token secret',
      ),
    );

    try {
      await service.getAssetCandles('user-1', 'asset-aapl');
      throw new Error('Expected promise to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse();

      expect(response).toMatchObject({
        success: false,
        error: {
          code: 'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
          message: 'KIS candle provider is unavailable.',
        },
      });
      expect(JSON.stringify(response)).not.toContain('access_token');
      expect(JSON.stringify(response)).not.toContain('raw payload');
    }
  });
});
