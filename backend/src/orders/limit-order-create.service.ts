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
import {
  FIVE_MINUTES_MS,
  LIMIT_ORDER_CANDLE_INTERVAL,
} from './limit-matching/limit-order-candle-eligibility';
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
  triggerEventId: true,
  triggerEventAt: true,
  matchedAt: true,
  matchingSource: true,
  candleEvidence: {
    select: {
      marketCandleId: true,
      interval: true,
      openTime: true,
      closeTime: true,
      triggerLowPrice: true,
      executionPricePolicy: true,
    },
  },
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
    executionPolicy: {
      autoExecutionEnabled: boolean;
      mode: 'live_trade_event' | 'reservation_only';
      triggerType: 'provider_trade_price' | null;
      fullFillOnly: true;
      /** Additive path-B disclosure; see limitOrderExecutionPolicy(). */
      liveTradeMatchingEnabled: boolean;
      candleReconciliationEnabled: boolean;
      candleInterval: '5m' | null;
      candleExecutionPricePolicy: 'limit_price' | null;
    };
  };
};

type LimitCreateTransactionClient = Prisma.TransactionClient;

/**
 * Limit-buy phase 1: quote preview and submitted-order creation with cash
 * reservation. No provider price is read anywhere in this service and no
 * WalletTransaction/Position is written during Create. With path A enabled,
 * only a later live-trade stream event may execute the submitted order.
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
      /** Compatibility for direct callers; OrdersService deliberately omits
       * this and validates with a post-lock clock_timestamp(). */
      now?: Date;
    },
  ): Promise<{
    seasonId: string;
    participantStatus: ParticipantStatus;
    seasonStatus: SeasonStatus;
    seasonStartAt: Date;
    seasonEndAt: Date;
  }> {
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

    const context = {
      seasonId: season.id,
      participantStatus: participant.participant_status,
      seasonStatus: season.status,
      seasonStartAt: season.start_at,
      seasonEndAt: season.end_at,
    };
    if (input.now) this.assertLockedTradableContext(context, input.now);
    return context;
  }

  assertLockedTradableContext(
    context: {
      participantStatus: ParticipantStatus;
      seasonStatus: SeasonStatus;
      seasonStartAt: Date;
      seasonEndAt: Date;
    },
    transactionNow: Date,
  ): void {
    if (context.participantStatus === ParticipantStatus.excluded) {
      this.throwApiError(
        HttpStatus.FORBIDDEN,
        'PARTICIPANT_EXCLUDED',
        'Season participant is excluded from trading.',
      );
    }
    if (context.participantStatus !== ParticipantStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'PARTICIPANT_NOT_ACTIVE',
        'Season participant is not active.',
      );
    }
    if (context.seasonStatus !== SeasonStatus.active) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_ACTIVE',
        'Season is not active.',
      );
    }
    if (transactionNow < context.seasonStartAt) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_NOT_STARTED',
        'Season has not started.',
      );
    }
    if (transactionNow >= context.seasonEndAt) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'SEASON_ENDED',
        'Season has ended.',
      );
    }
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
      matchingActivation?: {
        activatedAt: Date;
        streamId: string;
      } | null;
      /**
       * First fully-elapsed 5m window this order may be filled from (path B).
       * Null keeps the order path-A only — it is never activated against a
       * candle that was already running when it was submitted.
       */
      candleMatchingEligibleFrom?: Date | null;
      autoExecutionEnabled?: boolean;
      candleReconciliationEnabled?: boolean;
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
    // exists, so they are null at submission and remain null unless the path A
    // matcher later fills the order. The unfilled order's monetary story lives
    // in reservedAmount + reservationFeeRate (and, for the pre-submit preview,
    // the quote's pinned quoted* amounts).
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
        matchingActivatedAt: input.matchingActivation?.activatedAt ?? null,
        matchingActivationStreamId: input.matchingActivation?.streamId ?? null,
        candleMatchingEligibleFrom: input.candleMatchingEligibleFrom ?? null,
        idempotencyKey: input.idempotency.idempotencyKey,
        requestHash: input.idempotency.requestHash,
        submittedAt: input.submittedAt,
        executedAt: null,
        createdAt: input.submittedAt,
        updatedAt: input.submittedAt,
      },
      select: { id: true },
    });

    // 2b) Bootstrap the asset's window-completion checkpoint IN THE SAME
    // transaction as the order that makes the asset owe completion. Without
    // this, the asset-scoped health gate would see "submitted path-B order,
    // no checkpoint" (fail-closed) for every create between the first order
    // and the next sweep tick. ON CONFLICT DO NOTHING never moves an existing
    // cursor; a rollback of this create rolls the checkpoint back with it;
    // concurrent creates are serialized by the unique (asset_id, interval)
    // key. The anchor mirrors the supervisor's bootstrap: everything before
    // the order's first eligible window is vacuously complete.
    if (input.candleMatchingEligibleFrom) {
      const anchor = new Date(
        Math.floor(
          input.candleMatchingEligibleFrom.getTime() / FIVE_MINUTES_MS,
        ) * FIVE_MINUTES_MS,
      );
      await tx.$executeRaw`
        INSERT INTO "market_candle_finalization_checkpoints" (
          "asset_id", "interval",
          "finalized_through_open_time", "finalized_through_close_time",
          "created_at", "updated_at"
        ) VALUES (
          ${input.quote.asset.id},
          ${LIMIT_ORDER_CANDLE_INTERVAL},
          ${new Date(anchor.getTime() - FIVE_MINUTES_MS)},
          ${anchor},
          ${input.submittedAt},
          ${input.submittedAt}
        )
        ON CONFLICT ("asset_id", "interval") DO NOTHING
      `;
    }

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
        executionPolicy: {
          autoExecutionEnabled: input.autoExecutionEnabled === true,
          mode:
            input.autoExecutionEnabled === true
              ? 'live_trade_event'
              : 'reservation_only',
          triggerType:
            input.autoExecutionEnabled === true ? 'provider_trade_price' : null,
          fullFillOnly: true,
          liveTradeMatchingEnabled: input.autoExecutionEnabled === true,
          candleReconciliationEnabled:
            input.candleReconciliationEnabled === true,
          candleInterval:
            input.candleReconciliationEnabled === true ? '5m' : null,
          candleExecutionPricePolicy:
            input.candleReconciliationEnabled === true ? 'limit_price' : null,
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
