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

  const createService = () => {
    const prisma = createPrisma();
    const kisAuthClient = createKisAuthClient();
    const kisQuoteClient = createKisQuoteClient();
    const service = new AssetCandlesService(
      prisma as never,
      kisAuthClient as never,
      kisQuoteClient as never,
    );

    return { prisma, kisAuthClient, kisQuoteClient, service };
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
    }
  };

  const expectNoWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.asset,
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
    const calls = kisQuoteClient.getMarketDataByExplicitPath.mock
      .calls as unknown as Array<[KisQuoteCall]>;
    const call = calls[0]?.[0];

    if (!call) {
      throw new Error('Expected KIS quote client to be called.');
    }

    return call;
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
    });
    expect(kisCall.headers).toMatchObject({
      tr_id: 'FHKST03010230',
    });
  });

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
      market: 'KRX',
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

  it('returns crypto as explicitly unsupported without calling KIS', async () => {
    const { prisma, kisQuoteClient, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );

    await expectApiError(
      service.getAssetCandles('user-1', 'asset-btc'),
      400,
      'ASSET_CANDLES_UNSUPPORTED_ASSET_TYPE',
    );
    expect(kisQuoteClient.getMarketDataByExplicitPath).not.toHaveBeenCalled();
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
      'INVALID_CANDLE_INTERVAL',
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
