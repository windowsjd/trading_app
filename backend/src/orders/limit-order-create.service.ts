import { setAdminDiagnosticContext } from '../common/admin-diagnostics';
import {
  diagnosePositionMutationFailure,
  positionAvailabilityEvidence,
} from './position-failure-diagnosis';
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
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { PrismaService } from '../prisma/prisma.service';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
import {
  limitOrderErrorCodes,
  limitOrderErrorHttpStatus,
  type LimitOrderErrorCode,
} from './limit-order-error-policy';
import {
  calculateAvailableAmount,
  calculateLimitBuyReservation,
  calculateLimitSellQuote,
  validateQuotedLimitReservationBasis,
  type QuotedLimitReservationBasis,
} from './limit-order-policy';
import { reserveAvailablePositionQuantity } from './position-reservation-atomic';
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
      /** A limit order is never executed at create time. */
      state: 'submitted';
      submittedAt: string;
      quoteId: string | null;
      reservedAmount: string | null;
      reservedQuantity: string | null;
      reservationFeeRate: string | null;
      duplicate: boolean;
    };
    /**
     * Server-authoritative execution policy. When automatic matching is on it
     * reports the scheduler matcher (path A snapshot / path B closed-candle
     * touch, filled at the limit price); when off, reservation_only. Clients
     * read this rather than a client flag.
     */
    executionPolicy: LimitOrderExecutionPolicy;
  };
};

export type LimitOrderExecutionPolicy = {
  autoExecutionEnabled: boolean;
  mode: 'scheduler_snapshot_candle' | 'reservation_only';
  triggerType: 'provider_snapshot_or_closed_candle' | null;
  fullFillOnly: true;
  candleInterval: '5m' | null;
  candleExecutionPricePolicy: 'limit_price' | null;
};

export type LimitSellQuotePreview = {
  quotedFeeRate: Prisma.Decimal;
  grossAmount: Prisma.Decimal;
  feeAmount: Prisma.Decimal;
  netAmount: Prisma.Decimal;
  walletBalanceBefore: Prisma.Decimal;
  positionQuantityBefore: Prisma.Decimal;
  positionReservedBefore: Prisma.Decimal;
  positionAvailableBefore: Prisma.Decimal;
  estimatedPositionReservedAfter: Prisma.Decimal;
  estimatedPositionAvailableAfter: Prisma.Decimal;
  estimatedPositionQuantityAfter: Prisma.Decimal;
};

export function buildLimitOrderExecutionPolicy(input: {
  autoExecutionEnabled: boolean;
}): LimitOrderExecutionPolicy {
  const { autoExecutionEnabled } = input;
  return {
    autoExecutionEnabled,
    mode: autoExecutionEnabled
      ? 'scheduler_snapshot_candle'
      : 'reservation_only',
    triggerType: autoExecutionEnabled
      ? 'provider_snapshot_or_closed_candle'
      : null,
    fullFillOnly: true,
    candleInterval: autoExecutionEnabled ? '5m' : null,
    candleExecutionPricePolicy: autoExecutionEnabled ? 'limit_price' : null,
  };
}

type LimitCreateTransactionClient = Prisma.TransactionClient;

/**
 * Limit-order quote preview and submitted-order creation with reservation.
 * No provider price is read anywhere in this service and no
 * WalletTransaction is written during Create. Buy orders reserve wallet cash;
 * sell orders reserve position quantity. Registration completes against
 * PostgreSQL alone and the shared scheduler matcher performs later fills.
 */
