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
    const service = new AssetCandlesService(
      prisma as never,
      kisAuthClient as never,
      kisQuoteClient as never,
      binancePublicClient as never,
    );

    return {
      prisma,
      kisAuthClient,
      kisQuoteClient,
      binancePublicClient,
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
      interval: '5m',
      limit: '1500',
      date: '2026-06-21',
      to: '2026-06-21T04:30:00.000Z',
    });

    expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '5m',
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
        interval: '5m',
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
          interval: '5m',
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
    });
  });

  it.each([
    ['1d', '5m', Date.parse('2026-06-18T03:00:00.000Z')],
    ['7d', '1h', Date.parse('2026-06-12T03:00:00.000Z')],
    ['30d', '1d', Date.parse('2026-05-20T03:00:00.000Z')],
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
        { range },
      );

      expect(response.data.range).toBe(range);
      expect(response.data.interval).toBe(interval);
      expect(binancePublicClient.fetchKlines).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        interval,
        limit: 100,
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

  it.each(['5m', '15m', '30m', '1h', '4h', '1d', '1w'])(
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

  it.each(['5m', '15m', '30m', '1h', '4h', '1d', '1w'])(
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
          }),
        }),
      );
    },
  );

  it.each(['1m', '3m', '2m', '10m', '1M'])(
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

  it.each(['1m', '2m', '3m', '10m'])(
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
