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
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
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
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonRankingType,
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
  const canceledAt = new Date('2026-05-07T00:03:00.000Z');
  const createdAt = new Date('2026-05-07T00:01:01.000Z');
  const snapshotDate = new Date('2026-05-31T00:00:00.000Z');
  const capturedAt = new Date('2026-05-31T00:00:30.000Z');

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

  const detailedParticipant = {
    ...participant,
    participantStatus: ParticipantStatus.finished,
    initialCapitalKrw: new Prisma.Decimal('10000000.00000000'),
    maxDrawdown: new Prisma.Decimal('3.00000000'),
    currentRank: 2,
    finalRank: 1,
    finalTier: 'master',
    rewardGrantedAt: new Date('2026-05-31T00:00:00.000Z'),
    seasonRankings: [
      {
        totalAssetKrw: new Prisma.Decimal('12000000.00000000'),
        returnRate: new Prisma.Decimal('20.00000000'),
        rankingDate: snapshotDate,
        capturedAt,
      },
    ],
    dailyPortfolioSnapshots: [
      {
        totalAssetKrw: new Prisma.Decimal('11900000.00000000'),
        returnRate: new Prisma.Decimal('19.00000000'),
        snapshotDate,
        capturedAt,
      },
    ],
    _count: {
      orders: 10,
      exchangeTransactions: 2,
      walletTransactions: 13,
    },
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
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    position: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    exchangeTransaction: {
      count: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      findMany: jest.fn(),
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
    user: {
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
    const service = new RecordsService(prisma as never);

    return { prisma, service };
  };

  const mockCurrentSeason = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.season.findFirst.mockResolvedValueOnce(season);
  };

  const mockJoined = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
  };

  const mockDetailedParticipant = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(
      detailedParticipant,
    );
  };

  const mockSeasonHistory = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.seasonParticipant.count.mockResolvedValueOnce(1);
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([
      {
        ...detailedParticipant,
        seasonId: season.id,
        season: {
          id: season.id,
          name: season.name,
          status: SeasonStatus.settled,
        },
      },
    ]);
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

  const mockOrderWalletRecords = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.walletTransaction.count.mockResolvedValueOnce(1);
    prisma.walletTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'wt-order-buy-1',
        walletId: 'wallet-1',
        currencyCode: CurrencyCode.KRW,
        direction: WalletTransactionDirection.debit,
        txType: WalletTransactionType.order_buy,
        referenceType: WalletTransactionReferenceType.order,
        referenceId: 'order-1',
        amount: new Prisma.Decimal('200.20000000'),
        balanceAfter: new Prisma.Decimal('799.80000000'),
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
        rejectReason: null,
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
          market: 'NASDAQ',
          assetType: AssetType.us_stock,
        },
      },
    ]);
  };

  const mockCanceledOrderRecords = (
    prisma: ReturnType<typeof createPrisma>,
  ) => {
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-canceled-1',
        submittedAt: occurredAt,
        executedAt: null,
        canceledAt,
        rejectedAt: null,
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.canceled,
        quantity: new Prisma.Decimal('2.50000000'),
        limitPrice: new Prisma.Decimal('100.00000000'),
        executedPrice: null,
        currencyCode: CurrencyCode.USD,
        grossAmount: new Prisma.Decimal('250.00000000'),
        feeAmount: new Prisma.Decimal('0.25000000'),
        netAmount: new Prisma.Decimal('250.25000000'),
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

  const mockSeasonOrderRecords = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-1',
        assetId: 'asset-1',
        submittedAt: occurredAt,
        executedAt: new Date('2026-05-07T00:02:00.000Z'),
        canceledAt: null,
        rejectedAt: null,
        rejectReason: null,
        side: OrderSide.buy,
        orderType: OrderType.market,
        status: OrderStatus.executed,
        quantity: new Prisma.Decimal('1.00000000'),
        limitPrice: null,
        executedPrice: new Prisma.Decimal('190.00000000'),
        currencyCode: CurrencyCode.USD,
        grossAmount: new Prisma.Decimal('190.00000000'),
        feeAmount: new Prisma.Decimal('0.19000000'),
        netAmount: new Prisma.Decimal('190.19000000'),
        asset: {
          symbol: 'AAPL',
          name: 'Apple Inc.',
          market: 'NASDAQ',
          assetType: AssetType.us_stock,
        },
      },
    ]);
  };

  const mockSeasonExchangeRecords = (
    prisma: ReturnType<typeof createPrisma>,
  ) => {
    prisma.exchangeTransaction.count.mockResolvedValueOnce(1);
    prisma.exchangeTransaction.findMany.mockResolvedValueOnce([
      {
        id: 'ex-1',
        fromCurrency: CurrencyCode.KRW,
        toCurrency: CurrencyCode.USD,
        sourceAmount: new Prisma.Decimal('145000.00000000'),
        grossTargetAmount: new Prisma.Decimal('100.00000000'),
        feeRate: new Prisma.Decimal('0.001000'),
        feeAmount: new Prisma.Decimal('0.10000000'),
        feeCurrency: CurrencyCode.USD,
        appliedRate: new Prisma.Decimal('1450.00000000'),
        netTargetAmount: new Prisma.Decimal('99.90000000'),
        executedAt: occurredAt,
      },
    ]);
  };

  const profitPosition = (input: {
    assetId: string;
    symbol: string;
    quantity: string;
    averageCost: string;
    realizedPnl?: string;
    realizedPnlKrw?: string;
    currencyCode?: CurrencyCode;
    assetType?: AssetType;
    market?: string;
  }) => {
    const currencyCode = input.currencyCode ?? CurrencyCode.KRW;
    const assetType = input.assetType ?? AssetType.domestic_stock;

    return {
      id: `position-${input.assetId}`,
      assetId: input.assetId,
      quantity: new Prisma.Decimal(input.quantity),
      averageCost: new Prisma.Decimal(input.averageCost),
      currencyCode,
      realizedPnl: new Prisma.Decimal(input.realizedPnl ?? '0.00000000'),
      realizedPnlKrw: new Prisma.Decimal(
        input.realizedPnlKrw ?? input.realizedPnl ?? '0.00000000',
      ),
      asset: {
        id: input.assetId,
        symbol: input.symbol,
        name: `${input.symbol} Name`,
        market:
          input.market ??
          (currencyCode === CurrencyCode.USD ? 'NASDAQ' : 'KRX'),
        assetType,
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
    sourceType: AssetPriceSourceType.admin_manual,
    sourceName: 'manual-price',
    effectiveAt: new Date(Date.now() - 1_000),
    capturedAt: new Date(Date.now() - 1_000),
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

  const mockEmptyProfitInputs = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([]);
    prisma.position.findMany.mockResolvedValueOnce([]);
  };

  const mockPublicPortfolioInputs = (
    prisma: ReturnType<typeof createPrisma>,
    positions: ReturnType<typeof profitPosition>[],
  ) => {
    prisma.position.findMany.mockResolvedValueOnce(positions);
    prisma.cashWallet.findMany.mockResolvedValueOnce([
      {
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal('1000000.00000000'),
      },
      {
        currencyCode: CurrencyCode.USD,
        balanceAmount: new Prisma.Decimal('0.00000000'),
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
      prisma.position,
      prisma.cashWallet,
      prisma.assetPriceSnapshot,
      prisma.fxRateSnapshot,
      prisma.dailyPortfolioSnapshot,
      prisma.user,
    ]) {
      expect(model.create).not.toHaveBeenCalled();
      expect(model.update).not.toHaveBeenCalled();
      if ('updateMany' in model) {
        expect(model.updateMany).not.toHaveBeenCalled();
      }
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

  it('returns order wallet transaction records', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockOrderWalletRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'wallets',
    });

    expect(response.data.walletTransactions).toMatchObject({
      state: 'available',
      records: [
        {
          walletTransactionId: 'wt-order-buy-1',
          walletId: 'wallet-1',
          currencyCode: CurrencyCode.KRW,
          direction: WalletTransactionDirection.debit,
          transactionType: WalletTransactionType.order_buy,
          amount: '200.20000000',
          balanceAfter: '799.80000000',
          referenceType: WalletTransactionReferenceType.order,
          referenceId: 'order-1',
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

  it('returns canceled order records from actual order rows', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockCanceledOrderRecords(prisma);

    const response = await service.getRecords('user-1', {
      type: 'orders',
      currencyCode: 'USD',
    });

    expect(response.data.orders).toMatchObject({
      state: 'available',
      records: [
        {
          orderId: 'order-canceled-1',
          submittedAt: '2026-05-07T00:01:00.000Z',
          executedAt: null,
          canceledAt: '2026-05-07T00:03:00.000Z',
          rejectedAt: null,
          assetId: 'asset-1',
          symbol: 'AAPL',
          status: OrderStatus.canceled,
          quantity: '2.50000000',
          grossAmount: '250.00000000',
          feeAmount: '0.25000000',
          netAmount: '250.25000000',
        },
      ],
    });
    expectNoRecordWrites(prisma);
  });

  it('includes canceled order records for type all', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    mockExchangeRecords(prisma);
    mockWalletRecords(prisma);
    mockCanceledOrderRecords(prisma);

    const response = await service.getRecords('user-1', {});

    expect(response.data.orders).toMatchObject({
      state: 'available',
      records: [
        {
          orderId: 'order-canceled-1',
          status: OrderStatus.canceled,
          canceledAt: '2026-05-07T00:03:00.000Z',
        },
      ],
    });
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

  it('returns authenticated user season history records', async () => {
    const { prisma, service } = createService();
    mockSeasonHistory(prisma);

    const response = await service.getMySeasonRecords('user-1', {});

    expect(response.data).toMatchObject({
      state: 'available',
      seasons: [
        {
          seasonId: 'season-1',
          seasonName: 'Season 1',
          seasonStatus: SeasonStatus.settled,
          participantStatus: ParticipantStatus.finished,
          initialCapitalKrw: '10000000.00000000',
          finalRank: 1,
          finalTier: 'master',
          latestTotalAssetKrw: '12000000.00000000',
          latestReturnRate: '20.00000000',
          orderCount: 10,
          exchangeCount: 2,
          walletTransactionCount: 13,
        },
      ],
      pagination: {
        limit: 50,
        offset: 0,
        total: 1,
        returned: 1,
        nextOffset: null,
      },
    });
    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
        },
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('returns empty state when authenticated user has no season history', async () => {
    const { prisma, service } = createService();
    prisma.seasonParticipant.count.mockResolvedValueOnce(0);

    const response = await service.getMySeasonRecords('user-1', {});

    expect(response.data).toMatchObject({
      state: 'empty',
      seasons: [],
      pagination: {
        returned: 0,
      },
    });
    expect(prisma.seasonParticipant.findMany).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('applies seasonStatus filter for season history records', async () => {
    const { prisma, service } = createService();
    mockSeasonHistory(prisma);

    await service.getMySeasonRecords('user-1', {
      seasonStatus: 'settled',
    });

    expect(prisma.seasonParticipant.count).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        season: {
          status: SeasonStatus.settled,
        },
      },
    });
    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          season: {
            status: SeasonStatus.settled,
          },
        },
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('validates and clamps season history limit and offset', async () => {
    const { prisma, service } = createService();

    await expect(
      service.getMySeasonRecords('user-1', { limit: '0' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getMySeasonRecords('user-1', { offset: '-1' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getMySeasonRecords('user-1', { seasonStatus: 'paused' }),
    ).rejects.toBeInstanceOf(HttpException);

    prisma.seasonParticipant.count.mockResolvedValueOnce(1);
    prisma.seasonParticipant.findMany.mockResolvedValueOnce([]);

    const response = await service.getMySeasonRecords('user-1', {
      limit: '200',
      offset: '5',
    });

    expect(response.data.pagination).toEqual({
      limit: 100,
      offset: 5,
      total: 1,
      returned: 0,
      nextOffset: null,
    });
    expect(prisma.seasonParticipant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 100,
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('returns authenticated user season record detail', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    mockDetailedParticipant(prisma);
    prisma.order.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);
    prisma.position.count.mockResolvedValueOnce(3);
    prisma.dailyPortfolioSnapshot.findMany.mockResolvedValueOnce([
      {
        seasonParticipantId: 'sp-1',
        snapshotDate: new Date('2026-05-01T00:00:00.000Z'),
        totalAssetKrw: new Prisma.Decimal('10000000.00000000'),
        returnRate: new Prisma.Decimal('0.00000000'),
        capturedAt: new Date('2026-05-01T00:00:01.000Z'),
        createdAt: new Date('2026-05-01T00:00:01.000Z'),
      },
      {
        seasonParticipantId: 'sp-1',
        snapshotDate: new Date('2026-05-02T00:00:00.000Z'),
        totalAssetKrw: new Prisma.Decimal('9500000.00000000'),
        returnRate: new Prisma.Decimal('-5.00000000'),
        capturedAt: new Date('2026-05-02T00:00:01.000Z'),
        createdAt: new Date('2026-05-02T00:00:01.000Z'),
      },
    ]);
    prisma.position.findMany.mockResolvedValueOnce([
      profitPosition({
        assetId: 'asset-open',
        symbol: 'OPEN',
        quantity: '2.00000000',
        averageCost: '100.00000000',
        realizedPnl: '1000.00000000',
        realizedPnlKrw: '1000.00000000',
      }),
      profitPosition({
        assetId: 'asset-sold',
        symbol: 'SOLD',
        quantity: '0.00000000',
        averageCost: '100.00000000',
        realizedPnl: '5000.00000000',
        realizedPnlKrw: '5000.00000000',
      }),
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
      priceSnapshot('price-open', '130.00000000'),
    );

    const response = await service.getMySeasonRecordDetail(
      'user-1',
      'season-1',
    );

    expect(response.data).toMatchObject({
      state: 'available',
      season: {
        id: 'season-1',
      },
      participant: {
        id: 'sp-1',
        finalRank: 1,
        finalTier: 'master',
      },
      performance: {
        state: 'available',
        totalAssetKrw: '11900000.00000000',
        returnRate: '19.00000000',
        maxDrawdown: '5.00000000',
        snapshotDate: '2026-05-31',
      },
      activitySummary: {
        orders: {
          total: 10,
          submitted: 0,
          executed: 8,
          canceled: 2,
          rejected: 0,
        },
        exchanges: {
          total: 2,
        },
        walletTransactions: {
          total: 13,
        },
        positions: {
          open: 3,
        },
      },
      profitAnalysis: {
        state: 'available',
        totalRealizedPnlKrw: '6000.00000000',
        totalUnrealizedPnlKrw: '60.00000000',
        totalPnlKrw: '6060.00000000',
        bestAsset: {
          assetId: 'asset-sold',
          totalPnlKrw: '5000.00000000',
          positionState: 'fully_sold',
        },
        worstAsset: {
          assetId: 'asset-open',
          totalPnlKrw: '1060.00000000',
          positionState: 'open',
        },
      },
    });
    expectNoRecordWrites(prisma);
  });

  it('throws SEASON_NOT_FOUND for missing season detail', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.getMySeasonRecordDetail('user-1', 'missing-season'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.seasonParticipant.findUnique).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('returns not_joined for existing season detail without participant', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getMySeasonRecordDetail(
      'user-1',
      'season-1',
    );

    expect(response.data).toMatchObject({
      state: 'not_joined',
      participant: null,
      performance: {
        state: 'unavailable',
      },
      activitySummary: {
        orders: {
          total: 0,
        },
      },
    });
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(prisma.position.count).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('returns unavailable performance without fake fallback when snapshots and rankings are missing', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...detailedParticipant,
      seasonRankings: [],
      dailyPortfolioSnapshots: [],
      _count: {
        orders: 0,
        exchangeTransactions: 0,
        walletTransactions: 0,
      },
    });
    prisma.order.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    prisma.position.count.mockResolvedValueOnce(0);
    mockEmptyProfitInputs(prisma);

    const response = await service.getMySeasonRecordDetail(
      'user-1',
      'season-1',
    );

    expect(response.data.performance).toMatchObject({
      state: 'unavailable',
      totalAssetKrw: null,
      returnRate: null,
      reason: 'PERFORMANCE_UNAVAILABLE',
    });
    expectNoRecordWrites(prisma);
  });

  it('returns only authenticated user participant orders and applies filters', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    mockJoined(prisma);
    mockSeasonOrderRecords(prisma);

    const response = await service.getMySeasonOrders('user-1', 'season-1', {
      status: 'executed',
      side: 'buy',
      assetId: 'asset-1',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      seasonId: 'season-1',
      orders: [
        {
          orderId: 'order-1',
          assetId: 'asset-1',
          symbol: 'AAPL',
          market: 'NASDAQ',
          assetType: AssetType.us_stock,
          status: OrderStatus.executed,
          side: OrderSide.buy,
          grossAmount: '190.00000000',
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
    expectNoRecordWrites(prisma);
  });

  it('returns not_joined with empty order records for an unjoined season', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(null);

    const response = await service.getMySeasonOrders('user-1', 'season-1', {});

    expect(response.data).toMatchObject({
      state: 'not_joined',
      orders: [],
    });
    expect(prisma.order.findMany).not.toHaveBeenCalled();
    expectNoRecordWrites(prisma);
  });

  it('returns only authenticated user participant exchanges and applies currency filters', async () => {
    const { prisma, service } = createService();
    prisma.season.findUnique.mockResolvedValueOnce(season);
    mockJoined(prisma);
    mockSeasonExchangeRecords(prisma);

    const response = await service.getMySeasonExchanges('user-1', 'season-1', {
      fromCurrency: 'KRW',
      toCurrency: 'USD',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      seasonId: 'season-1',
      exchanges: [
        {
          exchangeId: 'ex-1',
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
          sourceAmount: '145000.00000000',
          netTargetAmount: '99.90000000',
        },
      ],
    });
    expect(prisma.exchangeTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          fromCurrency: CurrencyCode.KRW,
          toCurrency: CurrencyCode.USD,
        },
      }),
    );
    expectNoRecordWrites(prisma);
  });

  it('rejects invalid order and exchange filters', async () => {
    const { service } = createService();

    await expect(
      service.getMySeasonOrders('user-1', 'season-1', { status: 'filled' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getMySeasonOrders('user-1', 'season-1', { side: 'hold' }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.getMySeasonExchanges('user-1', 'season-1', {
        fromCurrency: 'EUR',
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('returns protected public user season summary without private ledgers', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-2',
      nickname: 'traderLee',
      profileImageUrl: null,
    });
    prisma.season.findUnique.mockResolvedValueOnce({
      ...season,
      status: SeasonStatus.settled,
    });
    mockDetailedParticipant(prisma);
    prisma.order.count.mockResolvedValueOnce(8);
    prisma.exchangeTransaction.count.mockResolvedValueOnce(2);
    mockPublicPortfolioInputs(prisma, [
      profitPosition({
        assetId: 'asset-1',
        symbol: 'AAA',
        quantity: '1.00000000',
        averageCost: '100.00000000',
      }),
      profitPosition({
        assetId: 'asset-2',
        symbol: 'BBB',
        quantity: '2.00000000',
        averageCost: '100.00000000',
      }),
      profitPosition({
        assetId: 'asset-3',
        symbol: 'CCC',
        quantity: '3.00000000',
        averageCost: '100.00000000',
      }),
      profitPosition({
        assetId: 'asset-4',
        symbol: 'DDD',
        quantity: '4.00000000',
        averageCost: '100.00000000',
      }),
      profitPosition({
        assetId: 'asset-5',
        symbol: 'EEE',
        quantity: '5.00000000',
        averageCost: '100.00000000',
      }),
      profitPosition({
        assetId: 'asset-6',
        symbol: 'FFF',
        quantity: '6.00000000',
        averageCost: '100.00000000',
      }),
    ]);
    for (const [id, price] of [
      ['price-1', '100.00000000'],
      ['price-2', '100.00000000'],
      ['price-3', '100.00000000'],
      ['price-4', '100.00000000'],
      ['price-5', '100.00000000'],
      ['price-6', '100.00000000'],
    ] as const) {
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        priceSnapshot(id, price),
      );
    }

    const response = await service.getUserSeasonRecordSummary(
      'user-1',
      'user-2',
      'season-1',
    );

    expect(response.data).toMatchObject({
      state: 'available',
      user: {
        id: 'user-2',
        nickname: 'traderLee',
      },
      season: {
        id: 'season-1',
        status: SeasonStatus.settled,
      },
      summary: {
        finalRank: 1,
        finalTier: 'master',
        rewardGranted: true,
        totalAssetKrw: '12000000.00000000',
        returnRate: '20.00000000',
        orderCount: 8,
        exchangeCount: 2,
      },
      publicPortfolioSummary: {
        state: 'available',
        topHoldings: [
          { symbol: 'FFF' },
          { symbol: 'EEE' },
          { symbol: 'DDD' },
          { symbol: 'CCC' },
          { symbol: 'BBB' },
        ],
      },
    });
    expect(response.data.publicPortfolioSummary.topHoldings).toHaveLength(5);
    expect(response.data).not.toHaveProperty('orders');
    expect(response.data).not.toHaveProperty('exchanges');
    const serialized = JSON.stringify(response.data);
    expect(serialized).not.toContain('walletId');
    expect(serialized).not.toContain('quantity');
    expect(serialized).not.toContain('averageCost');
    expect(serialized).not.toContain('balanceAmount');
    expect(serialized).not.toContain('assetId');
    expectNoRecordWrites(prisma);
  });

  it('redacts raw ids from public portfolio valuation errors', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'user-2',
      nickname: 'traderLee',
      profileImageUrl: null,
    });
    prisma.season.findUnique.mockResolvedValueOnce({
      ...season,
      status: SeasonStatus.settled,
    });
    mockDetailedParticipant(prisma);
    prisma.order.count.mockResolvedValueOnce(8);
    prisma.exchangeTransaction.count.mockResolvedValueOnce(2);
    mockPublicPortfolioInputs(prisma, [
      profitPosition({
        assetId: 'asset-private-1',
        symbol: 'AAA',
        quantity: '1.00000000',
        averageCost: '100.00000000',
      }),
    ]);

    const response = await service.getUserSeasonRecordSummary(
      'user-1',
      'user-2',
      'season-1',
    );

    expect(response.data.publicPortfolioSummary).toMatchObject({
      state: 'partial_unavailable',
      valuationErrors: [
        {
          symbol: 'AAA',
          name: 'AAA Name',
          market: 'KRX',
          assetType: AssetType.domestic_stock,
          code: 'ASSET_PRICE_UNAVAILABLE',
          message: 'Asset price snapshot is unavailable.',
        },
      ],
    });
    expect(JSON.stringify(response.data.publicPortfolioSummary)).not.toContain(
      'asset-private-1',
    );
    expectNoRecordWrites(prisma);
  });

  it('rejects missing authenticated user', async () => {
    const { service } = createService();

    await expect(service.getRecords(undefined, {})).rejects.toBeInstanceOf(
      HttpException,
    );
    await expect(
      service.getMySeasonRecords(undefined, {}),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
