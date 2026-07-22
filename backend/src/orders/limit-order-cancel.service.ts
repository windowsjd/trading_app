import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
  SeasonStatus,
} from '../generated/prisma/client';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  limitOrderErrorCodes,
  limitOrderErrorHttpStatus,
  type LimitOrderErrorCode,
} from './limit-order-error-policy';
import {
  LIMIT_ORDER_CANCEL_REASONS,
  type LimitOrderCancelReason,
} from './limit-order-policy';
import { OrderReservationService } from './order-reservation.service';
import {
  formatOrderResponse,
  type OrderResponsePayload,
} from './order-response.presenter';

const CANCEL_ORDER_SELECT = {
  id: true,
  seasonParticipantId: true,
  quoteId: true,
  side: true,
  orderType: true,
  status: true,
  quantity: true,
  limitPrice: true,
  executedPrice: true,
  currencyCode: true,
  grossAmount: true,
  feeAmount: true,
  netAmount: true,
  assetPriceSnapshotId: true,
  fxRateSnapshotId: true,
  reservedAmount: true,
  reservationReleasedAt: true,
  cancelReason: true,
  triggerEventId: true,
  triggerEventAt: true,
  matchedAt: true,
  matchingSource: true,
  submittedAt: true,
  executedAt: true,
  canceledAt: true,
  rejectedAt: true,
  rejectReason: true,
  createdAt: true,
  updatedAt: true,
  asset: {
    select: {
      id: true,
      symbol: true,
      name: true,
      market: true,
      currencyCode: true,
    },
  },
} as const;

export type CancelLimitOrderResponse = {
  success: true;
  data: {
    order: OrderResponsePayload;
    execution: {
      state: 'not_executed';
      reason: 'ORDER_CANCELED_BEFORE_EXECUTION';
      message: string;
      /** True when this call found the order already canceled. */
      alreadyCanceled: boolean;
      reservedAmountReleased: string | null;
    };
  };
};

export type LimitReservationCleanupResult = {
  canceledOrderCount: number;
  releasedReservationCount: number;
};

type CancelTransactionClient = Prisma.TransactionClient;

/**
 * Cancel + lifecycle-release paths for submitted limit-buy reservations.
 * Lock order is always Order row (FOR UPDATE) → CashWallet row (the guarded
 * UPDATE), and a release happens at most once per order because the order
 * leaves `submitted` in the same transaction that releases its reservation.
 *
 * Deliberately NOT gated by LIMIT_ORDER_ENABLED: already-reserved cash must
 * always be releasable even when the feature flag is turned back off.
 */
@Injectable()
export class LimitOrderCancelService {
  private readonly logger = new Logger(LimitOrderCancelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservation: OrderReservationService,
  ) {}

