import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
  QuoteStatus,
} from '../generated/prisma/client';
import {
  feeRateScale,
  formatDecimalScale,
  monetaryScale,
} from '../fx/fx-decimal-policy';
import { PrismaService } from '../prisma/prisma.service';
import {
  limitOrderErrorCodes,
  limitOrderErrorHttpStatus,
  type LimitOrderErrorCode,
} from './limit-order-error-policy';
import {
  calculateAvailableAmount,
  calculateLimitBuyReservation,
} from './limit-order-policy';
import { OrderReservationService } from './order-reservation.service';
import {
  formatOrderResponse,
  orderQuantityScale,
  type OrderResponsePayload,
} from './order-response.presenter';

const LIMIT_ORDER_PAYLOAD_SELECT = {
  id: true,
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

export type LimitBuyQuotePreview = {
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  reservedAmount: Prisma.Decimal;
  walletBalanceBefore: Prisma.Decimal;
  walletReservedBefore: Prisma.Decimal;
  walletAvailableBefore: Prisma.Decimal;
  estimatedReservedAfter: Prisma.Decimal;
  estimatedAvailableAfter: Prisma.Decimal;
  positionQuantityBefore: Prisma.Decimal;
  estimatedPositionQuantityAfter: Prisma.Decimal;
};

export type LimitOrderCreateResponse = {
  success: true;
  data: {
    order: OrderResponsePayload;
    execution: {
      /** Phase 1 never executes a limit order at create time. */
      state: 'submitted';
      submittedAt: string;
      quoteId: string | null;
      reservedAmount: string | null;
      reservationFeeRate: string | null;
      duplicate: boolean;
    };
  };
};

type LimitCreateTransactionClient = Prisma.TransactionClient;

/**
 * Limit-buy phase 1: quote preview and submitted-order creation with cash
 * reservation. No provider price is read anywhere in this service, no
 * WalletTransaction/Position is written, and no execution ever happens —
 * even a marketable limit price stays `submitted` until the user cancels or
 * lifecycle cleanup releases it.
 */
@Injectable()
export class LimitOrderCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservation: OrderReservationService,
  ) {}

  /**
   * Read-only wallet/position preview for a limit-buy quote. Rejects with
   * INSUFFICIENT_AVAILABLE_BALANCE when balance - reserved cannot cover the
   * would-be reservation. Never mutates anything.
   */
  async buildLimitBuyQuotePreview(input: {
    participantId: string;
    assetId: string;
    currencyCode: CurrencyCode;
    limitPrice: Prisma.Decimal;
    quantity: Prisma.Decimal;
    tradeFeeRate: Prisma.Decimal;
  }): Promise<LimitBuyQuotePreview> {
    const amounts = calculateLimitBuyReservation({
      limitPrice: input.limitPrice,
      quantity: input.quantity,
      tradeFeeRate: input.tradeFeeRate,
    });

    const [wallet, position] = await Promise.all([
      this.prisma.cashWallet.findUnique({
        where: {
          seasonParticipantId_currencyCode: {
            seasonParticipantId: input.participantId,
            currencyCode: input.currencyCode,
          },
        },
        select: {
          balanceAmount: true,
          reservedAmount: true,
        },
      }),
      this.prisma.position.findUnique({
        where: {
          seasonParticipantId_assetId: {
            seasonParticipantId: input.participantId,
            assetId: input.assetId,
          },
        },
        select: {
          quantity: true,
        },
      }),
    ]);

    const walletBalanceBefore = wallet?.balanceAmount ?? new Prisma.Decimal(0);
    const walletReservedBefore =
      wallet?.reservedAmount ?? new Prisma.Decimal(0);
    const walletAvailableBefore = calculateAvailableAmount(
      walletBalanceBefore,
      walletReservedBefore,
    );

    if (!wallet || walletAvailableBefore.lt(amounts.reservedAmount)) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Available cash balance is insufficient for the limit order reservation.',
      );
    }

    const positionQuantityBefore = position?.quantity ?? new Prisma.Decimal(0);

    return {
      ...amounts,
      walletBalanceBefore,
      walletReservedBefore,
      walletAvailableBefore,
      estimatedReservedAfter: walletReservedBefore.add(amounts.reservedAmount),
      estimatedAvailableAfter: walletAvailableBefore.sub(
        amounts.reservedAmount,
      ),
      positionQuantityBefore,
      estimatedPositionQuantityAfter: positionQuantityBefore.add(
        input.quantity,
      ),
    };
  }

  /**
   * Creates the submitted limit-buy order inside the caller's transaction.
   * One atomic unit: cash reservation, order row, quote consumption, and
   * the idempotent response payload all commit or roll back together.
   */
  async createSubmittedLimitBuyInTransaction(
    tx: LimitCreateTransactionClient,
    input: {
      quote: {
        id: string;
        limitPrice: Prisma.Decimal;
        asset: {
          id: string;
          settlementCurrency: CurrencyCode | null;
          currencyCode: CurrencyCode;
        };
      };
      season: { tradeFeeRate: Prisma.Decimal };
      participant: { id: string };
      quantity: Prisma.Decimal;
      idempotency: { idempotencyKey: string; requestHash: string };
      submittedAt: Date;
    },
  ): Promise<LimitOrderCreateResponse> {
    const currencyCode =
      input.quote.asset.settlementCurrency ?? input.quote.asset.currencyCode;
    const amounts = calculateLimitBuyReservation({
      limitPrice: input.quote.limitPrice,
      quantity: input.quantity,
      tradeFeeRate: input.season.tradeFeeRate,
    });
    const reservedAmountText = formatDecimalScale(
      amounts.reservedAmount,
      monetaryScale,
    );
    const reservationFeeRateText = formatDecimalScale(
      input.season.tradeFeeRate,
      feeRateScale,
    );

    // 1) Atomic cash reservation (fails the whole transaction on shortage).
    await this.reservation.reserveForLimitBuy(tx, {
      seasonParticipantId: input.participant.id,
      currencyCode,
      amount: reservedAmountText,
    });

    // 2) Submitted order row. gross/fee/net are the reservation-based
    // estimates derived from the limit price (never a provider price);
    // net = gross + fee = reservedAmount, matching the market-buy rounding.
    const created = await tx.order.create({
      data: {
        seasonParticipantId: input.participant.id,
        assetId: input.quote.asset.id,
        quoteId: input.quote.id,
        side: OrderSide.buy,
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        quantity: formatDecimalScale(input.quantity, orderQuantityScale),
        limitPrice: formatDecimalScale(input.quote.limitPrice, monetaryScale),
        executedPrice: null,
        currencyCode,
        grossAmount: formatDecimalScale(amounts.grossAmount, monetaryScale),
        feeAmount: formatDecimalScale(amounts.feeAmount, monetaryScale),
        netAmount: reservedAmountText,
        assetPriceSnapshotId: null,
        fxRateSnapshotId: null,
        reservedAmount: reservedAmountText,
        reservationFeeRate: reservationFeeRateText,
        reservationReleasedAt: null,
        cancelReason: null,
        idempotencyKey: input.idempotency.idempotencyKey,
        requestHash: input.idempotency.requestHash,
        submittedAt: input.submittedAt,
        createdAt: input.submittedAt,
        updatedAt: input.submittedAt,
      },
      select: { id: true },
    });

    // 3) Consume the quote inside the same transaction.
    const consumeResult = await tx.quote.updateMany({
      where: {
        id: input.quote.id,
        status: QuoteStatus.active,
      },
      data: {
        status: QuoteStatus.consumed,
        consumedAt: input.submittedAt,
      },
    });

    if (consumeResult.count !== 1) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'QUOTE_NOT_ACTIVE',
            message: 'Quote is not active.',
          },
        },
        HttpStatus.CONFLICT,
      );
    }

    const order = await tx.order.findUnique({
      where: { id: created.id },
      select: LIMIT_ORDER_PAYLOAD_SELECT,
    });

    if (!order) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT,
        'Created limit order could not be read back.',
      );
    }

    const response: LimitOrderCreateResponse = {
      success: true,
      data: {
        order: formatOrderResponse(order),
        execution: {
          state: 'submitted',
          submittedAt: input.submittedAt.toISOString(),
          quoteId: input.quote.id,
          reservedAmount: reservedAmountText,
          reservationFeeRate: reservationFeeRateText,
          duplicate: false,
        },
      },
    };

    // 4) Persist the payload for idempotent replays of the same request.
    await tx.order.update({
      where: { id: created.id },
      data: {
        responsePayloadJson: response as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return response;
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
