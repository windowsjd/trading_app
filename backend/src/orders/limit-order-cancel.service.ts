import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
  SeasonStatus,
  TradingAccountMode,
} from '../generated/prisma/client';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';
import { PrismaService } from '../prisma/prisma.service';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
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
import { releaseReservedPositionQuantity } from './position-reservation-atomic';
import {
  formatOrderResponse,
  type OrderResponsePayload,
} from './order-response.presenter';

const CANCEL_ORDER_SELECT = {
  id: true,
  tradingAccountId: true,
  tradingAccount: {
    select: {
      id: true,
      userId: true,
      mode: true,
      seasonParticipant: { select: { id: true, tradingAccountId: true } },
    },
  },
  quoteId: true,
  assetId: true,
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
  reservedQuantity: true,
  reservationReleasedAt: true,
  cancelReason: true,
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
      reservedQuantityReleased: string | null;
    };
  };
};

export type LimitReservationCleanupResult = {
  canceledOrderCount: number;
  releasedReservationCount: number;
};

type CancelTransactionClient = Prisma.TransactionClient;

/**
 * Cancel + lifecycle-release paths for submitted limit-order reservations.
 * Lock order is always Order row (FOR UPDATE) → reservation owner
 * (CashWallet for buy, Position for sell), and a release happens at most once
 * per order because the order leaves `submitted` in the same transaction that
 * releases its reservation.
 *
 * Deliberately NOT gated by LIMIT_ORDER_ENABLED: already-reserved cash or
 * quantity must always be releasable even when the feature flag is turned off.
 */
@Injectable()
export class LimitOrderCancelService {
  private readonly logger = new Logger(LimitOrderCancelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservation: OrderReservationService,
  ) {}