  /**
   * User-facing cancel of an owned submitted limit-buy order. Idempotent:
   * canceling an already-canceled order returns the current state without a
   * second release. Market orders keep the historical
   * ORDER_CANCEL_NOT_SUPPORTED (410) meaning.
   */
  async cancelOwnedLimitBuyOrder(input: {
    userId: string;
    orderId: string;
    canceledAt: Date;
  }): Promise<CancelLimitOrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the order row first (Order → CashWallet lock order). Ownership
      // is enforced in the same locking statement.
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT o."id"
        FROM "orders" o
        JOIN "season_participants" sp ON sp."id" = o."season_participant_id"
        WHERE o."id" = ${input.orderId}
          AND sp."user_id" = ${input.userId}
        FOR UPDATE OF o
      `;

      if (lockedRows.length !== 1) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'ORDER_NOT_FOUND',
              message: 'Order not found.',
            },
          },
          HttpStatus.NOT_FOUND,
        );
      }

      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: CANCEL_ORDER_SELECT,
      });

      if (!order) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'ORDER_NOT_FOUND',
              message: 'Order not found.',
            },
          },
          HttpStatus.NOT_FOUND,
        );
      }

      if (order.orderType === OrderType.market) {
        // Historical MVP market-order meaning, unchanged.
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'ORDER_CANCEL_NOT_SUPPORTED',
              message: 'Order cancel is not supported for MVP market orders.',
            },
          },
          HttpStatus.GONE,
        );
      }

      if (order.side !== OrderSide.buy) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_NOT_CANCELABLE,
          'Only limit buy orders can be canceled.',
        );
      }

      if (order.status === OrderStatus.canceled) {
        // Idempotent replay: the reservation was already released exactly
        // once when the order left `submitted`.
        return this.buildCancelResponse(order, {
          alreadyCanceled: true,
          reservedAmountReleased: null,
        });
      }

      if (order.status !== OrderStatus.submitted) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_NOT_CANCELABLE,
          'Only submitted limit orders can be canceled.',
        );
      }

      const releasedAmount = await this.releaseAndCancelLockedOrder(tx, {
        orderId: order.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        reservedAmount: order.reservedAmount,
        cancelReason: LIMIT_ORDER_CANCEL_REASONS.userCanceled,
        canceledAt: input.canceledAt,
      });

      const canceledOrder = await tx.order.findUnique({
        where: { id: order.id },
        select: CANCEL_ORDER_SELECT,
      });

      if (!canceledOrder) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_CANCEL_CONFLICT,
          'Canceled order could not be read back.',
        );
      }

      return this.buildCancelResponse(canceledOrder, {
        alreadyCanceled: false,
        reservedAmountReleased: releasedAmount,
      });
    });
  }

  /**
   * Cancels every submitted limit-buy order of one participant inside the
   * caller's transaction (participant exclusion path). Orders are locked
   * in a stable id order before wallets are touched.
   */
  async cancelOpenLimitBuysForParticipantInTransaction(
    tx: CancelTransactionClient,
    input: {
      seasonParticipantId: string;
      reason: LimitOrderCancelReason;
      canceledAt: Date;
    },
  ): Promise<LimitReservationCleanupResult> {
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "orders"
      WHERE "season_participant_id" = ${input.seasonParticipantId}
        AND "status" = 'submitted'
        AND "order_type" = 'limit'
        AND "side" = 'buy'
      ORDER BY "id"
      FOR UPDATE
    `;

    let canceledOrderCount = 0;
    for (const row of lockedRows) {
      const order = await tx.order.findUnique({
        where: { id: row.id },
        select: {
          id: true,
          seasonParticipantId: true,
          currencyCode: true,
          status: true,
          orderType: true,
          side: true,
          reservedAmount: true,
        },
      });

      if (
        !order ||
        order.status !== OrderStatus.submitted ||
        order.orderType !== OrderType.limit ||
        order.side !== OrderSide.buy
      ) {
        continue;
      }

      await this.releaseAndCancelLockedOrder(tx, {
        orderId: order.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        reservedAmount: order.reservedAmount,
        cancelReason: input.reason,
        canceledAt: input.canceledAt,
      });
      canceledOrderCount += 1;
    }

