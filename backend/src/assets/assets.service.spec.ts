jest.mock('../generated/prisma/client', () => {
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
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { AssetsService } from './assets.service';

describe('AssetsService', () => {
  const priceAt = new Date('2026-05-07T00:00:00.000Z');
  const activeSeason = {
    id: 'season-1',
    status: SeasonStatus.active,
    startAt: new Date(Date.now() - 86_400_000),
    endAt: new Date(Date.now() + 86_400_000),
  };

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
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    season: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      ...createWritableModel(),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      ...createWritableModel(),
    },
    cashWallet: {
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
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
    },
    fxExecuteRequest: {
      create: jest.fn(),
      update: jest.fn(),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new AssetsService(prisma as never);

    return { prisma, service };
  };

  const mockTradableSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'sp-1',
    });
  };

  const asset = (input: {
    id: string;
    symbol?: string;
    name?: string;
    market?: string;
    assetType?: AssetType;
    currencyCode?: CurrencyCode;
    isActive?: boolean;
  }) => {
    const currencyCode = input.currencyCode ?? CurrencyCode.KRW;
    const assetType = input.assetType ?? AssetType.domestic_stock;

    return {
      id: input.id,
      symbol: input.symbol ?? input.id.toUpperCase(),
      name: input.name ?? `Asset ${input.id}`,
      market:
        input.market ??
        (assetType === AssetType.crypto
          ? 'BINANCE'
          : currencyCode === CurrencyCode.USD
            ? 'NASDAQ'
            : 'KRX'),
      assetType,
      currencyCode,
      priceCurrency: currencyCode,
      settlementCurrency: currencyCode,
      isActive: input.isActive ?? true,
    };
  };

  const priceSnapshot = (
    id: string,
    price: string,
    currencyCode = CurrencyCode.KRW,
  ) => ({
    id,
    price: new Prisma.Decimal(price),
    priceKrw: null,
    currencyCode,
    sourceType: AssetPriceSourceType.admin_manual,
    sourceName: 'manual-price',
    effectiveAt: priceAt,
    capturedAt: new Date('2026-05-07T00:00:10.000Z'),
  });

  const providerPriceSnapshot = (
    id: string,
    sourceName: string,
    price: string,
    currencyCode = CurrencyCode.KRW,
    capturedAt = new Date(Date.now() - 1_000),
  ) => ({
    id,
    price: new Prisma.Decimal(price),
    currencyCode,
    sourceType: AssetPriceSourceType.provider_api,
    sourceName,
    effectiveAt: priceAt,
    capturedAt,
  });

  const freshUsdKrwSnapshot = () => ({
    id: 'fx-admin-1',
    rate: new Prisma.Decimal('1400.00000000'),
    sourceType: FxRateSourceType.admin_manual,
    sourceName: 'manual-fx',
    effectiveAt: new Date(Date.now() - 1_000),
    capturedAt: new Date(Date.now() - 1_000),
    approvedByUserId: 'operator-1',
  });

  const staleUsdKrwSnapshot = () => ({
    ...freshUsdKrwSnapshot(),
    effectiveAt: new Date(Date.now() - 61_000),
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

  const expectNoAssetWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.asset,
      prisma.season,
      prisma.seasonParticipant,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.cashWallet,
      prisma.order,
      prisma.position,
      prisma.dailyPortfolioSnapshot,
      prisma.seasonRanking,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.updateMany).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
      expect(model.deleteMany).not.toHaveBeenCalled();
    }

    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expectApiError(service.getAssets(undefined), 401, 'UNAUTHORIZED');
  });

  it('returns available empty assets when no assets match', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    const response = await service.getAssets('user-1');

    expect(response).toMatchObject({
      success: true,
      data: {
        state: 'available',
        filters: {
          assetType: null,
          currencyCode: null,
          market: null,
          search: null,
          includeInactive: false,
          withPrice: true,
        },
        pagination: {
          limit: 50,
          offset: 0,
          total: 0,
          returned: 0,
          nextOffset: null,
        },
        assets: [],
        priceErrors: [],
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoAssetWrites(prisma);
  });

  it('applies assetType filter', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    await service.getAssets('user-1', {
      assetType: AssetType.crypto,
    });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isActive: true,
          assetType: AssetType.crypto,
        }),
      }),
    );
    expectNoAssetWrites(prisma);
  });

  it('applies currencyCode filter', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    await service.getAssets('user-1', {
      currencyCode: CurrencyCode.USD,
    });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currencyCode: CurrencyCode.USD,
        }),
      }),
    );
    expectNoAssetWrites(prisma);
  });

  it('applies market filter', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    await service.getAssets('user-1', {
      market: 'NASDAQ',
    });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          market: 'NASDAQ',
        }),
      }),
    );
    expectNoAssetWrites(prisma);
  });

  it('applies search filter to symbol or name', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    await service.getAssets('user-1', {
      search: 'sam',
    });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            {
              symbol: {
                contains: 'sam',
                mode: 'insensitive',
              },
            },
            {
              name: {
                contains: 'sam',
                mode: 'insensitive',
              },
            },
          ],
        }),
      }),
    );
    expectNoAssetWrites(prisma);
  });

  it('rejects invalid assetType with BAD_REQUEST', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        assetType: 'forex',
      }),
      400,
      'INVALID_ASSET_TYPE',
    );
  });

  it('rejects invalid currencyCode with BAD_REQUEST', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        currencyCode: 'USDT',
      }),
      400,
      'INVALID_CURRENCY_CODE',
    );
  });

  it('rejects invalid includeInactive with BAD_REQUEST', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        includeInactive: 'yes',
      }),
      400,
      'INVALID_INCLUDE_INACTIVE',
    );
  });

  it('rejects invalid withPrice with BAD_REQUEST', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        withPrice: '1',
      }),
      400,
      'INVALID_WITH_PRICE',
    );
  });

  it.each([
    ['0', 'INVALID_LIMIT'],
    ['-1', 'INVALID_LIMIT'],
    ['abc', 'INVALID_LIMIT'],
  ])('rejects invalid limit=%s with BAD_REQUEST', async (limit, code) => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        limit,
      }),
      400,
      code,
    );
  });

  it.each([
    ['-1', 'INVALID_OFFSET'],
    ['abc', 'INVALID_OFFSET'],
  ])('rejects invalid offset=%s with BAD_REQUEST', async (offset, code) => {
    const { service } = createService();

    await expectApiError(
      service.getAssets('user-1', {
        offset,
      }),
      400,
      code,
    );
  });

  it('clamps limit greater than 100 to 100', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(0);
    prisma.asset.findMany.mockResolvedValueOnce([]);

    const response = await service.getAssets('user-1', {
      limit: '500',
    });

    expect(prisma.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
    expect(response.data.pagination.limit).toBe(100);
    expectNoAssetWrites(prisma);
  });

  it('returns KRW asset admin_manual price and priceKrw', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-krw', '70000.00000000'),
    );

    const response = await service.getAssets('user-1');

    expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assetId: 'asset-krw',
          currencyCode: CurrencyCode.KRW,
          sourceType: 'admin_manual',
        }),
      }),
    );
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(response.data.assets[0]).toMatchObject({
      assetId: 'asset-krw',
      symbol: '005930',
      price: {
        state: 'available',
        currentPrice: '70000.00000000',
        priceCurrency: CurrencyCode.KRW,
        priceKrwState: 'available',
        priceKrw: '70000.00000000',
        assetPriceSnapshotId: 'price-krw',
      },
    });
    expect(response.data.priceErrors).toEqual([]);
    expectNoAssetWrites(prisma);
  });

  it('adds trading UX fields to asset list items without removing existing fields', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    mockTradableSeason(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-btc', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0]).toMatchObject({
      assetId: 'asset-btc',
      id: 'asset-btc',
      settlementCurrency: CurrencyCode.USD,
      changeRate: null,
      marketStatus: 'always_open',
      tradable: true,
      tradeBlockedReason: null,
      price: {
        state: 'available',
        currentPrice: '100.00000000',
      },
    });
    expectNoAssetWrites(prisma);
  });

  it('marks assets without a price as not tradable with a safe reason', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-missing-price',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    mockTradableSeason(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0]).toMatchObject({
      assetId: 'asset-missing-price',
      id: 'asset-missing-price',
      tradable: false,
      tradeBlockedReason: 'PRICE_UNAVAILABLE',
      price: {
        state: 'unavailable',
        reason: 'ASSET_PRICE_UNAVAILABLE',
      },
    });
    expectNoAssetWrites(prisma);
  });

  it('marks stale USD conversion evidence as not tradable with PRICE_STALE', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-stale-fx',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    mockTradableSeason(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      staleUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-stale-fx', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0]).toMatchObject({
      assetId: 'asset-stale-fx',
      marketStatus: 'always_open',
      tradable: false,
      tradeBlockedReason: 'PRICE_STALE',
      price: {
        state: 'available',
        priceKrwState: 'unavailable',
        priceKrwReason: 'FX_RATE_STALE',
      },
    });
    expectNoAssetWrites(prisma);
  });

  it.each([
    {
      label: 'domestic KRX',
      sourceName: 'kis_krx_realtime_trade',
      fixture: asset({
        id: 'asset-krx',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
      priceCurrency: CurrencyCode.KRW,
    },
    {
      label: 'US NAS',
      sourceName: 'kis_us_delayed_trade',
      fixture: asset({
        id: 'asset-us',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
      priceCurrency: CurrencyCode.USD,
    },
    {
      label: 'crypto BINANCE',
      sourceName: 'binance_public_rest_24hr_ticker',
      fixture: asset({
        id: 'asset-btc',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
      priceCurrency: CurrencyCode.USD,
    },
  ])('uses fresh provider_api price first for $label assets', async (input) => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([input.fixture]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      providerPriceSnapshot(
        'provider-price-1',
        input.sourceName,
        '123.00000000',
        input.priceCurrency,
      ),
    ]);
    if (input.priceCurrency === CurrencyCode.USD) {
      prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([]);
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
        freshUsdKrwSnapshot(),
      );
    }

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      currentPrice: '123.00000000',
      assetPriceSnapshotId: 'provider-price-1',
      priceSource: {
        sourceType: 'provider_api',
        sourceName: input.sourceName,
        snapshotId: 'provider-price-1',
        fallbackUsed: false,
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoAssetWrites(prisma);
  });

  it('falls back to admin_manual asset price when provider_api price is stale', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-krx',
        market: 'KRX',
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
      }),
    ]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      providerPriceSnapshot(
        'provider-price-stale',
        'kis_krx_realtime_trade',
        '999.00000000',
        CurrencyCode.KRW,
        new Date(Date.now() - 61_000),
      ),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('admin-price-1', '70000.00000000'),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      currentPrice: '70000.00000000',
      assetPriceSnapshotId: 'admin-price-1',
      priceSource: {
        sourceType: 'admin_manual',
        sourceName: 'manual-price',
        snapshotId: 'admin-price-1',
        fallbackUsed: true,
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
      },
    });
    expectNoAssetWrites(prisma);
  });

  it('returns USD asset priceKrw using fresh approved admin_manual USD/KRW', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-usd',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      currentPrice: '100.00000000',
      priceCurrency: CurrencyCode.USD,
      priceKrwState: 'available',
      priceKrw: '140000.00000000',
    });
    expect(response.data.priceErrors).toEqual([]);
    expectNoAssetWrites(prisma);
  });

  it('uses fresh provider_api USD/KRW for USD asset KRW conversion', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-usd',
        market: 'NAS',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-1',
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date('2026-05-07T00:00:00.000Z'),
        capturedAt: new Date(Date.now() - 1_000),
      },
    ]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      priceKrwState: 'available',
      priceKrw: '150000.00000000',
      fxRateSource: {
        sourceType: 'provider_api',
        sourceName: 'exchange_rate_api',
        snapshotId: 'provider-fx-1',
        fallbackUsed: false,
      },
    });
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoAssetWrites(prisma);
  });

  it('marks USD asset priceKrw unavailable when USD/KRW is missing', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-usd',
        symbol: 'AAPL',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(null);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      priceKrwState: 'unavailable',
      priceKrwReason: 'FX_RATE_UNAVAILABLE',
      fxRateSource: {
        sourceType: null,
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
      },
    });
    expect(response.data.assets[0].price).not.toHaveProperty('priceKrw');
    expect(response.data.priceErrors).toEqual([
      {
        assetId: 'asset-usd',
        code: 'FX_RATE_UNAVAILABLE',
        message: 'USD/KRW FX rate snapshot is unavailable.',
      },
    ]);
    expectNoAssetWrites(prisma);
  });

  it('marks USD asset priceKrw unavailable when USD/KRW is stale', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-usd',
        symbol: 'AAPL',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      staleUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'available',
      priceKrwState: 'unavailable',
      priceKrwReason: 'FX_RATE_STALE',
    });
    expect(response.data.priceErrors[0]).toMatchObject({
      assetId: 'asset-usd',
      code: 'FX_RATE_STALE',
      message: 'USD/KRW FX rate snapshot is stale.',
    });
    expectNoAssetWrites(prisma);
  });

  it('marks asset price unavailable when asset price is missing', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-missing',
        symbol: 'MISS',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);

    const response = await service.getAssets('user-1');

    expect(response.data.assets[0].price).toMatchObject({
      state: 'unavailable',
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });
    expect(response.data.priceErrors).toEqual([
      {
        assetId: 'asset-missing',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable for asset asset-missing.',
      },
    ]);
    expectNoAssetWrites(prisma);
  });

  it('keeps other assets available when one asset price is unavailable', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(2);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-valued',
        symbol: 'VALUED',
      }),
      asset({
        id: 'asset-missing',
        symbol: 'MISSING',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst
      .mockResolvedValueOnce(priceSnapshot('price-valued', '100.00000000'))
      .mockResolvedValueOnce(null);

    const response = await service.getAssets('user-1');

    expect(response.data.assets).toMatchObject([
      {
        assetId: 'asset-valued',
        price: {
          state: 'available',
          priceKrw: '100.00000000',
        },
      },
      {
        assetId: 'asset-missing',
        price: {
          state: 'unavailable',
          reason: 'ASSET_PRICE_UNAVAILABLE',
        },
      },
    ]);
    expect(response.data.priceErrors).toEqual([
      {
        assetId: 'asset-missing',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable for asset asset-missing.',
      },
    ]);
    expectNoAssetWrites(prisma);
  });

  it('returns asset metadata only when withPrice=false', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-krw',
        symbol: '005930',
      }),
    ]);

    const response = await service.getAssets('user-1', {
      withPrice: 'false',
    });

    expect(response.data.assets[0]).toMatchObject({
      assetId: 'asset-krw',
      symbol: '005930',
    });
    expect(response.data.assets[0]).not.toHaveProperty('price');
    expect(response.data.priceErrors).toEqual([]);
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoAssetWrites(prisma);
  });

  it('returns NOT_FOUND when detail asset does not exist', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(null);

    await expectApiError(
      service.getAsset('user-1', 'asset-missing'),
      404,
      'ASSET_NOT_FOUND',
    );
    expectNoAssetWrites(prisma);
  });

  it('returns detail asset metadata, price state, and trading note', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    mockTradableSeason(prisma);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-btc', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAsset('user-1', 'asset-btc');

    expect(response.data).toMatchObject({
      state: 'available',
      asset: {
        assetId: 'asset-btc',
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
        changeRate: null,
        marketStatus: 'always_open',
        tradable: true,
        tradeBlockedReason: null,
        price: {
          state: 'available',
          currentPrice: '100.00000000',
          priceKrw: '140000.00000000',
        },
        tradingNote: {
          walletCurrency: CurrencyCode.USD,
          settlementCurrency: CurrencyCode.USD,
        },
      },
      priceErrors: [],
    });
    expect(response.data.asset.tradingNote.message).toContain(
      'Crypto is USD-settled',
    );
    expectNoAssetWrites(prisma);
  });

  it('returns detail trading UX fields for not joined users', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-btc',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-btc', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getAsset('user-1', 'asset-btc');

    expect(response.data.asset).toMatchObject({
      assetId: 'asset-btc',
      id: 'asset-btc',
      marketStatus: 'always_open',
      tradable: false,
      tradeBlockedReason: 'SEASON_NOT_JOINED',
      price: {
        state: 'available',
      },
      tradingNote: {
        settlementCurrency: CurrencyCode.USD,
      },
    });
    expectNoAssetWrites(prisma);
  });

  it('returns single asset price for polling fallback without raw payload', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-krw', '70000.00000000', CurrencyCode.KRW),
    );

    const response = await service.getAssetPrice('user-1', 'asset-krw');

    expect(response.data).toMatchObject({
      state: 'available',
      assetId: 'asset-krw',
      symbol: '005930',
      currentPrice: '70000.00000000',
      priceCurrency: CurrencyCode.KRW,
      priceKrwState: 'available',
      priceKrw: '70000.00000000',
      changeRate: null,
      assetPriceSnapshotId: 'price-krw',
      priceSource: {
        sourceName: 'manual-price',
      },
    });
    expect(response.data.freshnessAgeSeconds).toEqual(expect.any(Number));
    expect(
      prisma.assetPriceSnapshot.findFirst.mock.calls[0][0].select,
    ).not.toHaveProperty('rawPayloadJson');
    expect(JSON.stringify(response.data)).not.toContain('rawPayloadJson');
    expectNoAssetWrites(prisma);
  });

  it('returns unavailable single asset price when no snapshot exists', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
      }),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);

    const response = await service.getAssetPrice('user-1', 'asset-krw');

    expect(response.data).toMatchObject({
      state: 'unavailable',
      assetId: 'asset-krw',
      currentPrice: null,
      priceKrwState: 'unavailable',
      reason: 'ASSET_PRICE_UNAVAILABLE',
    });
    expectNoAssetWrites(prisma);
  });

  it('rejects single asset price without authenticated user', async () => {
    const { service } = createService();

    await expectApiError(
      service.getAssetPrice(undefined, 'asset-krw'),
      401,
      'UNAUTHORIZED',
    );
  });

  it('does not perform write mutations while reading assets with prices', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-usd',
        symbol: 'AAPL',
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    await service.getAssets('user-1');

    expectNoAssetWrites(prisma);
  });
});