  /**
   * User-facing cancel of an owned submitted limit order. Idempotent:
   * canceling an already-canceled order returns the current state without a
   * second release. Market orders keep the historical
   * ORDER_CANCEL_NOT_SUPPORTED (410) meaning.
   */
  async cancelOwnedLimitBuyOrder(input: {
    userId: string;
    orderId: string;
    canceledAt: Date;
    /**
     * Account-scoped cancel only: the resolved, owned account this cancel is
     * addressed to. It is NOT part of the locking WHERE (see
     * assertRequestedAccountScope) — filtering on it there would turn the
     * caller's OWN corrupted order into an indistinguishable 404.
     */
    expectedTradingAccountId?: string;
  }): Promise<CancelLimitOrderResponse> {
    return this.prisma.$transaction(async (tx) => {
      // Lock the order row first (Order → CashWallet lock order). The locking
      // statement enforces ONLY orderId + user ownership — deliberately not
      // the requested account. Account membership is classified afterwards
      // against the loaded row, so "someone else's order" (404) stays
      // distinguishable from "my own order with a broken account scope"
      // (500), which the old account-filtered lock could not do.
      const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT o."id"
        FROM "orders" o
        JOIN "trading_accounts" ta ON ta."id" = o."trading_account_id"
        WHERE o."id" = ${input.orderId}
          AND ta."user_id" = ${input.userId}
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

      // Account membership / scope classification runs before ANY cancel work
      // so a scope error can never change order status or reservedAmount.
      if (input.expectedTradingAccountId) {
        this.assertRequestedAccountScope(order, input.expectedTradingAccountId);
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

      if (order.status === OrderStatus.canceled) {
        // Idempotent replay: the reservation was already released exactly
        // once when the order left `submitted`.
        return this.buildCancelResponse(order, {
          alreadyCanceled: true,
          reservedAmountReleased: null,
          reservedQuantityReleased: null,
        });
      }

      if (order.status !== OrderStatus.submitted) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_NOT_CANCELABLE,
          'Only submitted limit orders can be canceled.',
        );
      }

      const released = await this.releaseAndCancelLockedOrder(tx, {
        orderId: order.id,
        side: order.side,
        assetId: order.assetId,
        tradingAccountId: this.requireOrderTradingScopeForRelease(order),
        currencyCode: order.currencyCode,
        reservedAmount: order.reservedAmount,
        reservedQuantity: order.reservedQuantity,
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
        reservedAmountReleased: released.reservedAmount,
        reservedQuantityReleased: released.reservedQuantity,
      });
    });
  }

  /**
   * Cancels every submitted limit order of one participant inside the
   * caller's transaction (participant exclusion path). Orders are locked
   * in a stable id order before wallets are touched.
   */
  async cancelOpenLimitBuysForParticipantInTransaction(
    tx: CancelTransactionClient,
    input: {
      tradingAccountId: string;
      reason: LimitOrderCancelReason;
      canceledAt: Date;
    },
  ): Promise<LimitReservationCleanupResult> {
    const lockedRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "orders"
      WHERE "trading_account_id" = ${input.tradingAccountId}
        AND "status" = 'submitted'
        AND "order_type" = 'limit'
      ORDER BY "id"
      FOR UPDATE
    `;

    let canceledOrderCount = 0;
    for (const row of lockedRows) {
      const order = await tx.order.findUnique({
        where: { id: row.id },
        select: {
          id: true,
          assetId: true,
          tradingAccountId: true,
          tradingAccount: {
            select: {
              id: true,
              mode: true,
              seasonParticipant: {
                select: { id: true, tradingAccountId: true },
              },
            },
          },
          currencyCode: true,
          status: true,
          orderType: true,
          side: true,
          reservedAmount: true,
          reservedQuantity: true,
        },
      });

      if (
        !order ||
        order.tradingAccountId !== input.tradingAccountId ||
        order.status !== OrderStatus.submitted ||
        order.orderType !== OrderType.limit ||
        (order.side !== OrderSide.buy && order.side !== OrderSide.sell)
      ) {
        continue;
      }

      await this.releaseAndCancelLockedOrder(tx, {
        orderId: order.id,
        side: order.side,
        assetId: order.assetId,
        tradingAccountId: this.requireOrderTradingScopeForRelease(order),
        currencyCode: order.currencyCode,
        reservedAmount: order.reservedAmount,
        reservedQuantity: order.reservedQuantity,
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
   * Season-end safety net: cancels submitted limit orders belonging to ended
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
          tradingAccount: {
            mode: TradingAccountMode.season,
            seasonParticipant: {
              season: {
                status: { in: [SeasonStatus.ended, SeasonStatus.settled] },
              },
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
          ORDER BY "id"
          FOR UPDATE
        `;

        let canceled = 0;
        for (const row of lockedRows) {
          const order = await tx.order.findUnique({
            where: { id: row.id },
            select: {
              id: true,
              assetId: true,
              side: true,
              tradingAccountId: true,
              tradingAccount: {
                select: {
                  id: true,
                  mode: true,
                  seasonParticipant: {
                    select: { id: true, tradingAccountId: true },
                  },
                },
              },
              currencyCode: true,
              reservedAmount: true,
              reservedQuantity: true,
            },
          });
          if (!order) continue;

          await this.releaseAndCancelLockedOrder(tx, {
            orderId: order.id,
            side: order.side,
            assetId: order.assetId,
            tradingAccountId: this.requireOrderTradingScopeForRelease(order),
            currencyCode: order.currencyCode,
            reservedAmount: order.reservedAmount,
            reservedQuantity: order.reservedQuantity,
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
          tradingAccount: { seasonParticipant: { seasonId } },
        },
      }),
      this.prisma.cashWallet.count({
        where: {
          tradingAccount: { seasonParticipant: { seasonId } },
          reservedAmount: { gt: 0 },
        },
      }),
    ]);

    return { openLimitBuyOrderCount, reservedWalletCount };
  }

  /**
   * Shared release+cancel step. Caller must hold the order row lock and
   * have verified status === submitted. Its cash/quantity reservation is
   * released via the corresponding atomic guard, then the order is flipped
   * out of `submitted` with a guarded updateMany — so release and cancel are
   * inseparable within the transaction.
   */
  private async releaseAndCancelLockedOrder(
    tx: CancelTransactionClient,
    input: {
      orderId: string;
      side: OrderSide;
      assetId: string;
      /** VERIFIED canonical account scope. */
      tradingAccountId: string;
      currencyCode: CurrencyCode;
      reservedAmount: Prisma.Decimal | null;
      reservedQuantity: Prisma.Decimal | null;
      cancelReason: LimitOrderCancelReason;
      canceledAt: Date;
    },
  ): Promise<{
    reservedAmount: string | null;
    reservedQuantity: string | null;
  }> {
    if (
      input.side === OrderSide.buy &&
      (!input.reservedAmount || input.reservedAmount.lte(0))
    ) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Submitted limit order has no recorded reservation.',
      );
    }
    if (
      input.side === OrderSide.sell &&
      (!input.reservedQuantity || input.reservedQuantity.lte(0))
    ) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Submitted limit sell has no recorded quantity reservation.',
      );
    }

    let releasedAmountText: string | null = null;
    let releasedQuantityText: string | null = null;
    if (input.side === OrderSide.buy) {
      const wallet = await tx.cashWallet.findUnique({
        where: {
          tradingAccountId_currencyCode: {
            tradingAccountId: input.tradingAccountId,
            currencyCode: input.currencyCode,
          },
        },
        select: { id: true, tradingAccountId: true },
      });

      if (!wallet) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Cash wallet for the order reservation was not found.',
        );
      }

      // Wallet scope must match the ORDER's verified account exactly before
      // any reservation is decreased: a null-scope wallet is repair-required,
      // a foreign wallet is never touched (both structured 500s).
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId: input.tradingAccountId,
      });

      releasedAmountText = formatDecimalScale(
        input.reservedAmount as Prisma.Decimal,
        monetaryScale,
      );

      await this.reservation.releaseLimitBuyReservation(tx, {
        walletId: wallet.id,
        tradingAccountId: input.tradingAccountId,
        currencyCode: input.currencyCode,
        amount: releasedAmountText,
      });
    } else {
      const position = await tx.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: input.tradingAccountId,
            assetId: input.assetId,
          },
        },
        select: {
          id: true,
          tradingAccountId: true,
        },
      });
      if (!position || position.tradingAccountId !== input.tradingAccountId) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Position for the order reservation was not found or mis-scoped.',
        );
      }
      releasedQuantityText = formatDecimalScale(
        input.reservedQuantity as Prisma.Decimal,
        monetaryScale,
      );
      const released = await releaseReservedPositionQuantity(tx, {
        positionId: position.id,
        tradingAccountId: input.tradingAccountId,
        assetId: input.assetId,
        quantity: releasedQuantityText,
      });
      if (released !== 1) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Position reservation does not cover the order quantity.',
        );
      }
    }

    const flipped = await tx.order.updateMany({
      where: {
        id: input.orderId,
        tradingAccountId: input.tradingAccountId,
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

    return {
      reservedAmount: releasedAmountText,
      reservedQuantity: releasedQuantityText,
    };
  }

  /**
   * Account-scoped cancel: the ownership lock already proved the caller owns
   * the order. The requested account must be the order's canonical account;
   * another account remains indistinguishable from an unknown order.
   */
  private assertRequestedAccountScope(
    order: {
      tradingAccountId: string | null;
      tradingAccount: {
        id: string;
        mode: TradingAccountMode;
        seasonParticipant: {
          id: string;
          tradingAccountId: string | null;
        } | null;
      } | null;
    },
    requestedTradingAccountId: string,
  ): void {
    const orderAccountId = order.tradingAccountId;

    if (
      orderAccountId === requestedTradingAccountId &&
      (!order.tradingAccount || order.tradingAccount.id !== orderAccountId)
    ) {
      this.throwScopeIntegrity(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Order trading-account relation is inconsistent.',
      );
    }

    if (orderAccountId === requestedTradingAccountId) return;

    // A normal order of another account of the same user: same 404 as an
    // unknown orderId, so no other account's contents are disclosed.
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

  private throwScopeIntegrity(code: string, message: string): never {
    throw new HttpException(
      {
        success: false,
        error: { code, message },
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /**
   * A release may only move the reservation of the ORDER's own account.
   * The order and its TradingAccount relation must agree. A season account
   * must still have its normal SeasonParticipant domain link.
   */
  private requireOrderTradingScopeForRelease(order: {
    tradingAccountId: string | null;
    tradingAccount: {
      id: string;
      mode: TradingAccountMode;
      seasonParticipant: { id: string; tradingAccountId: string | null } | null;
    } | null;
  }): string {
    if (!order.tradingAccountId) {
      this.throwScopeIntegrity(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Order has no canonical trading account scope.',
      );
    }

    if (
      !order.tradingAccount ||
      order.tradingAccount.id !== order.tradingAccountId
    ) {
      this.throwScopeIntegrity(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Order trading-account relation is inconsistent.',
      );
    }

    if (order.tradingAccount.mode === TradingAccountMode.general) {
      if (order.tradingAccount.seasonParticipant !== null) {
        this.throwScopeIntegrity(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order carries a season participant link.',
        );
      }
      return order.tradingAccountId;
    }

    if (
      !order.tradingAccount.seasonParticipant ||
      order.tradingAccountId !==
        order.tradingAccount.seasonParticipant.tradingAccountId
    ) {
      this.throwScopeIntegrity(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Order is scoped to a different trading account than its participant.',
      );
    }

    return order.tradingAccountId;
  }

  private buildCancelResponse(
    order: Parameters<typeof formatOrderResponse>[0],
    execution: {
      alreadyCanceled: boolean;
      reservedAmountReleased: string | null;
      reservedQuantityReleased: string | null;
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
            : 'Limit order was canceled and its reservation was released.',
          alreadyCanceled: execution.alreadyCanceled,
          reservedAmountReleased: execution.reservedAmountReleased,
          reservedQuantityReleased: execution.reservedQuantityReleased,
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
