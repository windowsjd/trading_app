import {
  captureFinancialFailure,
  expectSafeFinancialDiagnostic,
} from '../../test/support/financial-diagnostics';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
} from '../common/admin-diagnostics';
jest.mock('../generated/prisma/client', () => {
  const { Decimal, sqltag } = jest.requireActual(
    '@prisma/client/runtime/client',
  );

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
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
      sql: sqltag,
    },
    PrismaClient: class PrismaClient {},
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      general: 'general',
      season: 'season',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
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
  SnapshotReason,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { computeOrderQuoteRequestHash } from '../providers/durable-quote.policy';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { OrderReservationService } from './order-reservation.service';
import { OrdersService } from './orders.service';
import { UsdKrwRefreshService } from '../providers/usd-krw-refresh.service';
import { ProviderHttpError } from '../providers/provider.types';
import { PortfolioValuationService } from '../portfolio/portfolio-valuation.service';
import { PortfolioValuationError } from '../portfolio/portfolio-valuation.policy';
import {
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';

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
    tradingAccountId: 'trading-account-1',
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
    tradingAccount: {
      findUnique: jest.fn(),
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
      findMany: jest.fn(),
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
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
  });

  const createService = (withRefresh = false) => {
    const prisma = createPrisma();
    prisma.$transaction.mockImplementation(async (callback) =>
      callback(prisma),
    );
    prisma.$queryRaw.mockImplementation(async (template) => {
      const sql = template.join(' ? ');
      if (sql.includes('clock_timestamp')) return [{ now: new Date() }];
      if (sql.includes('"season_participants"'))
        return [
          {
            id: 'sp-1',
            seasonId: 'season-1',
            userId: 'user-1',
            tradingAccountId: 'trading-account-1',
            participantStatus: 'active',
          },
        ];
      if (sql.includes('"seasons"')) return [activeSeason];
      if (sql.includes('"trading_accounts"'))
        return [
          {
            id: 'trading-account-1',
            userId: 'user-1',
            mode: 'season',
            status: 'active',
          },
        ];
      return [];
    });
    const reservationService = new OrderReservationService();
    const limitOrderCreateService = new LimitOrderCreateService(
      prisma as never,
      reservationService,
    );
    const limitOrderCancelService = new LimitOrderCancelService(
      prisma as never,
      reservationService,
    );
    const primary = { ensureFreshUsdKrwSnapshot: jest.fn() };
    const secondary = {
      ingestUsdKrw: jest.fn().mockResolvedValue({ success: false }),
    };
    const refresh = new UsdKrwRefreshService(
      prisma as never,
      primary as never,
      secondary as never,
    );
    const service = new OrdersService(
      prisma as never,
      undefined,
      limitOrderCreateService,
      limitOrderCancelService,
      undefined,
      undefined,
      undefined,
      withRefresh ? refresh : undefined,
    );

    return { prisma, service, primary, secondary };
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

  const mockAssetPrice = (
    prisma: ReturnType<typeof createPrisma>,
    price = '100.00000000',
  ) => {
    prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce({
      id: 'aps-1',
      price: new Prisma.Decimal(price),
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
    walletScope: 'securities' | 'crypto_spot' = 'securities',
  ) => {
    prisma.cashWallet.findUnique.mockResolvedValueOnce({
      walletScope,
      id: 'wallet-1',
      tradingAccountId: 'trading-account-1',
      balanceAmount: new Prisma.Decimal(balance),
    });
  };

  const mockPosition = (
    prisma: ReturnType<typeof createPrisma>,
    quantity = '10.00000000',
  ) => {
    prisma.position.findUnique.mockResolvedValueOnce({
      tradingAccountId: 'trading-account-1',
      quantity: new Prisma.Decimal(quantity),
      reservedQuantity: new Prisma.Decimal(0),
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
          quantity: new Prisma.Decimal(body.quantity).toFixed(6),
          limitPrice: null,
          currencyCode: body.currencyCode ?? null,
        }),
        'utf8',
      )
      .digest('hex');

  const orderCreateBody = {
    assetId: 'asset-1',
    side: OrderSide.buy,
    orderType: OrderType.market,
    quantity: '1.000000',
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
      asset.currencyCode;
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
    const tradingAccountId = Object.prototype.hasOwnProperty.call(
      overrides,
      'tradingAccountId',
    )
      ? (overrides.tradingAccountId as string | null)
      : 'trading-account-1';
    const userId = (overrides.userId as string | undefined) ?? 'user-1';

    return {
      cashWalletScope: 'securities' as const,
      id: (overrides.id as string | undefined) ?? 'quote-order-1',
      userId,
      tradingAccountId,
      status: (overrides.status as string | undefined) ?? 'active',
      assetId,
      side,
      orderType,
      quantity,
      sourceAmount:
        (overrides.sourceAmount as Prisma.Decimal | undefined) ?? null,
      limitPrice,
      currencyCode,
      quotedPrice,
      quotedRate,
      maxChangeBps:
        (overrides.maxChangeBps as Prisma.Decimal | undefined) ??
        new Prisma.Decimal('30.0000'),
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
          seasonParticipantId: 'sp-1',
          tradingAccountId: tradingAccountId!,
          assetId,
          side,
          orderType,
          quantity,
          amount: overrides.sourceAmount as Prisma.Decimal | undefined,
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

  /**
   * A COMMITTED market create being replayed: same orderType and
   * idempotencyKey as `orderCreateBody`, with a stored response payload. The
   * quote-scoped replay-first lookup (작업 5 보완 2) matches on quoteId +
   * orderType + idempotencyKey, so all three must line up here.
   */
  const idempotentOrderRecord = (requestHash: string) => ({
    cashWalletScope: 'securities' as const,
    id: 'order-idempotent-1',
    tradingAccountId: 'trading-account-1',
    quoteId: 'quote-order-create-1',
    idempotencyKey: orderCreateBody.idempotencyKey,
    requestHash,
    responsePayloadJson: {
      success: true,
      data: {
        order: {
          orderId: 'order-idempotent-1',
          status: OrderStatus.executed,
        },
        execution: {
          state: 'executed',
          reason: 'ORDER_EXECUTED',
          message: 'Order was executed.',
        },
      },
    },
    side: OrderSide.buy,
    orderType: OrderType.market,
    status: OrderStatus.executed,
    quantity: new Prisma.Decimal('1.00000000'),
    limitPrice: null,
    executedPrice: new Prisma.Decimal('50000.00000000'),
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
            (overrides.quotedPrice as Prisma.Decimal | undefined) ??
            (orderType === OrderType.limit && limitPrice
              ? limitPrice
              : new Prisma.Decimal('100.00000000')),
          assetPriceSnapshotId: orderType === OrderType.market ? 'aps-1' : null,
          fxRateSnapshotId: currencyCode === CurrencyCode.USD ? 'fx-1' : null,
        });

    return {
      cashWalletScope: 'securities' as const,
      id: 'order-execute-1',
      tradingAccountId: 'trading-account-1',
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
        isActive: true,
        assetType:
          asset.assetType ??
          (currencyCode === CurrencyCode.USD
            ? AssetType.us_stock
            : AssetType.domestic_stock),
      },
      quote,
      tradingAccount: {
        id: 'trading-account-1',
        userId: 'user-1',
        mode: 'season',
        status: 'active',
        initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
        seasonParticipant: {
          ...participant,
          season: activeSeason,
        },
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
      {
        id: `${snapshotId}-korea-exim`,
        rate: new Prisma.Decimal(rate),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'korea_exim_exchange_rate',
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
      walletScope: 'securities' as const,
      id: 'wallet-1',
      tradingAccountId: 'trading-account-1',
      currencyCode,
      balanceAmount: new Prisma.Decimal(before),
    });
    // Buy debits go through the atomic raw-SQL available-balance guard;
    // sell credits still use cashWallet.updateMany. Mock both.
    prisma.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.cashWallet.findFirst.mockResolvedValueOnce({
      walletScope: 'securities' as const,
      id: 'wallet-1',
      tradingAccountId: 'trading-account-1',
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

  const providerAssetSnapshot = (input: {
    id: string;
    price: string;
    currencyCode?: CurrencyCode;
    sourceName?: string | null;
    effectiveAt?: Date;
    capturedAt?: Date;
    priceKrw?: string | null;
  }) => ({
    id: input.id,
    price: new Prisma.Decimal(input.price),
    priceKrw:
      input.priceKrw === undefined || input.priceKrw === null
        ? null
        : new Prisma.Decimal(input.priceKrw),
    currencyCode: input.currencyCode ?? CurrencyCode.KRW,
    sourceType: AssetPriceSourceType.provider_api,
    sourceName: input.sourceName ?? 'kis_krx_realtime_trade',
    effectiveAt: input.effectiveAt ?? executedAt,
    capturedAt: input.capturedAt ?? executedAt,
  });

  const providerFxSnapshot = (input: {
    id: string;
    rate: string;
    sourceName?: string | null;
    effectiveAt?: Date;
    capturedAt?: Date;
  }) => ({
    id: input.id,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    createdAt: input.capturedAt ?? executedAt,
    rate: new Prisma.Decimal(input.rate),
    sourceType: FxRateSourceType.provider_api,
    sourceName: input.sourceName ?? 'exchange_rate_api',
    effectiveAt: input.effectiveAt ?? executedAt,
    capturedAt: input.capturedAt ?? executedAt,
  });

  const adminFxSnapshot = (input: {
    id: string;
    rate: string;
    approvedByUserId?: string | null;
    effectiveAt?: Date;
    capturedAt?: Date;
  }) => ({
    id: input.id,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    createdAt: input.capturedAt ?? executedAt,
    rate: new Prisma.Decimal(input.rate),
    sourceType: FxRateSourceType.admin_manual,
    sourceName: 'manual-fx',
    effectiveAt: input.effectiveAt ?? executedAt,
    capturedAt: input.capturedAt ?? executedAt,
    approvedByUserId: Object.prototype.hasOwnProperty.call(
      input,
      'approvedByUserId',
    )
      ? input.approvedByUserId
      : 'operator-1',
  });

  const mockOrderExecutedPortfolioValuation = (
    prisma: ReturnType<typeof createPrisma>,
    input: {
      positionId?: string;
      assetId?: string;
      assetType?: AssetType;
      market?: string;
      currencyCode?: CurrencyCode;
      quantity?: string;
      averageCost?: string;
      krwCash?: string;
      usdCash?: string;
      initialCapitalKrw?: string;
      assetProviderCandidates?: ReturnType<typeof providerAssetSnapshot>[];
      assetAdminSnapshot?: {
        id: string;
        price: string;
        currencyCode?: CurrencyCode;
        effectiveAt?: Date;
        capturedAt?: Date;
      } | null;
      fxProviderCandidates?: ReturnType<typeof providerFxSnapshot>[];
      fxAdminSnapshot?: ReturnType<typeof adminFxSnapshot> | null;
      equitySnapshotId?: string;
      equityHistoryTotalAssetKrw?: string;
    } = {},
  ) => {
    const currencyCode = input.currencyCode ?? CurrencyCode.KRW;
    const assetId = input.assetId ?? 'asset-1';
    const assetType =
      input.assetType ??
      (currencyCode === CurrencyCode.USD
        ? AssetType.us_stock
        : AssetType.domestic_stock);
    const market =
      input.market ??
      (assetType === AssetType.crypto
        ? 'BINANCE'
        : currencyCode === CurrencyCode.USD
          ? 'NASDAQ'
          : 'KRX');

    prisma.tradingAccount.findUnique.mockResolvedValueOnce({
      userId: 'user-1',
      mode: 'season',
      initialCapitalKrw: new Prisma.Decimal(
        input.initialCapitalKrw ?? '1000000.00000000',
      ),
      seasonParticipant: {
        id: 'sp-1',
        userId: 'user-1',
        initialCapitalKrw: new Prisma.Decimal(
          input.initialCapitalKrw ?? '1000000.00000000',
        ),
      },
      cashWallets: [
        {
          walletScope: 'securities' as const,
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal(input.krwCash ?? '0.00000000'),
        },
        {
          walletScope: 'securities' as const,
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal(input.usdCash ?? '0.00000000'),
        },
        {
          walletScope: 'crypto_spot' as const,
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
        {
          walletScope: 'crypto_futures' as const,
          currencyCode: CurrencyCode.USD,
          balanceAmount: new Prisma.Decimal('0.00000000'),
        },
      ],
      positions: [
        {
          id: input.positionId ?? 'position-1',
          assetId,
          quantity: new Prisma.Decimal(input.quantity ?? '1.00000000'),
          averageCost: new Prisma.Decimal(input.averageCost ?? '100.00000000'),
          currencyCode,
          asset: {
            id: assetId,
            assetType,
            market,
            currencyCode,
            priceCurrency: currencyCode,
            settlementCurrency: currencyCode,
          },
        },
      ],
    });

    if (currencyCode === CurrencyCode.USD || input.usdCash) {
      prisma.fxRateSnapshot.findMany.mockResolvedValueOnce(
        input.fxProviderCandidates ?? [
          providerFxSnapshot({
            id: 'fx-portfolio-1',
            rate: '1400.00000000',
            sourceName: 'exchange_rate_api',
          }),
        ],
      );
      if (Object.prototype.hasOwnProperty.call(input, 'fxAdminSnapshot')) {
        prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce(
          input.fxAdminSnapshot ?? null,
        );
      }
    }

    prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce(
      (
        input.assetProviderCandidates ?? [
          providerAssetSnapshot({
            id: 'aps-portfolio-1',
            price: '100.00000000',
            currencyCode,
            sourceName:
              assetType === AssetType.crypto
                ? 'binance_public_rest_24hr_ticker'
                : currencyCode === CurrencyCode.USD
                  ? 'kis_us_delayed_trade'
                  : 'kis_krx_realtime_trade',
          }),
        ]
      ).map((snapshot) => ({ ...snapshot, assetId, createdAt: executedAt })),
    );
    if (Object.prototype.hasOwnProperty.call(input, 'assetAdminSnapshot')) {
      const snapshot = input.assetAdminSnapshot;
      prisma.assetPriceSnapshot.findFirst.mockResolvedValueOnce(
        snapshot
          ? {
              id: snapshot.id,
              assetId,
              sourceType: AssetPriceSourceType.admin_manual,
              createdAt: snapshot.capturedAt ?? executedAt,
              price: new Prisma.Decimal(snapshot.price),
              priceKrw: null,
              currencyCode: snapshot.currencyCode ?? currencyCode,
              sourceName: 'manual-price',
              effectiveAt: snapshot.effectiveAt ?? executedAt,
              capturedAt: snapshot.capturedAt ?? executedAt,
            }
          : null,
      );
    }

    prisma.position.update.mockResolvedValueOnce({
      id: input.positionId ?? 'position-1',
    });
    prisma.equitySnapshot.create.mockResolvedValueOnce({
      id: input.equitySnapshotId ?? 'equity-order-1',
    });
    prisma.equitySnapshot.findMany.mockResolvedValueOnce([
      {
        totalAssetKrw: new Prisma.Decimal(
          input.equityHistoryTotalAssetKrw ?? '1000000.00000000',
        ),
        capturedAt: executedAt,
      },
    ]);
    prisma.seasonParticipant.update.mockResolvedValueOnce({ id: 'sp-1' });
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

  const canceledLimitOrderRecord = (
    overrides: Partial<Record<string, unknown>> = {},
  ) => ({
    cashWalletScope: 'securities' as const,
    id: 'order-1',
    tradingAccountId: 'trading-account-1',
    quoteId: 'quote-1',
    side: OrderSide.buy,
    orderType: OrderType.limit,
    status: OrderStatus.canceled,
    quantity: new Prisma.Decimal('1.000000'),
    limitPrice: new Prisma.Decimal('100.00000000'),
    executedPrice: null,
    currencyCode: CurrencyCode.KRW,
    grossAmount: new Prisma.Decimal('100.00000000'),
    feeAmount: new Prisma.Decimal('0.10000000'),
    netAmount: new Prisma.Decimal('100.10000000'),
    assetPriceSnapshotId: null,
    fxRateSnapshotId: null,
    reservedAmount: new Prisma.Decimal('100.10000000'),
    reservationReleasedAt: canceledAt,
    cancelReason: 'user_canceled',
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
    ...overrides,
  });

  const expectAvailableCashDebitCall = (
    prisma: ReturnType<typeof createPrisma>,
    input: {
      walletId: string;
      tradingAccountId?: string;
      currencyCode: CurrencyCode;
      amount: string;
    },
  ) => {
    // debitAvailableCash is guarded by the canonical account id.
    const tradingAccountId = input.tradingAccountId ?? 'trading-account-1';
    const matched = prisma.$executeRaw.mock.calls.some((args: unknown[]) => {
      const values = args.slice(1);
      return (
        values[0] === input.amount &&
        values[1] === input.walletId &&
        values[2] === tradingAccountId &&
        values[3] === 'securities' &&
        values[4] === input.currencyCode &&
        values[5] === input.amount
      );
    });
    expect(matched).toBe(true);
  };

  const expectQuoteConsumeCall = (
    prisma: ReturnType<typeof createPrisma>,
    input: { quoteId: string; consumedAt: Date },
  ) => {
    expect(prisma.quote.updateMany).toHaveBeenCalledWith({
      where: {
        id: input.quoteId,
        status: 'active',
        tradingAccountId: 'trading-account-1',
      },
      data: { status: 'consumed', consumedAt: input.consumedAt },
    });
  };

  const expectNoOrderWrites = (
    prisma: ReturnType<typeof createPrisma>,
    options: { allowTransaction?: boolean } = {},
  ) => {
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

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.create).not.toHaveBeenCalled();
    expect(prisma.fxExecuteRequest.update).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    if (!options.allowTransaction) {
      expect(prisma.$transaction).not.toHaveBeenCalled();
    }
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
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
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
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
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
    mockPosition(prisma, '3.50000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'market',
      quantity: '2.000000',
    });

    expect(response.data).toMatchObject({
      state: 'available',
      asset: {
        id: 'asset-1',
        currencyCode: CurrencyCode.USD,
      },
      side: OrderSide.buy,
      orderType: OrderType.market,
      quantity: '2.000000',
      price: '100.00000000',
      grossAmount: '200.00000000',
      feeRate: '0.001000',
      feeAmount: '0.20000000',
      netAmount: '200.20000000',
      krwGrossAmount: '280000.00000000',
      krwFeeAmount: '280.00000000',
      krwNetAmount: '280280.00000000',
      walletBalanceBefore: '1000.00000000',
      estimatedWalletBalanceAfter: '799.80000000',
      positionQuantityBefore: '3.50000000',
      estimatedPositionQuantityAfter: '5.50000000',
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: 'fx-1',
      quoteId: 'quote-order-1',
      expiresAt: expect.any(String),
      maxChangeBps: '30.0000',
    });
    expect(
      new Date(response.data.expiresAt ?? '').getTime() -
        new Date(response.data.quoteAt).getTime(),
    ).toBe(15_000);
    expect(prisma.quote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cashWalletScope: 'securities' as const,
          quoteType: 'order',
          status: 'active',
          userId: 'user-1',
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-1',
          side: OrderSide.buy,
          orderType: OrderType.market,
          quantity: '2.000000',
          limitPrice: null,
          currencyCode: CurrencyCode.USD,
          quotedPrice: '100.00000000',
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: 'fx-1',
          maxChangeBps: '30.0000',
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
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
  });

  it('rejects order quote for excluded season participants before quote persistence', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...participant,
      participantStatus: ParticipantStatus.excluded,
    });

    await expectErrorCode(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '2.000000',
      }),
      'PARTICIPANT_EXCLUDED',
    );
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(prisma.quote.create).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('fails closed when the participant has no trading account link', async () => {
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      ...participant,
      tradingAccountId: null,
    });

    await expectErrorCode(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '2.000000',
      }),
      'TRADING_ACCOUNT_LINK_INTEGRITY',
    );
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
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
        id: 'provider-fx-exchange',
        rate: new Prisma.Decimal('1500.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      },
      {
        id: 'provider-fx-korea-exim',
        rate: new Prisma.Decimal('1490.00000000'),
        sourceType: FxRateSourceType.provider_api,
        sourceName: 'korea_exim_exchange_rate',
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
      krwGrossAmount: '327800.00000000',
      assetPriceSnapshotId: 'provider-price-us',
      fxRateSnapshotId: 'provider-fx-korea-exim',
      assetPriceSource: {
        sourceType: 'provider_api',
        sourceName: 'kis_us_delayed_trade',
        snapshotId: 'provider-price-us',
        fallbackUsed: false,
      },
      fxRateSource: {
        sourceType: 'provider_api',
        sourceName: 'korea_exim_exchange_rate',
        snapshotId: 'provider-fx-korea-exim',
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
    mockCashWallet(prisma, '1000.00000000', 'crypto_spot');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-btc',
      side: 'buy',
      orderType: 'market',
      amount: '500',
    });

    expect(response.data).toMatchObject({
      asset: {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
      },
      amount: '500.00000000',
      quantity: '0.010000',
      currencyCode: CurrencyCode.USD,
      grossAmount: '500.00000000',
      feeAmount: '0.50000000',
      netAmount: '500.50000000',
      krwGrossAmount: '700000.00000000',
      krwFeeAmount: '700.00000000',
      krwNetAmount: '700700.00000000',
      walletBalanceBefore: '1000.00000000',
      estimatedWalletBalanceAfter: '499.50000000',
      positionQuantityBefore: '0.00000000',
      estimatedPositionQuantityAfter: '0.01000000',
      assetPriceSnapshotId: 'aps-btc-1',
      fxRateSnapshotId: 'fx-1',
      maxChangeBps: '30.0000',
    });
    expect(prisma.cashWallet.findUnique).toHaveBeenCalledWith({
      where: {
        tradingAccountId_walletScope_currencyCode: {
          walletScope: 'crypto_spot',
          tradingAccountId: 'trading-account-1',
          currencyCode: CurrencyCode.USD,
        },
      },
      select: {
        walletScope: true,
        id: true,
        tradingAccountId: true,
        balanceAmount: true,
        reservedAmount: true,
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
    mockAssetPrice(prisma, '50000.00000000');
    mockFreshFx(prisma);
    mockPosition(prisma, '0.02000000');
    mockCashWallet(prisma, '25.00000000', 'crypto_spot');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-btc',
      side: 'sell',
      orderType: 'market',
      quantity: '0.010000',
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
      walletBalanceBefore: '25.00000000',
      estimatedWalletBalanceAfter: '524.50000000',
      positionQuantityBefore: '0.02000000',
      estimatedPositionQuantityAfter: '0.01000000',
      fxRateSnapshotId: 'fx-1',
      assetPriceSource: {
        sourceType: 'admin_manual',
        sourceName: 'manual-price',
        snapshotId: 'aps-1',
        fallbackUsed: true,
        fallbackReason: 'provider_missing',
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
        tradingAccountId_assetId: {
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-btc',
        },
      },
      select: {
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
      },
    });
    expectNoOrderWrites(prisma);
  });

  it('rejects limit quote orders', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);

    await expectErrorCode(
      service.quoteOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '3.000000',
        limitPrice: '50000.00000000',
        currencyCode: CurrencyCode.KRW,
      }),
      'LIMIT_ORDER_DISABLED',
    );
    expectNoOrderWrites(prisma);
  });

  it('quotes sell orders after checking position quantity', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockAsset(prisma, CurrencyCode.KRW);
    mockAssetPrice(prisma, '10000.00000000');
    mockPosition(prisma, '5.00000000');

    const response = await service.quoteOrder('user-1', {
      assetId: 'asset-1',
      side: 'sell',
      orderType: 'market',
      quantity: '2.000000',
    });

    expect(response.data).toMatchObject({
      side: OrderSide.sell,
      grossAmount: '20000.00000000',
      feeAmount: '20.00000000',
      netAmount: '19980.00000000',
      maxChangeBps: '30.0000',
    });
    expect(prisma.position.findUnique).toHaveBeenCalledWith({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-1',
        },
      },
      select: {
        tradingAccountId: true,
        quantity: true,
        reservedQuantity: true,
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

  it('creates and immediately executes market buy orders from durable quotes', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService(true);
    mockActiveSeason(prisma);
    mockJoined(prisma);
    prisma.quote.findFirst.mockResolvedValueOnce({
      currencyCode: CurrencyCode.KRW,
    });
    mockOrderQuoteForCreate(prisma, {
      quantity: new Prisma.Decimal('2.000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: null,
    });
    prisma.order.create.mockResolvedValueOnce({ id: 'order-created-1' });
    prisma.order.findUnique.mockResolvedValueOnce(
      orderExecutionRecord({
        id: 'order-created-1',
        quote: buildOrderQuoteRecord({
          id: 'quote-order-create-1',
          quantity: new Prisma.Decimal('2.000000'),
          quotedPrice: new Prisma.Decimal('100.00000000'),
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: null,
        }),
      }),
    );
    mockExecutionPrice(prisma);
    mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
    prisma.position.findUnique.mockResolvedValueOnce(null);
    prisma.position.create.mockResolvedValueOnce({ id: 'position-1' });
    prisma.walletTransaction.create.mockResolvedValueOnce({
      id: 'wallet-tx-create-buy-1',
    });
    mockOrderFinalization(
      prisma,
      executedOrderExecutionRecord({
        id: 'order-created-1',
        quoteId: 'quote-order-create-1',
      }),
    );
    prisma.order.update.mockResolvedValueOnce({ id: 'order-created-1' });

    const response = await service.createOrder('user-1', {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'market',
      quantity: '2.000000',
      quoteId: 'quote-order-create-1',
      idempotencyKey: 'order-create-key-1',
    });

    expect(response.data).toMatchObject({
      order: {
        orderId: 'order-created-1',
        status: OrderStatus.executed,
        executedPrice: '100.00000000',
        grossAmount: '200.00000000',
        feeAmount: '0.20000000',
        netAmount: '200.20000000',
        assetPriceSnapshotId: 'aps-exec-1',
      },
      execution: {
        state: 'executed',
        quoteId: 'quote-order-create-1',
        quotedPrice: '100.00000000',
        executePrice: '100.00000000',
        priceChangeBps: '0.0000',
        walletTransactionId: 'wallet-tx-create-buy-1',
        positionId: 'position-1',
        duplicate: false,
      },
    });
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-1',
          status: OrderStatus.submitted,
          quantity: '2.000000',
          quoteId: 'quote-order-create-1',
          limitPrice: null,
          executedPrice: null,
          idempotencyKey: 'order-create-key-1',
          requestHash: expect.any(String),
          executedAt: null,
        }),
      }),
    );
    expectQuoteConsumeCall(prisma, {
      quoteId: 'quote-order-create-1',
      consumedAt: krxMarketOpenAt,
    });
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: {
        id: 'order-created-1',
      },
      data: {
        responsePayloadJson: expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            order: expect.objectContaining({
              status: OrderStatus.executed,
            }),
            execution: expect.objectContaining({
              state: 'executed',
            }),
          }),
        }),
      },
      select: {
        id: true,
      },
    });
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.position.create).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('requires a requote when provider price changes too much during create execution', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockOrderQuoteForCreate(prisma, {
      quantity: new Prisma.Decimal('2.000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: null,
    });
    prisma.order.create.mockResolvedValueOnce({ id: 'order-created-1' });
    prisma.order.findUnique.mockResolvedValueOnce(
      orderExecutionRecord({
        id: 'order-created-1',
        quote: buildOrderQuoteRecord({
          id: 'quote-order-create-1',
          quantity: new Prisma.Decimal('2.000000'),
          quotedPrice: new Prisma.Decimal('100.00000000'),
          assetPriceSnapshotId: 'aps-1',
          fxRateSnapshotId: null,
        }),
      }),
    );
    mockExecutionPrice(prisma, '101.00000000');

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '2.000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-price-changed',
      }),
      'RATE_CHANGED_REQUOTE_REQUIRED',
    );
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it.each(['fresh', 'stale68', 'fallback', 'failure', 'requote'])(
    'prepares crypto USD market FX outside the transaction: %s',
    async (scenario) => {
      const { prisma, service, primary, secondary } = createService(true);
      let inTransaction = false;
      prisma.$transaction.mockImplementation(
        async (
          callback: (tx: ReturnType<typeof createPrisma>) => Promise<unknown>,
        ) => {
          inTransaction = true;
          try {
            return await callback(prisma);
          } finally {
            inTransaction = false;
          }
        },
      );
      const asset = {
        id: 'asset-btc',
        symbol: 'BTCUSDT',
        name: 'Bitcoin',
        market: 'BINANCE',
        assetType: AssetType.crypto,
        currencyCode: CurrencyCode.USD,
        isActive: true,
      };
      const quote = buildOrderQuoteRecord({
        id: 'quote-order-create-1',
        assetId: 'asset-btc',
        asset,
        currencyCode: CurrencyCode.USD,
        quantity: new Prisma.Decimal('0.010000'),
        sourceAmount: new Prisma.Decimal('500'),
        quotedPrice: new Prisma.Decimal('50000.00000000'),
        assetPriceSnapshotId: 'aps-btc-1',
        fxRateSnapshotId: 'fx-1',
      });
      mockActiveSeason(prisma);
      mockJoined(prisma);
      prisma.quote.findFirst.mockResolvedValueOnce({
        currencyCode: CurrencyCode.USD,
      });
      mockOrderQuoteForCreate(prisma, {
        assetId: 'asset-btc',
        asset,
        currencyCode: CurrencyCode.USD,
        quantity: new Prisma.Decimal('0.010000'),
        sourceAmount: new Prisma.Decimal('500'),
        quotedPrice: new Prisma.Decimal('50000.00000000'),
        assetPriceSnapshotId: 'aps-btc-1',
        fxRateSnapshotId: 'fx-1',
      });
      prisma.order.create.mockResolvedValueOnce({ id: 'order-btc-create-1' });
      prisma.order.findUnique.mockResolvedValueOnce(
        cryptoUsdOrderExecutionRecord({
          id: 'order-btc-create-1',
          quote,
        }),
      );
      mockExecutionPrice(
        prisma,
        '50000.00000000',
        'aps-btc-exec-1',
        'binance_public_rest_24hr_ticker',
      );
      const source =
        scenario === 'fallback'
          ? 'exchange_rate_api'
          : 'korea_exim_exchange_rate';
      const rows = [
        {
          id: 'fx-exec-1-korea-exim',
          sourceName: 'korea_exim_exchange_rate',
          sourceType: FxRateSourceType.provider_api,
          rate: new Prisma.Decimal('1400'),
          effectiveAt: new Date(Date.now() - 86400000),
          capturedAt: new Date(
            Date.now() - (scenario === 'fresh' ? 30000 : 68000),
          ),
        },
      ];
      prisma.fxRateSnapshot.findMany.mockImplementation(
        ({ where }: { where: { sourceName: unknown } }) =>
          Promise.resolve(
            rows.filter(
              (r) =>
                typeof where.sourceName !== 'string' ||
                r.sourceName === where.sourceName,
            ),
          ),
      );
      primary.ensureFreshUsdKrwSnapshot.mockImplementation(async () => {
        await Promise.resolve();
        expect(inTransaction).toBe(false);
        if (scenario === 'failure' || scenario === 'fallback')
          throw new ProviderHttpError(
            'korea_exim_exchange_rate',
            'PROVIDER_TIMEOUT',
            'fixture',
          );
        rows[0] = {
          ...rows[0],
          capturedAt: new Date(),
          rate: new Prisma.Decimal(scenario === 'requote' ? '1500' : '1400'),
        };
      });
      secondary.ingestUsdKrw.mockImplementation(async () => {
        expect(inTransaction).toBe(false);
        if (scenario === 'fallback')
          rows[0] = { ...rows[0], sourceName: source, capturedAt: new Date() };
        return await Promise.resolve({ success: scenario === 'fallback' });
      });
      mockExecutionWallet(
        prisma,
        '1000.00000000',
        '499.50000000',
        CurrencyCode.USD,
      );
      prisma.position.findUnique.mockResolvedValueOnce(null);
      prisma.position.create.mockResolvedValueOnce({ id: 'position-btc-1' });
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-btc-create-buy-1',
      });
      mockOrderFinalization(
        prisma,
        executedCryptoUsdOrderExecutionRecord({
          id: 'order-btc-create-1',
          quoteId: 'quote-order-create-1',
        }),
      );
      prisma.order.update.mockResolvedValueOnce({ id: 'order-btc-create-1' });

      const pending = service.createOrder('user-1', {
        assetId: 'asset-btc',
        side: 'buy',
        orderType: 'market',
        amount: '500',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-key-btc',
      });

      if (scenario === 'failure' || scenario === 'requote') {
        await expect(pending).rejects.toMatchObject({
          response: {
            error: {
              code:
                scenario === 'failure'
                  ? 'PROVIDER_RATE_STALE'
                  : 'RATE_CHANGED_REQUOTE_REQUIRED',
            },
          },
        });
        expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
        expect(prisma.position.create).not.toHaveBeenCalled();
        return;
      }
      const response = await pending;
      expect(primary.ensureFreshUsdKrwSnapshot).toHaveBeenCalledTimes(
        scenario === 'fresh' ? 0 : 1,
      );
      expect(secondary.ingestUsdKrw).toHaveBeenCalledTimes(
        scenario === 'fallback' ? 1 : 0,
      );
      expect(response.data).toMatchObject({
        order: {
          orderId: 'order-btc-create-1',
          status: OrderStatus.executed,
          asset: {
            symbol: 'BTCUSDT',
            market: 'BINANCE',
            currencyCode: CurrencyCode.USD,
          },
          currencyCode: CurrencyCode.USD,
          grossAmount: '500.00000000',
          feeAmount: '0.50000000',
          netAmount: '500.50000000',
          assetPriceSnapshotId: 'aps-btc-exec-1',
          fxRateSnapshotId: 'fx-exec-1',
        },
        execution: {
          state: 'executed',
          quotedRate: '1400.00000000',
          executeRate: '1400.00000000',
          fxRateSnapshotId: 'fx-exec-1-korea-exim',
          walletTransactionId: 'wallet-tx-btc-create-buy-1',
          positionId: 'position-btc-1',
        },
      });
      expectAvailableCashDebitCall(prisma, {
        walletId: 'wallet-1',
        currencyCode: CurrencyCode.USD,
        amount: '500.50000000',
      });
    },
  );

  it('rejects limit order create requests', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '1.000000',
        limitPrice: '50000.00000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-limit',
      }),
      'LIMIT_ORDER_DISABLED',
    );
    expectNoOrderWrites(prisma);
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
        orderType: 'market',
        quantity: '1.000000',
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
      orderType: OrderType.market,
      quantity: new Prisma.Decimal('1.000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: null,
    });

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: 'order-create-market-closed',
      }),
      'MARKET_CLOSED',
    );
    expect(prisma.order.create).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma, { allowTransaction: true });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects create without idempotencyKey', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
        quoteId: 'quote-order-create-1',
      }),
      'IDEMPOTENCY_REQUIRED',
    );
    expectNoOrderWrites(prisma);
  });

  it('rejects create with invalid idempotencyKey', async () => {
    const { prisma, service } = createService();

    await expectErrorCode(
      service.createOrder('user-1', {
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'market',
        quantity: '1.00000000',
        quoteId: 'quote-order-create-1',
        idempotencyKey: '   ',
      }),
      'IDEMPOTENCY_REQUIRED',
    );
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
    const { prisma, service, primary, secondary } = createService(true);
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
    expect(primary.ensureFreshUsdKrwSnapshot).not.toHaveBeenCalled();
    expect(secondary.ingestUsdKrw).not.toHaveBeenCalled();
    expect(prisma.quote.findFirst).not.toHaveBeenCalled();
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
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.market,
      quantity: new Prisma.Decimal('1.000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: null,
    });
    let racedRequestHash = '';
    // Pre-transaction lookups: the quote-scoped committed replay and the
    // canonical account scope must both miss to reach the create.
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.findFirst.mockResolvedValueOnce(null); // post-quote-lock replay lookup
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
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('conflicts after a unique idempotency race with different payload', async () => {
    useKrxMarketOpenTime();
    const { prisma, service } = createService();
    mockActiveSeason(prisma);
    mockJoined(prisma);
    mockOrderQuoteForCreate(prisma, {
      orderType: OrderType.market,
      quantity: new Prisma.Decimal('1.000000'),
      quotedPrice: new Prisma.Decimal('100.00000000'),
      assetPriceSnapshotId: 'aps-1',
      fxRateSnapshotId: null,
    });
    // Pre-transaction lookups: the quote-scoped committed replay and the
    // canonical account scope must both miss to reach the create.
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.findFirst.mockResolvedValueOnce(null);
    prisma.order.findFirst.mockResolvedValueOnce(null); // post-quote-lock replay lookup
    prisma.order.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.order.findFirst.mockResolvedValueOnce(
      idempotentOrderRecord('different-request-hash'),
    );

    await expect(
      service.createOrder('user-1', orderCreateBody),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
        nextOffset: null,
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
          quantity: '3.000000',
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
          tradingAccountId: 'trading-account-1',
          status: OrderStatus.executed,
          side: OrderSide.buy,
          assetId: 'asset-1',
        },
      }),
    );
    expectNoOrderWrites(prisma);
  });

  it('returns a single owned order detail with public execution metadata', async () => {
    const { prisma, service } = createService();
    prisma.order.findFirst.mockResolvedValueOnce({
      cashWalletScope: 'securities' as const,
      id: 'order-1',
      tradingAccountId: 'trading-account-1',
      assetId: 'asset-1',
      quoteId: 'quote-order-1',
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
        assetType: AssetType.us_stock,
        currencyCode: CurrencyCode.USD,
        priceCurrency: CurrencyCode.USD,
        settlementCurrency: CurrencyCode.USD,
      },
      quote: null,
      seasonParticipant: {
        id: 'sp-1',
        participantStatus: ParticipantStatus.active,
        joinedAt,
        tradingAccountId: 'trading-account-1',
        season: activeSeason,
      },
      assetPriceSnapshot: {
        sourceType: AssetPriceSourceType.provider_api,
      },
    });

    const response = await service.getOrder('user-1', 'order-1');

    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'order-1',
          tradingAccount: {
            userId: 'user-1',
            mode: 'season',
          },
        },
      }),
    );
    expect(response.data).toMatchObject({
      order: {
        orderId: 'order-1',
        quoteId: 'quote-order-1',
        status: OrderStatus.executed,
        executedPrice: '101.25000000',
      },
      execution: {
        state: OrderStatus.executed,
        priceSource: AssetPriceSourceType.provider_api,
        quoteId: 'quote-order-1',
        assetPriceSnapshotId: 'aps-1',
        fxRateSnapshotId: 'fx-1',
      },
    });
    expect(JSON.stringify(response.data)).not.toContain('responsePayloadJson');
    expectNoOrderWrites(prisma);
  });

  it('returns not found for missing or unowned order detail', async () => {
    const { prisma, service } = createService();
    prisma.order.findFirst.mockResolvedValueOnce(null);

    await expectErrorCode(
      service.getOrder('user-1', 'order-other-user'),
      'ORDER_NOT_FOUND',
    );
    expect(prisma.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'order-other-user',
          tradingAccount: {
            userId: 'user-1',
            mode: 'season',
          },
        },
      }),
    );
    expectNoOrderWrites(prisma);
  });

  it('keeps market order cancel unsupported (410) after the limit rollout', async () => {
    const { prisma, service } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-submitted-1' }]);
    prisma.order.findUnique.mockResolvedValueOnce({
      cashWalletScope: 'securities' as const,
      id: 'order-submitted-1',
      tradingAccountId: 'trading-account-1',
      quoteId: null,
      side: OrderSide.buy,
      orderType: OrderType.market,
      status: OrderStatus.submitted,
      quantity: new Prisma.Decimal('1.000000'),
      limitPrice: null,
      executedPrice: null,
      currencyCode: CurrencyCode.KRW,
      grossAmount: null,
      feeAmount: null,
      netAmount: null,
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
      reservedAmount: null,
      reservationReleasedAt: null,
      cancelReason: null,
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

    await expectErrorCode(
      service.cancelOrder('user-1', 'order-submitted-1'),
      'ORDER_CANCEL_NOT_SUPPORTED',
    );
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
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
          tradingAccountId: 'trading-account-1',
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
    await expect(service.getOrder(undefined, 'order-1')).rejects.toBeInstanceOf(
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
    // Ownership is enforced in the locking SELECT itself: no row comes back.
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(
      service.cancelOrder('user-1', 'order-other-user'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expectNoOrderWrites(prisma, { allowTransaction: true });
  });

  it.each([OrderStatus.executed, OrderStatus.rejected])(
    'rejects cancel for %s orders with ORDER_NOT_CANCELABLE',
    async (status) => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        canceledLimitOrderRecord({ status }),
      );

      await expectErrorCode(
        service.cancelOrder('user-1', 'order-1'),
        'ORDER_NOT_CANCELABLE',
      );
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    },
  );

  it('replays cancel idempotently for already-canceled limit orders', async () => {
    const { prisma, service } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
    prisma.order.findUnique.mockResolvedValueOnce(
      canceledLimitOrderRecord({ status: OrderStatus.canceled }),
    );

    const response = await service.cancelOrder('user-1', 'order-1');

    expect(response.data.execution).toMatchObject({
      state: 'not_executed',
      reason: 'ORDER_CANCELED_BEFORE_EXECUTION',
      alreadyCanceled: true,
      reservedAmountReleased: null,
    });
    // The reservation is NEVER released twice.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
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

  describe('closed-stock post-execution valuation parity', () => {
    const valuationAt = new Date('2026-07-10T09:00:00Z');
    const sessionClose = new Date('2026-07-10T06:30:00Z');
    const price = (
      id: string,
      value: string,
      effectiveAt = sessionClose,
      sourceType: AssetPriceSourceType = AssetPriceSourceType.provider_api,
      sourceName = 'kis_krx_realtime_trade',
    ) => ({
      id,
      assetId: 'asset-1',
      price: new Prisma.Decimal(value),
      priceKrw: null,
      currencyCode: CurrencyCode.KRW,
      sourceType,
      sourceName,
      effectiveAt,
      capturedAt: new Date(effectiveAt.getTime() + 2000),
      createdAt: valuationAt,
    });
    const manual = (id: string, value: string, at = sessionClose) =>
      price(id, value, at, AssetPriceSourceType.admin_manual, 'operator');

    function setup(rows: ReturnType<typeof price>[]) {
      const tx = createPrisma();
      const root = createPrisma();
      const orders = new OrdersService(root as never);
      const portfolio = new PortfolioValuationService(root as never);
      const initialCapitalKrw = new Prisma.Decimal('2000000');
      tx.tradingAccount.findUnique.mockResolvedValue({
        id: 'trading-account-1',
        userId: 'user-1',
        mode: 'season',
        initialCapitalKrw,
        seasonParticipant: { id: 'sp-1', userId: 'user-1', initialCapitalKrw },
        cashWallets: [
          {
            walletScope: 'securities' as const,
            currencyCode: CurrencyCode.KRW,
            balanceAmount: new Prisma.Decimal('1917000'),
          },
          {
            walletScope: 'securities' as const,
            currencyCode: CurrencyCode.USD,
            balanceAmount: new Prisma.Decimal('0'),
          },
          {
            walletScope: 'crypto_spot' as const,
            currencyCode: CurrencyCode.USD,
            balanceAmount: new Prisma.Decimal('0.00000000'),
          },
          {
            walletScope: 'crypto_futures' as const,
            currencyCode: CurrencyCode.USD,
            balanceAmount: new Prisma.Decimal('0.00000000'),
          },
        ],
        positions: [
          {
            id: 'position-1',
            assetId: 'asset-1',
            quantity: new Prisma.Decimal('2'),
            averageCost: new Prisma.Decimal('100000'),
            currencyCode: CurrencyCode.KRW,
            realizedPnl: new Prisma.Decimal('0'),
            realizedPnlKrw: new Prisma.Decimal('0'),
            asset: {
              id: 'asset-1',
              assetType: AssetType.domestic_stock,
              market: 'KRX',
              currencyCode: CurrencyCode.KRW,
              priceCurrency: CurrencyCode.KRW,
              settlementCurrency: CurrencyCode.KRW,
            },
          },
        ],
      });
      type Query = {
        where: {
          assetId: string;
          currencyCode: CurrencyCode;
          sourceType: AssetPriceSourceType;
          sourceName?: string;
          price?: { gt: number };
          id?: { in: string[] };
          effectiveAt?: { gte?: Date; lte: Date };
        };
        take?: number;
      };
      const queryRows = ({ where, take }: Query) =>
        rows
          .filter(
            (row) =>
              row.assetId === where.assetId &&
              row.currencyCode === where.currencyCode &&
              row.sourceType === where.sourceType &&
              (!where.sourceName || row.sourceName === where.sourceName) &&
              (!where.price || row.price.gt(where.price.gt)) &&
              (!where.id || where.id.in.includes(row.id)) &&
              (!where.effectiveAt ||
                ((!where.effectiveAt.gte ||
                  row.effectiveAt >= where.effectiveAt.gte) &&
                  row.effectiveAt <= where.effectiveAt.lte)),
          )
          .sort(
            (a, b) =>
              b.effectiveAt.getTime() - a.effectiveAt.getTime() ||
              b.capturedAt.getTime() - a.capturedAt.getTime(),
          )
          .slice(0, take);
      tx.assetPriceSnapshot.findMany.mockImplementation((query: Query) =>
        Promise.resolve(queryRows(query)),
      );
      tx.assetPriceSnapshot.findFirst.mockImplementation((query: Query) =>
        Promise.resolve(queryRows(query)[0] ?? null),
      );
      tx.equitySnapshot.create.mockResolvedValue({ id: 'equity-order-1' });
      tx.equitySnapshot.findMany.mockResolvedValue([]);
      const record = () =>
        orders.recordOrderExecutedPortfolioSnapshotInTransaction(
          tx as never,
          'sp-1',
          valuationAt,
          'trading-account-1',
        );
      const live = () =>
        portfolio.calculateTradingAccountValuation(
          'trading-account-1',
          valuationAt,
          'live_portfolio_valuation',
          tx as never,
        );
      return { tx, root, record, live };
    }

    afterEach(() => resetMarketSessionOverrideStoreForTest());

    it.each([0, 25])(
      'uses the same completed-session provider with %i post-close observations',
      async (noiseCount) => {
        const { tx, root, record, live } = setup([
          price('close', '248500'),
          price('invalid', '0'),
          price(
            'wrong-source',
            '999999',
            sessionClose,
            AssetPriceSourceType.provider_api,
            'wrong_source',
          ),
          ...Array.from({ length: noiseCount }, (_, i) =>
            price(
              `noise-${i}`,
              '999999',
              new Date(sessionClose.getTime() + (i + 1) * 60000),
            ),
          ),
          manual('old-fallback', '191500', new Date('2026-07-09T06:30:00Z')),
        ]);
        const common = await live();
        await expect(record()).resolves.toBe('equity-order-1');
        expect(common.totalAssetKrw).toBe('2414000.00000000');
        expect(
          common.assetPriceSourceDecisions[0].sourceDecision.selectedSnapshotId,
        ).toBe('close');
        expect(
          (tx.position.update.mock.calls[0] as [Prisma.PositionUpdateArgs])[0],
        ).toMatchObject({
          data: {
            currentPriceLocal: '248500.00000000',
            marketValueKrw: '497000.00000000',
          },
        });
        expect(
          (
            tx.equitySnapshot.create.mock.calls[0] as [
              Prisma.EquitySnapshotCreateArgs,
            ]
          )[0],
        ).toMatchObject({
          data: {
            totalAssetKrw: common.totalAssetKrw,
            returnRate: common.returnRate,
          },
        });
        expect(
          (
            tx.seasonParticipant.update.mock.calls[0] as [
              Prisma.SeasonParticipantUpdateArgs,
            ]
          )[0],
        ).toMatchObject({
          data: {
            totalAssetKrw: common.totalAssetKrw,
            totalReturnRate: common.returnRate,
          },
        });
        expect(tx.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
        expect(root.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
        expect(root.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
        expect(root.tradingAccount.findUnique).not.toHaveBeenCalled();
      },
    );

    it('uses only positive admin fallback evidence inside the completed session', async () => {
      const { tx, record, live } = setup([
        price('outside-provider', '999999', valuationAt),
        manual('prior-session', '191500', new Date('2026-07-09T06:30:00Z')),
        manual(
          'inside-session',
          '248500',
          new Date(sessionClose.getTime() - 1000),
        ),
        manual('invalid', '0'),
        manual('post-close', '999999', valuationAt),
      ]);
      const common = await live();
      await record();
      expect(common.assetPriceSourceDecisions[0].sourceDecision).toMatchObject({
        selectedSnapshotId: 'inside-session',
        selectedSourceType: 'admin_manual',
        fallbackUsed: true,
      });
      expect(
        (
          tx.equitySnapshot.create.mock.calls[0] as [
            Prisma.EquitySnapshotCreateArgs,
          ]
        )[0],
      ).toMatchObject({
        data: { totalAssetKrw: common.totalAssetKrw },
      });
    });

    it.each([false, true])(
      'fails closed without an admissible session price (calendar unavailable: %s)',
      async (unavailable) => {
        if (unavailable) markMarketSessionOverrideStoreRequired();
        const { tx, record, live } = setup([
          ...(unavailable ? [manual('inside-session', '248500')] : []),
          manual('prior-session', '191500', new Date('2026-07-09T06:30:00Z')),
          manual('post-close', '999999', valuationAt),
        ]);
        await expect(live()).rejects.toBeInstanceOf(PortfolioValuationError);
        await expectErrorCode(record(), 'ASSET_PRICE_UNAVAILABLE');
        expect(tx.equitySnapshot.create).not.toHaveBeenCalled();
        expect(tx.seasonParticipant.update).not.toHaveBeenCalled();
      },
    );
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
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
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
          quantity: '2.000000',
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
      expectQuoteConsumeCall(prisma, {
        quoteId: 'quote-order-execute-1',
        consumedAt: executedAt,
      });
      expectAvailableCashDebitCall(prisma, {
        walletId: 'wallet-1',
        currencyCode: CurrencyCode.KRW,
        amount: '200.20000000',
      });
      expect(prisma.position.create).toHaveBeenCalledWith({
        data: {
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-1',
          quantity: '2.00000000',
          reservedQuantity: '0.00000000',
          averageCost: '100.10000000',
          currencyCode: CurrencyCode.KRW,
          realizedPnl: '0.00000000',
          realizedPnlKrw: '0.00000000',
        },
        select: {
          id: true,
        },
      });
      expect(prisma.walletTransaction.create).toHaveBeenCalledWith({
        data: {
          tradingAccountId: 'trading-account-1',
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
          tradingAccountId: 'trading-account-1',
          status: OrderStatus.submitted,
        },
        data: {
          status: OrderStatus.executed,
          quantity: '2.000000',
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

      expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.cashWallet.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.position.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.position.create).toHaveBeenCalledTimes(1);
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.quote.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
      const financialSteps = [
        prisma.quote.updateMany,
        prisma.cashWallet.findUnique,
        prisma.$executeRaw,
        prisma.cashWallet.findFirst,
        prisma.position.findUnique,
        prisma.position.create,
        prisma.walletTransaction.create,
        prisma.order.updateMany,
      ].map((fn) => fn.mock.invocationCallOrder[0]);
      expect(financialSteps).toEqual([...financialSteps].sort((a, b) => a - b));
    });

    it('executes Binance crypto USD buys with USD wallet debit, USD position, and FX snapshot audit', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(cryptoUsdOrderExecutionRecord());
      mockExecutionPrice(
        prisma,
        '50000.00000000',
        'aps-btc-exec-1',
        'binance_public_rest_24hr_ticker',
      );
      prisma.fxRateSnapshot.findMany.mockResolvedValueOnce([
        {
          id: 'fx-exec-exchange',
          rate: new Prisma.Decimal('1400.00000000'),
          sourceType: FxRateSourceType.provider_api,
          sourceName: 'exchange_rate_api',
          effectiveAt: new Date(Date.now()),
          capturedAt: new Date(Date.now()),
        },
        {
          id: 'fx-exec-korea-exim',
          rate: new Prisma.Decimal('1399.00000000'),
          sourceType: FxRateSourceType.provider_api,
          sourceName: 'korea_exim_exchange_rate',
          effectiveAt: new Date(Date.now()),
          capturedAt: new Date(Date.now()),
        },
      ]);
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
      mockOrderFinalization(
        prisma,
        executedCryptoUsdOrderExecutionRecord({
          fxRateSnapshotId: 'fx-exec-korea-exim',
        }),
      );

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
          fxRateSnapshotId: 'fx-exec-korea-exim',
        },
        execution: {
          state: 'executed',
          priceSource: 'provider_api',
          quoteId: 'quote-order-btc-execute-1',
          quotedPrice: '50000.00000000',
          executePrice: '50000.00000000',
          priceChangeBps: '0.0000',
          quotedRate: '1400.00000000',
          executeRate: '1399.00000000',
          rateChangeBps: '7.1429',
          fxRateSnapshotId: 'fx-exec-korea-exim',
          walletTransactionId: 'wallet-tx-btc-buy-1',
          walletBalanceAfter: '499.50000000',
          positionId: 'position-btc-1',
        },
      });
      expectAvailableCashDebitCall(prisma, {
        walletId: 'wallet-1',
        currencyCode: CurrencyCode.USD,
        amount: '500.50000000',
      });
      expect(prisma.position.create).toHaveBeenCalledWith({
        data: {
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-btc',
          quantity: '0.01000000',
          reservedQuantity: '0.00000000',
          averageCost: '50050.00000000',
          currencyCode: CurrencyCode.USD,
          realizedPnl: '0.00000000',
          realizedPnlKrw: '0.00000000',
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
            fxRateSnapshotId: 'fx-exec-korea-exim',
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('records buy equity snapshots with fresh provider asset and FX valuation snapshots', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(cryptoUsdOrderExecutionRecord());
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
      mockOrderExecutedPortfolioValuation(prisma, {
        positionId: 'position-btc-1',
        assetId: 'asset-btc',
        assetType: AssetType.crypto,
        market: 'BINANCE',
        currencyCode: CurrencyCode.USD,
        quantity: '0.01000000',
        averageCost: '50050.00000000',
        usdCash: '499.50000000',
        initialCapitalKrw: '1000000.00000000',
        assetProviderCandidates: [
          providerAssetSnapshot({
            id: 'aps-btc-portfolio-1',
            price: '50000.00000000',
            currencyCode: CurrencyCode.USD,
            sourceName: 'binance_public_rest_24hr_ticker',
          }),
        ],
        fxProviderCandidates: [
          providerFxSnapshot({
            id: 'fx-portfolio-korea-exim',
            rate: '1400.00000000',
            sourceName: 'korea_exim_exchange_rate',
          }),
        ],
        equitySnapshotId: 'equity-order-btc-1',
        equityHistoryTotalAssetKrw: '1399300.00000000',
      });

      const response = await service.executeOrder(
        'user-1',
        'order-btc-execute-1',
      );

      expect(response.data.execution.equitySnapshotId).toBe(
        'equity-order-btc-1',
      );
      expect(prisma.position.update).toHaveBeenCalledWith({
        where: {
          id: 'position-btc-1',
        },
        data: {
          currentPriceLocal: '50000.00000000',
          currentPriceKrw: '70000000.00000000',
          marketValueLocal: '500.00000000',
          marketValueKrw: '700000.00000000',
          unrealizedPnlLocal: '-0.50000000',
          unrealizedPnlKrw: '-700.00000000',
        },
        select: {
          id: true,
        },
      });
      expect(prisma.equitySnapshot.create).toHaveBeenCalledWith({
        data: {
          tradingAccountId: 'trading-account-1',
          totalAssetKrw: '1399300.00000000',
          returnRate: '39.93000000',
          krwCash: '0.00000000',
          usdCashKrw: '699300.00000000',
          domesticStockValueKrw: '0.00000000',
          usStockValueKrw: '0.00000000',
          cryptoValueKrw: '700000.00000000',
          snapshotReason: SnapshotReason.order_executed,
          capturedAt: executedAt,
        },
        select: {
          id: true,
        },
      });
      expect(prisma.seasonParticipant.update).toHaveBeenCalledWith({
        where: {
          id: 'sp-1',
        },
        data: {
          totalAssetKrw: '1399300.00000000',
          totalReturnRate: '39.93000000',
          maxDrawdown: '0.00000000',
          totalFillCount: {
            increment: 1,
          },
        },
        select: {
          id: true,
        },
      });
    });

    it('records sell equity snapshots after position and realizedPnl updates', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          side: OrderSide.sell,
          orderType: OrderType.market,
          limitPrice: null,
        }),
      );
      mockExecutionPrice(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
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
      mockOrderExecutedPortfolioValuation(prisma, {
        positionId: 'position-1',
        quantity: '3.00000000',
        averageCost: '80.00000000',
        krwCash: '299.80000000',
        initialCapitalKrw: '500.00000000',
        assetProviderCandidates: [
          providerAssetSnapshot({
            id: 'aps-sell-portfolio-1',
            price: '100.00000000',
          }),
        ],
        equitySnapshotId: 'equity-order-sell-1',
        equityHistoryTotalAssetKrw: '599.80000000',
      });

      const response = await service.executeOrder('user-1', 'order-execute-1');

      expect(response.data.execution.equitySnapshotId).toBe(
        'equity-order-sell-1',
      );
      expect(prisma.equitySnapshot.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalAssetKrw: '599.80000000',
            returnRate: '19.96000000',
            krwCash: '299.80000000',
            domesticStockValueKrw: '300.00000000',
            snapshotReason: SnapshotReason.order_executed,
          }),
        }),
      );
      expect(prisma.seasonParticipant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalAssetKrw: '599.80000000',
            totalReturnRate: '19.96000000',
            totalFillCount: {
              increment: 1,
            },
          }),
        }),
      );
    });

    it.each([
      {
        name: 'stale provider asset snapshot',
        assetProviderCandidates: [
          providerAssetSnapshot({
            id: 'aps-portfolio-stale',
            price: '100.00000000',
            capturedAt: new Date(executedAt.getTime() - 301_000),
            effectiveAt: new Date(executedAt.getTime() - 301_000),
          }),
        ],
        expectedCode: 'PRICE_STALE',
      },
      {
        name: 'wrong sourceName provider asset snapshot',
        assetProviderCandidates: [
          providerAssetSnapshot({
            id: 'aps-portfolio-wrong-source',
            price: '100.00000000',
            sourceName: 'unexpected_provider',
          }),
        ],
        expectedCode: 'ASSET_PRICE_UNAVAILABLE',
      },
    ])(
      'rejects execute when post-execute valuation has $name',
      async ({ assetProviderCandidates, expectedCode }) => {
        const { prisma, service } = createService();
        prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
        mockExecutionPrice(prisma);
        mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
        prisma.position.findUnique.mockResolvedValueOnce(null);
        prisma.position.create.mockResolvedValueOnce({ id: 'position-1' });
        prisma.walletTransaction.create.mockResolvedValueOnce({
          id: 'wallet-tx-buy-1',
        });
        mockOrderFinalization(prisma);
        mockOrderExecutedPortfolioValuation(prisma, {
          positionId: 'position-1',
          quantity: '2.00000000',
          averageCost: '100.10000000',
          krwCash: '799.80000000',
          assetProviderCandidates,
          assetAdminSnapshot: null,
        });

        await expectErrorCode(
          service.executeOrder('user-1', 'order-execute-1'),
          expectedCode,
        );
        expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
        expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
      },
    );

    it.each([
      {
        name: 'stale provider FX snapshot',
        fxProviderCandidates: [
          providerFxSnapshot({
            id: 'fx-portfolio-stale',
            rate: '1400.00000000',
            sourceName: 'exchange_rate_api',
            capturedAt: new Date(executedAt.getTime() - 7_201_000),
            effectiveAt: new Date(executedAt.getTime() - 7_201_000),
          }),
        ],
        fxAdminSnapshot: null,
        expectedCode: 'FX_RATE_STALE',
      },
      {
        name: 'unapproved admin_manual FX snapshot',
        fxProviderCandidates: [],
        fxAdminSnapshot: adminFxSnapshot({
          id: 'fx-admin-unapproved',
          rate: '1400.00000000',
          approvedByUserId: null,
        }),
        expectedCode: 'FX_RATE_UNAVAILABLE',
      },
    ])(
      'rejects execute when post-execute valuation has $name',
      async ({ fxProviderCandidates, fxAdminSnapshot, expectedCode }) => {
        const { prisma, service } = createService();
        prisma.order.findFirst.mockResolvedValue(
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
        mockOrderExecutedPortfolioValuation(prisma, {
          positionId: 'position-btc-1',
          assetId: 'asset-btc',
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
          quantity: '0.01000000',
          averageCost: '50050.00000000',
          usdCash: '499.50000000',
          fxProviderCandidates,
          fxAdminSnapshot,
        });

        await expectErrorCode(
          service.executeOrder('user-1', 'order-btc-execute-1'),
          expectedCode,
        );
        expect(prisma.equitySnapshot.create).not.toHaveBeenCalled();
        expect(prisma.seasonParticipant.update).not.toHaveBeenCalled();
      },
    );

    it('rejects US stock executes when provider price changes by more than 30 bps', async () => {
      jest.setSystemTime(usMarketOpenAt);
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          currencyCode: CurrencyCode.USD,
          asset: {
            id: 'asset-1',
            symbol: 'AAPL',
            name: 'Apple Inc.',
            market: 'NASDAQ',
            assetType: AssetType.us_stock,
            currencyCode: CurrencyCode.USD,
            isActive: true,
          },
          quotedPrice: new Prisma.Decimal('100.00000000'),
        }),
      );
      mockExecutionPrice(
        prisma,
        '100.31000000',
        'aps-us-price-changed',
        'kis_us_delayed_trade',
      );

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'RATE_CHANGED_REQUOTE_REQUIRED',
      );
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.quote.updateMany).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.position.create).not.toHaveBeenCalled();
    });

    it('rejects crypto executes when provider price changes by more than 30 bps', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(cryptoUsdOrderExecutionRecord());
      mockExecutionPrice(
        prisma,
        '50155.00000000',
        'aps-btc-price-changed',
        'binance_public_rest_24hr_ticker',
      );

      await expectErrorCode(
        service.executeOrder('user-1', 'order-btc-execute-1'),
        'RATE_CHANGED_REQUOTE_REQUIRED',
      );
      expect(prisma.fxRateSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.quote.updateMany).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.position.create).not.toHaveBeenCalled();
    });

    it('executes buy orders and updates weighted average for an existing position', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
      mockExecutionPrice(prisma);
      mockExecutionWallet(prisma, '1000.00000000', '799.80000000');
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
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
          tradingAccountId: 'trading-account-1',
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
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          side: OrderSide.sell,
          orderType: OrderType.market,
          limitPrice: null,
        }),
      );
      mockExecutionPrice(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
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
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-1',
          quantity: {
            gte: '2.00000000',
          },
          reservedQuantity: {
            lte: '3.00000000',
          },
        },
        data: {
          quantity: {
            decrement: '2.00000000',
          },
          realizedPnl: {
            increment: '39.80000000',
          },
          realizedPnlKrw: {
            increment: '39.80000000',
          },
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          walletScope: 'securities',
          id: 'wallet-1',
          tradingAccountId: 'trading-account-1',
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

      expect(prisma.position.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.position.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.walletTransaction.create).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
      const financialSteps = [
        prisma.quote.updateMany,
        prisma.position.findUnique,
        prisma.position.updateMany,
        prisma.cashWallet.findUnique,
        prisma.cashWallet.updateMany,
        prisma.cashWallet.findFirst,
        prisma.walletTransaction.create,
        prisma.order.updateMany,
      ].map((fn) => fn.mock.invocationCallOrder[0]);
      expect(financialSteps).toEqual([...financialSteps].sort((a, b) => a - b));
    });

    it('records negative realizedPnlKrw for loss sells', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          side: OrderSide.sell,
          orderType: OrderType.market,
          limitPrice: null,
          quotedPrice: new Prisma.Decimal('70.00000000'),
        }),
      );
      mockExecutionPrice(prisma, '70.00000000');
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
        quantity: new Prisma.Decimal('5.00000000'),
        averageCost: new Prisma.Decimal('80.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
      mockExecutionWallet(prisma, '100.00000000', '239.86000000');
      prisma.walletTransaction.create.mockResolvedValueOnce({
        id: 'wallet-tx-sell-loss-1',
      });
      mockOrderFinalization(
        prisma,
        executedOrderExecutionRecord({
          side: OrderSide.sell,
          executedPrice: new Prisma.Decimal('70.00000000'),
          grossAmount: new Prisma.Decimal('140.00000000'),
          feeAmount: new Prisma.Decimal('0.14000000'),
          netAmount: new Prisma.Decimal('139.86000000'),
        }),
      );

      await service.executeOrder('user-1', 'order-execute-1');

      expect(prisma.position.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            realizedPnl: {
              decrement: '20.14000000',
            },
            realizedPnlKrw: {
              decrement: '20.14000000',
            },
          }),
        }),
      );
      expectNoForbiddenExecuteSideEffects(prisma);
    });

    it('executes Binance crypto USD sells with USD wallet credit and USD ledger currency', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(
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
        tradingAccountId: 'trading-account-1',
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
          tradingAccountId: 'trading-account-1',
          assetId: 'asset-btc',
          quantity: {
            gte: '0.01000000',
          },
          reservedQuantity: {
            lte: '0.01000000',
          },
        },
        data: {
          quantity: {
            decrement: '0.01000000',
          },
          realizedPnl: {
            increment: '99.50000000',
          },
          realizedPnlKrw: {
            increment: '139300.00000000',
          },
        },
      });
      expect(prisma.cashWallet.updateMany).toHaveBeenCalledWith({
        where: {
          walletScope: 'securities',
          id: 'wallet-1',
          tradingAccountId: 'trading-account-1',
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
      prisma.order.findFirst.mockResolvedValue(null);

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
        prisma.order.findFirst.mockResolvedValue(
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
      prisma.order.findFirst.mockResolvedValue(executedOrderExecutionRecord());

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
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
      prisma.assetPriceSnapshot.findMany.mockResolvedValueOnce([]);

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'ASSET_PRICE_UNAVAILABLE',
      );
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects execute after season end even when status is still active', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          tradingAccount: {
            id: 'trading-account-1',
            userId: 'user-1',
            mode: 'season',
            status: 'active',
            initialCapitalKrw: new Prisma.Decimal('1000000.00000000'),
            seasonParticipant: {
              ...participant,
              season: {
                ...activeSeason,
                endAt: new Date('2026-05-06T00:00:00.000Z'),
              },
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
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'MARKET_CLOSED',
      );
      expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });

    it('rejects limit execute orders as unsupported', async () => {
      const buy = createService();
      buy.prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          orderType: OrderType.limit,
          limitPrice: new Prisma.Decimal('99.00000000'),
        }),
      );
      mockExecutionPrice(buy.prisma, '100.00000000');

      await expectErrorCode(
        buy.service.executeOrder('user-1', 'order-execute-1'),
        'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
      );

      const sell = createService();
      sell.prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          side: OrderSide.sell,
          orderType: OrderType.limit,
          limitPrice: new Prisma.Decimal('101.00000000'),
        }),
      );
      mockExecutionPrice(sell.prisma, '100.00000000');

      await expectErrorCode(
        sell.service.executeOrder('user-1', 'order-execute-1'),
        'LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED',
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
          isActive: true,
          name: 'Apple Inc.',
          market: 'NASDAQ',
          assetType: AssetType.us_stock,
          currencyCode: CurrencyCode.USD,
        },
      });
      const unavailable = createService();
      unavailable.prisma.order.findFirst.mockResolvedValue(usdOrder);
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
      stale.prisma.order.findFirst.mockResolvedValue(usdOrder);
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
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
      mockExecutionPrice(prisma);
      prisma.cashWallet.findUnique
        .mockResolvedValueOnce({
          walletScope: 'securities' as const,
          id: 'wallet-1',
          tradingAccountId: 'trading-account-1',
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('1000.00000000'),
          reservedAmount: new Prisma.Decimal('0.00000000'),
        })
        .mockResolvedValueOnce({
          walletScope: 'securities' as const,
          id: 'wallet-1',
          tradingAccountId: 'trading-account-1',
          currencyCode: CurrencyCode.KRW,
          balanceAmount: new Prisma.Decimal('199.00000000'),
          reservedAmount: new Prisma.Decimal('0.00000000'),
        });
      prisma.$executeRaw.mockResolvedValueOnce(0);

      await expectErrorCode(
        service.executeOrder('user-1', 'order-execute-1'),
        'INSUFFICIENT_BALANCE',
      );
      expect(prisma.position.create).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('rejects sell when position is missing or quantity is insufficient', async () => {
      const missing = createService();
      missing.prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({ side: OrderSide.sell }),
      );
      mockExecutionPrice(missing.prisma);
      missing.prisma.position.findUnique.mockResolvedValueOnce(null);

      await expectErrorCode(
        missing.service.executeOrder('user-1', 'order-execute-1'),
        'INSUFFICIENT_QUANTITY',
      );

      const insufficient = createService();
      insufficient.prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({ side: OrderSide.sell }),
      );
      mockExecutionPrice(insufficient.prisma);
      insufficient.prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
        quantity: new Prisma.Decimal('1.00000000'),
        averageCost: new Prisma.Decimal('80.00000000'),
        currencyCode: CurrencyCode.KRW,
      });
      insufficient.prisma.position.updateMany.mockResolvedValueOnce({
        count: 0,
      });
      insufficient.prisma.position.findUnique.mockResolvedValueOnce({
        tradingAccountId: 'trading-account-1',
        assetId: 'asset-1',
        currencyCode: CurrencyCode.KRW,
        quantity: new Prisma.Decimal('1.00000000'),
        reservedQuantity: new Prisma.Decimal(0),
      });

      await expectErrorCode(
        insufficient.service.executeOrder('user-1', 'order-execute-1'),
        'INSUFFICIENT_QUANTITY',
      );
      expect(missing.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(insufficient.prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    });

    it('uses actual post-update wallet balance for walletTransaction balanceAfter', async () => {
      const { prisma, service } = createService();
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
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
      prisma.order.findFirst.mockResolvedValue(orderExecutionRecord());
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
      prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({
          side: OrderSide.sell,
        }),
      );
      mockExecutionPrice(prisma);
      prisma.position.findUnique.mockResolvedValueOnce({
        id: 'position-1',
        tradingAccountId: 'trading-account-1',
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

  describe('financial guard admin diagnostics', () => {
    beforeEach(() => jest.useFakeTimers().setSystemTime(executedAt));
    afterEach(() => jest.useRealTimers());
    const wallet = (overrides: Record<string, unknown> = {}) => ({
      walletScope: 'securities' as const,
      id: 'wallet-1',
      tradingAccountId: 'trading-account-1',
      currencyCode: CurrencyCode.KRW,
      balanceAmount: new Prisma.Decimal('1000'),
      reservedAmount: new Prisma.Decimal(0),
      ...overrides,
    });
    const position = (overrides: Record<string, unknown> = {}) => ({
      id: 'position-1',
      tradingAccountId: 'trading-account-1',
      assetId: 'asset-1',
      currencyCode: CurrencyCode.KRW,
      quantity: new Prisma.Decimal('10'),
      reservedQuantity: new Prisma.Decimal(0),
      averageCost: new Prisma.Decimal('80'),
      ...overrides,
    });
    const setup = (side = OrderSide.buy) => {
      const fixture = createService();
      fixture.prisma.order.findFirst.mockResolvedValue(
        orderExecutionRecord({ side }),
      );
      mockExecutionPrice(fixture.prisma);
      return fixture;
    };
    it.each([
      ['missing', null, 'wallet_not_found', 'INSUFFICIENT_BALANCE', undefined],
      [
        'reserved cash shortage',
        wallet({ reservedAmount: new Prisma.Decimal('900') }),
        'insufficient_available',
        'INSUFFICIENT_BALANCE',
        true,
      ],
      [
        'total balance shortage',
        wallet({ balanceAmount: new Prisma.Decimal('100') }),
        'insufficient_available',
        'INSUFFICIENT_BALANCE',
        false,
      ],
      ['concurrency', wallet(), 'conflict', 'CONFLICT', true],
      [
        'null scope',
        wallet({ tradingAccountId: null }),
        'null_scope',
        'FINANCIAL_SCOPE_REPAIR_REQUIRED',
        undefined,
      ],
      [
        'foreign scope',
        wallet({ tradingAccountId: 'foreign-account' }),
        'account_scope_mismatch',
        'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
        undefined,
      ],
      [
        'currency',
        wallet({ currencyCode: CurrencyCode.USD }),
        'currency_mismatch',
        'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
        undefined,
      ],
    ])(
      'market BUY retains %s after one rejected debit',
      async (_label, row, reason, code, balanceSufficient) => {
        const { prisma, service } = setup();
        prisma.cashWallet.findUnique
          .mockResolvedValueOnce(wallet())
          .mockResolvedValueOnce(row);
        prisma.$executeRaw.mockResolvedValueOnce(0);
        const { error, diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(error.getResponse()).toMatchObject({ error: { code } });
        expect(diagnostic).toMatchObject({
          failureStage: 'wallet_debit',
          evidence: {
            financialGuard: { failureReason: reason, mutationAffected: 0 },
          },
        });
        if (balanceSufficient !== undefined)
          expect(diagnostic?.evidence?.financialGuard).toMatchObject({
            balanceSufficient,
          });
        expectSafeFinancialDiagnostic(diagnostic);
        expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(2);
        expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
        expect(prisma.position.create).not.toHaveBeenCalled();
        expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
        expect(prisma.order.updateMany).not.toHaveBeenCalled();
      },
    );
    it.each(['admin', 'user', 'operator'])(
      'exposes financial evidence only to admin (%s)',
      async (role) => {
        const { prisma, service } = setup();
        prisma.cashWallet.findUnique
          .mockResolvedValueOnce(wallet())
          .mockResolvedValueOnce(
            wallet({ reservedAmount: new Prisma.Decimal('900') }),
          );
        prisma.$executeRaw.mockResolvedValueOnce(0);
        const { diagnostic } = await captureFinancialFailure(
          () => service.executeOrder('user-1', 'order-execute-1'),
          role,
        );
        if (role === 'admin') expectSafeFinancialDiagnostic(diagnostic);
        else expect(diagnostic).toBeUndefined();
      },
    );
    it.each([
      ['missing', null, 'financialGuard', 'wallet_not_found'],
      [
        'null scope',
        wallet({ tradingAccountId: null }),
        'financialScope',
        'null_scope',
      ],
      [
        'foreign scope',
        wallet({ tradingAccountId: 'foreign-account' }),
        'financialScope',
        'account_scope_mismatch',
      ],
    ])(
      'market BUY identifies lookup %s without debit',
      async (_label, row, key, reason) => {
        const { prisma, service } = setup();
        prisma.cashWallet.findUnique.mockResolvedValueOnce(row);
        const { diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(diagnostic?.evidence?.[key]).toMatchObject({
          failureReason: reason,
        });
        expectSafeFinancialDiagnostic(diagnostic);
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
        expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(1);
      },
    );
    it.each([
      [
        'total shortage',
        position({ quantity: new Prisma.Decimal('1') }),
        'insufficient_quantity',
        'INSUFFICIENT_QUANTITY',
        false,
        false,
      ],
      [
        'reserved shortage',
        position({ reservedQuantity: new Prisma.Decimal('9') }),
        'insufficient_available_quantity',
        'CONFLICT',
        true,
        false,
      ],
      ['concurrency', position(), 'conflict', 'CONFLICT', true, true],
      [
        'missing',
        null,
        'position_not_found',
        'INSUFFICIENT_QUANTITY',
        undefined,
        undefined,
      ],
      [
        'foreign scope',
        position({ tradingAccountId: 'foreign-account' }),
        'account_scope_mismatch',
        'INSUFFICIENT_QUANTITY',
        undefined,
        undefined,
      ],
    ])(
      'market SELL identifies %s without changing its historical public code',
      async (_label, row, reason, code, total, available) => {
        const { prisma, service } = setup(OrderSide.sell);
        prisma.position.findUnique
          .mockResolvedValueOnce(position())
          .mockResolvedValueOnce(row);
        prisma.position.updateMany.mockResolvedValueOnce({ count: 0 });
        const { error, diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(error.getResponse()).toMatchObject({ error: { code } });
        expect(diagnostic).toMatchObject({
          failureStage: 'position_decrement',
          evidence: {
            financialGuard: { failureReason: reason, mutationAffected: 0 },
          },
        });
        if (total !== undefined)
          expect(diagnostic?.evidence?.financialGuard).toMatchObject({
            totalQuantitySufficient: total,
            availableQuantitySufficient: available,
          });
        expectSafeFinancialDiagnostic(diagnostic);
        expect(prisma.position.findUnique).toHaveBeenCalledTimes(2);
        expect(prisma.position.findUnique).toHaveBeenLastCalledWith(
          expect.objectContaining({ where: { id: 'position-1' } }),
        );
        expect(prisma.position.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
        expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      },
    );
    it.each([
      ['missing', null, 'position_not_found', 'INSUFFICIENT_QUANTITY'],
      [
        'scope',
        position({ tradingAccountId: 'foreign-account' }),
        'account_scope_mismatch',
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
      ],
      [
        'currency',
        position({ currencyCode: CurrencyCode.USD }),
        'currency_mismatch',
        'ORDER_EXECUTION_TRANSACTION_FAILED',
      ],
    ])(
      'market SELL identifies initial %s without mutation',
      async (_label, row, reason, code) => {
        const { prisma, service } = setup(OrderSide.sell);
        prisma.position.findUnique.mockResolvedValueOnce(row);
        const { error, diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(error.getResponse()).toMatchObject({ error: { code } });
        expect([
          diagnostic?.evidence?.financialGuard,
          diagnostic?.evidence?.financialScope,
        ]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ failureReason: reason }),
          ]),
        );
        expect(prisma.position.updateMany).not.toHaveBeenCalled();
        expectSafeFinancialDiagnostic(diagnostic);
      },
    );
    it.each([
      ['missing', null, 'wallet_not_found', 'INSUFFICIENT_BALANCE'],
      ['concurrency', wallet(), 'conflict', 'CONFLICT'],
    ])(
      'market SELL credit identifies %s',
      async (_label, row, reason, code) => {
        const { prisma, service } = setup(OrderSide.sell);
        prisma.position.findUnique.mockResolvedValueOnce(position());
        prisma.position.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.cashWallet.findUnique
          .mockResolvedValueOnce(wallet())
          .mockResolvedValueOnce(row);
        prisma.cashWallet.updateMany.mockResolvedValueOnce({ count: 0 });
        const { error, diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(error.getResponse()).toMatchObject({ error: { code } });
        expect(diagnostic).toMatchObject({
          failureStage: 'wallet_credit',
          evidence: { financialGuard: { failureReason: reason } },
        });
        expect(prisma.cashWallet.updateMany).toHaveBeenCalledTimes(1);
        expect(prisma.position.findUnique).toHaveBeenCalledTimes(1);
        expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
        expectSafeFinancialDiagnostic(diagnostic);
      },
    );

    it.each([
      ['status', { status: 'consumed' }, 'QUOTE_NOT_ACTIVE', { active: false }],
      [
        'account',
        { tradingAccountId: 'foreign-account' },
        'QUOTE_MISMATCH',
        { scopeValid: false },
      ],
      [
        'currency',
        { currencyCode: CurrencyCode.USD },
        'QUOTE_MISMATCH',
        { currencyMatched: false },
      ],
      [
        'quantity',
        { quantity: new Prisma.Decimal('1') },
        'QUOTE_MISMATCH',
        { quantityMatched: false },
      ],
    ])(
      'preserves market quote %s predicate before financial writes',
      async (_label, overrides, code, predicates) => {
        const { prisma, service } = setup();
        const order = orderExecutionRecord();
        prisma.order.findFirst.mockResolvedValue({
          ...order,
          quote: { ...order.quote, ...overrides },
        });
        const { error, diagnostic } = await captureFinancialFailure(() =>
          service.executeOrder('user-1', 'order-execute-1'),
        );
        expect(error.getResponse()).toMatchObject({ error: { code } });
        expect(diagnostic).toMatchObject({
          failureStage: 'quote_validation',
          evidence: { quoteGuard: predicates },
        });
        expect(prisma.cashWallet.findUnique).not.toHaveBeenCalled();
        expect(prisma.position.findUnique).not.toHaveBeenCalled();
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
        expectSafeFinancialDiagnostic(diagnostic);
      },
    );
    it('distinguishes post-wallet read failure after an applied debit', async () => {
      const { prisma, service } = setup();
      mockExecutionWallet(prisma);
      prisma.cashWallet.findFirst.mockReset().mockResolvedValue(null);
      const { diagnostic } = await captureFinancialFailure(() =>
        service.executeOrder('user-1', 'order-execute-1'),
      );
      expect(diagnostic).toMatchObject({
        failureStage: 'wallet_post_read',
        evidence: {
          financialGuard: {
            failureReason: 'wallet_post_read_failed',
            scopeMatchedRead: false,
          },
        },
      });
      expect(prisma.cashWallet.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.position.create).not.toHaveBeenCalled();
    });
    it('identifies position create failure and keeps its structured public wrapper', async () => {
      const { prisma, service } = setup();
      mockExecutionWallet(prisma);
      prisma.position.findUnique.mockResolvedValue(null);
      prisma.position.create.mockRejectedValue(
        Object.assign(new Error('synthetic DB failure'), { code: 'P2002' }),
      );
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.executeOrder('user-1', 'order-execute-1'),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_EXECUTION_TRANSACTION_FAILED' },
      });
      expect(diagnostic?.failureStage).toBe('position_create');
      expect(diagnostic?.evidence?.safeCause).toMatchObject({
        category: 'db_unique_constraint',
        code: 'P2002',
      });
      expect(JSON.stringify(diagnostic)).not.toContain('synthetic DB failure');
      expectSafeFinancialDiagnostic(diagnostic);
      expect(prisma.position.create).toHaveBeenCalledTimes(1);
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    });
    it('identifies existing BUY position optimistic update rejection without a new read', async () => {
      const { prisma, service } = setup();
      mockExecutionWallet(prisma);
      prisma.position.findUnique.mockResolvedValue(position());
      prisma.position.updateMany.mockResolvedValue({ count: 0 });
      const { diagnostic } = await captureFinancialFailure(() =>
        service.executeOrder('user-1', 'order-execute-1'),
      );
      expect(diagnostic).toMatchObject({
        failureStage: 'position_update',
        evidence: {
          financialGuard: {
            failureReason: 'conflict',
            observation: 'optimistic_guard_rejection',
          },
        },
      });
      expect(prisma.position.findUnique).toHaveBeenCalledTimes(1);
      expectSafeFinancialDiagnostic(diagnostic);
    });
    it('identifies order finalization rejection after financial writes', async () => {
      const { prisma, service } = setup();
      mockExecutionWallet(prisma);
      prisma.position.findUnique.mockResolvedValue(null);
      prisma.position.create.mockResolvedValue({ id: 'position-1' });
      prisma.walletTransaction.create.mockResolvedValue({ id: 'ledger-1' });
      prisma.order.updateMany.mockResolvedValue({ count: 0 });
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.executeOrder('user-1', 'order-execute-1'),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_EXECUTION_CONFLICT' },
      });
      expect(diagnostic).toMatchObject({
        failureStage: 'order_finalization',
        evidence: {
          financialGuard: {
            failureReason: 'order_finalization_guard_rejected',
            mutationAffected: 0,
          },
        },
      });
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
      expectSafeFinancialDiagnostic(diagnostic);
    });
  });

  describe('source selection admin diagnostics', () => {
    function capture(
      action: () => Promise<unknown>,
      role: string | null = 'admin',
      requestPath = '/api/v1/orders/quote',
    ) {
      let pending!: Promise<{
        error: HttpException;
        diagnostic: ReturnType<typeof buildAdminDiagnostic>;
      }>;
      adminDiagnosticRequestMiddleware(
        {
          method: 'POST',
          originalUrl: requestPath,
          headers: {},
          user: role ? { userId: 'user-1', role } : undefined,
        } as never,
        { setHeader: jest.fn() } as never,
        () => {
          pending = action().then(
            () => {
              throw new Error('Expected selection failure');
            },
            (error: HttpException) => ({
              error,
              diagnostic: buildAdminDiagnostic(
                error,
                (error.getResponse() as { error: { code: string } }).error.code,
                error.getStatus(),
              ),
            }),
          );
        },
      );
      return pending;
    }
    it('preserves the 68-second failure matrix and safe refresh outcome after all providers fail', async () => {
      const { prisma, service, primary, secondary } = createService(true);
      const now = new Date();
      const old = providerFxSnapshot({
        id: 'old',
        rate: '1379.12345678',
        sourceName: 'korea_exim_exchange_rate',
        effectiveAt: new Date(now.getTime() - 68000),
        capturedAt: new Date(now.getTime() - 68000),
      });
      prisma.fxRateSnapshot.findMany.mockImplementation(
        ({ where }: { where: { sourceName: unknown } }) =>
          Promise.resolve(
            where.sourceName === 'exchange_rate_api' ? [] : [old],
          ),
      );
      primary.ensureFreshUsdKrwSnapshot.mockRejectedValue(
        new ProviderHttpError(
          'korea_exim_exchange_rate',
          'PROVIDER_TIMEOUT',
          'raw-secret-error',
        ),
      );
      secondary.ingestUsdKrw.mockResolvedValue({ success: false });
      const { error, diagnostic } = await capture(
        async () => {
          await service['prepareOrderExecutionFx']();
          return service['findFreshProviderUsdKrwSnapshotForOrderExecution'](
            prisma as never,
            buildOrderQuoteRecord() as never,
            now,
          );
        },
        'admin',
        '/api/v1/orders',
      );
      expect(getErrorCode(error)).toBe('PROVIDER_RATE_STALE');
      expect(diagnostic).toMatchObject({
        operation: 'ORDER_CREATE',
        failureStage: 'execution_rate_selection',
        evidence: {
          workflow: 'orders_execute',
          freshnessThresholdSeconds: 60,
          freshnessBasis: 'capturedAt',
          preflightRefresh: {
            attempted: true,
            result: 'unavailable',
            source: null,
          },
          transactionDbRevalidation: true,
          providerCandidates: [
            { ageSeconds: 68, reason: 'captured_at_stale' },
            { candidateFound: false },
          ],
          manualFallback: {
            lookupPerformed: false,
            result: 'not_allowed',
            reason: 'provider_only_workflow',
          },
          finalSelectionResult: 'NO_ELIGIBLE_SNAPSHOT',
        },
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/1379|raw-secret-error/);
    });

    it('rejects evidence that expires after successful preflight at the final execution clock', async () => {
      const { prisma, service, primary } = createService(true);
      const now = new Date();
      const row = providerFxSnapshot({
        id: 'fresh',
        rate: '1400',
        sourceName: 'korea_exim_exchange_rate',
        effectiveAt: now,
        capturedAt: now,
      });
      prisma.fxRateSnapshot.findMany.mockImplementation(
        ({ where }: { where: { sourceName: unknown } }) =>
          Promise.resolve(
            where.sourceName === 'exchange_rate_api' ? [] : [row],
          ),
      );
      await service['prepareOrderExecutionFx']();
      await expect(
        service['findFreshProviderUsdKrwSnapshotForOrderExecution'](
          prisma as never,
          buildOrderQuoteRecord() as never,
          new Date(now.getTime() + 61000),
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'PROVIDER_RATE_STALE' } },
      });
      expect(primary.ensureFreshUsdKrwSnapshot).not.toHaveBeenCalled();
    });

    it.each(['admin', 'user', 'operator', undefined])(
      'preserves quote source rejection only for %s',
      async (role) => {
        const { prisma, service } = createService();
        mockActiveSeason(prisma);
        mockJoined(prisma);
        mockAsset(prisma, CurrencyCode.USD);
        mockAssetPrice(prisma);
        const row = providerFxSnapshot({
          id: 'exim-stale',
          rate: '1379.12345678',
          sourceName: 'korea_exim_exchange_rate',
          effectiveAt: new Date(Date.now() - 1842000),
          capturedAt: new Date(Date.now() - 1842000),
        });
        prisma.fxRateSnapshot.findMany.mockImplementation(async ({ where }) =>
          typeof where.sourceName === 'string' ? [] : [row],
        );
        prisma.fxRateSnapshot.findFirst.mockResolvedValue(null);
        const { error, diagnostic } = await capture(
          () =>
            service.quoteOrder('user-1', {
              assetId: 'asset-1',
              side: 'buy',
              orderType: 'market',
              quantity: '2',
            }),
          role ?? null,
        );
        expect(error.getResponse()).toMatchObject({
          success: false,
          error: {
            code: 'FX_RATE_UNAVAILABLE',
            message: 'FX rate is unavailable.',
          },
        });
        expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(2); // unchanged bounded source supplement
        expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledTimes(1);
        expect(prisma.quote.create).not.toHaveBeenCalled();
        if (role === 'admin')
          expect(diagnostic).toMatchObject({
            failureStage: 'fx_rate_selection',
            evidence: {
              workflow: 'orders_quote',
              freshnessThresholdSeconds: 300,
              providerCandidates: [
                {
                  snapshotId: 'exim-stale',
                  ageSeconds: 1842,
                  reason: 'captured_at_stale',
                },
                { candidateFound: false },
              ],
              manualFallback: {
                lookupPerformed: true,
                eligibleQueryCandidateFound: false,
              },
            },
          });
        else expect(diagnostic).toBeUndefined();
        expect(JSON.stringify(diagnostic) ?? '').not.toContain('1379.12345678');
      },
    );
    it('distinguishes stale manual fallback and does not diagnose successful lower-priority or manual selection', async () => {
      const { prisma, service } = createService();
      prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
      prisma.fxRateSnapshot.findFirst.mockResolvedValue({
        id: 'manual-old',
        sourceName: 'manual',
        rate: new Prisma.Decimal('1379.12345678'),
        effectiveAt: new Date(Date.now() - 61000),
        capturedAt: new Date(),
      });
      const { error, diagnostic } = await capture(() =>
        service['findFreshUsdKrwSnapshot'](new Date(), 'orders_quote'),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'FX_RATE_STALE' },
      });
      expect(diagnostic).toMatchObject({
        evidence: {
          manualFallback: {
            snapshotId: 'manual-old',
            reason: 'effective_at_stale',
            ageSeconds: 61,
            freshnessThresholdSeconds: 60,
          },
        },
      });
      const old = providerFxSnapshot({
        id: 'exim-old',
        rate: '1379',
        sourceName: 'korea_exim_exchange_rate',
        effectiveAt: new Date(Date.now() - 301000),
        capturedAt: new Date(Date.now() - 301000),
      });
      const fresh = providerFxSnapshot({
        id: 'exchange-fresh',
        rate: '1380',
        sourceName: 'exchange_rate_api',
        effectiveAt: new Date(),
        capturedAt: new Date(),
      });
      prisma.fxRateSnapshot.findMany.mockResolvedValue([old, fresh]);
      prisma.fxRateSnapshot.findFirst.mockClear();
      await expect(
        service['findFreshUsdKrwSnapshot'](new Date(), 'orders_quote'),
      ).resolves.toMatchObject({ id: 'exchange-fresh' });
      expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
      prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
      prisma.fxRateSnapshot.findFirst.mockResolvedValue({
        ...fresh,
        id: 'manual-fresh',
        sourceType: 'admin_manual',
      });
      await expect(
        service['findFreshUsdKrwSnapshot'](new Date(), 'orders_quote'),
      ).resolves.toMatchObject({ id: 'manual-fresh' });
    });
    it('preserves execute provider-only failure and its actual threshold without fallback reads', async () => {
      const { prisma, service } = createService();
      prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
      const { diagnostic } = await capture(() =>
        service['findFreshProviderUsdKrwSnapshotForOrderExecution'](
          prisma as never,
          { id: 'quote-1' } as never,
          new Date(),
        ),
      );
      expect(diagnostic).toMatchObject({
        failureStage: 'execution_rate_selection',
        evidence: {
          workflow: 'orders_execute',
          freshnessThresholdSeconds: 60,
          manualFallback: { lookupPerformed: false, result: 'not_allowed' },
        },
      });
      expect(prisma.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
    });
  });
});