@Injectable()
export class LimitOrderCreateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservation: OrderReservationService,
  ) {}

  /**
   * Read-only wallet/position preview for a limit-order quote. Buy rejects
   * when available wallet cash cannot cover the reservation; sell rejects
   * when available position quantity cannot cover it. Never mutates anything.
   */
  async buildLimitBuyQuotePreview(input: {
    /** VERIFIED trading account id. */
    tradingAccountId: string;
    assetId: string;
    currencyCode: CurrencyCode;
    limitPrice: Prisma.Decimal;
    quantity: Prisma.Decimal;
    tradeFeeRate: Prisma.Decimal;
  }): Promise<LimitBuyQuotePreview> {
    setAdminDiagnosticContext({
      failureStage: 'quote_cash_availability',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_quote',
          guardName: 'available_cash',
        },
      },
    });
    const amounts = calculateLimitBuyReservation({
      limitPrice: input.limitPrice,
      quantity: input.quantity,
      tradeFeeRate: input.tradeFeeRate,
    });

    const [wallet, position] = await Promise.all([
      this.prisma.cashWallet.findUnique({
        where: {
          tradingAccountId_currencyCode: {
            tradingAccountId: input.tradingAccountId,
            currencyCode: input.currencyCode,
          },
        },
        select: {
          id: true,
          tradingAccountId: true,
          balanceAmount: true,
          reservedAmount: true,
        },
      }),
      this.prisma.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: input.tradingAccountId,
            assetId: input.assetId,
          },
        },
        select: {
          id: true,
          tradingAccountId: true,
          quantity: true,
        },
      }),
    ]);

    // Scope before balance: a wallet without (or with a foreign) account
    // scope must never back an available-balance preview.
    if (wallet) {
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId: input.tradingAccountId,
      });
    }

    const walletBalanceBefore = wallet?.balanceAmount ?? new Prisma.Decimal(0);
    const walletReservedBefore =
      wallet?.reservedAmount ?? new Prisma.Decimal(0);
    const walletAvailableBefore = calculateAvailableAmount(
      walletBalanceBefore,
      walletReservedBefore,
    );

    if (!wallet || walletAvailableBefore.lt(amounts.reservedAmount)) {
      setAdminDiagnosticContext({
        failureStage: 'quote_cash_availability',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_buy_quote',
            guardName: 'available_cash',
            walletFound: !!wallet,
            scopeValid: wallet ? true : undefined,
            failureReason: wallet
              ? 'insufficient_available'
              : 'wallet_not_found',
            availableSufficient: wallet ? false : undefined,
            balanceSufficient: wallet
              ? walletBalanceBefore.gte(amounts.reservedAmount)
              : undefined,
            reservedCashPresent: wallet
              ? walletReservedBefore.gt(0)
              : undefined,
          },
        },
      });

      this.throwLimitOrderError(
        limitOrderErrorCodes.INSUFFICIENT_AVAILABLE_BALANCE,
        'Available cash balance is insufficient for the limit order reservation.',
      );
    }

    const positionQuantityBefore = position?.quantity ?? new Prisma.Decimal(0);
    if (position && position.tradingAccountId !== input.tradingAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'quote_position_scope',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_buy_quote',
            guardName: 'position_scope',
            positionFound: true,
            scopeValid: false,
            failureReason: 'account_scope_mismatch',
          },
        },
      });
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position scope does not match the limit-order trading account.',
      );
    }

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

  async buildLimitSellQuotePreview(input: {
    tradingAccountId: string;
    assetId: string;
    currencyCode: CurrencyCode;
    limitPrice: Prisma.Decimal;
    quantity: Prisma.Decimal;
    tradeFeeRate: Prisma.Decimal;
  }): Promise<LimitSellQuotePreview> {
    setAdminDiagnosticContext({
      failureStage: 'quote_position_availability',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_quote',
          guardName: 'available_position_quantity',
        },
      },
    });
    const amounts = calculateLimitSellQuote({
      limitPrice: input.limitPrice,
      quantity: input.quantity,
      tradeFeeRate: input.tradeFeeRate,
    });
    const [wallet, position] = await Promise.all([
      this.prisma.cashWallet.findUnique({
        where: {
          tradingAccountId_currencyCode: {
            tradingAccountId: input.tradingAccountId,
            currencyCode: input.currencyCode,
          },
        },
        select: {
          id: true,
          tradingAccountId: true,
          balanceAmount: true,
        },
      }),
      this.prisma.position.findUnique({
        where: {
          tradingAccountId_assetId: {
            tradingAccountId: input.tradingAccountId,
            assetId: input.assetId,
          },
        },
        select: {
          tradingAccountId: true,
          quantity: true,
          reservedQuantity: true,
        },
      }),
    ]);
    if (wallet) {
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId: input.tradingAccountId,
      });
    }
    if (position && position.tradingAccountId !== input.tradingAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'quote_position_scope',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_quote',
            guardName: 'position_scope',
            positionFound: true,
            scopeValid: false,
            failureReason: 'account_scope_mismatch',
          },
        },
      });
      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position scope does not match the limit-order trading account.',
      );
    }
    const reservedQuantity =
      position?.reservedQuantity ?? new Prisma.Decimal(0);
    const available = position
      ? position.quantity.sub(reservedQuantity)
      : new Prisma.Decimal(0);
    if (!position || available.lt(input.quantity)) {
      setAdminDiagnosticContext({
        failureStage: 'quote_position_availability',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_quote',
            guardName: 'available_position_quantity',
            scopeValid: position ? true : undefined,
            ...positionAvailabilityEvidence(position, input.quantity),
          },
        },
      });

      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Available position quantity is insufficient.',
      );
    }
    return {
      ...amounts,
      quotedFeeRate: input.tradeFeeRate,
      walletBalanceBefore: wallet?.balanceAmount ?? new Prisma.Decimal(0),
      positionQuantityBefore: position.quantity,
      positionReservedBefore: reservedQuantity,
      positionAvailableBefore: available,
      estimatedPositionReservedAfter: reservedQuantity.add(input.quantity),
      estimatedPositionAvailableAfter: available.sub(input.quantity),
      estimatedPositionQuantityAfter: position.quantity.sub(input.quantity),
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

  /** Shared lifecycle authorization; see season-trading-lock for writer order. */
  async lockTradableContextInTransaction(
    tx: LimitCreateTransactionClient,
    input: { userId: string; seasonParticipantId: string; now?: Date },
  ) {
    const { season, participant, account } = await lockSeasonTradingContext(
      tx,
      { ...input, participantWrite: false },
    );
    const context = {
      seasonId: season.id,
      participantStatus: participant.participantStatus,
      seasonStatus: season.status,
      seasonStartAt: season.startAt,
      seasonEndAt: season.endAt,
      tradingAccountId: account.id,
      accountStatus: account.status,
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
      accountStatus?: string;
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
    if (
      context.accountStatus !== undefined &&
      context.accountStatus !== 'active'
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TRADING_ACCOUNT_NOT_ACTIVE',
        'Trading account is not active',
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
   * Creates the submitted limit order inside the caller's transaction. One
   * atomic unit: cash/quantity reservation, order row, quote consumption, and
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
      /** VERIFIED trading account id. */
      tradingAccountId: string;
      quantity: Prisma.Decimal;
      idempotency: { idempotencyKey: string; requestHash: string };
      submittedAt: Date;
      /** Whether the scheduler matcher will auto-fill this order; drives the
       * additive executionPolicy on the response. Defaults to false. */
      autoExecutionEnabled?: boolean;
    },
  ): Promise<LimitOrderCreateResponse> {
    setAdminDiagnosticContext({
      failureStage: 'quote_reservation_basis',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_reservation',
          guardName: 'quote_reservation_basis',
        },
      },
    });
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

    // 1) Atomic cash reservation (fails the whole transaction on shortage;
    // the wallet's scope is verified and rides in the UPDATE's WHERE, so a
    // foreign/unscoped wallet can never be reserved against).
    await this.reservation.reserveForLimitBuy(tx, {
      tradingAccountId: input.tradingAccountId,
      currencyCode,
      amount: reservedAmountText,
    });

    // 2) Submitted order row. grossAmount/feeAmount/netAmount/executedPrice/
    // executedAt mean ACTUAL EXECUTION RESULT and stay null until a fill
    // exists. The unfilled order's monetary story lives
    // in reservedAmount + reservationFeeRate (and, for the pre-submit preview,
    // the quote's pinned quoted* amounts).
    setAdminDiagnosticContext({
      failureStage: 'order_create',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_reservation',
          guardName: 'order_create',
        },
      },
    });
    const created = await tx.order.create({
      data: {
        tradingAccountId: input.tradingAccountId,
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

    // 3) Consume the quote inside the same transaction and account scope.
    setAdminDiagnosticContext({
      failureStage: 'quote_consume',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_reservation',
          guardName: 'active_quote_in_account',
        },
      },
    });
    const consumeCount = (
      await tx.quote.updateMany({
        where: {
          id: input.quote.id,
          status: QuoteStatus.active,
          tradingAccountId: input.tradingAccountId,
        },
        data: {
          status: QuoteStatus.consumed,
          consumedAt: input.submittedAt,
        },
      })
    ).count;

    if (consumeCount !== 1) {
      setAdminDiagnosticContext({
        failureStage: 'quote_consume',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_buy_reservation',
            guardName: 'active_quote_in_account',
            mutationAffected: consumeCount,
            mutationResult: 'rejected',
            failureReason: 'quote_consume_guard_rejected',
          },
        },
      });

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

    setAdminDiagnosticContext({
      failureStage: 'order_read_back',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_reservation',
          guardName: 'order_read_back',
        },
      },
    });
    const order = await tx.order.findUnique({
      where: { id: created.id },
      select: LIMIT_ORDER_PAYLOAD_SELECT,
    });

    if (!order) {
      setAdminDiagnosticContext({
        failureStage: 'order_read_back',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_buy_reservation',
            guardName: 'order_read_back',
            failureReason: 'order_read_back_failed',
          },
        },
      });

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
          reservedQuantity: null,
          reservationFeeRate: reservationFeeRateText,
          duplicate: false,
        },
        executionPolicy: buildLimitOrderExecutionPolicy({
          autoExecutionEnabled: input.autoExecutionEnabled === true,
        }),
      },
    };

    // 4) Persist the payload for idempotent replays of the same request.
    setAdminDiagnosticContext({
      failureStage: 'order_replay_payload_write',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_buy_reservation',
          guardName: 'order_replay_payload',
        },
      },
    });
    await tx.order.update({
      where: { id: created.id },
      data: {
        responsePayloadJson: response as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    return response;
  }

  /** Submitted limit sell: reserve position quantity, consume quote, persist replay. */
  async createSubmittedLimitSellInTransaction(
    tx: LimitCreateTransactionClient,
    input: {
      quote: {
        id: string;
        limitPrice: Prisma.Decimal;
        quotedFeeRate: Prisma.Decimal | null;
        quotedGrossAmount: Prisma.Decimal | null;
        quotedFeeAmount: Prisma.Decimal | null;
        quotedNetAmount: Prisma.Decimal | null;
        asset: {
          id: string;
          settlementCurrency: CurrencyCode | null;
          currencyCode: CurrencyCode;
        };
      };
      tradingAccountId: string;
      quantity: Prisma.Decimal;
      idempotency: { idempotencyKey: string; requestHash: string };
      submittedAt: Date;
      autoExecutionEnabled?: boolean;
    },
  ): Promise<LimitOrderCreateResponse> {
    setAdminDiagnosticContext({
      failureStage: 'quote_reservation_basis',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'quote_fee_basis',
        },
      },
    });
    const currencyCode =
      input.quote.asset.settlementCurrency ?? input.quote.asset.currencyCode;
    if (
      !input.quote.quotedFeeRate ||
      !input.quote.quotedGrossAmount ||
      !input.quote.quotedFeeAmount ||
      !input.quote.quotedNetAmount
    ) {
      setAdminDiagnosticContext({
        failureStage: 'quote_reservation_basis',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'quote_fee_basis',
            failureReason: 'missing_fee_basis',
            feeRatePresent: !!input.quote.quotedFeeRate,
            grossPresent: !!input.quote.quotedGrossAmount,
            feePresent: !!input.quote.quotedFeeAmount,
            netPresent: !!input.quote.quotedNetAmount,
          },
        },
      });
      this.throwLimitOrderError(
        limitOrderErrorCodes.QUOTE_RESERVATION_BASIS_INVALID,
        'Limit sell quote is missing its pinned fee basis.',
      );
    }
    const recomputed = calculateLimitSellQuote({
      limitPrice: input.quote.limitPrice,
      quantity: input.quantity,
      tradeFeeRate: input.quote.quotedFeeRate,
    });
    if (
      input.quote.quotedFeeRate.lt(0) ||
      input.quote.quotedFeeRate.gt(1) ||
      !recomputed.grossAmount.eq(input.quote.quotedGrossAmount) ||
      !recomputed.feeAmount.eq(input.quote.quotedFeeAmount) ||
      !recomputed.netAmount.eq(input.quote.quotedNetAmount)
    ) {
      setAdminDiagnosticContext({
        failureStage: 'quote_reservation_basis',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'quote_fee_basis',
            failureReason: 'fee_basis_inconsistent',
            feeRateInRange:
              !input.quote.quotedFeeRate.lt(0) &&
              !input.quote.quotedFeeRate.gt(1),
            grossMatched: recomputed.grossAmount.eq(
              input.quote.quotedGrossAmount,
            ),
            feeMatched: recomputed.feeAmount.eq(input.quote.quotedFeeAmount),
            netMatched: recomputed.netAmount.eq(input.quote.quotedNetAmount),
          },
        },
      });
      this.throwLimitOrderError(
        limitOrderErrorCodes.QUOTE_RESERVATION_BASIS_INVALID,
        'Limit sell quote fee basis is inconsistent.',
      );
    }

    setAdminDiagnosticContext({
      failureStage: 'position_reservation_lookup',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'position_scope',
        },
      },
    });
    const position = await tx.position.findUnique({
      where: {
        tradingAccountId_assetId: {
          tradingAccountId: input.tradingAccountId,
          assetId: input.quote.asset.id,
        },
      },
      select: {
        id: true,
        tradingAccountId: true,
        currencyCode: true,
      },
    });
    if (!position || position.currencyCode !== currencyCode) {
      setAdminDiagnosticContext({
        failureStage: 'position_reservation_lookup',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'position_scope',
            positionFound: !!position,
            currencyMatched: position ? false : undefined,
            failureReason: position
              ? 'currency_mismatch'
              : 'position_not_found',
          },
        },
      });

      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Position for the limit sell was not found.',
      );
    }
    if (position.tradingAccountId !== input.tradingAccountId) {
      setAdminDiagnosticContext({
        failureStage: 'position_reservation_scope',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'position_scope',
            positionFound: true,
            scopeValid: false,
            failureReason:
              position.tradingAccountId == null
                ? 'null_scope'
                : 'account_scope_mismatch',
          },
        },
      });

      this.throwApiError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position scope does not match the limit sell account.',
      );
    }
    const quantityText = formatDecimalScale(input.quantity, orderQuantityScale);
    setAdminDiagnosticContext({
      failureStage: 'position_reservation',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'available_position_quantity',
          positionFound: true,
          scopeValid: true,
          currencyMatched: true,
        },
      },
    });
    const reserved = await reserveAvailablePositionQuantity(tx, {
      positionId: position.id,
      tradingAccountId: input.tradingAccountId,
      assetId: input.quote.asset.id,
      quantity: quantityText,
    });
    if (reserved !== 1) {
      await diagnosePositionMutationFailure(tx, {
        positionId: position.id,
        tradingAccountId: input.tradingAccountId,
        assetId: input.quote.asset.id,
        currencyCode,
        quantity: input.quantity,
        guard: 'available_position_quantity',
        financialOperation: 'limit_sell_reservation',
        failureStage: 'position_reservation',
        mutationAffected: reserved,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_QUANTITY',
        'Available position quantity is insufficient.',
      );
    }

    const feeRateText = formatDecimalScale(
      input.quote.quotedFeeRate,
      feeRateScale,
    );
    setAdminDiagnosticContext({
      failureStage: 'order_create',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'order_create',
        },
      },
    });
    const created = await tx.order.create({
      data: {
        tradingAccountId: input.tradingAccountId,
        assetId: input.quote.asset.id,
        quoteId: input.quote.id,
        side: OrderSide.sell,
        orderType: OrderType.limit,
        status: OrderStatus.submitted,
        quantity: quantityText,
        limitPrice: formatDecimalScale(input.quote.limitPrice, monetaryScale),
        executedPrice: null,
        currencyCode,
        grossAmount: null,
        feeAmount: null,
        netAmount: null,
        reservedAmount: null,
        reservedQuantity: quantityText,
        reservationFeeRate: feeRateText,
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
    setAdminDiagnosticContext({
      failureStage: 'quote_consume',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'active_quote_in_account',
        },
      },
    });
    const consumedCount = (
      await tx.quote.updateMany({
        where: {
          id: input.quote.id,
          status: QuoteStatus.active,
          tradingAccountId: input.tradingAccountId,
        },
        data: {
          status: QuoteStatus.consumed,
          consumedAt: input.submittedAt,
        },
      })
    ).count;
    if (consumedCount !== 1) {
      setAdminDiagnosticContext({
        failureStage: 'quote_consume',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'active_quote_in_account',
            mutationAffected: consumedCount,
            mutationResult: 'rejected',
            failureReason: 'quote_consume_guard_rejected',
          },
        },
      });

      this.throwApiError(
        HttpStatus.CONFLICT,
        'QUOTE_NOT_ACTIVE',
        'Quote is not active.',
      );
    }
    setAdminDiagnosticContext({
      failureStage: 'order_read_back',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'order_read_back',
        },
      },
    });
    const order = await tx.order.findUnique({
      where: { id: created.id },
      select: LIMIT_ORDER_PAYLOAD_SELECT,
    });
    if (!order) {
      setAdminDiagnosticContext({
        failureStage: 'order_read_back',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_sell_reservation',
            guardName: 'order_read_back',
            failureReason: 'order_read_back_failed',
          },
        },
      });

      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT,
        'Created limit sell could not be read back.',
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
          reservedAmount: null,
          reservedQuantity: quantityText,
          reservationFeeRate: feeRateText,
          duplicate: false,
        },
        executionPolicy: buildLimitOrderExecutionPolicy({
          autoExecutionEnabled: input.autoExecutionEnabled === true,
        }),
      },
    };
    setAdminDiagnosticContext({
      failureStage: 'order_replay_payload_write',
      evidence: {
        financialGuard: {
          financialOperation: 'limit_sell_reservation',
          guardName: 'order_replay_payload',
        },
      },
    });
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
      setAdminDiagnosticContext({
        failureStage: 'quote_reservation_basis',
        evidence: {
          financialGuard: {
            financialOperation: 'limit_buy_reservation',
            guardName: 'quote_reservation_basis',
            failureReason: result.reason,
            predicates: result.predicates,
          },
        },
      });

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
