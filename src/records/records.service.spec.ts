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
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
      exchange_transaction: 'exchange_transaction',
      order: 'order',
      manual_adjustment: 'manual_adjustment',
      settlement: 'settlement',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      fee: 'fee',
      adjustment: 'adjustment',
      settlement: 'settlement',
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
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { RecordsService } from './records.service';

describe('RecordsService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const occurredAt = new Date('2026-05-07T00:01:00.000Z');
  const createdAt = new Date('2026-05-07T00:01:01.000Z');

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
    exchangeTransaction: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    walletTransaction: {
      count: jest.fn(),
      findMany: jest.fn(),
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
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new RecordsService(prisma as never);

    return { prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
  };

  const mockExchangeRecords = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.exchangeTransaction.count.mockResolvedValueOnce(1);
    prisma.exchangeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'ex-1',
        fxRateSnapshotId: 'fx-1',
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: new Prisma.Decimal('140000.00000000'),
        grossTargetAmount: new Prisma.Decimal('100.00000000'),
        feeRate: new Prisma.Decimal('0.001000'),
        feeAmount: new Prisma.Decimal('0.10000000'),
        feeCurrency: CurrencyCode.USD,
        appliedRate: new Prisma.Decimal('1400.00000000'),
        netTargetAmount: new Prisma.Decimal('99.90000000'),
        executedAt: occurredAt,
        createdAt,
      },
    ]);
  };

  const mockWalletRecords = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'wt-1',
        walletId: 'wallet-1',
        currencyCode: CurrencyCode.KRW,
        direction: WalletTransactionDirection.credit,
        txType: WalletTransactionType.initial_grant,
        referenceType: WalletTransactionReferenceType.season_join,
        referenceId: 'sp-1',
        amount: new Prisma.Decimal('10000000.00000000'),
        balanceAfter: new Prisma.Decimal('10000000.00000000'),
        occurredAt,
        createdAt,
      },
    ]);
  };

  const mockOrderRecords = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-1',
        submittedAt: occurredAt,
        executedAt: null,
        canceledAt: null,
        rejectedAt: null,
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        quantity: new Prisma.Decimal('2.50000000'),
        limitPrice: new Prisma.Decimal('100.00000000'),
        executedPrice: null,
        currencyCode: CurrencyCode.USD,
        grossAmount: null,
        feeAmount: null,
        netAmount: null,
        assetPriceSnapshotId: null,
        fxRateSnapshotId: null,
        createdAt,
        asset: {
          id: 'asset-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
        },
      },
    ]);
  };

  const expectNoRecordWrites = (prisma: ReturnType<typeof createPrisma>) => {
    for (const model of [
      prisma.season,
      prisma.seasonParticipant,
      prisma.exchangeTransaction,
      prisma.walletTransaction,
      prisma.order,
      prisma.cashWallet,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  it('returns exchange records', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockExchangeRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'exchanges',
      currencyCode: 'KRW',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      type: 'exchanges',
      filters: {
        currencyCode: CurrencyCode.KRW,
      },
      exchanges: {
        state: 'available',
        pagination: {
          limit: 50,
          offset: 0,
          total: 1,
          returned: 1,
        },
        records: [
          {
            exchangeId: 'ex-1',
            fromCurrency: CurrencyCode.KRW,
            toCurrency: CurrencyCode.USD,
            sourceAmount: '140000.00000000',
            appliedRate: '1400.00000000',
            netTargetAmount: '99.90000000',
          },
        ],
      },
    });
    expect(prisma.exchangeTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          OR: [
            { fromCurrency: CurrencyCode.KRW },
            { toCurrency: CurrencyCode.KRW },
          ],
        },
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('returns wallet transaction records', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockWalletRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'wallets',
    });

    expect(response.data.walletTransactions).toMatchObject({
      state: 'available',
      records: [
        {
          walletTransactionId: 'wt-1',
          walletId: 'wallet-1',
          currencyCode: CurrencyCode.KRW,
          direction: WalletTransactionDirection.credit,
          transactionType: WalletTransactionType.initial_grant,
          amount: '10000000.00000000',
          balanceAfter: '10000000.00000000',
          referenceType: WalletTransactionReferenceType.season_join,
          referenceId: 'sp-1',
        },
      ],
    });
    expectNoRecordWrites(prisma);
  });

  it('returns exchange, wallet, and order sections for type all', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockExchangeRecords(prisma);
    mockWalletRecords(prisma);
    mockOrderRecords(prisma);

    const response = await service.getRecords('user-1', {});

    expect(response.data).toMatchObject({
      state: 'available',
      type: 'all',
      exchanges: {
        state: 'available',
      },
      walletTransactions: {
        state: 'available',
      },
      orders: {
        state: 'available',
        records: [
          {
            orderId: 'order-1',
            assetId: 'asset-1',
            symbol: 'AAPL',
            side: OrderSide.buy,
            orderType: OrderType.limit,
            status: OrderStatus.submitted,
            quantity: '2.50000000',
            limitPrice: '100.00000000',
          },
        ],
      },
    });
    expectNoRecordWrites(prisma);
  });

  it('returns order records from actual order rows', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockOrderRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'orders',
      currencyCode: 'USD',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      orders: {
        state: 'available',
        pagination: {
          limit: 50,
          offset: 0,
          total: 1,
          returned: 1,
        },
        records: [
          {
            orderId: 'order-1',
            submittedAt: '2026-05-07T00:01:00.000Z',
            executedAt: null,
            assetId: 'asset-1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
            side: OrderSide.buy,
            orderType: OrderType.limit,
            status: OrderStatus.submitted,
            quantity: '2.50000000',
            limitPrice: '100.00000000',
            currencyCode: CurrencyCode.USD,
          },
        ],
      },
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.USD,
        },
      }),
    );
    expect(prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('returns not_joined without reading records', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getRecords('user-1', {});

    expect(response.data).toMatchObject({
      state: 'not_joined',
      reason: 'SEASON_NOT_JOINED',
      exchanges: {
        records: [],
      },
      walletTransactions: {
        records: [],
      },
      orders: {
        state: 'available',
        records: [],
      },
    });
    expect(prisma.exchangeTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.findMany).not.toHaveBeenCalled();
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('returns unavailable when no current season exists', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValue(null);

    const response = await service.getRecords('user-1', {});

    expect(response.data).toMatchObject({
      state: 'unavailable',
      season: null,
      reason: 'CURRENT_SEASON_NOT_FOUND',
    });
    expect(prisma.season.findFirst).toHaveBeenCalledTimes(4);
    expectNoRecordWrites(prisma);
  });

  it('rejects invalid type, limit, offset, and currencyCode', async () => {
    const { service } = createService();

    await expect(
      service.getRecords('user-1', { type: 'positions' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getRecords('user-1', { limit: '0' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getRecords('user-1', { offset: '-1' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getRecords('user-1', { currencyCode: 'EUR' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('clamps limit to max 100', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockExchangeRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'exchanges',
      limit: '200',
    });

    expect(response.data.exchanges?.pagination.limit).toBe(100);
    expect(prisma.exchangeTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getRecords(undefined, {})).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
