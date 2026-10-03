jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
  type AssetPriceSnapshot,
} from '../generated/prisma/client';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from '../orders/market-calendar/market-session-override.store';
import { AssetsService } from './assets.service';
import {
  adminDiagnosticRequestMiddleware,
  setAdminDiagnosticContext,
} from '../common/admin-diagnostics';
import { AssetTickerGateway } from '../realtime/asset-ticker.gateway';
import { KIS_DOMESTIC_PERIOD_SOURCE } from '../providers/kis/candles/kis-period-candle.types';
import { BINANCE_CANDLE_SOURCE } from '../providers/binance/binance-candle.types';
import { DailyChangeRateService } from './daily-change-rate.service';
import { MarketCandlesRepository } from './market-candles.repository';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BinanceWebSocketIngestionService } from '../providers/binance/binance-websocket.ingestion.service';
import { parseBinanceWebSocketMessage } from '../providers/binance/binance-websocket.parser';
import type { ProviderConfigService } from '../providers/provider-config.service';
import { buildProviderRawPayloadJson } from '../providers/provider-raw-payload';

describe('AssetsService', () => {
  const priceAt = new Date('2026-05-07T00:00:00.000Z');
  const testNow = new Date('2026-07-20T03:00:00.000Z');
  // Anchored to the fixed testNow — NEVER to the real Date.now(): this
  // fixture is built at module load, before the fake timers in beforeEach
  // pin the clock, so real-time anchoring would make the season active only
  // on the day the suite happens to run.
  const activeSeason = {
    id: 'season-1',
    status: SeasonStatus.active,
    startAt: new Date(testNow.getTime() - 86_400_000),
    endAt: new Date(testNow.getTime() + 86_400_000),
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
    marketCandle: { findMany: jest.fn().mockResolvedValue([]) },
    asset: {
      count: jest.fn(),
      findFirst: jest.fn(),
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

  const createService = (binanceSymbolMetadata?: {
    getDisplayPriceDecimals: jest.Mock;
  }, redis?: { get: jest.Mock; eval: jest.Mock }) => {
    const prisma = createPrisma();
    const service = new AssetsService(
      prisma as never,
      binanceSymbolMetadata as never,
      new DailyChangeRateService(new MarketCandlesRepository(prisma as never)),
      redis as never,
    );

    return { prisma, service, binanceSymbolMetadata };
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
    effectiveAt: capturedAt,
    capturedAt,
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(testNow);
  });

  afterEach(() => {
    jest.useRealTimers();
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

  const freshUsdKrwProviderSnapshots = () =>
    ['korea_exim_exchange_rate', 'exchange_rate_api'].map(
      (sourceName, index) => ({
        id: `fx-provider-${index + 1}`,
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        rate: new Prisma.Decimal('1400.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName,
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 1_000),
        approvedByUserId: null,
      }),
    );

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
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
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

  // Typed wrapper so nested matcher values are not `any` assignments.
  const containing = (
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    expect.objectContaining(value) as Record<string, unknown>;

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expectApiError(service.getAssets(undefined), 401, 'UNAUTHORIZED');
  });

  it('exposes provider display decimals on list, detail and ticker payloads', async () => {
    const getDisplayPriceDecimals = jest.fn().mockReturnValue(5);
    const { prisma, service } = createService({ getDisplayPriceDecimals });
    const dogeAsset = asset({
      id: 'asset-doge',
      symbol: 'DOGEUSDT',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
    });
    prisma.asset.count.mockResolvedValue(1);
    prisma.asset.findMany.mockResolvedValue([dogeAsset]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
    prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);
    prisma.asset.findUnique.mockResolvedValue(dogeAsset);
    prisma.asset.findFirst.mockResolvedValue(dogeAsset);

    const list = await service.getAssets('user-1');
    const detail = await service.getAsset('user-1', 'asset-doge');
    const ticker = await service.getAssetPriceForTicker('asset-doge');

    expect(getDisplayPriceDecimals).toHaveBeenCalledWith({
      market: 'BINANCE',
      symbol: 'DOGEUSDT',
    });
    // Same value on every surface the client can read it from.
    expect(list.data.assets[0].displayPriceDecimals).toBe(5);
    expect(detail.data.asset.displayPriceDecimals).toBe(5);
    expect(ticker?.asset.displayPriceDecimals).toBe(5);
  });

  it('caches the realtime USD/KRW selection for a short TTL (one FX read per burst)', async () => {
    const { prisma, service } = createService();
    prisma.fxRateSnapshot.findMany.mockResolvedValue(
      freshUsdKrwProviderSnapshots(),
    );

    const first = await service.convertRealtimePriceToKrw({
      priceLocal: '2.00000000',
      priceCurrency: CurrencyCode.USD,
    });
    const second = await service.convertRealtimePriceToKrw({
      priceLocal: '3.00000000',
      priceCurrency: CurrencyCode.USD,
    });

    expect(first).toMatchObject({
      state: 'available',
      priceKrw: '2800.00000000',
    });
    // Same cached rate, new local price — no second FX read.
    expect(second).toMatchObject({
      state: 'available',
      priceKrw: '4200.00000000',
    });
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();

    // TTL expiry → exactly one more read.
    jest.setSystemTime(new Date(testNow.getTime() + 2_500));
    await service.convertRealtimePriceToKrw({
      priceLocal: '2.00000000',
      priceCurrency: CurrencyCode.USD,
    });
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(2);
  });

  it('caches an unavailable realtime FX selection too (no per-event retry storm)', async () => {
    const { prisma, service } = createService();
    prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);

    const first = await service.convertRealtimePriceToKrw({
      priceLocal: '2.00000000',
      priceCurrency: CurrencyCode.USD,
    });
    const second = await service.convertRealtimePriceToKrw({
      priceLocal: '2.00000000',
      priceCurrency: CurrencyCode.USD,
    });

    expect(first.state).toBe('unavailable');
    expect(second.state).toBe('unavailable');
    // One selection cycle performs the bounded first page plus one query for
    // each missing configured provider. The cached second call performs none.
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(3);
  });

  it('converts KRW-priced realtime prices without touching FX at all', async () => {
    const { prisma, service } = createService();

    const conversion = await service.convertRealtimePriceToKrw({
      priceLocal: '70123.00000000',
      priceCurrency: CurrencyCode.KRW,
    });

    expect(conversion).toMatchObject({
      state: 'available',
      priceKrw: '70123.00000000',
    });
    expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('keeps displayPriceDecimals null when no provider precision is wired', async () => {
    const { prisma, service } = createService();
    prisma.asset.count.mockResolvedValue(1);
    prisma.asset.findMany.mockResolvedValue([asset({ id: 'asset-krx' })]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);

    const list = await service.getAssets('user-1');

    expect(list.data.assets[0].displayPriceDecimals).toBeNull();
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
        where: containing({
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
        where: containing({
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
        where: containing({
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
        where: containing({
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
        where: containing({
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

  it.each([
    // Season boundaries are half-open [startAt, endAt) around the pinned
    // testNow; none of these depend on the real run date or host timezone.
    ['starts exactly now', 0, 86_400_000],
    ['starts one second from now', 1_000, 86_400_000],
    ['ended one second ago', -86_400_000, -1_000],
    ['ends exactly now', -86_400_000, 0],
  ] as const)(
    'asset tradability is independent of season boundary: %s',
    async (_label, startOffsetMs, endOffsetMs) => {
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
      prisma.season.findFirst.mockResolvedValueOnce({
        ...activeSeason,
        startAt: new Date(testNow.getTime() + startOffsetMs),
        endAt: new Date(testNow.getTime() + endOffsetMs),
      });
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce({ id: 'sp-1' });
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
        freshUsdKrwSnapshot(),
      );
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        priceSnapshot('price-btc', '100.00000000', CurrencyCode.USD),
      );

      const response = await service.getAssets('user-1');

      expect(response.data.assets[0]).toMatchObject({
        tradable: true,
        tradeBlockedReason: null,
      });
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    },
  );

  it('keeps trading UX stable when the host timezone differs from Seoul', async () => {
    // The service must derive market decisions from the pinned
    // instant, not the host timezone. TZ changes only affect local
    // formatting; this guards against accidental local-time arithmetic.
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const { prisma, service } = createService();
      prisma.asset.count.mockResolvedValueOnce(1);
      prisma.asset.findMany.mockResolvedValueOnce([
        asset({ id: 'asset-krx', assetType: AssetType.domestic_stock }),
      ]);
      mockTradableSeason(prisma);
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
        freshUsdKrwSnapshot(),
      );
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        priceSnapshot('price-krx', '71500.00000000'),
      );

      const response = await service.getAssets('user-1');

      // testNow = 2026-07-20 12:00 KST (a regular Monday KRX session):
      // still open regardless of the host timezone.
      expect(response.data.assets[0]).toMatchObject({
        marketStatus: 'open',
        tradable: true,
        tradeBlockedReason: null,
      });
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it('shows closed + MARKET_CLOSED with a carry-forward price on an override-closed day', async () => {
    // testNow (2026-07-20 12:00 KST, Monday) is a regular open KRX session;
    // an active operator CLOSED override flips it to a confirmed closure
    // while the last snapshot price stays displayable.
    applyMarketSessionOverrideSnapshot(
      [
        {
          market: 'KRX',
          localDate: '2026-07-20',
          overrideType: 'closed',
          openTime: null,
          closeTime: null,
          reason: 'emergency closure',
        },
      ],
      new Date(),
    );
    try {
      const { prisma, service } = createService();
      prisma.asset.count.mockResolvedValueOnce(1);
      prisma.asset.findMany.mockResolvedValueOnce([
        asset({ id: 'asset-krx', assetType: AssetType.domestic_stock }),
      ]);
      mockTradableSeason(prisma);
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
        freshUsdKrwSnapshot(),
      );
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        priceSnapshot('price-krx', '71500.00000000'),
      );

      const response = await service.getAssets('user-1');

      expect(response.data.assets[0]).toMatchObject({
        id: 'asset-krx',
        marketStatus: 'closed',
        tradable: false,
        tradeBlockedReason: 'MARKET_CLOSED',
        price: {
          state: 'available',
          currentPrice: '71500.00000000',
        },
      });
    } finally {
      resetMarketSessionOverrideStoreForTest();
    }
  });

  it('reports unknown (not closed) when calendar coverage is unavailable', async () => {
    // Required-but-unloaded override store = calendar_unavailable. The UI
    // must see 'unknown' (price-preparing placeholder), never a false
    // 'closed', and the blocked reason must differ from MARKET_CLOSED.
    markMarketSessionOverrideStoreRequired();
    try {
      const { prisma, service } = createService();
      prisma.asset.count.mockResolvedValueOnce(1);
      prisma.asset.findMany.mockResolvedValueOnce([
        asset({ id: 'asset-krx', assetType: AssetType.domestic_stock }),
      ]);
      mockTradableSeason(prisma);
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
        freshUsdKrwSnapshot(),
      );
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        priceSnapshot('price-krx', '71500.00000000'),
      );

      const response = await service.getAssets('user-1');

      expect(response.data.assets[0]).toMatchObject({
        marketStatus: 'unknown',
        tradable: false,
        tradeBlockedReason: 'UNKNOWN',
      });
    } finally {
      resetMarketSessionOverrideStoreForTest();
    }
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
      capturedAt: new Date('2026-07-17T19:59:00.000Z'),
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
        input.capturedAt,
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
        new Date(Date.now() - 301_000),
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

  it('uses fresh Korea EXIM provider_api USD/KRW before ExchangeRate-API for USD asset KRW conversion', async () => {
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
        id: 'provider-fx-exchange',
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date('2026-05-07T00:00:00.000Z'),
        capturedAt: new Date(Date.now() - 1_000),
      },
      {
        id: 'provider-fx-korea-exim',
        rate: new Prisma.Decimal('1490.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'korea_exim_exchange_rate',
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
      priceKrw: '149000.00000000',
      fxRateSource: {
        sourceType: 'provider_api',
        sourceName: 'korea_exim_exchange_rate',
        snapshotId: 'provider-fx-korea-exim',
        fallbackUsed: false,
      },
    });
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoAssetWrites(prisma);
  });

  it('uses fresh ExchangeRate-API USD/KRW when Korea EXIM provider_api is stale for USD asset KRW conversion', async () => {
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
        id: 'provider-fx-korea-exim-stale',
        rate: new Prisma.Decimal('1490.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'korea_exim_exchange_rate',
        effectiveAt: new Date('2026-05-07T00:00:00.000Z'),
        capturedAt: new Date(Date.now() - 7_201_000),
      },
      {
        id: 'provider-fx-exchange',
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
        snapshotId: 'provider-fx-exchange',
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

  it('preserves the observed provider session decision across the manual fallback await', async () => {
    const { prisma, service } = createService();
    const row = asset({
      id: 'krx-observation',
      market: 'KRX',
      assetType: AssetType.domestic_stock,
      currencyCode: CurrencyCode.KRW,
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([
      providerPriceSnapshot(
        'stale-krx',
        'kis_krx_realtime_trade',
        '12345.87654321',
        CurrencyCode.KRW,
        new Date(Date.now() - 3600000),
      ),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockImplementation(async () => {
      // An operator/cache state transition after selection must not rewrite
      // the already-observed failure into market_calendar_unavailable.
      markMarketSessionOverrideStoreRequired();
      return null;
    });
    try {
      const result = await service['findLatestEligibleAssetPriceSnapshot'](
        row,
        new Date(),
      );
      expect(result.failureContext).toMatchObject({
        evidence: {
          marketSession: { state: 'open' },
          providerDecision: { rejectedProviderReason: 'captured_at_stale' },
          providerCandidates: [
            { reason: 'captured_at_stale', ageSeconds: 3600 },
          ],
        },
      });
      expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result.failureContext)).not.toContain(
        '12345.87654321',
      );
    } finally {
      resetMarketSessionOverrideStoreForTest();
    }
  });

  it('forwards already computed selection evidence independently for two concurrent failed rows', async () => {
    const { prisma, service } = createService();
    const rows = ['a', 'b'].map((id) =>
      asset({
        id,
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
      }),
    );
    prisma.asset.count.mockResolvedValue(2);
    prisma.asset.findMany.mockResolvedValue(rows);
    prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
    prisma.assetPriceSnapshot.findMany.mockImplementation(async ({ where }) => {
      const id = where.assetId;
      // Distinct failures overlap inside the same request.
      await Promise.resolve();
      return [
        providerPriceSnapshot(
          `snapshot-${id}`,
          'binance_public_rest_24hr_ticker',
          '100',
          CurrencyCode.USD,
          new Date(Date.now() - (id === 'a' ? 3600000 : 7200000)),
        ),
      ];
    });
    let pending!: ReturnType<AssetsService['getAssets']>;
    adminDiagnosticRequestMiddleware(
      {
        method: 'GET',
        originalUrl: '/api/v1/assets?withPrice=true',
        headers: {},
        user: { userId: 'admin', role: 'admin' },
      } as never,
      { setHeader: jest.fn() } as never,
      () => {
        setAdminDiagnosticContext({
          evidence: { unrelated: 'shared-row-shadow' },
          entities: { assetId: 'shadow' },
        });
        pending = service.getAssets('admin');
      },
    );
    const response = await pending;
    expect(response.data.priceErrors).toHaveLength(2);
    for (const row of response.data.priceErrors) {
      const id = row.assetId;
      expect(row.diagnostic).toMatchObject({
        entities: { assetId: id, snapshotId: `snapshot-${id}` },
        evidence: {
          workflow: 'assets_with_price',
          finalSelectionResult: 'NO_ELIGIBLE_SNAPSHOT',
          manualFallback: { eligibleQueryCandidateFound: false },
          providerDecision: { rejectedProviderReason: 'captured_at_stale' },
          providerCandidates: [
            { candidateFound: false },
            {
              snapshotId: `snapshot-${id}`,
              positiveValue: true,
              reason: 'captured_at_stale',
              ageSeconds: id === 'a' ? 3600 : 7200,
            },
          ],
        },
      });
      expect(row.diagnostic?.evidence?.freshnessThresholdSeconds).toEqual(
        expect.any(Number),
      );
      expect(JSON.stringify(row.diagnostic)).not.toMatch(
        /shared-row-shadow|"assetId":"shadow"/,
      );
      expect(JSON.stringify(row.diagnostic)).not.toContain(
        `snapshot-${id === 'a' ? 'b' : 'a'}`,
      );
      expect(
        row.diagnostic?.diagnosticEvents.events.map((event) => event.event),
      ).toEqual(['HTTP_REQUEST_RECEIVED', 'PARTIAL_FAILURE_RECORDED']);
    }
    expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(2);
    expectNoAssetWrites(prisma);
  });

  it.each(['admin', 'user', 'operator'] as const)(
    'returns real price failure with role-scoped diagnostic for %s',
    async (role) => {
      const { prisma, service } = createService();
      prisma.asset.findUnique.mockResolvedValueOnce(
        asset({ id: 'asset-missing-price' }),
      );
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);
      const request = {
        method: 'GET',
        originalUrl: '/api/v1/assets/asset-missing-price',
        headers: { 'x-request-id': `asset-${role}` },
        user: undefined as { userId: string; role: typeof role } | undefined,
      };
      let read!: ReturnType<AssetsService['getAsset']>;
      adminDiagnosticRequestMiddleware(
        request as never,
        { setHeader: jest.fn() } as never,
        () => {
          // The guard attaches the current DB role after request middleware.
          request.user = { userId: 'user-1', role };
          read = service.getAsset('user-1', 'asset-missing-price');
        },
      );
      const response = await read;
      expect(response.data.asset.price).toMatchObject({
        state: 'unavailable',
        reason: 'ASSET_PRICE_UNAVAILABLE',
      });
      expect(response.data.priceErrors[0]).toMatchObject({
        assetId: 'asset-missing-price',
        code: 'ASSET_PRICE_UNAVAILABLE',
      });
      if (role === 'admin') {
        expect(response.data.priceErrors[0].diagnostic).toMatchObject({
          code: 'ASSET_PRICE_UNAVAILABLE',
          httpStatus: 200,
          requestId: 'asset-admin',
          operation: 'ASSET_PRICE_READ',
          failureStage: 'asset_price_selection',
        });
      } else {
        expect(response.data.priceErrors[0]).not.toHaveProperty('diagnostic');
      }
      expectNoAssetWrites(prisma);
    },
  );

  it('keeps a 90-second provider snapshot available for REST display without priceErrors', async () => {
    const { prisma, service } = createService();
    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({ id: 'asset-krx', assetType: AssetType.domestic_stock }),
    );
    const capturedAt = new Date(Date.now() - 90_000);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      providerPriceSnapshot(
        'price-90-seconds',
        'kis_krx_realtime_trade',
        '70000.00000000',
        CurrencyCode.KRW,
        capturedAt,
      ),
    ]);

    const response = await service.getAsset('user-1', 'asset-krx');
    expect(response.data.asset.price).toMatchObject({
      state: 'available',
      currentPrice: '70000.00000000',
      priceCapturedAt: capturedAt.toISOString(),
    });
    expect(response.data.priceErrors).toEqual([]);
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
      tradable: true,
      tradeBlockedReason: null,
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
    const findFirstCalls = prisma.assetPriceSnapshot.findFirst.mock
      .calls as unknown[][];
    const firstFindFirstArg = findFirstCalls[0][0] as {
      select?: Record<string, unknown>;
    };
    expect(firstFindFirstArg.select).not.toHaveProperty('rawPayloadJson');
    expect(JSON.stringify(response.data)).not.toContain('rawPayloadJson');
    expectNoAssetWrites(prisma);
  });

  it.each([AssetType.domestic_stock, AssetType.crypto])(
    'shares the %s daily baseline across REST, live ticks and reconnect snapshots',
    async (assetType) => {
      const { prisma, service } = createService();
      const isCrypto = assetType === AssetType.crypto;
      const currency = isCrypto ? CurrencyCode.USD : CurrencyCode.KRW;
      const sourceName = isCrypto ? 'binance_spot_ws_ticker' : 'kis_krx_realtime_trade';
      const fixture = asset({ id: 'asset-daily', symbol: isCrypto ? 'BTCUSDT' : '005930', assetType, currencyCode: currency });
      const current = providerPriceSnapshot('current', sourceName, '110', currency);
      prisma.asset.findUnique.mockResolvedValue(fixture);
      prisma.asset.findFirst.mockResolvedValue(fixture);
      prisma.asset.findMany.mockResolvedValue([fixture]);
      prisma.asset.count.mockResolvedValue(1);
      prisma.assetPriceSnapshot.findMany.mockResolvedValue([current]);
      prisma.fxRateSnapshot.findMany.mockResolvedValue(freshUsdKrwProviderSnapshots());
      prisma.marketCandle.findMany.mockResolvedValue([{
        assetId: fixture.id, interval: '1d', sourceProvider: isCrypto ? BINANCE_CANDLE_SOURCE : KIS_DOMESTIC_PERIOD_SOURCE, isClosed: true,
        openTime: new Date(isCrypto ? '2026-07-19T00:00:00Z' : '2026-07-15T15:00:00Z'),
        closeTime: new Date(isCrypto ? '2026-07-20T00:00:00Z' : '2026-07-16T15:00:00Z'),
        sourceUpdatedAt: new Date(isCrypto ? '2026-07-20T00:00:00Z' : '2026-07-16T15:00:00Z'),
        open: new Prisma.Decimal(100), high: new Prisma.Decimal(101),
        low: new Prisma.Decimal(99), close: new Prisma.Decimal(100),
      }]);
      expect((await service.getAssetPrice('user-1', fixture.id)).data.changeRate).toBe('10.00000000');
      expect((await service.getAsset('user-1', fixture.id)).data.asset.price).toMatchObject({ changeRate: '10.00000000' });
      expect((await service.getAssets('user-1', { withPrice: 'true' })).data.assets[0].price).toMatchObject({ changeRate: '10.00000000' });
      const gateway = new AssetTickerGateway(prisma as never, {} as never, {} as never, service,
        { getMetadata: async () => ({ ...fixture, assetId: fixture.id }) } as never, {} as never, {} as never);
      const internal = gateway as unknown as {
        buildSnapshotTickerMessage(id: string): Promise<Record<string, unknown>>;
        buildRealtimeTickerMessageFromEvent(event: unknown): Promise<Record<string, unknown>>;
      };
      expect(await internal.buildSnapshotTickerMessage(fixture.id)).toMatchObject({ changeRate: '10.00000000' });
      const event = { type: isCrypto ? 'binance_realtime_price' : 'kis_realtime_price', assetId: fixture.id,
        price: { price: '110', currencyCode: currency, sourceName, changeRate: '-99.9',
          effectiveAt: testNow.toISOString(), capturedAt: testNow.toISOString() } };
      expect(await internal.buildRealtimeTickerMessageFromEvent(event)).toMatchObject({ priceLocal: '110', changeRate: '10.00000000' });
      event.price.price = '120';
      expect(await internal.buildRealtimeTickerMessageFromEvent(event)).toMatchObject({ priceLocal: '120', changeRate: '20.00000000' });
      event.price.price = '130'; event.price.changeRate = '999';
      expect(await internal.buildRealtimeTickerMessageFromEvent(event)).toMatchObject({ priceLocal: '130', changeRate: '30.00000000' });
      // Reconnection reloads REST current state with the same daily definition.
      prisma.assetPriceSnapshot.findMany.mockResolvedValue([providerPriceSnapshot('recovered', sourceName, '130', currency)]);
      expect(await internal.buildSnapshotTickerMessage(fixture.id)).toMatchObject({ priceLocal: '130.00000000', changeRate: '30.00000000' });
      expect(prisma.marketCandle.findMany).toHaveBeenCalledTimes(1);
      expectNoAssetWrites(prisma);
    },
  );

  it('builds ticker price selection with the same asset price policy as REST price', async () => {
    const { prisma, service } = createService();
    const fixture = asset({
      id: 'asset-krw',
      symbol: '005930',
      name: 'Samsung',
    });
    const current = priceSnapshot(
      'price-krw',
      '70000.00000000',
      CurrencyCode.KRW,
    );
    prisma.asset.findUnique.mockResolvedValueOnce(fixture);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const restResponse = await service.getAssetPrice('user-1', 'asset-krw');

    prisma.asset.findFirst.mockResolvedValueOnce(fixture);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const tickerSelection = await service.getAssetPriceForTicker('asset-krw');

    expect(tickerSelection).toMatchObject({
      asset: {
        id: 'asset-krw',
        symbol: '005930',
        priceCurrency: CurrencyCode.KRW,
      },
      price: {
        state: 'available',
        currentPrice: restResponse.data.currentPrice,
        priceKrwState: restResponse.data.priceKrwState,
        priceKrw: restResponse.data.priceKrw,
        changeRate: restResponse.data.changeRate,
        assetPriceSnapshotId: restResponse.data.assetPriceSnapshotId,
        priceSource: restResponse.data.priceSource,
      },
    });
    expect(JSON.stringify(tickerSelection)).not.toContain('rawPayloadJson');
    expectNoAssetWrites(prisma);
  });

  it('keeps changeRate null when only previous DB snapshots exist for list, detail, and price endpoints', async () => {
    const { prisma, service } = createService();
    const current = priceSnapshot(
      'price-current',
      '125.00000000',
      CurrencyCode.KRW,
    );

    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    ]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const listResponse = await service.getAssets('user-1');

    expect(listResponse.data.assets[0]).toMatchObject({
      changeRate: null,
      price: {
        currentPrice: '125.00000000',
        changeRate: null,
      },
    });

    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    );
    prisma.season.findFirst.mockResolvedValueOnce(null);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const detailResponse = await service.getAsset('user-1', 'asset-krw');

    expect(detailResponse.data.asset).toMatchObject({
      changeRate: null,
      price: {
        changeRate: null,
      },
    });

    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const priceResponse = await service.getAssetPrice('user-1', 'asset-krw');

    expect(priceResponse.data).toMatchObject({
      state: 'available',
      currentPrice: '125.00000000',
      changeRate: null,
    });
    expect(JSON.stringify(priceResponse.data)).not.toContain('rawPayloadJson');
    expectNoAssetWrites(prisma);
  });

  it('returns null changeRate when no previous positive price snapshot exists for list, detail, and price endpoints', async () => {
    const { prisma, service } = createService();
    const current = priceSnapshot(
      'price-current',
      '125.00000000',
      CurrencyCode.KRW,
    );

    prisma.asset.count.mockResolvedValueOnce(1);
    prisma.asset.findMany.mockResolvedValueOnce([
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    ]);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const listResponse = await service.getAssets('user-1');

    expect(listResponse.data.assets[0]).toMatchObject({
      changeRate: null,
      price: {
        currentPrice: '125.00000000',
        changeRate: null,
      },
    });

    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    );
    prisma.season.findFirst.mockResolvedValueOnce(null);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const detailResponse = await service.getAsset('user-1', 'asset-krw');

    expect(detailResponse.data.asset).toMatchObject({
      changeRate: null,
      price: {
        changeRate: null,
      },
    });

    prisma.asset.findUnique.mockResolvedValueOnce(
      asset({
        id: 'asset-krw',
        symbol: '005930',
        name: 'Samsung',
      }),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(current);

    const priceResponse = await service.getAssetPrice('user-1', 'asset-krw');

    expect(priceResponse.data).toMatchObject({
      state: 'available',
      currentPrice: '125.00000000',
      changeRate: null,
    });
    expect(JSON.stringify(priceResponse.data)).not.toContain('rawPayloadJson');
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
  describe('Binance writer, selected price evidence and Crypto HOT contract', () => {
    const contract = JSON.parse(readFileSync(
      join(__dirname, 'fixtures/binance-crypto-hot-contract.json'), 'utf8',
    )) as {
      frames: { stream: string; data: { s: string; q?: string } }[];
      assets: { id: string; name: string; turnover: string | null }[];
    };

    async function cryptoSetup(onlyTrio = false, wsEligible = true, missingRestAssetId?: string) {
      const h = createService();
      const frames = onlyTrio ? contract.frames.slice(0, 3) : contract.frames;
      const assets = frames.map(frame => asset({
        id: frame.data.s, symbol: frame.data.s,
        name: contract.assets.find(a => a.id === frame.data.s)!.name,
        assetType: AssetType.crypto, currencyCode: CurrencyCode.USD,
      }));
      h.prisma.asset.findMany.mockImplementation(async args =>
        args.where.symbol?.in
          ? assets.filter(a => args.where.symbol.in.includes(a.symbol))
          : assets,
      );
      h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
      h.prisma.fxRateSnapshot.findFirst.mockResolvedValue(freshUsdKrwSnapshot());
      const snapshots: AssetPriceSnapshot[] = [];
      h.prisma.assetPriceSnapshot.create.mockImplementation(async ({ data }) => {
        const id = `ws-${data.assetId}`;
        // Prisma accepts decimal strings on writes but returns Decimal fields on reads.
        snapshots.push({
          ...data, id, createdAt: new Date(testNow),
          price: new Prisma.Decimal(data.price),
          priceKrw: data.priceKrw == null ? null : new Prisma.Decimal(data.priceKrw),
        });
        return { id };
      });
      const ingestion = new BinanceWebSocketIngestionService(h.prisma as never, {
        getConfig: () => ({
          common: { providerIngestionEnabled: true, rawPayloadMaxBytes: 12000 },
          binance: { enabled: true, usdtAsUsdEquivalent: true, wsSnapshotThrottleMs: 0 },
        }),
      } as unknown as ProviderConfigService);
      for (const frame of frames) {
        const result = await ingestion.ingestParsedMessage(parseBinanceWebSocketMessage({
          frame: JSON.stringify(frame), receivedAt: new Date(testNow.getTime() - 1000),
        }));
        expect(result.created).toBe(1);
      }
      // A newer REST row must not override eligible WS evidence or fill missing q.
      for (const a of assets) snapshots.push({
        ...providerPriceSnapshot(`rest-${a.id}`, 'binance_public_rest_24hr_ticker', '999', CurrencyCode.USD),
        assetId: a.id, priceKrw: null, sourceTimestamp: null, createdAt: new Date(testNow), note: null,
        rawPayloadJson: buildProviderRawPayloadJson({
          payload: {
            symbol: a.symbol, lastPrice: '999', volume: '1',
            ...(a.id === missingRestAssetId ? {} : { quoteVolume: '777777' }),
          }, maxBytes: 12000,
        }),
      });
      h.prisma.assetPriceSnapshot.findMany.mockImplementation(async ({ where }) =>
        where.id ? snapshots.filter(s => where.id.in.includes(s.id))
          : snapshots.filter(s => s.assetId === where.assetId && (wsEligible || s.sourceName !== 'binance_spot_ws_ticker')),
      );
      return h;
    }

    it.each([
      ['desc', ['ETHUSDT', 'SOLUSDT', 'BTCUSDT']],
      ['asc', ['BTCUSDT', 'SOLUSDT', 'ETHUSDT']],
    ] as const)('sorts real combined-frame turnover %s across crypto assets', async (sortOrder, expected) => {
      const h = await cryptoSetup(true);
      const response = await h.service.getAssets('user', { assetType: 'crypto', sortBy: 'turnover', sortOrder });
      expect(response.data.assets.map(a => a.symbol)).toEqual(expected);
      expect(response.data.assets.map(a => a.turnover)).toEqual(sortOrder === 'desc' ? ['5000', '2000', '1000'] : ['1000', '2000', '5000']);
      for (const a of response.data.assets) {
        expect(a.turnoverPeriod).toBe('rolling_24h');
        expect(a.price).toMatchObject({ state: 'available', currentPrice: '100.00000000', priceKrw: '140000.00000000', assetPriceSnapshotId: `ws-${a.id}` });
      }
    });

    it('validates the shared HOT fixture against writer output and Market TOP 5 at the same snapshot', async () => {
      const h = await cryptoSetup();
      const query = { assetType: 'crypto', sortBy: 'turnover', sortOrder: 'desc' };
      const hot = (await h.service.getAssets('user', { ...query, limit: '5' })).data;
      const market = (await h.service.getAssets('user', { ...query, limit: '20', sortSnapshot: hot.sortSnapshot })).data;
      expect(hot.assets).toHaveLength(5);
      expect(market.assets).toMatchObject(contract.assets);
      expect(hot.assets).toEqual(market.assets.slice(0, 5));
      expect(hot.sortSnapshot).toBe(market.sortSnapshot);
      expect(market.assets.at(-1)).toMatchObject({ id: 'DOGEUSDT', turnover: null, turnoverPeriod: null });
      expect(JSON.stringify(hot)).not.toContain('rawPayloadJson');
      const writesBeforeRead = h.prisma.assetPriceSnapshot.create.mock.calls.length;
      await h.service.getAssets('user', query);
      expect(h.prisma.assetPriceSnapshot.create).toHaveBeenCalledTimes(writesBeforeRead);
    });

    it.each(['asc', 'desc'] as const)('uses selected REST quoteVolume when WS is ineligible, keeping missing REST evidence last (%s)', async sortOrder => {
      const h = await cryptoSetup(false, false, 'BTCUSDT');
      const response = await h.service.getAssets('user', { assetType: 'crypto', sortBy: 'turnover', sortOrder });
      expect(response.data.assets).toHaveLength(contract.assets.length);
      expect(response.data.assets.map(a => a.turnover)).toEqual([...contract.assets.slice(1).map(() => '777777'), null]);
      expect(response.data.assets.map(a => a.symbol)).toEqual([
        ...contract.assets.map(a => a.id).filter(id => id !== 'BTCUSDT').sort(), 'BTCUSDT',
      ]);
      for (const a of response.data.assets) {
        expect(a.turnoverPeriod).toBe(a.id === 'BTCUSDT' ? null : 'rolling_24h');
        expect(a.price).toMatchObject({ state: 'available', currentPrice: '999.00000000', priceKrw: '1398600.00000000', assetPriceSnapshotId: `rest-${a.id}` });
      }
    });
  });
  describe('whole-universe sorting and stable snapshot pagination', () => {
    function sortedSetup(redis?: { get: jest.Mock; eval: jest.Mock }) {
      const h = createService(undefined, redis);
      const values = ['-2', '8', null, '0', '-9', '3', '3'];
      h.prisma.asset.findMany.mockResolvedValue(
        values.map((_, i) => asset({ id: `a${i}`, symbol: `S${i}` })),
      );
      h.prisma.assetPriceSnapshot.findMany.mockImplementation(async (args) => {
        if (args.select.rawPayloadJson)
          return values.map((_, i) => ({
            id: `p${i}`,
            sourceType: 'provider_api',
            sourceName: 'kis_krx_realtime_trade',
            rawPayloadJson: {
              truncated: false,
              payload: {
                messageType: 'websocket_trade',
                rawFields: {
                  ACML_VOL: String(1000 - i),
                  ACML_TR_PBMN: i === 2 ? '' : String(i * 100),
                },
              },
            },
          }));
        return [
          providerPriceSnapshot(
            `p${args.where.assetId.slice(1)}`,
            'kis_krx_realtime_trade',
            '100',
          ),
        ];
      });
      jest
        .spyOn(h.service, 'calculateChangeRate')
        .mockImplementation(async (asset) => values[Number(asset.id.slice(1))]);
      return h;
    }
    it.each([
      ['changeRate', 'desc', ['a1', 'a5', 'a6', 'a3', 'a0', 'a4', 'a2']],
      ['changeRate', 'asc', ['a4', 'a0', 'a3', 'a5', 'a6', 'a1', 'a2']],
      ['turnover', 'desc', ['a6', 'a5', 'a4', 'a3', 'a1', 'a0', 'a2']],
      ['turnover', 'asc', ['a0', 'a1', 'a3', 'a4', 'a5', 'a6', 'a2']],
    ])(
      '%s %s sorts before pagination, with unavailable last and stable ties',
      async (sortBy, sortOrder, expected) => {
        const h = sortedSetup();
        const query = {
          sortBy: sortBy as string,
          sortOrder: sortOrder as string,
          limit: '2',
          search: 'S',
        };
        const first = (await h.service.getAssets('user', query)).data;
        expect(first.assets.map((a) => a.id)).toEqual(expected.slice(0, 2));
        expect(h.prisma.asset.findMany.mock.calls[0][0]).not.toHaveProperty(
          'take',
        );
        expect(h.prisma.asset.findMany.mock.calls[0][0].where).toHaveProperty(
          'OR',
        );
        // New values/candidates must not perturb a sequence already being read.
        h.prisma.asset.findMany.mockResolvedValue([]);
        const ids = first.assets.map((a) => a.id);
        for (let offset = 2; offset < 7; offset += 2) {
          const page = (
            await h.service.getAssets('user', {
              ...query,
              offset: String(offset),
              sortSnapshot: first.sortSnapshot,
            })
          ).data;
          ids.push(...page.assets.map((a) => a.id));
          expect(page.pagination.total).toBe(7);
        }
        expect(ids).toEqual(expected);
        expect(new Set(ids).size).toBe(7);
        expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(1);
        const refresh = (
          await h.service.getAssets('user', { ...query, sortRefresh: 'true' })
        ).data;
        expect(refresh.assets).toEqual([]);
        expect(refresh.sortSnapshot).not.toBe(first.sortSnapshot);
        expectNoAssetWrites(h.prisma);
      },
    );
    it('shares immutable pages across instances through the existing Redis connection', async () => {
      const previous = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://fixture.invalid';
      const store = new Map<string, string>();
      const redis = {
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        eval: jest.fn(
          async (_script: string, keys: string[], args: string[]) => {
            store.set(keys[0], args[2]);
            store.set(keys[1], args[1]);
          },
        ),
      };
      try {
        const first = sortedSetup(redis);
        const query = { sortBy: 'turnover', limit: '2' };
        const page = (await first.service.getAssets('user', query)).data;
        const other = createService(undefined, redis);
        const next = (
          await other.service.getAssets('user', {
            ...query,
            offset: '2',
            sortSnapshot: page.sortSnapshot,
          })
        ).data;
        expect(next.assets.map((a) => a.id)).toEqual(['a4', 'a3']);
        expect(other.prisma.asset.findMany).not.toHaveBeenCalled();
        expect(redis.eval.mock.calls[0][2][3]).toBe('600');
        const shared = (await other.service.getAssets('another-user', query))
          .data;
        expect(shared.sortSnapshot).toBe(page.sortSnapshot);
        expect(other.prisma.asset.findMany).not.toHaveBeenCalled();
        expect(redis.eval).toHaveBeenCalledTimes(1);
        redis.get.mockRejectedValue(new Error('cache unavailable'));
        await expectApiError(
          createService(undefined, redis).service.getAssets('user', {
            ...query,
            offset: '2',
            sortSnapshot: page.sortSnapshot,
          }),
          409,
          'ASSET_SORT_SNAPSHOT_EXPIRED',
        );
      } finally {
        if (previous === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = previous;
      }
    });
    it.each([false, true])(
      'prices once for 100 users, concurrent=%s',
      async (concurrent) => {
        const h = sortedSetup();
        const build = jest.spyOn(
          h.service as unknown as {
            buildAssetsWithPrices: () => Promise<unknown>;
          },
          'buildAssetsWithPrices',
        );
        const read = (i: number) =>
          h.service.getAssets(`user-${i}`, {
            sortBy: 'turnover',
            limit: String((i % 10) + 1),
          });
        const pages = concurrent
          ? await Promise.all(Array.from({ length: 100 }, (_, i) => read(i)))
          : [];
        if (!concurrent)
          for (let i = 0; i < 100; i++) pages.push(await read(i));
        expect(new Set(pages.map((p) => p.data.sortSnapshot)).size).toBe(1);
        expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledTimes(1);
        expect(h.prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(8);
      },
    );
    it('clears failed coalescing state and allows retry', async () => {
      const h = sortedSetup();
      h.prisma.asset.findMany.mockRejectedValueOnce(new Error('DB failed'));
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          h.service.getAssets('a', { sortBy: 'turnover' }),
        ),
      );
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(1);
      expect(
        (await h.service.getAssets('b', { sortBy: 'turnover' })).data.assets,
      ).toHaveLength(7);
      expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(2);
    });
    it.each([
      { assetType: 'crypto' },
      { currencyCode: 'USD' },
      { market: 'NAS' },
      { search: 'SAM' },
      { includeInactive: 'true' },
      { sortBy: 'changeRate' },
    ])('isolates filter %j', async (changed) => {
      const h = sortedSetup();
      const q = { sortBy: 'turnover', assetType: 'domestic_stock' };
      const first = (await h.service.getAssets('a', q)).data;
      expect(
        (await h.service.getAssets('b', { ...q, ...changed })).data
          .sortSnapshot,
      ).not.toBe(first.sortSnapshot);
      expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(2);
      await expectApiError(
        h.service.getAssets('a', {
          ...q,
          ...changed,
          sortSnapshot: first.sortSnapshot,
        }),
        400,
        'INVALID_SORT_SNAPSHOT',
      );
    });
    it('normalizes defaults and trims, isolates sort direction, allows different page sizes', async () => {
      const h = sortedSetup();
      const q = { sortBy: 'changeRate', search: 'S' };
      const first = (
        await h.service.getAssets('a', { ...q, search: ' S ', limit: '2' })
      ).data;
      expect(
        (
          await h.service.getAssets('b', {
            ...q,
            sortOrder: 'desc',
            includeInactive: 'false',
            withPrice: 'true',
            limit: '3',
          })
        ).data.sortSnapshot,
      ).toBe(first.sortSnapshot);
      const next = (
        await h.service.getAssets('c', {
          ...q,
          offset: '2',
          limit: '3',
          sortSnapshot: first.sortSnapshot,
        })
      ).data;
      expect(next.assets.map((a) => a.id)).toEqual(['a6', 'a3', 'a0']);
      expect(
        (await h.service.getAssets('a', { ...q, sortOrder: 'asc' })).data
          .sortSnapshot,
      ).not.toBe(first.sortSnapshot);
      await expectApiError(
        h.service.getAssets('a', {
          ...q,
          sortOrder: 'asc',
          sortSnapshot: first.sortSnapshot,
        }),
        400,
        'INVALID_SORT_SNAPSHOT',
      );
    });
    it('refreshes immediately and after two seconds without perturbing older pages', async () => {
      const h = sortedSetup();
      const q = { sortBy: 'turnover', limit: '2' };
      const first = (await h.service.getAssets('a', q)).data;
      h.prisma.asset.findMany.mockResolvedValue([]);
      const fresh = (
        await h.service.getAssets('b', { ...q, sortRefresh: 'true' })
      ).data;
      expect(fresh.sortSnapshot).not.toBe(first.sortSnapshot);
      expect(fresh.assets).toEqual([]);
      expect((await h.service.getAssets('c', q)).data.sortSnapshot).toBe(
        fresh.sortSnapshot,
      );
      expect(
        (
          await h.service.getAssets('a', {
            ...q,
            offset: '2',
            sortSnapshot: first.sortSnapshot,
          })
        ).data.assets.map((a) => a.id),
      ).toEqual(['a4', 'a3']);
      jest.setSystemTime(new Date(testNow.getTime() + 2001));
      expect((await h.service.getAssets('a', q)).data.sortSnapshot).not.toBe(
        fresh.sortSnapshot,
      );
      expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(3);
    });
    it('bounds search cardinality and restarts evicted tokens', async () => {
      const h = createService();
      h.prisma.asset.findMany.mockResolvedValue([]);
      const first = (
        await h.service.getAssets('a', { sortBy: 'turnover', search: 'S' })
      ).data;
      for (let i = 0; i < 210; i++)
        await h.service.getAssets('a', {
          sortBy: 'turnover',
          search: `prefix-${i}`,
        });
      const cache = (
        h.service as unknown as { sortedSnapshots: Map<string, unknown> }
      ).sortedSnapshots;
      expect(cache.size).toBe(200);
      await expectApiError(
        h.service.getAssets('a', {
          sortBy: 'turnover',
          search: 'S',
          offset: '2',
          sortSnapshot: first.sortSnapshot,
        }),
        409,
        'ASSET_SORT_SNAPSHOT_EXPIRED',
      );
      jest.setSystemTime(new Date(testNow.getTime() + 600001));
      await h.service.getAssets('a', { sortBy: 'turnover' });
      expect(cache.size).toBe(1);
    });
    it('retains local pages during Redis read/write outage; missing remote token restarts', async () => {
      const previous = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://fixture.invalid';
      const redis = {
        get: jest.fn().mockRejectedValue(new Error('outage')),
        eval: jest.fn().mockRejectedValue(new Error('outage')),
      };
      try {
        const h = sortedSetup(redis);
        const q = { sortBy: 'turnover', limit: '2' };
        const first = (await h.service.getAssets('a', q)).data;
        expect(
          (
            await h.service.getAssets('b', {
              ...q,
              offset: '2',
              sortSnapshot: first.sortSnapshot,
            })
          ).data.assets.map((a) => a.id),
        ).toEqual(['a4', 'a3']);
        expect((await h.service.getAssets('c', q)).data.sortSnapshot).toBe(
          first.sortSnapshot,
        );
        await expectApiError(
          createService(undefined, redis).service.getAssets('b', {
            ...q,
            offset: '2',
            sortSnapshot: first.sortSnapshot,
          }),
          409,
          'ASSET_SORT_SNAPSHOT_EXPIRED',
        );
      } finally {
        if (previous === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = previous;
      }
    });
    it.each([true, false])(
      'isolates concurrent admin/user/operator diagnostics, adminFirst=%s',
      async (adminFirst) => {
        const h = createService();
        h.prisma.asset.findMany.mockResolvedValue([asset({ id: 'failed' })]);
        h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
        const read = (
          role: 'admin' | 'user' | 'operator',
          requestId: string,
          sortSnapshot?: string,
        ) => {
          let pending!: ReturnType<AssetsService['getAssets']>;
          adminDiagnosticRequestMiddleware(
            {
              method: 'GET',
              originalUrl: '/api/v1/assets',
              headers: { 'x-request-id': requestId },
              user: { userId: role, role },
            } as never,
            { setHeader: jest.fn() } as never,
            () => {
              pending = h.service.getAssets(role, {
                sortBy: 'turnover',
                sortSnapshot,
              });
            },
          );
          return pending;
        };
        const roles = adminFirst
          ? (['admin', 'user', 'operator'] as const)
          : (['user', 'operator', 'admin'] as const);
        const results = await Promise.all(
          roles.map((role) => read(role, `request-${role}`)),
        );
        expect(new Set(results.map((r) => r.data.sortSnapshot)).size).toBe(1);
        for (let i = 0; i < roles.length; i++)
          if (roles[i] === 'admin')
            expect(results[i].data.priceErrors[0].diagnostic).toMatchObject({
              requestId: 'request-admin',
              operation: 'ASSET_PRICE_READ',
            });
          else
            expect(results[i].data.priceErrors[0]).not.toHaveProperty(
              'diagnostic',
            );
        const token = results[0].data.sortSnapshot;
        expect(
          (await read('admin', 'another-admin', token)).data.priceErrors[0]
            .diagnostic?.requestId,
        ).toBe('another-admin');
        expect(
          (await read('user', 'ordinary', token)).data.priceErrors[0],
        ).not.toHaveProperty('diagnostic');
        const cache = (
          h.service as unknown as { sortedSnapshots: Map<string, unknown> }
        ).sortedSnapshots;
        expect(JSON.stringify([...cache.values()])).not.toMatch(
          /diagnostic|request-admin|another-admin/,
        );
        expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(1);
      },
    );
    it('presents cached-failure diagnostic after a DB correction', async () => {
      const h = createService();
      h.prisma.asset.findMany.mockResolvedValue([asset({ id: 'corrected' })]);
      h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue(null);
      const first = (await h.service.getAssets('user', { sortBy: 'turnover' }))
        .data;
      h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue(
        priceSnapshot('correction', '100'),
      );
      let pending!: ReturnType<AssetsService['getAssets']>;
      adminDiagnosticRequestMiddleware(
        {
          method: 'GET',
          originalUrl: '/api/v1/assets',
          headers: { 'x-request-id': 'corrected-request' },
          user: { userId: 'admin', role: 'admin' },
        } as never,
        { setHeader: jest.fn() } as never,
        () => {
          pending = h.service.getAssets('admin', {
            sortBy: 'turnover',
            sortSnapshot: first.sortSnapshot,
          });
        },
      );
      const result = await pending;
      expect(result.data.assets).toEqual(first.assets);
      expect(result.data.priceErrors[0].diagnostic).toMatchObject({
        requestId: 'corrected-request',
        evidence: {
          selectionResult: 'SNAPSHOT_PARTIAL_FAILURE',
          originalSelectionEvidence: 'not_retained_in_shared_cache',
          reproductionResult: 'original_failure_not_reproduced',
        },
      });
    });

    it('never serializes FX diagnostics and rebuilds them per page across instances', async () => {
      const previous = process.env.REDIS_URL;
      process.env.REDIS_URL = 'redis://fixture.invalid';
      const store = new Map<string, string>();
      const redis = {
        get: jest.fn(async (key: string) => store.get(key) ?? null),
        eval: jest.fn(
          async (_script: string, keys: string[], args: string[]) => {
            store.set(keys[0], args[2]);
            store.set(keys[1], args[1]);
          },
        ),
      };
      const first = createService(undefined, redis);
      const other = createService(undefined, redis);
      const candidates = ['a', 'b'].map((id) =>
        asset({
          id,
          symbol: id,
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
          market: 'NAS',
        }),
      );
      for (const h of [first, other]) {
        h.prisma.asset.findMany.mockResolvedValue(candidates);
        h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue(
          priceSnapshot('usd-price', '100', CurrencyCode.USD),
        );
        h.prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);
      }
      const read = (
        h: typeof first,
        role: 'admin' | 'user',
        requestId: string,
        token?: string,
        offset = '0',
      ) => {
        let pending!: ReturnType<AssetsService['getAssets']>;
        adminDiagnosticRequestMiddleware(
          {
            method: 'GET',
            originalUrl: '/api/v1/assets',
            headers: { 'x-request-id': requestId },
            user: { userId: 'same-user', role },
          } as never,
          { setHeader: jest.fn() } as never,
          () => {
            pending = h.service.getAssets('same-user', {
              sortBy: 'turnover',
              limit: '1',
              sortSnapshot: token,
              offset,
            });
          },
        );
        return pending;
      };
      try {
        const page = (await read(first, 'admin', 'fx-admin-one')).data;
        expect(page.priceErrors).toHaveLength(1);
        expect(page.priceErrors[0].diagnostic).toMatchObject({
          requestId: 'fx-admin-one',
          operation: 'ASSET_PRICE_KRW_CONVERSION',
          evidence: {
            selectionResult: 'REJECTED',
            workflow: 'assets_with_price',
            providerCandidates: [
              { candidateFound: false },
              { candidateFound: false },
            ],
            manualFallback: { eligibleQueryCandidateFound: false },
            cachedFailureObservation: { sortSnapshot: page.sortSnapshot },
          },
        });
        expect(JSON.stringify([...store.values()])).not.toMatch(
          /diagnostic|fx-admin-one|rawPayloadJson/,
        );
        expect(JSON.stringify(page.priceErrors[0].diagnostic)).not.toMatch(
          /"price":|"currentPrice":|rawPayloadJson/,
        );
        const ordinary = (
          await read(other, 'user', 'role-demoted', page.sortSnapshot, '1')
        ).data;
        expect(ordinary.priceErrors).toHaveLength(1);
        expect(ordinary.priceErrors[0]).not.toHaveProperty('diagnostic');
        const admin = (
          await read(other, 'admin', 'fx-admin-next', page.sortSnapshot, '1')
        ).data;
        expect(admin.priceErrors[0].diagnostic).toMatchObject({
          requestId: 'fx-admin-next',
          entities: { assetId: 'b' },
        });
        expect(other.prisma.asset.findMany).not.toHaveBeenCalled();
        store.set('assets:sort:public:v1:' + page.sortSnapshot, '{broken');
        await expectApiError(
          createService(undefined, redis).service.getAssets('user', {
            sortBy: 'turnover',
            sortSnapshot: page.sortSnapshot,
          }),
          409,
          'ASSET_SORT_SNAPSHOT_EXPIRED',
        );
      } finally {
        if (previous === undefined) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = previous;
      }
    });

    it('rejects invalid/expired/mismatched continuations instead of changing page order', async () => {
      const h = sortedSetup();
      const query = { sortBy: 'turnover', sortOrder: 'desc' };
      const first = (await h.service.getAssets('user', query)).data;
      for (const changed of [
        { sortBy: 'other' },
        { sortBy: 'volume' },
        { withPrice: 'false' },
        { withPrice: ' false ' },
        { sortRefresh: 'yes' },
        { sortRefresh: 'true', offset: '2' },
        { sortRefresh: 'true', sortSnapshot: first.sortSnapshot },
      ]) {
        await expectApiError(
          h.service.getAssets('user', { ...query, ...changed }),
          400,
          'INVALID_ASSET_SORT',
        );
      }
      await expectApiError(
        h.service.getAssets('user', { ...query, offset: '2' }),
        400,
        'INVALID_SORT_SNAPSHOT',
      );
      expect(
        (
          await h.service.getAssets('other', {
            ...query,
            sortSnapshot: first.sortSnapshot,
          })
        ).data.sortSnapshot,
      ).toBe(first.sortSnapshot);
      await expectApiError(
        h.service.getAssets('user', {
          ...query,
          search: 'new',
          sortSnapshot: first.sortSnapshot,
        }),
        400,
        'INVALID_SORT_SNAPSHOT',
      );
      jest.setSystemTime(new Date(testNow.getTime() + 600_001));
      await expectApiError(
        h.service.getAssets('user', {
          ...query,
          sortSnapshot: first.sortSnapshot,
        }),
        409,
        'ASSET_SORT_SNAPSHOT_EXPIRED',
      );
    });
  });
});
