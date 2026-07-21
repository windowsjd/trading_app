import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  QuoteStatus,
  SeasonStatus,
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
  validateQuotedLimitReservationBasis,
  type QuotedLimitReservationBasis,
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
  /**
   * The reservation basis as shown to the user. These four values are
   * persisted verbatim on the durable quote and are what create reserves —
   * never a recomputation against the live Season.tradeFeeRate.
   */
  quotedFeeRate: Prisma.Decimal;
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
      quotedFeeRate: input.tradeFeeRate,
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
   * Locks the durable quote row for the duration of the create transaction.
   * FIRST step of the create lock order — see lockTradableContextInTransaction
   * for the full ordering rationale. Locking here (rather than relying on the
   * conditional consume at the end) means two concurrent creates against the
   * same quote serialize instead of both reserving cash and having the loser
   * roll its reservation back.
   */
  async lockQuoteForCreateInTransaction(
    tx: LimitCreateTransactionClient,
    quoteId: string,
  ): Promise<void> {
    await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "quotes" WHERE "id" = ${quoteId} FOR UPDATE
    `;
  }

  /**
   * Re-reads and locks the season/participant state that authorizes a limit
   * create, INSIDE the create transaction. The identical checks run before
   * the transaction too, but only as a fast-fail courtesy: financial
   * correctness rests here, on these locked rows.
   *
   * Lock order is Quote → SeasonParticipant → Season → CashWallet, and every
   * concurrent writer is compatible with it:
   *   - participant exclusion (operator-season-moderation) takes
   *     SeasonParticipant → Order → CashWallet, so it can never hold the
   *     wallet while waiting for the participant;
   *   - settlement takes SeasonParticipant → … → Season, which is why the
   *     participant is locked BEFORE the season here (the reverse order would
   *     deadlock against a settling season);
   *   - season lifecycle ending updates Season alone in its transaction and
   *     cleans up orders afterwards in separate ones;
   *   - user cancel and both cleanup paths take Order → CashWallet and never
   *     touch Season/SeasonParticipant locks.
   *
   * Both rows are taken FOR SHARE, not FOR UPDATE: concurrent creates do not
   * serialize against each other, while a plain UPDATE of either row (the
   * exclusion write and the season-ending write both acquire FOR NO KEY
   * UPDATE) still conflicts and must wait. Create never upgrades either lock,
   * so no lock-upgrade deadlock is introduced. Rows are locked BY ID so the
   * post-wait re-read always returns the newest committed version and the
   * status check happens in application code with a precise error.
   */
  async lockTradableContextInTransaction(
    tx: LimitCreateTransactionClient,
    input: {
      userId: string;
      seasonParticipantId: string;
      now: Date;
    },
  ): Promise<{ seasonId: string }> {
    const participantRows = await tx.$queryRaw<
      Array<{
        id: string;
        season_id: string;
        user_id: string;
        participant_status: ParticipantStatus;
      }>
    >`
      SELECT "id", "season_id", "user_id", "participant_status"
      FROM "season_participants"
      WHERE "id" = ${input.seasonParticipantId}
      FOR SHARE
    `;

    const participant = participantRows[0];
    if (!participant || participant.user_id !== input.userId) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'PARTICIPANT_NOT_FOUND',
        'Season participant was not found.',
      );
    }

    if (participant.participant_status === ParticipantStatus.excluded) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'PARTICIPANT_EXCLUDED',
        'Season participant is excluded from trading.',
      );
    }

    if (participant.participant_status !== ParticipantStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PARTICIPANT_NOT_ACTIVE',
        'Season participant is not active.',
      );
    }

    // seasonId comes from the LOCKED participant row, not from the caller's
    // pre-transaction read, so the participant-to-season link is verified
    // against committed state as well.
    // trade_fee_rate is deliberately NOT selected: the reservation basis comes
    // from the quote, and not having the live rate in scope makes it
    // impossible to reintroduce a re-price at create time by accident.
    const seasonRows = await tx.$queryRaw<
      Array<{
        id: string;
        status: SeasonStatus;
        start_at: Date;
        end_at: Date;
      }>
    >`
      SELECT "id", "status", "start_at", "end_at"
      FROM "seasons"
      WHERE "id" = ${participant.season_id}
      FOR SHARE
    `;

    const season = seasonRows[0];
    if (!season) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }

    if (season.status !== SeasonStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }

    if (input.now.getTime() < season.start_at.getTime()) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_STARTED',
        'Season has not started.',
      );
    }

    if (input.now.getTime() >= season.end_at.getTime()) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_ENDED',
        'Season has ended.',
      );
    }

    return { seasonId: season.id };
  }

  /**
   * Creates the submitted limit-buy order inside the caller's transaction.
   * One atomic unit: cash reservation, order row, quote consumption, and
   * the idempotent response payload all commit or roll back together.
   *
   * The reservation is taken from the basis pinned on the durable quote —
   * the live Season.tradeFeeRate is deliberately NOT an input here, so a fee
   * rate change between quote and create cannot move the reservation.
   */
  async createSubmittedLimitBuyInTransaction(
    tx: LimitCreateTransactionClient,
    input: {
      quote: {
        id: string;
        limitPrice: Prisma.Decimal;
        quotedFeeRate: Prisma.Decimal | null;
        quotedGrossAmount: Prisma.Decimal | null;
        quotedFeeAmount: Prisma.Decimal | null;
        quotedReservedAmount: Prisma.Decimal | null;
        asset: {
          id: string;
          settlementCurrency: CurrencyCode | null;
          currencyCode: CurrencyCode;
        };
      };
      participant: { id: string };
      quantity: Prisma.Decimal;
      idempotency: { idempotencyKey: string; requestHash: string };
      submittedAt: Date;
    },
  ): Promise<LimitOrderCreateResponse> {
    const currencyCode =
      input.quote.asset.settlementCurrency ?? input.quote.asset.currencyCode;
    const basis = this.requireQuotedReservationBasis({
      quote: input.quote,
      quantity: input.quantity,
    });
    const reservedAmountText = formatDecimalScale(
      basis.quotedReservedAmount,
      monetaryScale,
    );
    const reservationFeeRateText = formatDecimalScale(
      basis.quotedFeeRate,
      feeRateScale,
    );

    // 1) Atomic cash reservation (fails the whole transaction on shortage).
    await this.reservation.reserveForLimitBuy(tx, {
      seasonParticipantId: input.participant.id,
      currencyCode,
      amount: reservedAmountText,
    });

    // 2) Submitted order row. grossAmount/feeAmount/netAmount/executedPrice/
    // executedAt mean ACTUAL EXECUTION RESULT and stay null until a fill
    // exists — phase 1 has no matching engine, so they are null here and for
    // the whole submitted→canceled lifetime. The unfilled order's monetary
    // story lives in reservedAmount + reservationFeeRate (and, for the
    // pre-submit preview, the quote's pinned quoted* amounts).
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
        grossAmount: null,
        feeAmount: null,
        netAmount: null,
        assetPriceSnapshotId: null,
        fxRateSnapshotId: null,
        reservedAmount: reservedAmountText,
        reservationFeeRate: reservationFeeRateText,
        reservationReleasedAt: null,
        cancelReason: null,
        idempotencyKey: input.idempotency.idempotencyKey,
        requestHash: input.idempotency.requestHash,
        submittedAt: input.submittedAt,
        executedAt: null,
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

  /**
   * Reads the reservation basis pinned on the durable quote and refuses the
   * create unless it is complete, non-negative, in range, and self-consistent
   * with the quote's own limitPrice × quantity. There is deliberately NO
   * fallback to the live season fee rate: an unusable basis is a conflict the
   * user resolves by re-quoting, never a silently re-priced reservation.
   */
  private requireQuotedReservationBasis(input: {
    quote: {
      limitPrice: Prisma.Decimal;
      quotedFeeRate: Prisma.Decimal | null;
      quotedGrossAmount: Prisma.Decimal | null;
      quotedFeeAmount: Prisma.Decimal | null;
      quotedReservedAmount: Prisma.Decimal | null;
    };
    quantity: Prisma.Decimal;
  }): QuotedLimitReservationBasis {
    const result = validateQuotedLimitReservationBasis({
      quotedFeeRate: input.quote.quotedFeeRate,
      quotedGrossAmount: input.quote.quotedGrossAmount,
      quotedFeeAmount: input.quote.quotedFeeAmount,
      quotedReservedAmount: input.quote.quotedReservedAmount,
      limitPrice: input.quote.limitPrice,
      quantity: input.quantity,
    });

    if (!result.ok) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.QUOTE_RESERVATION_BASIS_INVALID,
        result.reason,
      );
    }

    return result.basis;
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
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
      status,
    );
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
