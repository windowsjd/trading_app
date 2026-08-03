jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

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
    Prisma: { Decimal },
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
  OrderStatus,
  OrderType,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { LIMIT_ORDER_CANCEL_REASONS } from './limit-order-policy';
import { OrderReservationService } from './order-reservation.service';

describe('LimitOrderCancelService', () => {
  const submittedAt = new Date('2026-05-07T00:01:00.000Z');
  const canceledAt = new Date('2026-05-07T01:00:00.000Z');
  const timestamps = {
    createdAt: submittedAt,
    updatedAt: submittedAt,
  };

  const orderRecord = (overrides: Partial<Record<string, unknown>> = {}) => ({
    id: 'order-1',
    seasonParticipantId: 'sp-1',
    tradingAccountId: 'trading-account-1',
    seasonParticipant: { tradingAccountId: 'trading-account-1' },
    quoteId: 'quote-1',
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
    submittedAt,
    executedAt: null,
    canceledAt: null,
    rejectedAt: null,
    rejectReason: null,
    ...timestamps,
    asset: {
      id: 'asset-1',
      symbol: '005930',
      name: 'Samsung',
      market: 'KRX',
      currencyCode: CurrencyCode.KRW,
    },
    ...overrides,
  });

  const createPrisma = () => ({
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    cashWallet: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  });

  const createService = () => {
    const prisma = createPrisma();
    prisma.$transaction.mockImplementation(async (callback: never) =>
      (callback as (tx: unknown) => Promise<unknown>)(prisma),
    );
    const service = new LimitOrderCancelService(
      prisma as never,
      new OrderReservationService(),
    );
    return { prisma, service };
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

  describe('cancelOwnedLimitBuyOrder', () => {
    it('releases the reservation exactly once and flips the order to canceled', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderRecord())
        .mockResolvedValueOnce(
          orderRecord({
            status: OrderStatus.canceled,
            canceledAt,
            cancelReason: LIMIT_ORDER_CANCEL_REASONS.userCanceled,
            reservationReleasedAt: canceledAt,
          }),
        );
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(1); // release applied
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });

      const response = await service.cancelOwnedLimitBuyOrder({
        userId: 'user-1',
        orderId: 'order-1',
        canceledAt,
      });

      expect(response.data.order).toMatchObject({
        orderId: 'order-1',
        status: OrderStatus.canceled,
        cancelReason: 'user_canceled',
        canceledAt: canceledAt.toISOString(),
        reservationReleasedAt: canceledAt.toISOString(),
        reservedAmount: '150150.00000000',
      });
      expect(response.data.execution).toMatchObject({
        state: 'not_executed',
        reason: 'ORDER_CANCELED_BEFORE_EXECUTION',
        alreadyCanceled: false,
        reservedAmountReleased: '150150.00000000',
      });

      // Release goes through the guarded raw UPDATE exactly once
      // (values: [amount, walletId, participantId, tradingAccountId,
      // currency, amount]).
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect((prisma.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual([
        '150150.00000000',
        'wallet-1',
        'sp-1',
        'trading-account-1',
        CurrencyCode.KRW,
        '150150.00000000',
      ]);

      // The order leaves `submitted` with a guarded updateMany in the same
      // transaction; cancel bookkeeping is written together.
      expect(prisma.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', status: OrderStatus.submitted },
        data: {
          status: OrderStatus.canceled,
          canceledAt,
          cancelReason: 'user_canceled',
          reservationReleasedAt: canceledAt,
        },
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: canceling an already-canceled order never releases twice', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({
          status: OrderStatus.canceled,
          canceledAt,
          cancelReason: 'user_canceled',
          reservationReleasedAt: canceledAt,
        }),
      );

      const response = await service.cancelOwnedLimitBuyOrder({
        userId: 'user-1',
        orderId: 'order-1',
        canceledAt: new Date('2026-05-07T02:00:00.000Z'),
      });

      expect(response.data.execution).toMatchObject({
        alreadyCanceled: true,
        reservedAmountReleased: null,
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('simulates two concurrent cancels: the loser sees canceled and releases nothing', async () => {
      // With FOR UPDATE the second cancel blocks until the first commits and
      // then reads status=canceled. Model exactly that interleaving.
      const { prisma, service } = createService();
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'order-1' }])
        .mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderRecord())
        .mockResolvedValueOnce(
          orderRecord({
            status: OrderStatus.canceled,
            canceledAt,
            cancelReason: 'user_canceled',
            reservationReleasedAt: canceledAt,
          }),
        )
        .mockResolvedValueOnce(
          orderRecord({
            status: OrderStatus.canceled,
            canceledAt,
            cancelReason: 'user_canceled',
            reservationReleasedAt: canceledAt,
          }),
        );
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });

      const first = await service.cancelOwnedLimitBuyOrder({
        userId: 'user-1',
        orderId: 'order-1',
        canceledAt,
      });
      const second = await service.cancelOwnedLimitBuyOrder({
        userId: 'user-1',
        orderId: 'order-1',
        canceledAt: new Date('2026-05-07T01:00:01.000Z'),
      });

      expect(first.data.execution.alreadyCanceled).toBe(false);
      expect(second.data.execution.alreadyCanceled).toBe(true);
      // Exactly ONE release across both cancels.
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.order.updateMany).toHaveBeenCalledTimes(1);
    });

    it('returns ORDER_NOT_FOUND for unowned or missing orders (lock row empty)', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-x',
          canceledAt,
        }),
        'ORDER_NOT_FOUND',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('keeps ORDER_CANCEL_NOT_SUPPORTED (410) for market orders', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ orderType: OrderType.market, limitPrice: null }),
      );

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'ORDER_CANCEL_NOT_SUPPORTED',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it.each([OrderStatus.executed, OrderStatus.rejected])(
      'rejects %s orders with ORDER_NOT_CANCELABLE',
      async (status) => {
        const { prisma, service } = createService();
        prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
        prisma.order.findUnique.mockResolvedValueOnce(orderRecord({ status }));

        await expectErrorCode(
          service.cancelOwnedLimitBuyOrder({
            userId: 'user-1',
            orderId: 'order-1',
            canceledAt,
          }),
          'ORDER_NOT_CANCELABLE',
        );
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
      },
    );

    it('reports ORDER_RESERVATION_INCONSISTENT when the wallet cannot cover the release', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(orderRecord());
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(0); // guard failed

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'ORDER_RESERVATION_INCONSISTENT',
      );
      // The order is NOT flipped when the release fails: the transaction
      // rejects, so order and wallet roll back together.
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    });

    it('reports ORDER_RESERVATION_INCONSISTENT when a submitted limit order has no reservation', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ reservedAmount: null }),
      );

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'ORDER_RESERVATION_INCONSISTENT',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('reports ORDER_CANCEL_CONFLICT when the guarded status flip loses a race', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(orderRecord());
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'ORDER_CANCEL_CONFLICT',
      );
    });

    it('works while LIMIT_ORDER_ENABLED is off (cancel is never feature-gated)', async () => {
      const original = process.env.LIMIT_ORDER_ENABLED;
      process.env.LIMIT_ORDER_ENABLED = 'false';
      try {
        const { prisma, service } = createService();
        prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
        prisma.order.findUnique
          .mockResolvedValueOnce(orderRecord())
          .mockResolvedValueOnce(
            orderRecord({
              status: OrderStatus.canceled,
              canceledAt,
              cancelReason: 'user_canceled',
              reservationReleasedAt: canceledAt,
            }),
          );
        prisma.cashWallet.findUnique.mockResolvedValueOnce({
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
        });
        prisma.$executeRaw.mockResolvedValueOnce(1);
        prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });

        const response = await service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        });
        expect(response.data.order.status).toBe(OrderStatus.canceled);
      } finally {
        if (original === undefined) delete process.env.LIMIT_ORDER_ENABLED;
        else process.env.LIMIT_ORDER_ENABLED = original;
      }
    });
  });

  describe('participant exclusion cleanup', () => {
    it('cancels every submitted limit buy of the participant inside the given transaction', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'order-1' },
        { id: 'order-2' },
      ]);
      prisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
          seasonParticipant: { tradingAccountId: 'trading-account-1' },
          currencyCode: CurrencyCode.KRW,
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          side: 'buy',
          reservedAmount: new Prisma.Decimal('100.00000000'),
        })
        .mockResolvedValueOnce({
          id: 'order-2',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
          seasonParticipant: { tradingAccountId: 'trading-account-1' },
          currencyCode: CurrencyCode.USD,
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          side: 'buy',
          reservedAmount: new Prisma.Decimal('50.00000000'),
        });
      prisma.cashWallet.findUnique
        .mockResolvedValueOnce({
          id: 'wallet-krw',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
        })
        .mockResolvedValueOnce({
          id: 'wallet-usd',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
        });
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const result =
        await service.cancelOpenLimitBuysForParticipantInTransaction(
          prisma as never,
          {
            seasonParticipantId: 'sp-1',
            reason: LIMIT_ORDER_CANCEL_REASONS.participantExcluded,
            canceledAt,
          },
        );

      expect(result).toEqual({
        canceledOrderCount: 2,
        releasedReservationCount: 2,
      });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
      expect(prisma.order.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'order-1', status: OrderStatus.submitted },
        data: expect.objectContaining({
          cancelReason: 'participant_excluded',
        }) as never,
      });
      // No new $transaction: it joins the caller's exclusion transaction.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is a no-op (idempotent) when the participant has no open limit buys', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const result =
        await service.cancelOpenLimitBuysForParticipantInTransaction(
          prisma as never,
          {
            seasonParticipantId: 'sp-1',
            reason: LIMIT_ORDER_CANCEL_REASONS.participantExcluded,
            canceledAt,
          },
        );

      expect(result).toEqual({
        canceledOrderCount: 0,
        releasedReservationCount: 0,
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('season-end cleanup', () => {
    it('cancels ended-season limit buys in bounded batches with season_ended reason', async () => {
      const { prisma, service } = createService();
      prisma.order.findMany
        .mockResolvedValueOnce([{ id: 'order-1' }, { id: 'order-2' }])
        .mockResolvedValueOnce([]);
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'order-1' },
        { id: 'order-2' },
      ]);
      prisma.order.findUnique
        .mockResolvedValueOnce({
          id: 'order-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
          seasonParticipant: { tradingAccountId: 'trading-account-1' },
          currencyCode: CurrencyCode.KRW,
          reservedAmount: new Prisma.Decimal('100.00000000'),
        })
        .mockResolvedValueOnce({
          id: 'order-2',
          seasonParticipantId: 'sp-2',
          tradingAccountId: 'trading-account-2',
          seasonParticipant: { tradingAccountId: 'trading-account-2' },
          currencyCode: CurrencyCode.KRW,
          reservedAmount: new Prisma.Decimal('40.00000000'),
        });
      prisma.cashWallet.findUnique
        .mockResolvedValueOnce({
          id: 'wallet-1',
          seasonParticipantId: 'sp-1',
          tradingAccountId: 'trading-account-1',
        })
        .mockResolvedValueOnce({
          id: 'wallet-2',
          seasonParticipantId: 'sp-2',
          tradingAccountId: 'trading-account-2',
        });
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.order.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cleanupEndedSeasonLimitReservations({
        now: canceledAt,
        batchSize: 2,
      });

      expect(result).toEqual({
        canceledOrderCount: 2,
        releasedReservationCount: 2,
      });
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: OrderStatus.submitted,
            orderType: OrderType.limit,
            side: 'buy',
            seasonParticipant: {
              season: {
                status: { in: [SeasonStatus.ended, SeasonStatus.settled] },
              },
            },
          }) as never,
          take: 2,
        }),
      );
      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cancelReason: 'season_ended',
          }) as never,
        }),
      );
    });

    it('skips orders a user cancel raced away (re-validated under lock) and stays idempotent', async () => {
      const { prisma, service } = createService();
      prisma.order.findMany.mockResolvedValueOnce([{ id: 'order-1' }]);
      // Lock query re-checks status=submitted: the raced order drops out.
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const result = await service.cleanupEndedSeasonLimitReservations({
        now: canceledAt,
        batchSize: 10,
      });

      expect(result).toEqual({
        canceledOrderCount: 0,
        releasedReservationCount: 0,
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('does nothing when no ended-season limit buys remain (re-runnable)', async () => {
      const { prisma, service } = createService();
      prisma.order.findMany.mockResolvedValueOnce([]);

      const result = await service.cleanupEndedSeasonLimitReservations({
        now: canceledAt,
      });

      expect(result).toEqual({
        canceledOrderCount: 0,
        releasedReservationCount: 0,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('settlement precondition summary', () => {
    it('counts open limit buys and wallets still holding reservations', async () => {
      const { prisma, service } = createService();
      const orderCount = jest.fn().mockResolvedValue(2);
      (prisma.order as Record<string, unknown>).count = orderCount;
      prisma.cashWallet.count.mockResolvedValue(1);

      const summary = await service.getOpenLimitReservationSummary('season-1');

      expect(summary).toEqual({
        openLimitBuyOrderCount: 2,
        reservedWalletCount: 1,
      });
      expect(orderCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            seasonParticipant: { seasonId: 'season-1' },
          }) as never,
        }),
      );
      expect(prisma.cashWallet.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            reservedAmount: { gt: 0 },
          }) as never,
        }),
      );
    });
  });

  /**
   * 작업 5 보완 1. The account-scoped cancel used to put
   * `o.trading_account_id = :accountId` in the LOCKING statement, which
   * collapsed three different situations into one 404: another user's order,
   * another account's order, and the caller's OWN order with a null or
   * corrupted scope. Only the middle case may stay a 404.
   */
  describe('account-scoped cancel scope classification', () => {
    const scopedCancel = (
      service: LimitOrderCancelService,
      expectedTradingAccountId = 'trading-account-1',
    ) =>
      service.cancelOwnedLimitBuyOrder({
        userId: 'user-1',
        orderId: 'order-1',
        canceledAt,
        expectedTradingAccountId,
      });

    const expectNoReservationOrStatusChange = (
      prisma: ReturnType<typeof createPrisma>,
    ) => {
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(prisma.order.updateMany).not.toHaveBeenCalled();
    };

    it('locks on orderId + user ownership only, never on the requested account', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderRecord())
        .mockResolvedValueOnce(
          orderRecord({
            status: OrderStatus.canceled,
            canceledAt,
            cancelReason: LIMIT_ORDER_CANCEL_REASONS.userCanceled,
            reservationReleasedAt: canceledAt,
          }),
        );
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });

      await scopedCancel(service);

      const lockValues = (prisma.$queryRaw.mock.calls[0] as unknown[]).slice(1);
      expect(lockValues).toEqual(['order-1', 'user-1']);
      expect(lockValues).not.toContain('trading-account-1');
    });

    it('cancels normally when order, participant, and requested account all agree', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique
        .mockResolvedValueOnce(orderRecord())
        .mockResolvedValueOnce(
          orderRecord({
            status: OrderStatus.canceled,
            canceledAt,
            cancelReason: LIMIT_ORDER_CANCEL_REASONS.userCanceled,
            reservationReleasedAt: canceledAt,
          }),
        );
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-1',
      });
      prisma.$executeRaw.mockResolvedValueOnce(1);
      prisma.order.updateMany.mockResolvedValueOnce({ count: 1 });

      const response = await scopedCancel(service);
      expect(response.data.execution.reservedAmountReleased).toBe(
        '150150.00000000',
      );
    });

    it('returns 404 for an orderId that does not belong to the caller', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expectErrorCode(scopedCancel(service), 'ORDER_NOT_FOUND');
      expectNoReservationOrStatusChange(prisma);
    });

    it("returns 404 for the caller's own NORMAL order on a different account", async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({
          tradingAccountId: 'trading-account-2',
          seasonParticipant: { tradingAccountId: 'trading-account-2' },
        }),
      );

      await expectErrorCode(scopedCancel(service), 'ORDER_NOT_FOUND');
      expectNoReservationOrStatusChange(prisma);
    });

    it("surfaces the caller's own NULL-scope order as TRADING_SCOPE_REPAIR_REQUIRED", async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ tradingAccountId: null }),
      );

      await expectErrorCode(
        scopedCancel(service),
        'TRADING_SCOPE_REPAIR_REQUIRED',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('surfaces a mis-scoped order of the requested participant as TRADING_ACCOUNT_SCOPE_MISMATCH', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ tradingAccountId: 'trading-account-9' }),
      );

      await expectErrorCode(
        scopedCancel(service),
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('does not hide an order scoped to THIS account whose participant link disagrees', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({
          tradingAccountId: 'trading-account-1',
          seasonParticipant: { tradingAccountId: null },
        }),
      );

      await expectErrorCode(
        scopedCancel(service),
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('classifies scope BEFORE the market-order 410, so corruption is never masked', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ orderType: OrderType.market, tradingAccountId: null }),
      );

      await expectErrorCode(
        scopedCancel(service),
        'TRADING_SCOPE_REPAIR_REQUIRED',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('keeps the LEGACY cancel contract: another user is still a plain 404', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([]);

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'ORDER_NOT_FOUND',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('keeps the LEGACY cancel fail-closed on a null own-order scope', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(
        orderRecord({ tradingAccountId: null }),
      );

      await expectErrorCode(
        service.cancelOwnedLimitBuyOrder({
          userId: 'user-1',
          orderId: 'order-1',
          canceledAt,
        }),
        'TRADING_SCOPE_REPAIR_REQUIRED',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('fails closed with FINANCIAL_SCOPE_REPAIR_REQUIRED on a null-scope wallet', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(orderRecord());
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: null,
      });

      await expectErrorCode(
        scopedCancel(service),
        'FINANCIAL_SCOPE_REPAIR_REQUIRED',
      );
      expectNoReservationOrStatusChange(prisma);
    });

    it('fails closed with FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH on a foreign wallet', async () => {
      const { prisma, service } = createService();
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValueOnce(orderRecord());
      prisma.cashWallet.findUnique.mockResolvedValueOnce({
        id: 'wallet-1',
        seasonParticipantId: 'sp-1',
        tradingAccountId: 'trading-account-7',
      });

      await expectErrorCode(
        scopedCancel(service),
        'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      );
      expectNoReservationOrStatusChange(prisma);
    });
  });
});
