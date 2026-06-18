jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
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
    QuoteStatus: {
      active: 'active',
      consumed: 'consumed',
      expired: 'expired',
      canceled: 'canceled',
    },
    QuoteType: {
      fx: 'fx',
      order: 'order',
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
import { createHash } from 'node:crypto';
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
  SeasonStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { computeOrderQuoteRequestHash } from '../providers/durable-quote.policy';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');
  const joinedAt = new Date('2026-05-02T00:00:00.000Z');
  const submittedAt = new Date('2026-05-07T00:01:00.000Z');
  const executedAt = new Date('2026-05-07T00:02:00.000Z');
  const canceledAt = new Date('2026-05-07T00:03:00.000Z');
  const createdAt = new Date('2026-05-07T00:01:01.000Z');
  const updatedAt = new Date('2026-05-07T00:02:01.000Z');
  const usMarketOpenAt = new Date('2026-05-07T14:00:00.000Z');
  const krxMarketOpenAt = new Date('2026-05-07T00:02:00.000Z');

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
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
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
    walletTransaction: {
      create: jest.fn(),
    },
    exchangeTransaction: {
      create: jest.fn(),
    },
    cashWallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    fxExecuteRequest: {
      create: jest.fn(),
      update: jest.fn(),
    },
    quote: {
      create: jest.fn().mockResolvedValue({ id: 'quote-order-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    equitySnapshot: {
      create: jest.fn(),
    },
    dailyPortfolioSnapshot: {
      create: jest.fn(),
    },
    seasonRanking: {
      create: jest.fn(),
    },
    position: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    $transaction: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    const service = new OrdersService(prisma as never);

    return { prisma, service };
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(usMarketOpenAt);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const useKrxMarketOpenTime = () => {
    jest.setSystemTime(krxMarketOpenAt);
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
      assetType:
        currencyCode === CurrencyCode.USD
          ? AssetType.us_stock
          : AssetType.domestic_stock,
      currencyCode,
      isActive: true,
    });
  };

  const mockBinanceCryptoAsset = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.asset.findUnique.mockResolvedValueOnce({
      id: 'asset-btc',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      isActive: true,
    });
  };

  const mockAssetPrice = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'aps-1',
      price: new Prisma.Decimal('100.00000000'),
      sourceName: 'manual-price',
      effectiveAt: new Date(Date.now()),
      capturedAt: new Date(Date.now()),
    });
  };

  const mockFreshFx = (prisma: ReturnType<typeof createPrisma>) => {
    prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
      id: 'fx-1',
      rate: new Prisma.Decimal('1400.00000000'),
      sourceName: 'manual-fx',
      effectiveAt: new Date(Date.now()),
      capturedAt: new Date(Date.now()),
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

  const hashOrderCreateRequest = (body: {
    assetId: string;
    side: OrderSide;
    orderType: OrderType;
    quantity: string;
    limitPrice?: string;
    currencyCode?: CurrencyCode;
    quoteId?: string;
  }) =>
    createHash('sha256')
      .update(
        JSON.stringify({
          apiVersion: 'order-create:v1',
          quoteId: body.quoteId ?? 'quote-order-create-1',
          assetId: body.assetId,
          side: body.side,
          orderType: body.orderType,
          quantity: new Prisma.Decimal(body.quantity).toFixed(8),
          limitPrice:
            body.orderType === OrderType.limit
              ? new Prisma.Decimal(body.limitPrice ?? '0').toFixed(8)
              : null,
          currencyCode: body.currencyCode ?? null,
        }),
        'utf8',
      )
      .digest('hex');

  const orderCreateBody = {
    assetId: 'asset-1',
    side: OrderSide.buy,
    orderType: OrderType.limit,
    quantity: '1.00000000',
    limitPrice: '50000.00000000',
    quoteId: 'quote-order-create-1',
    idempotencyKey: 'order-create-key-duplicate',
  };

  const buildOrderQuoteRecord = (overrides: Record<string, unknown> = {}) => {
    type QuoteAssetFixture = {
      id: string;
      symbol: string;
      name: string;
      market: string;
      assetType: AssetType;
      currencyCode: CurrencyCode;
      isActive: boolean;
    };
    const asset = (overrides.asset as QuoteAssetFixture | undefined) ?? {
      id: (overrides.assetId as string | undefined) ?? 'asset-1',
      symbol:
        (overrides.currencyCode as CurrencyCode | undefined) ===
        CurrencyCode.USD
          ? 'AAPL'
          : '005930',
      name:
        (overrides.currencyCode as CurrencyCode | undefined) ===
        CurrencyCode.USD
          ? 'Apple Inc.'
          : 'Samsung',
      market:
        (overrides.currencyCode as CurrencyCode | undefined) ===
        CurrencyCode.USD
          ? 'NASDAQ'
          : 'KRX',
      assetType:
        (overrides.currencyCode as CurrencyCode | undefined) ===
        CurrencyCode.USD
          ? AssetType.us_stock
          : AssetType.domestic_stock,
      currencyCode:
        (overrides.currencyCode as CurrencyCode | undefined) ??
        CurrencyCode.KRW,
      isActive: true,
    };
    const assetId = (overrides.assetId as string | undefined) ?? asset.id;
    const side = (overrides.side as OrderSide | undefined) ?? OrderSide.buy;
    const orderType =
      (overrides.orderType as OrderType | undefined) ?? OrderType.market;
    const quantity =
      (overrides.quantity as Prisma.Decimal | undefined) ??
      new Prisma.Decimal('2.00000000');
    const limitPrice =
      orderType === OrderType.limit
        ? ((overrides.limitPrice as Prisma.Decimal | undefined) ??
          new Prisma.Decimal('50000.00000000'))
        : null;
    const currencyCode =
      (overrides.currencyCode as CurrencyCode | undefined) ??
      (asset.currencyCode as CurrencyCode);
    const quotedPrice =
      (overrides.quotedPrice as Prisma.Decimal | undefined) ??
      (orderType === OrderType.limit && limitPrice
        ? limitPrice
        : new Prisma.Decimal('100.00000000'));
    const quotedRate =
      (overrides.quotedRate as Prisma.Decimal | null | undefined) ??
      (currencyCode === CurrencyCode.USD
        ? new Prisma.Decimal('1400.00000000')
        : null);
    const seasonParticipantId =
      (overrides.seasonParticipantId as string | undefined) ?? 'sp-1';
    const userId = (overrides.userId as string | undefined) ?? 'user-1';

    return {
      id: (overrides.id as string | undefined) ?? 'quote-order-1',
      userId,
      seasonParticipantId,
      status: (overrides.status as string | undefined) ?? 'active',
      assetId,
      side,
      orderType,
      quantity,
      limitPrice,
      currencyCode,
      quotedPrice,
      quotedRate,
      maxChangeBps:
        (overrides.maxChangeBps as Prisma.Decimal | undefined) ??
        new Prisma.Decimal('50.0000'),
      assetPriceSnapshotId:
        (overrides.assetPriceSnapshotId as string | null | undefined) ??
        (orderType === OrderType.market ? 'aps-1' : null),
      fxRateSnapshotId:
        (overrides.fxRateSnapshotId as string | null | undefined) ??
        (currencyCode === CurrencyCode.USD ? 'fx-1' : null),
      expiresAt:
        (overrides.expiresAt as Date | undefined) ??
        new Date('2099-01-01T00:00:00.000Z'),
      requestHash:
        (overrides.requestHash as string | undefined) ??
        computeOrderQuoteRequestHash({
          userId,
          seasonParticipantId,
          assetId,
          side,
          orderType,
          quantity,
          limitPrice,
          currencyCode,
        }),
      asset,
    };
  };

  const mockOrderQuoteForCreate = (
    prisma: ReturnType<typeof createPrisma>,
    overrides: Record<string, unknown> = {},
  ) => {
    prisma.quote.findFirst.mockResolvedValueOnce(
      buildOrderQuoteRecord({
        id: 'quote-order-create-1',
        ...overrides,
      }),
    );
  };

  const idempotentOrderRecord = (requestHash: string) => ({
    id: 'order-idempotent-1',
    requestHash,
    responsePayloadJson: {
      success: true,
      data: {
        order: {
          orderId: 'order-idempotent-1',
          status: OrderStatus.submitted,
        },
        execution: {
          state: 'not_executed',
          reason: 'ORDER_SUBMITTED_NOT_EXECUTED',
          message:
            'Order was submitted and can be executed through the execute endpoint.',
        },
      },
    },
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

  const orderExecutionRecord = (overrides: Record<string, unknown> = {}) => {
    const assetId = (overrides.assetId as string | undefined) ?? 'asset-1';
    const side = (overrides.side as OrderSide | undefined) ?? OrderSide.buy;
    const orderType =
      (overrides.orderType as OrderType | undefined) ?? OrderType.market;
    const quantity =
      (overrides.quantity as Prisma.Decimal | undefined) ??
      new Prisma.Decimal('2.00000000');
    const limitPrice =
      (overrides.limitPrice as Prisma.Decimal | null | undefined) ??
      (orderType === OrderType.limit
        ? new Prisma.Decimal('100.00000000')
        : null);
    const currencyCode =
      (overrides.currencyCode as CurrencyCode | undefined) ?? CurrencyCode.KRW;
    const asset = (overrides.asset as
      | {
          id: string;
          symbol: string;
          name: string;
          market: string;
          assetType?: AssetType;
          currencyCode: CurrencyCode;
          isActive?: boolean;
        }
      | undefined) ?? {
      id: assetId,
      symbol: currencyCode === CurrencyCode.USD ? 'AAPL' : '005930',
      name: currencyCode === CurrencyCode.USD ? 'Apple Inc.' : 'Samsung',
      market: currencyCode === CurrencyCode.USD ? 'NASDAQ' : 'KRX',
      assetType:
        currencyCode === CurrencyCode.USD
          ? AssetType.us_stock
          : AssetType.domestic_stock,
      currencyCode,
      isActive: true,
    };
    const quote = Object.prototype.hasOwnProperty.call(overrides, 'quote')
      ? (overrides.quote as ReturnType<typeof buildOrderQuoteRecord> | null)
      : buildOrderQuoteRecord({
          id: 'quote-order-execute-1',
          assetId,
          asset: {
            ...asset,
            assetType:
              asset.assetType ??
              (currencyCode === CurrencyCode.USD
                ? AssetType.us_stock
                : AssetType.domestic_stock),
            isActive: asset.isActive ?? true,
          },
          side,
          orderType,
          quantity,
          limitPrice,
          currencyCode,
          quotedPrice:
            orderType === OrderType.limit && limitPrice
              ? limitPrice
              : new Prisma.Decimal('100.00000000'),
          assetPriceSnapshotId: orderType === OrderType.market ? 'aps-1' : null,
          fxRateSnapshotId: currencyCode === CurrencyCode.USD ? 'fx-1' : null,
        });

    return {
      id: 'order-execute-1',
      seasonParticipantId: 'sp-1',
      assetId,
      quoteId: quote?.id ?? null,
      side,
      orderType,
      status: OrderStatus.submitted,
      quantity,
      limitPrice,
      executedPrice: null,
      currencyCode,
      grossAmount: new Prisma.Decimal('190.00000000'),
      feeAmount: new Prisma.Decimal('0.19000000'),
      netAmount: new Prisma.Decimal('190.19000000'),
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
        ...asset,
        assetType:
          asset.assetType ??
          (currencyCode === CurrencyCode.USD
            ? AssetType.us_stock
            : AssetType.domestic_stock),
      },
      quote,
      seasonParticipant: {
        ...participant,
        season: activeSeason,
      },
      ...overrides,
    };
  };

  const executedOrderExecutionRecord = (
    overrides: Record<string, unknown> = {},
  ) => ({
    ...orderExecutionRecord(),
    status: OrderStatus.executed,
    executedPrice: new Prisma.Decimal('100.00000000'),
    grossAmount: new Prisma.Decimal('200.00000000'),
    feeAmount: new Prisma.Decimal('0.20000000'),
    netAmount: new Prisma.Decimal('200.20000000'),
    assetPriceSnapshotId: 'aps-exec-1',
    executedAt,
    updatedAt,
    ...overrides,
  });

  const mockExecutionPrice = (
    prisma: ReturnType<typeof createPrisma>,
    price = '100.00000000',
    snapshotId = 'aps-exec-1',
    sourceName = 'kis_krx_realtime_trade',
  ) => {
    const providerNow = new Date(Date.now());
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: snapshotId,
        price: new Prisma.Decimal(price),
        sourceType: AssetPriceSourceType.provider_api,
        sourceName,
        effectiveAt: providerNow,
        capturedAt: providerNow,
      },
    ]);
  };

  const mockExecutionFx = (
    prisma: ReturnType<typeof createPrisma>,
    rate = '1400.00000000',
    snapshotId = 'fx-exec-1',
  ) => {
    const providerNow = new Date(Date.now());
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: snapshotId,
        rate: new Prisma.Decimal(rate),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: providerNow,
        capturedAt: providerNow,
      },
    ]);
  };

  const mockExecutionWallet = (
    prisma: ReturnType<typeof createPrisma>,
    before = '1000.00000000',
    after = '799.80000000',
    currencyCode = CurrencyCode.KRW,
  ) => {
    prisma.cashWallet.findUnique.mockResolvedValueOnce({
      id: 'wallet-1',
      seasonParticipantId: 'sp-1',
      currencyCode,
      balanceAmount: new Prisma.Decimal(before),
    });
    prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.cashWallet.findFirst.mockResolvedValueOnce({
      id: 'wallet-1',
      seasonParticipantId: 'sp-1',
      currencyCode,
      balanceAmount: new Prisma.Decimal(after),
    });
  };

  const mockOrderFinalization = (
    prisma: ReturnType<typeof createPrisma>,
    order = executedOrderExecutionRecord(),
  ) => {
    prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.order.findUnique.mockResolvedValueOnce(order);
  };

  const cryptoUsdOrderExecutionRecord = (
    overrides: Record<string, unknown> = {},
  ) => {
    const side = (overrides.side as OrderSide | undefined) ?? OrderSide.buy;
    const quantity =
      (overrides.quantity as Prisma.Decimal | undefined) ??
      new Prisma.Decimal('0.01000000');
    const asset = {
      id: 'asset-btc',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      market: 'BINANCE',
      assetType: AssetType.crypto,
      currencyCode: CurrencyCode.USD,
      isActive: true,
    };

    return orderExecutionRecord({
      id: 'order-btc-execute-1',
      assetId: 'asset-btc',
      side,
      quantity,
      currencyCode: CurrencyCode.USD,
      asset,
      quote: buildOrderQuoteRecord({
        id: 'quote-order-btc-execute-1',
        assetId: 'asset-btc',
        asset,
        side,
        orderType: OrderType.market,
        quantity,
        currencyCode: CurrencyCode.USD,
        quotedPrice: new Prisma.Decimal('50000.00000000'),
        assetPriceSnapshotId: 'aps-btc-1',
        fxRateSnapshotId: 'fx-1',
      }),
      ...overrides,
    });
  };

  const executedCryptoUsdOrderExecutionRecord = (
    overrides: Record<string, unknown> = {},
  ) =>
    executedOrderExecutionRecord({
      id: 'order-btc-execute-1',
      assetId: 'asset-btc',
      quoteId: 'quote-order-btc-execute-1',
      quantity: new Prisma.Decimal('0.01000000'),
      executedPrice: new Prisma.Decimal('50000.00000000'),
      currencyCode: CurrencyCode.USD,
      grossAmount: new Prisma.Decimal('500.00000000'),
      feeAmount: new Prisma.Decimal('0.50000000'),
      netAmount: new Prisma.Decimal('500.50000000'),
      assetPriceSnapshotId: 'aps-btc-exec-1',
      fxRateSnapshotId: 'fx-exec-1',
      asset: {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
        isActive: true,
      },
      ...overrides,
    });

  const getErrorCode = (error: unknown) => {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };

    return response.error.code;
  };

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);

    try {
      await promise;
    } catch (error) {
      expect(getErrorCode(error)).toBe(code);
    }
  };

  const expectNoForbiddenExecuteSideEffects = (
    prisma: ReturnType<typeof createPrisma>,
  ) => {
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
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
      if ('updateMany' in model) {
        expect(model.updateMany).not.toHaveBeenCalled();
      }
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
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
      if ('updateMany' in model) {
        expect(model.updateMany).not.toHaveBeenCalled();
      }
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.order.delete).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  };

  const expectOnlyOrderCancelWrite = (
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
      if ('updateMany' in model) {
        expect(model.updateMany).not.toHaveBeenCalled();
      }
      expect(model.upsert).not.toHaveBeenCalled();
      expect(model.delete).not.toHaveBeenCalled();
    }

    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.order.upsert).not.toHaveBeenCalled();
    expect(prisma.order.delete).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
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
      quoteId: 'quote-order-1',
      expiresAt: expect.any(String),
      maxChangeBps: '50.0000',
    });
    expect(
      new Date(response.data.expiresAt ?? '').getTime() -
        new Date(response.data.quoteAt).getTime(),
    ).toBe(10_000);
    expect(prisma.quote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          quoteType: 'order',
          status: 'active',
          userId: 'user-1',
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          side: OrderSide.buy,
          orderType: OrderType.market,
          quantity: '2.00000000',
          limitPrice: null,
          currencyCode: CurrencyCode.USD,
          quotedPrice: '100.00000000',
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: 'fx-1',
          maxChangeBps: '50.0000',
          expiresAt: expect.any(Date),
          requestHash: expect.any(String),
          assetPriceSourceJson: expect.objectContaining({
            sourceType: 'admin_manual',
            snapshotId: 'aps-1',
          }),
          fxRateSourceJson: expect.objectContaining({
            sourceType: 'admin_manual',
            snapshotId: 'fx-1',
          }),
        }),
      }),
    );
    const quoteWrite = prisma.quote.create.mock.calls[0][0].data;
    const expectedRequestHash = createHash('sha256')
      .update(
        JSON.stringify({
          apiVersion: 'order-quote:v1',
          userId: 'user-1',
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          side: OrderSide.buy,
          orderType: OrderType.market,
          quantity: '2.00000000',
          limitPrice: null,
          currencyCode: CurrencyCode.USD,
        }),
        'utf8',
      )
      .digest('hex');
    expect(quoteWrite.requestHash).toBe(expectedRequestHash);
    expect(JSON.stringify(quoteWrite.assetPriceSourceJson)).not.toMatch(
      /rawPayload|approval_key|access_token|KIS_APP_SECRET|DATABASE_URL/i,
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('uses fresh provider_api asset price and FX for orders quote only', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    prisma.asset.findUnique.mockResolvedValueOnce({
      id: 'asset-us',
      symbol: 'AAPL',
      name: 'Apple Inc.',
      market: 'NAS',
      assetType: AssetType.us_stock,
      currencyCode: CurrencyCode.USD,
      isActive: true,
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-us',
        price: new Prisma.Decimal('110.00000000'),
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_us_delayed_trade',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      },
    ]);
    prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-fx-usd-krw',
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      },
    ]);
    mockCashWallet(prisma, '1000.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-us',
      side: 'buy',
      orderType: 'market',
      quantity: '2.00000000',
    });

    expect(response.data).toMatchObject({
      price: '110.00000000',
      grossAmount: '220.00000000',
      krwGrossAmount: '330000.00000000',
      assetPriceSnapshotId: 'provider-price-us',
      fxRateSnapshotId: 'provider-fx-usd-krw',
      assetPriceSource: {
        sourceType: 'provider_api',
        sourceName: 'kis_us_delayed_trade',
        snapshotId: 'provider-price-us',
        fallbackUsed: false,
      },
      fxRateSource: {
        sourceType: 'provider_api',
        sourceName: 'exchange_rate_api',
        snapshotId: 'provider-fx-usd-krw',
        fallbackUsed: false,
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('falls back to admin_manual price when orders quote provider price is stale', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    prisma.asset.findUnique.mockResolvedValueOnce({
      id: 'asset-krx',
      symbol: '005930',
      name: 'Samsung',
      market: 'KRX',
      assetType: AssetType.domestic_stock,
      currencyCode: CurrencyCode.KRW,
      isActive: true,
    });
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-stale',
        price: new Prisma.Decimal('999.00000000'),
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_krx_realtime_trade',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 61_000),
      },
    ]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'admin-price-krx',
      price: new Prisma.Decimal('100.00000000'),
      sourceName: 'manual-close',
      effectiveAt: new Date(Date.now() - 1_000),
      capturedAt: new Date(Date.now() - 1_000),
    });
    mockCashWallet(prisma, '1000.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-krx',
      side: 'buy',
      orderType: 'market',
      quantity: '2.00000000',
    });

    expect(response.data).toMatchObject({
      price: '100.00000000',
      assetPriceSnapshotId: 'admin-price-krx',
      assetPriceSource: {
        sourceType: 'admin_manual',
        sourceName: 'manual-close',
        snapshotId: 'admin-price-krx',
        fallbackUsed: true,
        fallbackReason: 'provider_rejected',
        rejectedProviderReason: 'captured_at_stale',
      },
    });
    expectNoOrderWrites(prisma);
  });

  it('quotes Binance crypto USD buy orders against the USD wallet and USD/KRW FX', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockBinanceCryptoAsset(prisma);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'aps-btc-1',
      price: new Prisma.Decimal('50000.00000000'),
    });
    mockFreshFx(prisma);
    mockCashWallet(prisma, '1000.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-btc',
      side: 'buy',
      orderType: 'market',
      quantity: '0.01000000',
    });

    expect(response.data).toMatchObject({
      asset: {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
      },
      currencyCode: CurrencyCode.USD,
      grossAmount: '500.00000000',
      feeAmount: '0.50000000',
      netAmount: '500.50000000',
      krwGrossAmount: '700000.00000000',
      krwFeeAmount: '700.00000000',
      krwNetAmount: '700700.00000000',
      assetPriceSnapshotId: 'aps-btc-1',
      fxRateSnapshotId: 'fx-1',
    });
    expect(prisma.cashWallet.findUnique).toHaveBeenCalledWith({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.USD,
        },
      },
      select: {
        balanceAmount: true,
      },
    });
    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('quotes Binance crypto USD sell orders with USD net and KRW converted amounts', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockBinanceCryptoAsset(prisma);
    mockFreshFx(prisma);
    mockPosition(prisma, '0.02000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-btc',
      side: 'sell',
      orderType: 'limit',
      quantity: '0.01000000',
      limitPrice: '50000.00000000',
    });

    expect(response.data).toMatchObject({
      asset: {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
      },
      side: OrderSide.sell,
      currencyCode: CurrencyCode.USD,
      grossAmount: '500.00000000',
      feeAmount: '0.50000000',
      netAmount: '499.50000000',
      krwGrossAmount: '700000.00000000',
      krwFeeAmount: '700.00000000',
      krwNetAmount: '699300.00000000',
      fxRateSnapshotId: 'fx-1',
      assetPriceSource: {
        sourceType: null,
        fallbackReason: 'limit_price_provided',
      },
      fxRateSource: {
        sourceType: 'admin_manual',
        sourceName: 'manual-fx',
        snapshotId: 'fx-1',
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
      },
    });
    expect(prisma.position.findUnique).toHaveBeenCalledWith({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: 'sp-1',
          assetId: 'asset-btc',
        },
      },
      select: {
        quantity: true,
      },
    });
    expectNoOrderWrites(prisma);
  });

  it('quotes limit buy orders using limitPrice', async () => {
    useKrxMarketOpenTime();
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
      assetPriceSource: {
        sourceType: null,
        sourceName: null,
        snapshotId: null,
        fallbackUsed: false,
        fallbackReason: 'limit_price_provided',
      },
    });
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('quotes sell orders after checking position quantity', async () => {
    useKrxMarketOpenTime();
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
    useKrxMarketOpenTime();
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

  it('rejects order quote before the season starts or after it ends', async () => {
    const beforeStart = createService();
    beforeStart.prisma.season.findFirst.mockResolvedValueOnce({
      ...activeSeason,
      startAt: new Date('2026-05-08T00:00:00.000Z'),
    });

    await expectErrorCode(
      beforeStart.service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
      }),
      'SEASON_NOT_STARTED',
    );

    const afterEnd = createService();
    afterEnd.prisma.season.findFirst.mockResolvedValueOnce({
      ...activeSeason,
      endAt: new Date('2026-05-06T00:00:00.000Z'),
    });

    await expectErrorCode(
      afterEnd.service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
      }),
      'SEASON_ENDED',
    );
    expectNoOrderWrites(beforeStart.prisma);
    expectNoOrderWrites(afterEnd.prisma);
  });

  it('rejects order quote when the stock market is closed before provider reads', async () => {
    jest.setSystemTime(new Date('2026-05-06T23:59:59.000Z'));
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);

    await expectErrorCode(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
      }),
      'MARKET_CLOSED',
    );
    expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
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
    useKrxMarketOpenTime();
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
    mockOrderQuoteForCreate(prisma, {
      currencyCode: CurrencyCode.USD,
      quantity: new Prisma.Decimal('2.00000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
    });
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
      quoteId: 'quote-order-create-1',
      idempotencyKey: 'order-create-key-1',
    });

    expect(response.data).toMatchObject({
      order: {
        orderId: expect.any(String),
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
        reason: 'ORDER_SUBMITTED_NOT_EXECUTED',
        message:
          'Order was submitted and can be executed through the execute endpoint.',
      },
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          status: OrderStatus.submitted,
          quantity: '2.00000000',
          quoteId: 'quote-order-create-1',
          limitPrice: null,
          executedPrice: null,
          grossAmount: '200.00000000',
          feeAmount: '0.20000000',
          netAmount: '200.20000000',
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: 'fx-1',
          idempotencyKey: 'order-create-key-1',
          requestHash: expect.any(String),
          responsePayloadJson: {
            success: true,
            data: expect.objectContaining({
              order: expect.objectContaining({
                orderId: expect.any(String),
                status: OrderStatus.submitted,
              }),
            }),
          },
          executedAt: null,
          canceledAt: null,
          rejectedAt: null,
        }),
      }),
    );
    expectOnlyOrderCreateWrite(prisma);
  });

  it('keeps order create on admin_manual sources even when provider_api rows exist', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.USD);
    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([
      {
        id: 'provider-price-create',
        price: new Prisma.Decimal('999.00000000'),
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: 'kis_us_delayed_trade',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      },
    ]);
    mockAssetPrice(prisma);
    mockFreshFx(prisma);
    mockCashWallet(prisma);
    mockOrderQuoteForCreate(prisma, {
      currencyCode: CurrencyCode.USD,
      quantity: new Prisma.Decimal('2.00000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
    });
    prisma.order.create.mockResolvedValueOnce({ id: 'order-submitted-1' });

    const response = await service.createOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'market',
      quantity: '2.00000000',
      quoteId: 'quote-order-create-1',
      idempotencyKey: 'order-create-provider-closed',
    });

    expect(response.data.order).toMatchObject({
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: 'fx-1',
    });
    expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
    expectOnlyOrderCreateWrite(prisma);
  });

  it('creates submitted Binance crypto USD market orders with USD currency and FX audit snapshot', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockBinanceCryptoAsset(prisma);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'aps-btc-1',
      price: new Prisma.Decimal('50000.00000000'),
    });
    mockFreshFx(prisma);
    mockCashWallet(prisma, '1000.00000000');
    mockOrderQuoteForCreate(prisma, {
      assetId: 'asset-btc',
      asset: {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
        isActive: true,
      },
      currencyCode: CurrencyCode.USD,
      quantity: new Prisma.Decimal('0.01000000'),
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: 'aps-btc-1',
      fxRateSnapshotId: 'fx-1',
    });
    prisma.order.create.mockResolvedValueOnce({ id: 'order-btc-1' });

    const response = await service.createOrder('user-1', {
      assetId: 'asset-btc',
      side: 'buy',
      orderType: 'market',
      quantity: '0.01000000',
      quoteId: 'quote-order-create-1',
      idempotencyKey: 'order-create-key-btc',
    });

    expect(response.data.order).toMatchObject({
      status: OrderStatus.submitted,
      asset: {
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
      },
      currencyCode: CurrencyCode.USD,
      grossAmount: '500.00000000',
      feeAmount: '0.50000000',
      netAmount: '500.50000000',
      assetPriceSnapshotId: 'aps-btc-1',
      fxRateSnapshotId: 'fx-1',
    });
    expect(prisma.cashWallet.findUnique).toHaveBeenCalledWith({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.USD,
        },
      },
      select: {
        balanceAmount: true,
      },
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: 'asset-btc',
          currencyCode: CurrencyCode.USD,
          grossAmount: '500.00000000',
          feeAmount: '0.50000000',
          netAmount: '500.50000000',
          assetPriceSnapshotId: 'aps-btc-1',
          fxRateSnapshotId: 'fx-1',
        }),
      }),
    );
    expectOnlyOrderCreateWrite(prisma);
  });

  it('creates submitted limit order with limitPrice', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.limit,
      quantity: new Prisma.Decimal('1.00000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
    });
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
      quoteId: 'quote-order-create-1',
      idempotencyKey: 'order-create-key-2',
    });

    expect(response.data.order).toMatchObject({
      orderId: expect.any(String),
      status: OrderStatus.submitted,
      limitPrice: '50000.00000000',
      assetPriceSnapshotId: null,
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          limitPrice: '50000.00000000',
          quoteId: 'quote-order-create-1',
          assetPriceSnapshotId: null,
          fxRateSnapshotId: null,
        }),
      }),
    );
    expectOnlyOrderCreateWrite(prisma);
  });

  it('rejects order create after season end even if status is active', async () => {
    const { prisma, service } = createService();
    prisma.season.findFirst.mockResolvedValueOnce({
      ...activeSeason,
      endAt: new Date('2026-05-06T00:00:00.000Z'),
    });

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '50000.00000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-ended',
      }),
      'SEASON_ENDED',
    );
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('rejects order create when the stock market is closed', async () => {
    jest.setSystemTime(new Date('2026-05-07T06:30:00.000Z'));
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.limit,
      quantity: new Prisma.Decimal('1.00000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
    });

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '50000.00000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-market-closed',
      }),
      'MARKET_CLOSED',
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('rejects create without idempotencyKey', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '50000.00000000',
        quoteId: 'quote-order-create-1',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
  });

  it('rejects create with invalid idempotencyKey', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '50000.00000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: '   ',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
  });

  it('rejects create without quoteId', async () => {
    const { prisma, service } = createService();

    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        limitPrice: '50000.00000000',
        idempotencyKey: 'order-create-key-1',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expectNoOrderWrites(prisma);
  });

  it('replays duplicate create with same idempotencyKey and same payload', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    const requestHash = hashOrderCreateRequest(orderCreateBody);
    const existingOrder = idempotentOrderRecord(requestHash);
    prisma.order.findFirst.mockResolvedValueOnce(existingOrder);

    const response = await service.createOrder('user-1', orderCreateBody);

    expect(response).toBe(existingOrder.responsePayloadJson);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('conflicts duplicate create with same idempotencyKey and different payload', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    prisma.order.findFirst.mockResolvedValueOnce(
      idempotentOrderRecord('different-request-hash'),
    );

    await expect(
      service.createOrder('user-1', orderCreateBody),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('conflicts duplicate create with same idempotencyKey and different quoteId', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    const existingHash = hashOrderCreateRequest(orderCreateBody);
    prisma.order.findFirst.mockResolvedValueOnce(
      idempotentOrderRecord(existingHash),
    );

    await expect(
      service.createOrder('user-1', {
        ...orderCreateBody,
        quoteId: 'quote-order-create-2',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it('replays existing order after a unique idempotency race with same payload', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.limit,
      quantity: new Prisma.Decimal('1.00000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
    });
    let racedRequestHash = '';
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.create.mockImplementationOnce((args) => {
      racedRequestHash = args.data.requestHash;

      return Promise.reject({ code: 'P2002' });
    });
    const existingOrder = idempotentOrderRecord('');
    prisma.order.findFirst.mockImplementationOnce(() =>
      Promise.resolve({
        ...existingOrder,
        requestHash: racedRequestHash,
      }),
    );

    const response = await service.createOrder('user-1', orderCreateBody);

    expect(response).toBe(existingOrder.responsePayloadJson);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expectOnlyOrderCreateWrite(prisma);
  });

  it('conflicts after a unique idempotency race with different payload', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockCashWallet(prisma, '1000000.00000000');
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.limit,
      quantity: new Prisma.Decimal('1.00000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
    });
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.order.findFirst.mockResolvedValueOnce(
      idempotentOrderRecord('different-request-hash'),
    );

    await expect(
      service.createOrder('user-1', orderCreateBody),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
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

  it('cancels submitted orders with a guarded status update', async () => {
    const { prisma, service } = createService();
    prisma.order.findFirst.mockResolvedValueOnce({
      id: 'order-submitted-1',
      seasonParticipantId: 'sp-1',
      status: OrderStatus.submitted,
    });
    prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.order.findUnique.mockResolvedValueOnce({
      id: 'order-submitted-1',
      side: OrderSide.buy,
      orderType: OrderType.limit,
      status: OrderStatus.canceled,
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
      canceledAt,
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

    const response = await service.cancelOrder('user-1', ' order-submitted-1 ');

    expect(response.data).toMatchObject({
      order: {
        orderId: 'order-submitted-1',
        status: OrderStatus.canceled,
        canceledAt: '2026-05-07T00:03:00.000Z',
        executedAt: null,
        rejectedAt: null,
      },
      execution: {
        state: 'not_executed',
        reason: 'ORDER_CANCELED_BEFORE_EXECUTION',
      },
    });
    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'order-submitted-1',
        seasonParticipant: {
          userId: 'user-1',
        },
      },
      select: {
        id: true,
        seasonParticipantId: true,
        status: true,
      },
    });
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-submitted-1',
        seasonParticipantId: 'sp-1',
        status: OrderStatus.submitted,
      },
      data: {
        status: OrderStatus.canceled,
        canceledAt: expect.any(Date),
      },
    });
    expect(prisma.season.findFirst).not.toHaveBeenCalled();
    expectOnlyOrderCancelWrite(prisma);
  });

  it('reads canceled orders with status filter', async () => {
    const { prisma, service } = createService();
    mockCurrentSeason(prisma);
    mockJoined(prisma);
    prisma.order.count.mockResolvedValueOnce(1);
    prisma.order.findMany.mockResolvedValueOnce([
      {
        id: 'order-canceled-1',
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.canceled,
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
        canceledAt,
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
      status: 'canceled',
    });

    expect(response.data.orders).toMatchObject([
      {
        orderId: 'order-canceled-1',
        status: OrderStatus.canceled,
        canceledAt: '2026-05-07T00:03:00.000Z',
      },
    ]);
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonParticipantId: 'sp-1',
          status: OrderStatus.canceled,
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
        idempotencyKey: 'order-create-key-auth',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.cancelOrder(undefined, 'order-1'),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects cancel with empty orderId', async () => {
    const { service } = createService();

    await expect(service.cancelOrder('user-1', ' ')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('returns not found for missing or unowned orders', async () => {
    const { prisma, service } = createService();
    prisma.order.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.cancelOrder('user-1', 'order-other-user'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma);
  });

  it.each([OrderStatus.executed, OrderStatus.canceled, OrderStatus.rejected])(
    'rejects cancel for %s orders',
    async (status) => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce({
        id: 'order-1',
        seasonParticipantId: 'sp-1',
        status,
      });

      await expect(
        service.cancelOrder('user-1', 'order-1'),
      ).rejects.toBeInstanceOf(HttpException);
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expectNoOrderWrites(prisma);
    },
  );

  it('returns conflict when guarded cancel update affects no rows', async () => {
    const { prisma, service } = createService();
    prisma.order.findFirst.mockResolvedValueOnce({
      id: 'order-1',
      seasonParticipantId: 'sp-1',
      status: OrderStatus.submitted,
    });
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.cancelOrder('user-1', 'order-1'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expectOnlyOrderCancelWrite(prisma);
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
        idempotencyKey: 'order-create-key-not-joined',
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
        idempotencyKey: 'order-create-key-invalid-side',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'stop',
        quantity: '1.00000000',
        limitPrice: '100.00000000',
        idempotencyKey: 'order-create-key-invalid-type',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '0',
        limitPrice: '100.00000000',
        idempotencyKey: 'order-create-key-invalid-quantity',
      }),
    ).rejects.toBeInstanceOf(HttpException);
    await expect(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.00000000',
        idempotencyKey: 'order-create-key-invalid-limit',
      }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  describe('executeOrder', () => {
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(executedAt);
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('executes buy orders and creates a new position', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      mockExecutionPrice(prisma);
      mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
      prisma.position.findUnique.mockResolvedValueOnce(null);
      prisma.position.create.mockResolvedValueOnce({ id: 'position-1' });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-buy-1',
      });
      mockOrderFinalization(prisma);

      const response = await service.executeOrder('user-1', 'order-execute-1');

      expect(response.data).toMatchObject({
        order: {
          orderId: 'order-execute-1',
          status: OrderStatus.executed,
          executedPrice: '100.00000000',
          grossAmount: '200.00000000',
          feeAmount: '0.20000000',
          netAmount: '200.20000000',
          assetPriceSnapshotId: 'aps-exec-1',
          fxRateSnapshotId: null,
        },
        execution: {
          state: 'executed',
          executedAt: executedAt.toISOString(),
          priceSource: 'provider_api',
          quoteId: 'quote-order-execute-1',
          quotedPrice: '100.00000000',
          executePrice: '100.00000000',
          priceChangeBps: '0.0000',
          assetPriceSnapshotId: 'aps-exec-1',
          fxRateSnapshotId: null,
          walletTransactionId: 'wallet-tx-buy-1',
          walletBalanceAfter: '799.80000000',
          positionId: 'position-1',
          duplicate: false,
        },
      });
      expect(prisma.quote.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'quote-order-execute-1',
          status: 'active',
        },
        data: {
          status: 'consumed',
          consumedAt: executedAt,
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.KRW,
          balanceAmount: {
            gte: '200.20000000',
          },
        },
        data: {
          balanceAmount: {
            decrement: '200.20000000',
          },
        },
      });
      expect(prisma.position.create).toHaveBeenCalledWith({
        data: {
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          quantity: '2.00000000',
          averageCost: '100.10000000',
          currencyCode: CurrencyCode.KRW,
          realizedPnl: '0.00000000',
        },
        select: {
          id: true,
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
        data: {
          seasonParticipantId: 'sp-1',
          walletId: 'wallet-1',
          currencyCode: CurrencyCode.KRW,
          direction: WalletTransactionDirection.debit,
          txType: WalletTransactionType.order_buy,
          referenceType: WalletTransactionReferenceType.order,
          referenceId: 'order-execute-1',
          amount: '200.20000000',
          balanceAfter: '799.80000000',
          occurredAt: executedAt,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'order-execute-1',
          seasonParticipantId: 'sp-1',
          status: OrderStatus.submitted,
        },
        data: {
          status: OrderStatus.executed,
          executedPrice: '100.00000000',
          grossAmount: '200.00000000',
          feeAmount: '0.20000000',
          netAmount: '200.20000000',
          assetPriceSnapshotId: 'aps-exec-1',
          fxRateSnapshotId: null,
          executedAt,
        },
      });
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('executes Binance crypto USD buys with USD wallet debit, USD position, and FX snapshot audit', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        cryptoUsdOrderExecutionRecord(),
      );
      mockExecutionPrice(
        prisma,
        '50000.00000000',
        'aps-btc-exec-1',
        'binance_public_rest_24hr_ticker',
      );
      mockExecutionFx(prisma);
      mockExecutionWallet(
        prisma,
        '1000.00000000',
        '499.50000000',
        CurrencyCode.USD,
      );
      prisma.position.findUnique.mockResolvedValueOnce(null);
      prisma.position.create.mockResolvedValueOnce({ id: 'position-btc-1' });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-btc-buy-1',
      });
      mockOrderFinalization(prisma, executedCryptoUsdOrderExecutionRecord());

      const response = await service.executeOrder(
        'user-1',
        'order-btc-execute-1',
      );

      expect(response.data).toMatchObject({
        order: {
          orderId: 'order-btc-execute-1',
          asset: {
            symbol: 'BTCUSDT',
            market: 'BINANCE',
            currencyCode: CurrencyCode.USD,
          },
          currencyCode: CurrencyCode.USD,
          status: OrderStatus.executed,
          grossAmount: '500.00000000',
          feeAmount: '0.50000000',
          netAmount: '500.50000000',
          assetPriceSnapshotId: 'aps-btc-exec-1',
          fxRateSnapshotId: 'fx-exec-1',
        },
        execution: {
          state: 'executed',
          priceSource: 'provider_api',
          quoteId: 'quote-order-btc-execute-1',
          quotedPrice: '50000.00000000',
          executePrice: '50000.00000000',
          priceChangeBps: '0.0000',
          quotedRate: '1400.00000000',
          executeRate: '1400.00000000',
          rateChangeBps: '0.0000',
          fxRateSnapshotId: 'fx-exec-1',
          walletTransactionId: 'wallet-tx-btc-buy-1',
          walletBalanceAfter: '499.50000000',
          positionId: 'position-btc-1',
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.USD,
          balanceAmount: {
            gte: '500.50000000',
          },
        },
        data: {
          balanceAmount: {
            decrement: '500.50000000',
          },
        },
      });
      expect(prisma.position.create).toHaveBeenCalledWith({
        data: {
          seasonParticipantId: 'sp-1',
          assetId: 'asset-btc',
          quantity: '0.01000000',
          averageCost: '50050.00000000',
          currencyCode: CurrencyCode.USD,
          realizedPnl: '0.00000000',
        },
        select: {
          id: true,
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          currencyCode: CurrencyCode.USD,
          direction: WalletTransactionDirection.debit,
          txType: WalletTransactionType.order_buy,
          amount: '500.50000000',
          balanceAfter: '499.50000000',
        }),
        select: {
          id: true,
        },
      });
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fxRateSnapshotId: 'fx-exec-1',
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('executes buy orders and updates weighted average for an existing position', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      mockExecutionPrice(prisma);
      mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        quantity: new Prisma.Decimal('3.00000000'),
        averageCost: new Prisma.Decimal('90.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-buy-1',
      });
      mockOrderFinalization(prisma);

      const response = await service.executeOrder('user-1', 'order-execute-1');

      expect(response.data.execution.positionId).toBe('position-1');
      expect(prisma.position.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'position-1',
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          quantity: '3.00000000',
          averageCost: '90.00000000',
        },
        data: {
          quantity: '5.00000000',
          averageCost: '94.04000000',
        },
      });
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('executes sell orders with position decrement and realizedPnl update', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({
          side: OrderSide.sell,
        }),
      );
      mockExecutionPrice(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        quantity: new Prisma.Decimal('5.00000000'),
        averageCost: new Prisma.Decimal('80.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
      mockExecutionWallet(prisma, '100.00000000', '299.80000000');
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-sell-1',
      });
      mockOrderFinalization(
        prisma,
        executedOrderExecutionRecord({
          side: OrderSide.sell,
          netAmount: new Prisma.Decimal('199.80000000'),
          feeAmount: new Prisma.Decimal('0.20000000'),
        }),
      );

      const response = await service.executeOrder('user-1', 'order-execute-1');

      expect(response.data.execution.walletBalanceAfter).toBe('299.80000000');
      expect(prisma.position.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'position-1',
          seasonParticipantId: 'sp-1',
          assetId: 'asset-1',
          quantity: {
            gte: '2.00000000',
          },
        },
        data: {
          quantity: {
            decrement: '2.00000000',
          },
          realizedPnl: {
            increment: '39.80000000',
          },
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.KRW,
        },
        data: {
          balanceAmount: {
            increment: '199.80000000',
          },
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            direction: WalletTransactionDirection.credit,
            txType: WalletTransactionType.order_sell,
            amount: '199.80000000',
            balanceAfter: '299.80000000',
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('executes Binance crypto USD sells with USD wallet credit and USD ledger currency', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        cryptoUsdOrderExecutionRecord({
          side: OrderSide.sell,
        }),
      );
      mockExecutionPrice(
        prisma,
        '50000.00000000',
        'aps-btc-exec-1',
        'binance_public_rest_24hr_ticker',
      );
      mockExecutionFx(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-btc-1',
        quantity: new Prisma.Decimal('0.02000000'),
        averageCost: new Prisma.Decimal('40000.00000000'),
        currencyCode: CurrencyCode.USD,
      });
      prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
      mockExecutionWallet(
        prisma,
        '100.00000000',
        '599.50000000',
        CurrencyCode.USD,
      );
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-btc-sell-1',
      });
      mockOrderFinalization(
        prisma,
        executedCryptoUsdOrderExecutionRecord({
          side: OrderSide.sell,
          netAmount: new Prisma.Decimal('499.50000000'),
        }),
      );

      const response = await service.executeOrder(
        'user-1',
        'order-btc-execute-1',
      );

      expect(response.data).toMatchObject({
        order: {
          orderId: 'order-btc-execute-1',
          side: OrderSide.sell,
          currencyCode: CurrencyCode.USD,
          netAmount: '499.50000000',
          fxRateSnapshotId: 'fx-exec-1',
        },
        execution: {
          priceSource: 'provider_api',
          quoteId: 'quote-order-btc-execute-1',
          quotedPrice: '50000.00000000',
          executePrice: '50000.00000000',
          priceChangeBps: '0.0000',
          quotedRate: '1400.00000000',
          executeRate: '1400.00000000',
          rateChangeBps: '0.0000',
          walletTransactionId: 'wallet-tx-btc-sell-1',
          walletBalanceAfter: '599.50000000',
          positionId: 'position-btc-1',
        },
      });
      expect(prisma.position.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'position-btc-1',
          seasonParticipantId: 'sp-1',
          assetId: 'asset-btc',
          quantity: {
            gte: '0.01000000',
          },
        },
        data: {
          quantity: {
            decrement: '0.01000000',
          },
          realizedPnl: {
            increment: '99.50000000',
          },
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          currencyCode: CurrencyCode.USD,
        },
        data: {
          balanceAmount: {
            increment: '499.50000000',
          },
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            currencyCode: CurrencyCode.USD,
            direction: WalletTransactionDirection.credit,
            txType: WalletTransactionType.order_sell,
            amount: '499.50000000',
            balanceAfter: '599.50000000',
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('rejects execute without authenticated user or valid orderId', async () => {
      const { prisma, service } = createService();

      await expectErrorCode(
        service.executeOrder(undefined, 'order-execute-1'),
        'UNAUTHORIZED',
      );
      await expectErrorCode(
        service.executeOrder('user-1', '   '),
        'INVALID_ORDER_ID',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('returns not found for missing or unowned execute orders', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(null);

      await expectErrorCode(
        service.executeOrder('user-1', 'order-other-user'),
        'ORDER_NOT_FOUND',
      );
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.canceled, OrderStatus.rejected])(
      'rejects execute for %s orders',
      async (status) => {
        const { prisma, service } = createService();
        prisma.order.findFirst.mockResolvedValueOnce(
          orderExecutionRecord({ status }),
        );

        await expectErrorCode(
          service.executeOrder('user-1', 'order-execute-1'),
          'ORDER_NOT_EXECUTABLE',
        );
        expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
        expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      },
    );

    it('returns already executed current-state response without mutation', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        executedOrderExecutionRecord(),
      );

      const response = await service.executeOrder('user-1', 'order-execute-1');

      expect(response.data).toMatchObject({
        order: {
          orderId: 'order-execute-1',
          status: OrderStatus.executed,
          executedAt: executedAt.toISOString(),
        },
        execution: {
          state: 'already_executed',
          executedAt: executedAt.toISOString(),
          walletTransactionId: null,
          walletBalanceAfter: null,
          positionId: null,
          duplicate: true,
        },
      });
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.position.create).not.toHaveBeenCalled();
      expect(prisma.position.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('rejects execute when market price is unavailable', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'PROVIDER_PRICE_UNAVAILABLE',
      );
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects execute after season end even when status is still active', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({
          seasonParticipant: {
            ...participant,
            season: {
              ...activeSeason,
              endAt: new Date('2026-05-06T00:00:00.000Z'),
            },
          },
        }),
      );

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'SEASON_ENDED',
      );
      expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects execute when the market closed after quote/create', async () => {
      jest.setSystemTime(new Date('2026-05-07T06:30:00.000Z'));
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'MARKET_CLOSED',
      );
      expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects non-marketable buy and sell limit orders', async () => {
      const buy = createService();
      buy.prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({
          orderType: OrderType.limit,
          limitPrice: new Prisma.Decimal('99.00000000'),
        }),
      );
      mockExecutionPrice(buy.prisma, '100.00000000');

      await expectErrorCode(
        buy.service.executeOrder('user-1', 'order-execute-1'),
        'ORDER_LIMIT_NOT_MARKETABLE',
      );

      const sell = createService();
      sell.prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({
          side: OrderSide.sell,
          orderType: OrderType.limit,
          limitPrice: new Prisma.Decimal('101.00000000'),
        }),
      );
      mockExecutionPrice(sell.prisma, '100.00000000');

      await expectErrorCode(
        sell.service.executeOrder('user-1', 'order-execute-1'),
        'ORDER_LIMIT_NOT_MARKETABLE',
      );
      expect(buy.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(sell.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    });

    it('rejects USD execute when FX is unavailable or stale', async () => {
      jest.setSystemTime(usMarketOpenAt);
      const usdOrder = orderExecutionRecord({
        currencyCode: CurrencyCode.USD,
        asset: {
          id: 'asset-1',
          symbol: 'AAPL',
          name: 'Apple Inc.',
          market: 'NASDAQ',
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
        },
      });
      const unavailable = createService();
      unavailable.prisma.order.findFirst.mockResolvedValueOnce(usdOrder);
      mockExecutionPrice(
        unavailable.prisma,
        '100.00000000',
        'aps-exec-1',
        'kis_us_delayed_trade',
      );
      unavailable.prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([]);

      await expectErrorCode(
        unavailable.service.executeOrder('user-1', 'order-execute-1'),
        'PROVIDER_RATE_UNAVAILABLE',
      );

      const stale = createService();
      stale.prisma.order.findFirst.mockResolvedValueOnce(usdOrder);
      mockExecutionPrice(
        stale.prisma,
        '100.00000000',
        'aps-exec-1',
        'kis_us_delayed_trade',
      );
      stale.prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
        {
          id: 'fx-stale-1',
          rate: new Prisma.Decimal('1400.00000000'),
          sourceType: FxRateSourceType.provider_api,
          sourceName: 'exchange_rate_api',
          effectiveAt: new Date(usMarketOpenAt.getTime() - 61_000),
          capturedAt: new Date(usMarketOpenAt.getTime() - 61_000),
        },
      ]);

      await expectErrorCode(
        stale.service.executeOrder('user-1', 'order-execute-1'),
        'PROVIDER_RATE_STALE',
      );
      expect(unavailable.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(stale.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    });

    it('rejects buy when cash balance is insufficient after guarded debit', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      mockExecutionPrice(prisma);
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal('1000.00000000'),
      });
      prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.cashWallet.findFirst.mockResolvedValueOnce({
        balanceAmount: new Prisma.Decimal('199.00000000'),
      });

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'INSUFFICIENT_CASH_BALANCE',
      );
      expect(prisma.position.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects sell when position is missing or quantity is insufficient', async () => {
      const missing = createService();
      missing.prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({ side: OrderSide.sell }),
      );
      mockExecutionPrice(missing.prisma);
      missing.prisma.position.findUnique.mockResolvedValueOnce(null);

      await expectErrorCode(
        missing.service.executeOrder('user-1', 'order-execute-1'),
        'ORDER_POSITION_NOT_FOUND',
      );

      const insufficient = createService();
      insufficient.prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({ side: OrderSide.sell }),
      );
      mockExecutionPrice(insufficient.prisma);
      insufficient.prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        quantity: new Prisma.Decimal('1.00000000'),
        averageCost: new Prisma.Decimal('80.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      insufficient.prisma.position.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      insufficient.prisma.position.findFirst.mockResolvedValueOnce({
        quantity: new Prisma.Decimal('1.00000000'),
      });

      await expectErrorCode(
        insufficient.service.executeOrder('user-1', 'order-execute-1'),
        'INSUFFICIENT_POSITION_QUANTITY',
      );
      expect(missing.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(insufficient.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    });

    it('uses actual post-update wallet balance for walletTransaction balanceAfter', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      mockExecutionPrice(prisma);
      mockExecutionWallet(prisma, '1000.00000000', '777.77777777');
      prisma.position.findUnique.mockResolvedValueOnce(null);
      prisma.position.create.mockResolvedValueOnce({ id: 'position-1' });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-buy-1',
      });
      mockOrderFinalization(prisma);

      await service.executeOrder('user-1', 'order-execute-1');

      expect(prisma.walletTransaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            balanceAfter: '777.77777777',
          }),
        }),
      );
    });

    it('uses guarded finalization for cancel/execute conflicts', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(orderExecutionRecord());
      mockExecutionPrice(prisma);
      mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
      prisma.position.findUnique.mockResolvedValueOnce(null);
      prisma.position.create.mockResolvedValueOnce({ id: 'position-1' });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-buy-1',
      });
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'ORDER_EXECUTION_CONFLICT',
      );
      expect(prisma.order.findUnique).not.toHaveBeenCalled();
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('uses guarded finalization for order double execution conflicts', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValueOnce(
        orderExecutionRecord({
          side: OrderSide.sell,
        }),
      );
      mockExecutionPrice(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        quantity: new Prisma.Decimal('2.00000000'),
        averageCost: new Prisma.Decimal('80.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
      mockExecutionWallet(prisma, '100.00000000', '299.80000000');
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-sell-1',
      });
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'ORDER_EXECUTION_CONFLICT',
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: OrderStatus.submitted,
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });
  });
});
