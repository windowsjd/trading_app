import { HttpException, Injectable } from '@nestjs/common';
import {
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
import { PrismaService } from '../prisma/prisma.service';
import { formatDecimalScale, monetaryScale } from '../fx/fx-decimal-policy';
import { settleLimitBuyReservedCash } from '../wallets/cash-wallet-atomic';
import {
  resolveFxProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
import {
  limitOrderErrorCodes,
  limitOrderErrorHttpStatus,
  type LimitOrderErrorCode,
} from './limit-order-error-policy';
import {
  calculateBuyPositionAverageCost,
  calculateLimitFillAmounts,
  isFillWithinReservation,
} from './limit-order-execution-policy';
import {
  LimitOrderCandleEvidenceService,
  type EligibleClosedCandle,
} from './limit-order-candle-evidence.service';
import { OrdersService } from './orders.service';

const ZERO_MONEY = '0.00000000';

/**
 * The price basis a fill commits against, chosen by the matching service:
 * - `snapshot` (path A): fill at the fresh provider snapshot price.
 * - `candle` (path B): fill at the ORDER's limitPrice, with the closed 5m
 *   candle as touch evidence.
 */
export type LimitFillPlan =
  | {
      path: 'snapshot';
      executedPrice: Prisma.Decimal;
      assetPriceSnapshotId: string;
    }
  | {
      path: 'candle';
      executedPrice: Prisma.Decimal;
      candle: EligibleClosedCandle;
    };

export type LimitFillOutcome =
  | {
      state: 'filled';
      orderId: string;
      seasonId: string;
      seasonParticipantId: string;
      path: 'snapshot' | 'candle';
      executedPrice: string;
      netAmount: string;
    }
  | {
      /** The order was no longer fillable when locked (raced by cancel /
       * cleanup / a prior fill), or a USD fill lacked fresh FX evidence.
       * Not an error — the matcher simply moves on. */
      state: 'skipped';
      orderId: string;
      reason: string;
    };

type ExecTx = Prisma.TransactionClient;

const EXEC_ORDER_SELECT = {
  id: true,
  seasonParticipantId: true,
  assetId: true,
  side: true,
  orderType: true,
  status: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  reservedAmount: true,
  reservationFeeRate: true,
  asset: { select: { id: true, isActive: true } },
  seasonParticipant: {
    select: {
      participantStatus: true,
      tradingAccountId: true,
      season: {
        select: { id: true, status: true, startAt: true, endAt: true },
      },
    },
  },
} as const;

/**
 * Executes ONE limit-buy fill in its own transaction. Lock order is always
 * Order (FOR UPDATE) → CashWallet (guarded settle) → Position → WalletTransaction
 * — identical to the user-cancel / cleanup paths, so a fill and a cancel that
 * race the same order serialize on the order row and exactly one wins. Every
 * authorization fact is re-verified against the LOCKED rows; the matcher's
 * pre-checks are only there to avoid opening a transaction that would no-op.
 */
@Injectable()
export class LimitOrderExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candleEvidence: LimitOrderCandleEvidenceService,
    private readonly ordersService: OrdersService,
  ) {}

  async fillLimitBuyOrder(input: {
    orderId: string;
    now: Date;
    plan: LimitFillPlan;
  }): Promise<LimitFillOutcome> {
    const { orderId, now, plan } = input;
    return this.prisma.$transaction(async (tx) => {
      // 1) Lock the order row first (Order → CashWallet → Position order).
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
      `;
      if (locked.length !== 1) {
        return { state: 'skipped', orderId, reason: 'order_not_found' };
      }

      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: EXEC_ORDER_SELECT,
      });
      if (!order) {
        return { state: 'skipped', orderId, reason: 'order_not_found' };
      }

      // 2) Re-validate the order shape against the locked row. A concurrent
      // cancel/cleanup that already flipped it out of `submitted` lands here.
      if (
        order.status !== OrderStatus.submitted ||
        order.side !== OrderSide.buy ||
        order.orderType !== OrderType.limit
      ) {
        return { state: 'skipped', orderId, reason: 'not_submitted_limit_buy' };
      }
      if (
        !order.limitPrice ||
        !order.reservedAmount ||
        !order.reservationFeeRate
      ) {
        // A submitted limit buy must carry its reservation basis; a missing one
        // is an invariant breach, never a silent fill.
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Submitted limit order is missing its reservation basis.',
        );
      }

      // 3) Re-validate season / participant / asset (§17: no fill at/after endAt).
      const season = order.seasonParticipant.season;
      if (
        season.status !== SeasonStatus.active ||
        now < season.startAt ||
        now >= season.endAt
      ) {
        return { state: 'skipped', orderId, reason: 'season_not_active' };
      }
      if (
        order.seasonParticipant.participantStatus !== ParticipantStatus.active
      ) {
        return { state: 'skipped', orderId, reason: 'participant_not_active' };
      }
      if (!order.asset.isActive) {
        return { state: 'skipped', orderId, reason: 'asset_inactive' };
      }

      // 4) Re-verify the price basis reaches the limit (§19 step 12).
      if (plan.executedPrice.gt(order.limitPrice)) {
        return { state: 'skipped', orderId, reason: 'price_above_limit' };
      }

      // 5) Actual amounts from the ACTUAL execution price and the PINNED fee
      // rate (never the live season rate).
      const amounts = calculateLimitFillAmounts({
        executedPrice: plan.executedPrice,
        quantity: order.quantity,
        reservationFeeRate: order.reservationFeeRate,
      });
      if (!isFillWithinReservation(amounts.netAmount, order.reservedAmount)) {
        // Cannot happen while price <= limit and the fee rate is the pinned
        // one — but if it ever does, refuse rather than silently overspend.
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Actual fill amount exceeds the order reservation.',
        );
      }

      // 6) USD-settled fills attach fill-time FX evidence; without a fresh
      // provider USD/KRW snapshot the fill defers to a later cycle (an
      // automatic fill has no user to requote, so it cannot proceed on stale
      // FX). KRW-settled assets need no FX.
      let fxRateSnapshotId: string | null = null;
      if (order.currencyCode === CurrencyCode.USD) {
        fxRateSnapshotId = await this.resolveFxEvidenceSnapshotId(tx, now);
        if (!fxRateSnapshotId) {
          return {
            state: 'skipped',
            orderId,
            reason: 'fx_evidence_unavailable',
          };
        }
      }

      const netAmountText = formatDecimalScale(
        amounts.netAmount,
        monetaryScale,
      );
      const reservedAmountText = formatDecimalScale(
        order.reservedAmount,
        monetaryScale,
      );

      // 7) Settle wallet: debit the actual net, release the whole reservation,
      // in one guarded statement (balance still covers all other reservations).
      const wallet = await tx.cashWallet.findUnique({
        where: {
          seasonParticipantId_currencyCode: {
            seasonParticipantId: order.seasonParticipantId,
            currencyCode: order.currencyCode,
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
      const settled = await settleLimitBuyReservedCash(tx, {
        walletId: wallet.id,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        actualDebit: netAmountText,
        orderReservation: reservedAmountText,
      });
      if (settled !== 1) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Wallet settlement guard failed for the limit fill.',
        );
      }

      // 8) Evidence link. Path A → snapshot; path B → shared candle evidence.
      let assetPriceSnapshotId: string | null = null;
      let limitOrderCandleEvidenceId: string | null = null;
      if (plan.path === 'snapshot') {
        assetPriceSnapshotId = plan.assetPriceSnapshotId;
      } else {
        limitOrderCandleEvidenceId =
          await this.candleEvidence.findOrCreateEvidenceInTransaction(
            tx,
            plan.candle,
            order.assetId,
          );
      }

      // 9) Position (same average-cost policy as market buy).
      await this.upsertBuyPosition(tx, {
        seasonParticipantId: order.seasonParticipantId,
        assetId: order.assetId,
        currencyCode: order.currencyCode,
        quantity: order.quantity,
        netAmount: amounts.netAmount,
      });

      // 10) Ledger row + order finalization.
      const walletAfter = await tx.cashWallet.findUniqueOrThrow({
        where: { id: wallet.id },
        select: { balanceAmount: true },
      });
      // Transitional dual-write: a fill must never create a ledger row for a
      // participant whose account link is missing (deploy-boundary state
      // that trading-accounts:repair-links has to fix first).
      if (!order.seasonParticipant.tradingAccountId) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
          'Participant has no trading account link; run trading-accounts:repair-links.',
        );
      }

      await tx.walletTransaction.create({
        data: {
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId: order.seasonParticipant.tradingAccountId,
          walletId: wallet.id,
          currencyCode: order.currencyCode,
          direction: WalletTransactionDirection.debit,
          txType: WalletTransactionType.order_buy,
          referenceType: WalletTransactionReferenceType.order,
          referenceId: order.id,
          amount: netAmountText,
          balanceAfter: formatDecimalScale(
            walletAfter.balanceAmount,
            monetaryScale,
          ),
          occurredAt: now,
        },
        select: { id: true },
      });

      const executedPriceText = formatDecimalScale(
        plan.executedPrice,
        monetaryScale,
      );
      const flipped = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.submitted },
        data: {
          status: OrderStatus.executed,
          executedPrice: executedPriceText,
          grossAmount: formatDecimalScale(amounts.grossAmount, monetaryScale),
          feeAmount: formatDecimalScale(amounts.feeAmount, monetaryScale),
          netAmount: netAmountText,
          assetPriceSnapshotId,
          fxRateSnapshotId,
          limitOrderCandleEvidenceId,
          executedAt: now,
          reservationReleasedAt: now,
        },
      });
      if (flipped.count !== 1) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.LIMIT_ORDER_EXECUTION_CONFLICT,
          'Order state changed while filling.',
        );
      }

      // 11) Equity snapshot — reuse the market path's exact valuation so a
      // limit fill and a market fill leave identical portfolio state.
      await this.ordersService.recordOrderExecutedPortfolioSnapshotInTransaction(
        tx,
        order.seasonParticipantId,
        now,
      );

      return {
        state: 'filled',
        orderId: order.id,
        seasonId: season.id,
        seasonParticipantId: order.seasonParticipantId,
        path: plan.path,
        executedPrice: executedPriceText,
        netAmount: netAmountText,
      };
    });
  }

  private async upsertBuyPosition(
    tx: ExecTx,
    input: {
      seasonParticipantId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
    },
  ): Promise<string> {
    const existing = await tx.position.findUnique({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: input.seasonParticipantId,
          assetId: input.assetId,
        },
      },
      select: { id: true, quantity: true, averageCost: true },
    });

    const { newQuantity, newAverageCost } = calculateBuyPositionAverageCost({
      netAmount: input.netAmount,
      quantity: input.quantity,
      existing,
    });

    if (!existing) {
      const created = await tx.position.create({
        data: {
          seasonParticipantId: input.seasonParticipantId,
          assetId: input.assetId,
          quantity: formatDecimalScale(newQuantity, monetaryScale),
          averageCost: formatDecimalScale(newAverageCost, monetaryScale),
          currencyCode: input.currencyCode,
          realizedPnl: ZERO_MONEY,
          realizedPnlKrw: ZERO_MONEY,
        },
        select: { id: true },
      });
      return created.id;
    }

    // Optimistic guard on the prior (quantity, averageCost): a concurrent
    // position write loses and the fill fails closed rather than double-adding.
    const updated = await tx.position.updateMany({
      where: {
        id: existing.id,
        quantity: existing.quantity,
        averageCost: existing.averageCost,
      },
      data: {
        quantity: formatDecimalScale(newQuantity, monetaryScale),
        averageCost: formatDecimalScale(newAverageCost, monetaryScale),
      },
    });
    if (updated.count !== 1) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.LIMIT_ORDER_EXECUTION_CONFLICT,
        'Position changed while filling.',
      );
    }
    return existing.id;
  }

  /**
   * Latest fresh provider USD/KRW snapshot id for fill-time FX evidence, or
   * null. No requote-bps guard: an automatic fill has no user quote to compare
   * against. Uses the same provider eligibility + freshness the order execute
   * path uses.
   */
  private async resolveFxEvidenceSnapshotId(
    tx: ExecTx,
    now: Date,
  ): Promise<string | null> {
    const eligibility = resolveFxProviderEligibility({
      workflow: 'orders_execute',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    if (!eligibility.eligible) return null;

    const candidates = await tx.fxRateSnapshot.findMany({
      where: {
        baseCurrency: CurrencyCode.USD,
        quoteCurrency: CurrencyCode.KRW,
        sourceType: FxRateSourceType.provider_api,
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 10,
      select: {
        id: true,
        rate: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    const selection = selectFreshProviderSnapshotBySourcePriority({
      candidates,
      expectedSourceNames: eligibility.sourceNames,
      now,
      freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => candidate.rate.gt(0),
    });
    return selection.state === 'selected' ? selection.snapshot.id : null;
  }

  private throwLimitOrderError(
    code: LimitOrderErrorCode,
    message: string,
  ): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      limitOrderErrorHttpStatus[code],
    );
  }
}
