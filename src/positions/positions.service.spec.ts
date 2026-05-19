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
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
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
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { PositionsService } from './positions.service';

describe('PositionsService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const priceAt = new Date('2026-05-07T00:00:00.000Z');

  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
  };

  const participant = {
    id: 'sp-1',
    participantStatus: ParticipantStatus.active,
    joinedAt,
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
    season: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      ...createWritableModel(),
    },
    position: {
      findMany: jest.fn(),
      ...createWritableModel(),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn(),
      ...createWritableModel(),
    },
    fxRateSnapshot: {
      findFirst: jest.fn(),
      ...createWritableModel(),
    },
    cashWallet: {
      ...createWritableModel(),
    },
    order: {
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
    const service = new PositionsService(prisma as never);

    return { prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
  };

  const position = (input: {
    id: string;
    assetId?: string;
    symbol?: string;
    quantity: string;
    averageCost: string;
    currencyCode?: CurrencyCode;
    assetType?: AssetType;
    realizedPnl?: string;
  }) => {
    const currencyCode = input.currencyCode ?? CurrencyCode.KRW;
    const assetId = input.assetId ?? `asset-${input.id}`;

    return {
      id: input.id,
      assetId,
      quantity: new Prisma.Decimal(input.quantity),
      averageCost: new Prisma.Decimal(input.averageCost),
      currencyCode,
      realizedPnl: new Prisma.Decimal(input.realizedPnl ?? '0.00000000'),
      asset: {
        id: assetId,
        symbol: input.symbol ?? assetId.toUpperCase(),
        name: `Asset ${assetId}`,
        market: currencyCode === CurrencyCode.USD ? 'NASDAQ' : 'KRX',
        assetType: input.assetType ?? AssetType.domestic_stock,
        currencyCode,
      },
    };
  };

  const priceSnapshot = (
    id: string,
    price: string,
    currencyCode = CurrencyCode.KRW,
  ) => ({
    id,
    price: new Prisma.Decimal(price),
    currencyCode,
    effectiveAt: priceAt,
    capturedAt: new Date('2026-05-07T00:00:10.000Z'),
  });

  const freshUsdKrwSnapshot = () => ({
    rate: new Prisma.Decimal('1400.00000000'),
    sourceType: FxRateSourceType.admin_manual,
    effectiveAt: new Date(Date.now() - 1_000),
    approvedByUserId: 'operator-1',
  });

  const staleUsdKrwSnapshot = () => ({
    ...freshUsdKrwSnapshot(),
    effectiveAt: new Date(Date.now() - 61_000),
  });

  const expectNoPositionWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.position,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.cashWallet,
      prisma.order,
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

    await expect(service.getPositions(undefined)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('returns unavailable when no current season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getPositions('user-1');

    expect(response.data).toMatchObject({
      state: 'unavailable',
      season: null,
      participant: null,
      positions: [],
      reason: 'CURRENT_SEASON_NOT_FOUND',
      summary: {
        totalPositionsCount: 0,
        totalPositionValueKrw: '0.00000000',
      },
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoPositionWrites(prisma);
  });

  it('returns not_joined when participant does not exist', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getPositions('user-1');

    expect(response.data).toMatchObject({
      state: 'not_joined',
      participant: null,
      positions: [],
      reason: 'SEASON_NOT_JOINED',
    });
    expect(prisma.position.findMany).not.toHaveBeenCalled();
    expectNoPositionWrites(prisma);
  });

  it('returns available empty positions when joined participant has no positions', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([]);

    const response = await service.getPositions('user-1');

    expect(response.data).toMatchObject({
      state: 'available',
      positions: [],
      pagination: {
        limit: 50,
        offset: 0,
        total: 0,
        returned: 0,
      },
      summary: {
        openPositionsCount: 0,
        totalPositionsCount: 0,
        valuedPositionsCount: 0,
        unavailableValuationsCount: 0,
        totalPositionValueKrw: '0.00000000',
      },
    });
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoPositionWrites(prisma);
  });

  it('queries open positions by default', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-open',
        assetId: 'asset-open',
        symbol: 'OPEN',
        quantity: '2.00000000',
        averageCost: '100.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-open', '120.00000000'),
    );

    const response = await service.getPositions('user-1');

    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          quantity: {
            gt: 0,
          },
        },
      }),
    );
    expect(response.data.positions).toHaveLength(1);
    expect(response.data.filters.includeClosed).toBe(false);
    expectNoPositionWrites(prisma);
  });

  it('includes closed positions when includeClosed=true', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-closed',
        assetId: 'asset-closed',
        symbol: 'CLOSED',
        quantity: '0.00000000',
        averageCost: '100.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-closed', '90.00000000'),
    );

    const response = await service.getPositions('user-1', {
      includeClosed: 'true',
    });

    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
        },
      }),
    );
    expect(response.data.filters.includeClosed).toBe(true);
    expect(response.data.positions[0]).toMatchObject({
      positionId: 'position-closed',
      quantity: '0.00000000',
      valuation: {
        state: 'available',
        positionValueKrw: '0.00000000',
      },
    });
    expectNoPositionWrites(prisma);
  });

  it('applies assetType filter', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([]);

    await service.getPositions('user-1', {
      assetType: AssetType.crypto,
    });

    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          asset: {
            is: {
              assetType: AssetType.crypto,
            },
          },
        }),
      }),
    );
    expectNoPositionWrites(prisma);
  });

  it('applies currencyCode filter', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([]);

    await service.getPositions('user-1', {
      currencyCode: CurrencyCode.USD,
    });

    expect(prisma.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currencyCode: CurrencyCode.USD,
        }),
      }),
    );
    expectNoPositionWrites(prisma);
  });

  it('rejects invalid query with BAD_REQUEST', async () => {
    const { service } = createService();

    await expect(
      service.getPositions('user-1', {
        includeClosed: 'yes',
      }),
    ).rejects.toMatchObject({
      status: 400,
    });

    await expect(
      service.getPositions('user-1', {
        assetType: 'forex',
      }),
    ).rejects.toMatchObject({
      status: 400,
    });
  });

  it('returns KRW position valuation from admin_manual asset price', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-krw',
        assetId: 'asset-krw',
        symbol: 'KRWSTK',
        quantity: '2.00000000',
        averageCost: '90.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-krw', '100.00000000'),
    );

    const response = await service.getPositions('user-1');

    expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceType: 'admin_manual',
          assetId: 'asset-krw',
          currencyCode: CurrencyCode.KRW,
        }),
      }),
    );
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expect(response.data.positions[0]).toMatchObject({
      positionId: 'position-krw',
      valuation: {
        state: 'available',
        currentPrice: '100.00000000',
        positionValue: '200.00000000',
        positionValueKrw: '200.00000000',
        unrealizedPnl: '20.00000000',
        unrealizedPnlKrw: '20.00000000',
        returnRate: '0.11111111',
      },
    });
    expect(response.data.summary.totalPositionValueKrw).toBe('200.00000000');
    expectNoPositionWrites(prisma);
  });

  it('returns USD position KRW valuation using fresh approved admin_manual USD/KRW', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-usd',
        assetId: 'asset-usd',
        symbol: 'AAPL',
        quantity: '2.00000000',
        averageCost: '80.00000000',
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.us_stock,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      freshUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getPositions('user-1');

    expect(response.data.positions[0]).toMatchObject({
      positionId: 'position-usd',
      currencyCode: CurrencyCode.USD,
      valuation: {
        state: 'available',
        positionValue: '200.00000000',
        positionValueKrw: '280000.00000000',
        unrealizedPnl: '40.00000000',
        unrealizedPnlKrw: '56000.00000000',
      },
    });
    expect(response.data.summary.totalPositionValueKrw).toBe('280000.00000000');
    expectNoPositionWrites(prisma);
  });

  it('marks USD valuation unavailable when USD/KRW is missing', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-usd',
        quantity: '1.00000000',
        averageCost: '80.00000000',
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.us_stock,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(null);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getPositions('user-1');

    expect(response.data.positions[0].valuation).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_UNAVAILABLE',
    });
    expect(response.data.valuationErrors).toEqual([
      {
        positionId: 'position-usd',
        assetId: 'asset-position-usd',
        code: 'FX_RATE_UNAVAILABLE',
        message: 'USD/KRW FX rate snapshot is unavailable.',
      },
    ]);
    expect(response.data.summary).toMatchObject({
      valuedPositionsCount: 0,
      unavailableValuationsCount: 1,
      totalPositionValueKrw: '0.00000000',
    });
    expectNoPositionWrites(prisma);
  });

  it('marks USD valuation unavailable when USD/KRW is stale', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-usd',
        quantity: '1.00000000',
        averageCost: '80.00000000',
        currencyCode: CurrencyCode.USD,
        assetType: AssetType.us_stock,
      }),
    ]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
      staleUsdKrwSnapshot(),
    );
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-usd', '100.00000000', CurrencyCode.USD),
    );

    const response = await service.getPositions('user-1');

    expect(response.data.positions[0].valuation).toMatchObject({
      state: 'unavailable',
      reason: 'FX_RATE_STALE',
    });
    expect(response.data.valuationErrors[0]).toMatchObject({
      code: 'FX_RATE_STALE',
      message: 'USD/KRW FX rate snapshot is stale.',
    });
    expectNoPositionWrites(prisma);
  });

  it('keeps available valuations when another position price is missing', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-valued',
        assetId: 'asset-valued',
        symbol: 'VALUED',
        quantity: '1.00000000',
        averageCost: '90.00000000',
      }),
      position({
        id: 'position-missing',
        assetId: 'asset-missing',
        symbol: 'MISSING',
        quantity: '3.00000000',
        averageCost: '10.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst
      .mockResolvedValueOnce(priceSnapshot('price-valued', '100.00000000'))
      .mockResolvedValueOnce(null);

    const response = await service.getPositions('user-1');

    expect(response.data.positions).toMatchObject([
      {
        positionId: 'position-valued',
        valuation: {
          state: 'available',
          positionValueKrw: '100.00000000',
        },
      },
      {
        positionId: 'position-missing',
        valuation: {
          state: 'unavailable',
          reason: 'ASSET_PRICE_UNAVAILABLE',
        },
      },
    ]);
    expect(response.data.summary).toMatchObject({
      valuedPositionsCount: 1,
      unavailableValuationsCount: 1,
      totalPositionValueKrw: '100.00000000',
    });
    expect(response.data.valuationErrors).toEqual([
      {
        positionId: 'position-missing',
        assetId: 'asset-missing',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable for asset asset-missing.',
      },
    ]);
    expectNoPositionWrites(prisma);
  });

  it('sorts by positionValueKrw desc, pushes unavailable valuations behind, and applies pagination', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.position.findMany.mockResolvedValueOnce([
      position({
        id: 'position-a',
        assetId: 'asset-a',
        symbol: 'AAA',
        quantity: '1.00000000',
        averageCost: '90.00000000',
      }),
      position({
        id: 'position-b',
        assetId: 'asset-b',
        symbol: 'BBB',
        quantity: '1.00000000',
        averageCost: '90.00000000',
      }),
      position({
        id: 'position-c',
        assetId: 'asset-c',
        symbol: 'CCC',
        quantity: '1.00000000',
        averageCost: '90.00000000',
      }),
      position({
        id: 'position-d',
        assetId: 'asset-d',
        symbol: 'DDD',
        quantity: '1.00000000',
        averageCost: '90.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst
      .mockResolvedValueOnce(priceSnapshot('price-a', '100.00000000'))
      .mockResolvedValueOnce(priceSnapshot('price-b', '300.00000000'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(priceSnapshot('price-d', '200.00000000'));

    const response = await service.getPositions('user-1', {
      limit: '2',
      offset: '1',
    });

    expect(response.data.pagination).toEqual({
      limit: 2,
      offset: 1,
      total: 4,
      returned: 2,
    });
    expect(response.data.positions.map((item) => item.positionId)).toEqual([
      'position-d',
      'position-a',
    ]);
    expect(response.data.summary).toMatchObject({
      totalPositionsCount: 4,
      valuedPositionsCount: 3,
      unavailableValuationsCount: 1,
      totalPositionValueKrw: '600.00000000',
    });
    expect(response.data.valuationErrors).toEqual([
      {
        positionId: 'position-c',
        assetId: 'asset-c',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable for asset asset-c.',
      },
    ]);
    expectNoPositionWrites(prisma);
  });
});
