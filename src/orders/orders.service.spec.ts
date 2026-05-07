jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    OrderType: {
      market: 'market',
      limit: 'limit',
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
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const submittedAt = new Date('2026-05-07T00:01:00.000Z');
  const executedAt = new Date('2026-05-07T00:02:00.000Z');
  const createdAt = new Date('2026-05-07T00:01:01.000Z');
  const updatedAt = new Date('2026-05-07T00:02:01.000Z');

  const season = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
  };
  const activeSeason = {
    ...season,
    tradeFeeRate: new Prisma.Decimal('0.001000'),
  };

  const participant = {
    id: 'sp-1',
    participantStatus: ParticipantStatus.active,
    joinedAt,
  };

  const createPrisma = () => ({
    season: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    seasonParticipant: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    order: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    asset: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    fxRateSnapshot: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
    },
    cashWallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    fxExecuteRequest: {
      create: jest.fn(),
      update: jest.fn(),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    position: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new OrdersService(prisma as never);

    return { prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const mockActiveSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
  };

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
  };

  const mockAsset = (
    prisma: ReturnType<typeof createPrisma>,
    currencyCode = CurrencyCode.USD,
  ) => {
    prisma.asset.findUnique.mockResolvedValueOnce({
      id: 'asset-1',
      symbol: currencyCode === CurrencyCode.USD ? 'AAPL' : '005930',
      name: currencyCode === CurrencyCode.USD ? 'Apple Inc.' : 'Samsung',
      market: currencyCode === CurrencyCode.USD ? 'NASDAQ' : 'KRX',
      currencyCode,
      isActive: true,
    });
  };

  const mockAssetPrice = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'aps-1',
      price: new Prisma.Decimal('100.00000000'),
    });
  };

  const mockFreshFx = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'fx-1',
      rate: new Prisma.Decimal('1400.00000000'),
      effectiveAt: new Date(Date.now()),
    });
  };

  const mockCashWallet = (
    prisma: ReturnType<typeof createPrisma>,
    balance = '1000.00000000',
  ) => {
    prisma.cashWallet.findUnique.mockResolvedValueOnce({
      balanceAmount: new Prisma.Decimal(balance),
    });
  };

  const mockPosition = (
    prisma: ReturnType<typeof createPrisma>,
    quantity = '10.00000000',
  ) => {
    prisma.position.findUnique.mockResolvedValueOnce({
      quantity: new Prisma.Decimal(quantity),
    });
  };

  const mockOrders = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-1',
        side: OrderSide.buy,
        orderType: OrderType.market,
        status: OrderStatus.executed,
        quantity: new Prisma.Decimal('3.00000000'),
        limitPrice: null,
        executedPrice: new Prisma.Decimal('101.25000000'),
        currencyCode: CurrencyCode.USD,
        grossAmount: new Prisma.Decimal('303.75000000'),
        feeAmount: new Prisma.Decimal('0.30375000'),
        netAmount: new Prisma.Decimal('304.05375000'),
        assetPriceSnapshotId: 'aps-1',
        fxRateSnapshotId: 'fx-1',
        submittedAt,
        executedAt,
        canceledAt: null,
        rejectedAt: null,
        rejectReason: null,
        createdAt,
        updatedAt,
        asset: {
          id: 'asset-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          market: 'NASDAQ',
          currencyCode: CurrencyCode.USD,
        },
      },
    ]);
  };

  const expectNoOrderWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.order,
      prisma.asset,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.cashWallet,
      prisma.position,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  const expectOnlyOrderCreateWrite = (
    prisma: ReturnType<typeof createPrisma>,
  ) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.asset,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.cashWallet,
      prisma.position,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.order.delete).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('quotes market buy orders without mutating DB', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.USD);
    mockAssetPrice(prisma);
    mockFreshFx(prisma);
    mockCashWallet(prisma);

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'market',
      quantity: '2.00000000',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      asset: {
        id: 'asset-1',
        currencyCode: CurrencyCode.USD,
      },
      side: OrderSide.buy,
      orderType: OrderType.market,
      quantity: '2.00000000',
      price: '100.00000000',
      grossAmount: '200.00000000',
      feeRate: '0.001000',
      feeAmount: '0.20000000',
      netAmount: '200.20000000',
      krwGrossAmount: '280000.00000000',
      krwFeeAmount: '280.00000000',
      krwNetAmount: '280280.00000000',
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: 'fx-1',
      quoteId: null,
      expiresAt: null,
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('quotes limit buy orders using limitPrice', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'limit',
      quantity: '3.00000000',
      limitPrice: '50000.00000000',
      currencyCode: CurrencyCode.KRW,
    });

    expect(response.data).toMatchObject({
      orderType: OrderType.limit,
      price: '50000.00000000',
      currencyCode: CurrencyCode.KRW,
      grossAmount: '150000.00000000',
      feeAmount: '150.00000000',
      netAmount: '150150.00000000',
      krwNetAmount: '150150.00000000',
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('quotes sell orders after checking position quantity', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockPosition(prisma, '5.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-1',
      side: 'sell',
      orderType: 'limit',
      quantity: '2.00000000',
      limitPrice: '10000.00000000',
    });

    expect(response.data).toMatchObject({
      side: OrderSide.sell,
      grossAmount: '20000.00000000',
      feeAmount: '20.00000000',
      netAmount: '19980.00000000',
    });
    expect(prisma.position.findUnique).toHaveBeenCalledWith({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
        },
      },
      select: {
        quantity: true,
      },
    });
    expectNoOrderWrites(prisma);
  });

  it('rejects quote when market price is unavailable', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
  });

  it('rejects quote when USD/KRW FX is unavailable or stale', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.USD);
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    const retry = createService();
    mockActiveSeason(retry.prisma);
    mockJoined(retry.prisma);
    mockAsset(retry.prisma, CurrencyCode.USD);
    retry.prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'fx-1',
      rate: new Prisma.Decimal('1400.00000000'),
      effectiveAt: new Date(Date.now() - 61_000),
    });

    await expect(
      retry.service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
    expectNoOrderWrites(retry.prisma);
  });

  it('rejects quote when buy cash balance is insufficient', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '10.00000000');

    await expect(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
  });

  it('creates submitted market order without wallet, position, or settlement writes', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.USD);
    mockAssetPrice(prisma);
    mockFreshFx(prisma);
    mockCashWallet(prisma);
    prisma.order.create.mockResolvedValueOnce({
      id: 'order-submitted-1',
      side: OrderSide.buy,
      orderType: OrderType.market,
      status: OrderStatus.submitted,
      quantity: new Prisma.Decimal('2.00000000'),
      limitPrice: null,
      executedPrice: null,
      currencyCode: CurrencyCode.USD,
      grossAmount: new Prisma.Decimal('200.00000000'),
      feeAmount: new Prisma.Decimal('0.20000000'),
      netAmount: new Prisma.Decimal('200.20000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: 'fx-1',
      submittedAt,
      executedAt: null,
      canceledAt: null,
      rejectedAt: null,
      rejectReason: null,
      createdAt,
      updatedAt,
      asset: {
        id: 'asset-1',
        symbol: 'AAPL',
        name: 'Apple Inc.',
        market: 'NASDAQ',
        currencyCode: CurrencyCode.USD,
      },
    });

    const response = await service.createOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'market',
      quantity: '2.00000000',
    });

    expect(response.data).toMatchObject({
      order: {
        orderId: 'order-submitted-1',
        status: OrderStatus.submitted,
        executedAt: null,
        grossAmount: '200.00000000',
        feeAmount: '0.20000000',
        netAmount: '200.20000000',
        assetPriceSnapshotId: 'aps-1',
        fxRateSnapshotId: 'fx-1',
      },
      execution: {
        state: 'not_executed',
        reason: 'ORDER_EXECUTION_NOT_IMPLEMENTED',
      },
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          status: OrderStatus.submitted,
          quantity: '2.00000000',
          limitPrice: null,
          executedPrice: null,
          grossAmount: '200.00000000',
          feeAmount: '0.20000000',
          netAmount: '200.20000000',
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: 'fx-1',
          executedAt: null,
          canceledAt: null,
          rejectedAt: null,
        }),
      }),
    );
    expectOnlyOrderCreateWrite(prisma);
  });

  it('creates submitted limit order with limitPrice', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    prisma.order.create.mockResolvedValueOnce({
      id: 'order-submitted-2',
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: new Prisma.Decimal('1.00000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      executedPrice: null,
      currencyCode: CurrencyCode.KRW,
      grossAmount: new Prisma.Decimal('50000.00000000'),
      feeAmount: new Prisma.Decimal('50.00000000'),
      netAmount: new Prisma.Decimal('50050.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
      submittedAt,
      executedAt: null,
      canceledAt: null,
      rejectedAt: null,
      rejectReason: null,
      createdAt,
      updatedAt,
      asset: {
        id: 'asset-1',
        symbol: '005930',
        name: 'Samsung',
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
      },
    });

    const response = await service.createOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'limit',
      quantity: '1.00000000',
      limitPrice: '50000.00000000',
    });

    expect(response.data.order).toMatchObject({
      orderId: 'order-submitted-2',
      status: OrderStatus.submitted,
      limitPrice: '50000.00000000',
      assetPriceSnapshotId: null,
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          limitPrice: '50000.00000000',
          assetPriceSnapshotId: null,
          fxRateSnapshotId: null,
        }),
      }),
    );
    expectOnlyOrderCreateWrite(prisma);
  });

  it('returns order rows for the authenticated participant', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockOrders(prisma);

    const response = await service.getOrders('user-1', {
      status: 'executed',
      side: 'buy',
      assetId: 'asset-1',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      filters: {
        status: OrderStatus.executed,
        side: OrderSide.buy,
        assetId: 'asset-1',
      },
      pagination: {
        limit: 50,
        offset: 0,
        total: 1,
        returned: 1,
      },
      orders: [
        {
          orderId: 'order-1',
          asset: {
            id: 'asset-1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
          },
          side: OrderSide.buy,
          orderType: OrderType.market,
          status: OrderStatus.executed,
          quantity: '3.00000000',
          limitPrice: null,
          executedPrice: '101.25000000',
          currencyCode: CurrencyCode.USD,
          grossAmount: '303.75000000',
          feeAmount: '0.30375000',
          netAmount: '304.05375000',
          submittedAt: '2026-05-07T00:01:00.000Z',
          executedAt: '2026-05-07T00:02:00.000Z',
        },
      ],
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          status: OrderStatus.executed,
          side: OrderSide.buy,
          assetId: 'asset-1',
        },
      }),
    );
    expectNoOrderWrites(prisma);
  });

  it('reads submitted orders created by the create MVP', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-submitted-1',
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        quantity: new Prisma.Decimal('1.00000000'),
        limitPrice: new Prisma.Decimal('50000.00000000'),
        executedPrice: null,
        currencyCode: CurrencyCode.KRW,
        grossAmount: new Prisma.Decimal('50000.00000000'),
        feeAmount: new Prisma.Decimal('50.00000000'),
        netAmount: new Prisma.Decimal('50050.00000000'),
        assetPriceSnapshotId: null,
        fxRateSnapshotId: null,
        submittedAt,
        executedAt: null,
        canceledAt: null,
        rejectedAt: null,
        rejectReason: null,
        createdAt,
        updatedAt,
        asset: {
          id: 'asset-1',
          symbol: '005930',
          name: 'Samsung',
          market: 'KRX',
          currencyCode: CurrencyCode.KRW,
        },
      },
    ]);

    const response = await service.getOrders('user-1', {
      status: 'submitted',
    });

    expect(response.data.orders).toMatchObject([
      {
        orderId: 'order-submitted-1',
        status: OrderStatus.submitted,
        executedAt: null,
        limitPrice: '50000.00000000',
        grossAmount: '50000.00000000',
        feeAmount: '50.00000000',
        netAmount: '50050.00000000',
      },
    ]);
    expectNoOrderWrites(prisma);
  });

  it('returns not_joined without reading order rows', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getOrders('user-1', {});

    expect(response.data).toMatchObject({
      state: 'not_joined',
      orders: [],
      reason: 'SEASON_NOT_JOINED',
    });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('returns unavailable when no current season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getOrders('user-1', {});

    expect(response.data).toMatchObject({
      state: 'unavailable',
      season: null,
      orders: [],
      reason: 'CURRENT_SEASON_NOT_FOUND',
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoOrderWrites(prisma);
  });

  it('uses explicit seasonId and clamps limit to max 100', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    mockJoined(prisma);
    mockOrders(prisma);

    const response = await service.getOrders('user-1', {
      seasonId: 'season-1',
      limit: '200',
      offset: '5',
    });

    expect(response.data.pagination).toMatchObject({
      limit: 100,
      offset: 5,
    });
    expect(prisma.season.findUnique).toHaveBeenCalledWith({
      where: {
        id: 'season-1',
      },
      select: {
        id: true,
        name: true,
        status: true,
        startAt: true,
        endAt: true,
      },
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 100,
      }),
    );
    expectNoOrderWrites(prisma);
  });

  it('rejects invalid status, side, limit, and offset', async () => {
    const { service } = createService();

    await expect(
      service.getOrders('user-1', { status: 'pending' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getOrders('user-1', { side: 'hold' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getOrders('user-1', { limit: '0' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getOrders('user-1', { offset: '-1' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getOrders(undefined, {})).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rejects quote and create without authenticated user', async () => {
    const { service } = createService();

    await expect(
      service.quoteOrder(undefined, {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder(undefined, {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects create when user has not joined the active season', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('rejects invalid create request body fields', async () => {
    const { service } = createService();

    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'hold',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'stop',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '0',
        limitPrice: '100.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