    return {
      canceledOrderCount,
      releasedReservationCount: canceledOrderCount,
    };
  }

  /**
   * Season-end safety net: cancels submitted limit buys belonging to ended
   * (or settled) seasons and releases their reservations, in bounded
   * batches. Idempotent and re-runnable — it re-selects open orders every
   * pass, so a crash mid-way is healed by the next run.
   */
  async cleanupEndedSeasonLimitReservations(input: {
    now: Date;
    batchSize?: number;
  }): Promise<LimitReservationCleanupResult> {
    const batchSize = input.batchSize ?? 100;
    let canceledOrderCount = 0;

    for (;;) {
      const batch = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          side: OrderSide.buy,
          seasonParticipant: {
            season: {
              status: { in: [SeasonStatus.ended, SeasonStatus.settled] },
            },
          },
        },
        select: { id: true },
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        take: batchSize,
      });

      if (batch.length === 0) {
        break;
      }

      const batchIds = batch.map((row) => row.id);
      const batchCanceled = await this.prisma.$transaction(async (tx) => {
        // Re-lock and re-validate inside the transaction: a user cancel may
        // have raced the selection above.
        const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "orders"
          WHERE "id" = ANY(${batchIds})
            AND "status" = 'submitted'
            AND "order_type" = 'limit'
            AND "side" = 'buy'
          ORDER BY "id"
          FOR UPDATE
        `;

        let canceled = 0;
        for (const row of lockedRows) {
          const order = await tx.order.findUnique({
            where: { id: row.id },
            select: {
              id: true,
              seasonParticipantId: true,
              currencyCode: true,
              reservedAmount: true,
            },
          });
          if (!order) continue;

          await this.releaseAndCancelLockedOrder(tx, {
            orderId: order.id,
            seasonParticipantId: order.seasonParticipantId,
            currencyCode: order.currencyCode,
            reservedAmount: order.reservedAmount,
            cancelReason: LIMIT_ORDER_CANCEL_REASONS.seasonEnded,
            canceledAt: input.now,
          });
          canceled += 1;
        }
        return canceled;
      });

      canceledOrderCount += batchCanceled;
      if (batch.length < batchSize) {
        break;
      }
    }

    if (canceledOrderCount > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'limit_order_season_end_cleanup',
          canceledOrderCount,
        }),
      );
    }

    return {
      canceledOrderCount,
      releasedReservationCount: canceledOrderCount,
    };
  }

  /**
   * Settlement precondition input: open submitted limit-buy orders and
   * wallets still carrying a reservation for the season. Settlement must
   * not proceed while either is non-zero.
   */
  async getOpenLimitReservationSummary(seasonId: string): Promise<{
    openLimitBuyOrderCount: number;
    reservedWalletCount: number;
  }> {
    const [openLimitBuyOrderCount, reservedWalletCount] = await Promise.all([
      this.prisma.order.count({
        where: {
          status: OrderStatus.submitted,
          orderType: OrderType.limit,
          side: OrderSide.buy,
          seasonParticipant: { seasonId },
        },
      }),
      this.prisma.cashWallet.count({
        where: {
          seasonParticipant: { seasonId },
          reservedAmount: { gt: 0 },
        },
      }),
    ]);

    return { openLimitBuyOrderCount, reservedWalletCount };
  }

  /**
   * Shared release+cancel step. Caller must hold the order row lock and
   * have verified status === submitted. Wallet reservation is released via
   * the atomic guard (CashWallet lock acquired here, after the order lock),
   * then the order is flipped out of `submitted` with a guarded updateMany —
   * so release and cancel are inseparable within the transaction.
   */
  private async releaseAndCancelLockedOrder(
    tx: CancelTransactionClient,
    input: {
      orderId: string;
      seasonParticipantId: string;
      currencyCode: CurrencyCode;
      reservedAmount: Prisma.Decimal | null;
      cancelReason: LimitOrderCancelReason;
      canceledAt: Date;
    },
  ): Promise<string> {
    if (!input.reservedAmount || input.reservedAmount.lte(0)) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Submitted limit order has no recorded reservation.',
      );
    }

    const wallet = await tx.cashWallet.findUnique({
      where: {
        seasonParticipantId_currencyCode: {
          seasonParticipantId: input.seasonParticipantId,
          currencyCode: input.currencyCode,
        },
      },
      select: { id: true },
    });

    if (!wallet) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Cash wallet for the order reservation was not found.',
      );
    }

    const releasedAmountText = formatDecimalScale(
      input.reservedAmount,
      monetaryScale,
    );

    await this.reservation.releaseLimitBuyReservation(tx, {
      walletId: wallet.id,
      seasonParticipantId: input.seasonParticipantId,
      currencyCode: input.currencyCode,
      amount: releasedAmountText,
    });

    const flipped = await tx.order.updateMany({
      where: {
        id: input.orderId,
        status: OrderStatus.submitted,
      },
      data: {
        status: OrderStatus.canceled,
        canceledAt: input.canceledAt,
        cancelReason: input.cancelReason,
        reservationReleasedAt: input.canceledAt,
      },
    });

    if (flipped.count !== 1) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_CANCEL_CONFLICT,
        'Order state changed while canceling.',
      );
    }

    return releasedAmountText;
  }

  private buildCancelResponse(
    order: Parameters<typeof formatOrderResponse>[0],
    execution: {
      alreadyCanceled: boolean;
      reservedAmountReleased: string | null;
    },
  ): CancelLimitOrderResponse {
    return {
      success: true,
      data: {
        order: formatOrderResponse(order),
        execution: {
          state: 'not_executed',
          reason: 'ORDER_CANCELED_BEFORE_EXECUTION',
          message: execution.alreadyCanceled
            ? 'Order was already canceled; the reservation was released when it was first canceled.'
            : 'Limit order was canceled and its cash reservation was released.',
          alreadyCanceled: execution.alreadyCanceled,
          reservedAmountReleased: execution.reservedAmountReleased,
        },
      },
    };
  }

  private throwLimitOrderError(
    code: LimitOrderErrorCode,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      limitOrderErrorHttpStatus[code],
    );
  }
}
