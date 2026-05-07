jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
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
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
    },
    cashWallet: {
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

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
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
});
