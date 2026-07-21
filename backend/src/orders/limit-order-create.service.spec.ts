jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
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
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
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
  AssetType,
  CurrencyCode,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { computeOrderQuoteRequestHash } from '../providers/durable-quote.policy';
import {
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { OrderReservationService } from './order-reservation.service';
import { OrdersService } from './orders.service';

describe('limit buy quote/create (phase 1: reservation only)', () => {
  // 2026-05-07 is a regular Thursday: KRX session 00:00-06:30Z (09:00-15:30
  // KST). krxOpenAt is in-session; krxClosedAt is after the close.
  const krxOpenAt = new Date('2026-05-07T00:30:00.000Z');
  const krxClosedAt = new Date('2026-05-07T08:00:00.000Z');
  const startAt = new Date('2026-05-01T00:00:00.000Z');
  const endAt = new Date('2026-05-31T00:00:00.000Z');

  const activeSeason = {
    id: 'season-1',
    name: 'Season 1',
    status: SeasonStatus.active,
    startAt,
    endAt,
    tradeFeeRate: new Prisma.Decimal('0.001000'),
  };

  const participant = {
    id: 'sp-1',
    participantStatus: ParticipantStatus.active,
    joinedAt: startAt,
  };

  const krxAsset = {
    id: 'asset-1',
    symbol: '005930',
    name: 'Samsung',
    market: 'KRX',
    assetType: AssetType.domestic_stock,
    currencyCode: CurrencyCode.KRW,
    isActive: true,
  };

  const cryptoAsset = {
    id: 'asset-btc',
    symbol: 'BTCUSDT',
    name: 'Bitcoin',
    market: 'BINANCE',
    assetType: AssetType.crypto,
    currencyCode: CurrencyCode.USD,
    isActive: true,
  };

  const createPrisma = () => ({
    season: { findFirst: jest.fn() },
    seasonParticipant: { findUnique: jest.fn() },
    asset: { findUnique: jest.fn() },
    cashWallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    position: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
    },
    quote: {
      create: jest.fn().mockResolvedValue({ id: 'quote-limit-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    order: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    walletTransaction: { create: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([]),
  });

  const createService = () => {
    const prisma = createPrisma();
    prisma.$transaction.mockImplementation(async (callback: never) =>
      (callback as (tx: unknown) => Promise<unknown>)(prisma),
    );
    const reservation = new OrderReservationService();
    const service = new OrdersService(
      prisma as never,
      undefined,
      new LimitOrderCreateService(prisma as never, reservation),
      new LimitOrderCancelService(prisma as never, reservation),
    );
    return { prisma, service };
  };

  const mockQuoteContext = (
    prisma: ReturnType<typeof createPrisma>,
    input: {
      asset?: typeof krxAsset | typeof cryptoAsset;
      balance?: string;
      reserved?: string;
      positionQuantity?: string | null;
    } = {},
  ) => {
    prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
    prisma.asset.findUnique.mockResolvedValueOnce(input.asset ?? krxAsset);
    prisma.cashWallet.findUnique.mockResolvedValueOnce({
      balanceAmount: new Prisma.Decimal(input.balance ?? '1000000.00000000'),
      reservedAmount: new Prisma.Decimal(input.reserved ?? '0'),
    });
    prisma.position.findUnique.mockResolvedValueOnce(
      input.positionQuantity
        ? { quantity: new Prisma.Decimal(input.positionQuantity) }
        : null,
    );
  };

  const limitQuoteBody = {
    assetId: 'asset-1',
    side: 'buy',
    orderType: 'limit',
    quantity: '3.000000',
    limitPrice: '50000.00000000',
    currencyCode: CurrencyCode.KRW,
  };

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    try {
      await promise;
      throw new Error('Expected promise to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getResponse()).toMatchObject({
        success: false,
        error: { code },
      });
    }
  };

  const originalFlag = process.env.LIMIT_ORDER_ENABLED;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(krxOpenAt);
    process.env.LIMIT_ORDER_ENABLED = 'true';
  });

  afterEach(() => {
    jest.useRealTimers();
    resetMarketSessionOverrideStoreForTest();
    if (originalFlag === undefined) delete process.env.LIMIT_ORDER_ENABLED;
    else process.env.LIMIT_ORDER_ENABLED = originalFlag;
  });

  describe('quote', () => {
    it('quotes a KRX limit buy from limitPrice only and never mutates the wallet', async () => {
      const { prisma, service } = createService();
      mockQuoteContext(prisma, { reserved: '100000.00000000' });

      const response = await service.quoteOrder('user-1', limitQuoteBody);

      expect(response.data).toMatchObject({
        orderType: OrderType.limit,
        price: '50000.00000000',
        limitPrice: '50000.00000000',
        quantity: '3.000000',
        grossAmount: '150000.00000000',
        feeRate: '0.001000',
        feeAmount: '150.00000000',
        netAmount: '150150.00000000',
        reservedAmount: '150150.00000000',
        walletBalanceBefore: '1000000.00000000',
        walletReservedBefore: '100000.00000000',
        walletAvailableBefore: '900000.00000000',
        estimatedReservedAfter: '250150.00000000',
        estimatedAvailableAfter: '749850.00000000',
        assetPriceSnapshotId: null,
        assetPriceSource: null,
        quoteId: 'quote-limit-1',
      });
      // quotedPrice === limitPrice; no provider price is ever consulted.
      expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
      // Quote step never mutates the wallet.
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      // Durable quote stores the limit shape and the limit-aware hash.
      expect(prisma.quote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderType: OrderType.limit,
            limitPrice: '50000.00000000',
            quotedPrice: '50000.00000000',
            assetPriceSnapshotId: null,
            requestHash: computeOrderQuoteRequestHash({
              userId: 'user-1',
              seasonParticipantId: 'sp-1',
              assetId: 'asset-1',
              side: 'buy',
              orderType: 'limit',
              quantity: '3.000000',
              limitPrice: '50000.00000000',
              currencyCode: 'KRW',
            }),
          }) as never,
        }),
      );
    });

    it('includes orderType and limitPrice in the request hash (differs from market)', () => {
      const base = {
        userId: 'user-1',
        seasonParticipantId: 'sp-1',
        assetId: 'asset-1',
        side: 'buy',
        quantity: '3.000000',
        currencyCode: 'KRW',
      } as const;
      const marketHash = computeOrderQuoteRequestHash({
        ...base,
        orderType: 'market',
        limitPrice: null,
      });
      const limitHash = computeOrderQuoteRequestHash({
        ...base,
        orderType: 'limit',
        limitPrice: '50000.00000000',
      });
      const otherLimitHash = computeOrderQuoteRequestHash({
        ...base,
        orderType: 'limit',
        limitPrice: '50001.00000000',
      });
      expect(limitHash).not.toBe(marketHash);
      expect(limitHash).not.toBe(otherLimitHash);
    });

    it.each([
      [{ side: 'sell' }, 'LIMIT_BUY_ONLY'],
      [{ limitPrice: undefined }, 'INVALID_LIMIT_PRICE'],
      [{ limitPrice: '0' }, 'INVALID_LIMIT_PRICE'],
      [{ limitPrice: '-1' }, 'INVALID_LIMIT_PRICE'],
      [{ limitPrice: 'abc' }, 'INVALID_LIMIT_PRICE'],
      [{ limitPrice: '1.000000001' }, 'INVALID_LIMIT_PRICE'],
      [{ limitPrice: '10000000000000000.00000000' }, 'INVALID_LIMIT_PRICE'],
      [{ quantity: '0' }, 'INVALID_QUANTITY'],
      [{ orderType: 'market' }, 'ORDER_TYPE_NOT_SUPPORTED'],
    ])('rejects %j with %s before touching the DB', async (patch, code) => {
      const { prisma, service } = createService();
      await expectErrorCode(
        service.quoteOrder('user-1', { ...limitQuoteBody, ...patch }),
        code,
      );
      expect(prisma.quote.create).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects read-only when available balance cannot cover the reservation', async () => {
      const { prisma, service } = createService();
      // balance 200000, reserved 100000 -> available 100000 < 150150.
      mockQuoteContext(prisma, {
        balance: '200000.00000000',
        reserved: '100000.00000000',
      });

      await expectErrorCode(
        service.quoteOrder('user-1', limitQuoteBody),
        'INSUFFICIENT_AVAILABLE_BALANCE',
      );
      expect(prisma.quote.create).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
    });

    it('rejects stock limit quotes while the market is closed', async () => {
      jest.setSystemTime(krxClosedAt);
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset);

      await expectErrorCode(
        service.quoteOrder('user-1', limitQuoteBody),
        'MARKET_CLOSED',
      );
      expect(prisma.quote.create).not.toHaveBeenCalled();
    });

    it('fails closed with MARKET_CALENDAR_UNAVAILABLE when the calendar cannot decide', async () => {
      markMarketSessionOverrideStoreRequired();
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset);

      await expectErrorCode(
        service.quoteOrder('user-1', limitQuoteBody),
        'MARKET_CALENDAR_UNAVAILABLE',
      );
      expect(prisma.quote.create).not.toHaveBeenCalled();
    });

    it('allows crypto limit buys 24h (outside stock sessions)', async () => {
      jest.setSystemTime(krxClosedAt);
      const { prisma, service } = createService();
      mockQuoteContext(prisma, { asset: cryptoAsset });
      prisma.fxRateSnapshot.findFirst.mockResolvedValueOnce({
        id: 'fx-1',
        rate: new Prisma.Decimal('1400.00000000'),
        sourceName: 'manual-fx',
        effectiveAt: new Date(Date.now() - 1_000),
        capturedAt: new Date(Date.now() - 1_000),
      });

      const response = await service.quoteOrder('user-1', {
        ...limitQuoteBody,
        assetId: 'asset-btc',
        limitPrice: '100.00000000',
        quantity: '1.000000',
        currencyCode: CurrencyCode.USD,
      });

      expect(response.data).toMatchObject({
        orderType: OrderType.limit,
        reservedAmount: '100.10000000',
        krwNetAmount: '140140.00000000',
      });
    });

    it('rejects limit quotes with LIMIT_ORDER_DISABLED when the flag is off', async () => {
      process.env.LIMIT_ORDER_ENABLED = 'false';
      const { prisma, service } = createService();

      await expectErrorCode(
        service.quoteOrder('user-1', limitQuoteBody),
        'LIMIT_ORDER_DISABLED',
      );
      expect(prisma.season.findFirst).not.toHaveBeenCalled();
      expect(prisma.quote.create).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const activeQuoteRecord = (
      overrides: Partial<Record<string, unknown>> = {},
    ) => ({
      id: 'quote-limit-1',
      seasonParticipantId: 'sp-1',
      status: 'active',
      assetId: 'asset-1',
      side: 'buy',
      orderType: OrderType.limit,
      quantity: new Prisma.Decimal('3.000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      currencyCode: CurrencyCode.KRW,
      quotedPrice: new Prisma.Decimal('50000.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
      expiresAt: new Date(Date.now() + 15_000),
      requestHash: computeOrderQuoteRequestHash({
        userId: 'user-1',
        seasonParticipantId: 'sp-1',
        assetId: 'asset-1',
        side: 'buy',
        orderType: 'limit',
        quantity: '3.000000',
        limitPrice: '50000.00000000',
        currencyCode: 'KRW',
      }),
      asset: { ...krxAsset, priceCurrency: null, settlementCurrency: null },
      ...overrides,
    });

    const createdOrderRecord = () => ({
      id: 'order-limit-1',
      quoteId: 'quote-limit-1',
      side: 'buy',
      orderType: OrderType.limit,
      status: OrderStatus.submitted,
      quantity: new Prisma.Decimal('3.000000'),
      limitPrice: new Prisma.Decimal('50000.00000000'),
      executedPrice: null,
      currencyCode: CurrencyCode.KRW,
      grossAmount: new Prisma.Decimal('150000.00000000'),
      feeAmount: new Prisma.Decimal('150.00000000'),
      netAmount: new Prisma.Decimal('150150.00000000'),
      assetPriceSnapshotId: null,
      fxRateSnapshotId: null,
      reservedAmount: new Prisma.Decimal('150150.00000000'),
      reservationReleasedAt: null,
      cancelReason: null,
      submittedAt: krxOpenAt,
      executedAt: null,
      canceledAt: null,
      rejectedAt: null,
      rejectReason: null,
      createdAt: krxOpenAt,
      updatedAt: krxOpenAt,
      asset: {
        id: 'asset-1',
        symbol: '005930',
        name: 'Samsung',
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
      },
    });

    const limitCreateBody = {
      assetId: 'asset-1',
      side: 'buy',
      orderType: 'limit',
      quantity: '3.000000',
      limitPrice: '50000.00000000',
      quoteId: 'quote-limit-1',
      idempotencyKey: 'limit-create-1',
    };

    const mockCreateContext = (prisma: ReturnType<typeof createPrisma>) => {
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null); // idempotency read
      prisma.quote.findFirst.mockResolvedValueOnce(activeQuoteRecord());
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset); // tradable check
      prisma.cashWallet.findUnique.mockResolvedValueOnce({ id: 'wallet-1' });
      prisma.$executeRaw.mockResolvedValueOnce(1); // reservation applied
      prisma.order.create.mockResolvedValueOnce({ id: 'order-limit-1' });
      prisma.order.findUnique.mockResolvedValueOnce(createdOrderRecord());
      prisma.order.update.mockResolvedValueOnce({ id: 'order-limit-1' });
    };

    it('creates a SUBMITTED order with an atomic reservation in one transaction', async () => {
      const { prisma, service } = createService();
      mockCreateContext(prisma);

      const response = await service.createOrder('user-1', limitCreateBody);

      expect(response.data.order).toMatchObject({
        orderId: 'order-limit-1',
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        limitPrice: '50000.00000000',
        reservedAmount: '150150.00000000',
        reservationReleasedAt: null,
      });
      expect(response.data.execution).toMatchObject({
        state: 'submitted',
        reservedAmount: '150150.00000000',
        reservationFeeRate: '0.001000',
        duplicate: false,
      });

      // Atomic reservation through the raw guard (values:
      // [amount, walletId, participantId, currency, amount]).
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect((prisma.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
        '150150.00000000',
        'wallet-1',
        'sp-1',
        CurrencyCode.KRW,
        '150150.00000000',
      ]);

      // Order row stores the reservation bookkeeping.
      expect(prisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderType: OrderType.limit,
            status: OrderStatus.submitted,
            limitPrice: '50000.00000000',
            reservedAmount: '150150.00000000',
            reservationFeeRate: '0.001000',
            assetPriceSnapshotId: null,
            executedPrice: null,
          }) as never,
        }),
      );

      // Quote consumed inside the same transaction.
      expect(prisma.quote.updateMany).toHaveBeenCalledWith({
        where: { id: 'quote-limit-1', status: 'active' },
        data: expect.objectContaining({ status: 'consumed' }) as never,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // Phase 1 forbidden effects: no debit, no ledger, no position, no
      // provider price, no execution.
      expect(prisma.cashWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.position.create).not.toHaveBeenCalled();
      expect(prisma.position.update).not.toHaveBeenCalled();
      expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.assetPriceSnapshot.findMany).not.toHaveBeenCalled();
    });

    it('registers a MARKETABLE limit price as submitted too (no immediate execution)', async () => {
      const { prisma, service } = createService();
      // limitPrice far above any plausible market price — still submitted;
      // marketability is never even evaluated (no provider price read).
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null);
      prisma.quote.findFirst.mockResolvedValueOnce(
        activeQuoteRecord({
          limitPrice: new Prisma.Decimal('99999999.00000000'),
          quotedPrice: new Prisma.Decimal('99999999.00000000'),
          quantity: new Prisma.Decimal('1.000000'),
          requestHash: computeOrderQuoteRequestHash({
            userId: 'user-1',
            seasonParticipantId: 'sp-1',
            assetId: 'asset-1',
            side: 'buy',
            orderType: 'limit',
            quantity: '1.000000',
            limitPrice: '99999999.00000000',
            currencyCode: 'KRW',
          }),
        }),
      );
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset);
      prisma.cashWallet.findUnique.mockResolvedValueOnce({ id: 'wallet-1' });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.create.mockResolvedValueOnce({ id: 'order-limit-1' });
      prisma.order.findUnique.mockResolvedValueOnce(createdOrderRecord());
      prisma.order.update.mockResolvedValueOnce({ id: 'order-limit-1' });

      const response = await service.createOrder('user-1', {
        ...limitCreateBody,
        quantity: '1.000000',
        limitPrice: '99999999.00000000',
      });

      expect(response.data.execution.state).toBe('submitted');
      expect(prisma.assetPriceSnapshot.findFirst).not.toHaveBeenCalled();
      expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
      expect(prisma.position.create).not.toHaveBeenCalled();
    });

    it('rolls back the reservation when a later step in the transaction fails', async () => {
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null);
      prisma.quote.findFirst.mockResolvedValueOnce(activeQuoteRecord());
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset);
      prisma.cashWallet.findUnique.mockResolvedValueOnce({ id: 'wallet-1' });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.create.mockRejectedValueOnce(
        new Error('order insert failed'),
      );
      // The $transaction mock propagates the rejection: everything in the
      // callback (including the reservation UPDATE) rolls back atomically in
      // the real database; here we assert the error escapes the transaction.
      await expect(
        service.createOrder('user-1', limitCreateBody),
      ).rejects.toThrow('order insert failed');
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    });

    it('fails with INSUFFICIENT_AVAILABLE_BALANCE when the atomic guard reserves 0 rows', async () => {
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null);
      prisma.quote.findFirst.mockResolvedValueOnce(activeQuoteRecord());
      prisma.asset.findUnique.mockResolvedValueOnce(krxAsset);
      prisma.cashWallet.findUnique.mockResolvedValueOnce({ id: 'wallet-1' });
      prisma.$executeRaw.mockResolvedValueOnce(0);
      prisma.cashWallet.findFirst.mockResolvedValueOnce({
        balanceAmount: new Prisma.Decimal('100000.00000000'),
        reservedAmount: new Prisma.Decimal('0'),
      });

      await expectErrorCode(
        service.createOrder('user-1', limitCreateBody),
        'INSUFFICIENT_AVAILABLE_BALANCE',
      );
      expect(prisma.order.create).not.toHaveBeenCalled();
      expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    });

    it('replays the stored payload for the same idempotency key', async () => {
      const { prisma, service } = createService();
      const storedPayload = { success: true, data: { marker: 'stored' } };
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce({
        ...createdOrderRecord(),
        requestHash: expectedCreateHash(limitCreateBody),
        responsePayloadJson: storedPayload,
      });

      const response = await service.createOrder('user-1', limitCreateBody);

      expect(response).toBe(storedPayload);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['limitPrice', { limitPrice: '50001.00000000' }],
      ['quantity', { quantity: '4.000000' }],
      ['orderType', { orderType: 'market', limitPrice: undefined }],
      ['assetId', { assetId: 'asset-2' }],
    ])(
      'conflicts when the same idempotency key is reused with a different %s',
      async (_field, patch) => {
        const { prisma, service } = createService();
        prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
        prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
        prisma.order.findFirst.mockResolvedValueOnce({
          ...createdOrderRecord(),
          requestHash: expectedCreateHash(limitCreateBody),
          responsePayloadJson: { success: true, data: {} },
        });

        await expectErrorCode(
          service.createOrder('user-1', {
            ...limitCreateBody,
            ...patch,
          }),
          'ORDER_IDEMPOTENCY_CONFLICT',
        );
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
      },
    );

    it('blocks stock limit creates while the market is closed', async () => {
      jest.setSystemTime(krxClosedAt);
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null);
      prisma.quote.findFirst.mockResolvedValueOnce(activeQuoteRecord());

      await expectErrorCode(
        service.createOrder('user-1', limitCreateBody),
        'MARKET_CLOSED',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
    });

    it('fails closed on create when calendar coverage is unavailable', async () => {
      markMarketSessionOverrideStoreRequired();
      const { prisma, service } = createService();
      prisma.season.findFirst.mockResolvedValueOnce(activeSeason);
      prisma.seasonParticipant.findUnique.mockResolvedValueOnce(participant);
      prisma.order.findFirst.mockResolvedValueOnce(null);
      prisma.quote.findFirst.mockResolvedValueOnce(activeQuoteRecord());

      await expectErrorCode(
        service.createOrder('user-1', limitCreateBody),
        'MARKET_CALENDAR_UNAVAILABLE',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('rejects limit creates with LIMIT_ORDER_DISABLED when the flag is off', async () => {
      process.env.LIMIT_ORDER_ENABLED = '0';
      const { prisma, service } = createService();

      await expectErrorCode(
        service.createOrder('user-1', limitCreateBody),
        'LIMIT_ORDER_DISABLED',
      );
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    function expectedCreateHash(body: {
      quoteId: string;
      assetId: string;
      side: string;
      orderType: string;
      quantity: string;
      limitPrice?: string;
    }): string {
      const { createHash } =
        jest.requireActual<typeof import('node:crypto')>('node:crypto');
      return createHash('sha256')
        .update(
          JSON.stringify({
            apiVersion: 'order-create:v1',
            quoteId: body.quoteId,
            assetId: body.assetId,
            side: body.side,
            orderType: body.orderType,
            quantity: Number(body.quantity).toFixed(6),
            limitPrice: body.limitPrice
              ? Number(body.limitPrice).toFixed(8)
              : null,
            currencyCode: null,
          }),
          'utf8',
        )
        .digest('hex');
    }
  });
});
