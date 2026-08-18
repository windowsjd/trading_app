import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  CurrencyCode,
  FxRateSourceType,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import {
  formatDecimalScale,
  monetaryScale,
  roundDecimalHalfUp,
} from '../fx/fx-decimal-policy';
import { settleLimitBuyReservedCash } from '../wallets/cash-wallet-atomic';
import { diagnoseCashWalletMutationFailure } from '../wallets/cash-wallet-failure-diagnosis';
import { assertCashWalletTradingAccountScope } from '../wallets/cash-wallet-scope';
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
  calculateLimitSellFillAmounts,
  isFillWithinReservation,
} from './limit-order-execution-policy';
import { settleReservedPositionQuantity } from './position-reservation-atomic';
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
      seasonId: string | null;
      seasonParticipantId: string | null;
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
  tradingAccountId: true,
  assetId: true,
  side: true,
  orderType: true,
  status: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  reservedAmount: true,
  reservedQuantity: true,
  reservationFeeRate: true,
  asset: { select: { id: true, isActive: true } },
  quote: {
    select: {
      id: true,
      seasonParticipantId: true,
      tradingAccountId: true,
    },
  },
  seasonParticipant: {
    select: {
      id: true,
      participantStatus: true,
      tradingAccountId: true,
      tradingAccount: {
        select: { id: true, mode: true, status: true },
      },
      season: {
        select: { id: true, status: true, startAt: true, endAt: true },
      },
    },
  },
  tradingAccount: {
    select: {
      id: true,
      mode: true,
      status: true,
      initialCapitalKrw: true,
      seasonParticipant: { select: { id: true } },
    },
  },
} as const;

/**
 * Executes ONE limit-order fill in its own transaction. Season fills lock the
 * Order first. General fills take the account's exclusive performance fence,
 * then Order → CashWallet/Position → WalletTransaction. Cancel does not take
 * the account fence and still races on the Order row, so exactly one wins.
 * Every authorization fact is re-verified against locked rows; matcher
 * pre-checks only avoid transactions that would no-op.
 */
@Injectable()
export class LimitOrderExecutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candleEvidence: LimitOrderCandleEvidenceService,
    private readonly ordersService: OrdersService,
    @Optional()
    private readonly generalPerformance?: GeneralAccountPerformanceService,
  ) {}

  async fillLimitOrder(input: {
    orderId: string;
    now: Date;
    plan: LimitFillPlan;
  }): Promise<LimitFillOutcome> {
    const { orderId, now, plan } = input;
    return this.prisma.$transaction(async (tx) => {
      const prelock = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          tradingAccountId: true,
          tradingAccount: { select: { mode: true } },
        },
      });
      if (
        prelock?.tradingAccountId &&
        prelock.tradingAccount?.mode === TradingAccountMode.general
      ) {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "trading_accounts"
          WHERE "id" = ${prelock.tradingAccountId}
          FOR UPDATE
        `;
      }
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
        order.orderType !== OrderType.limit ||
        (order.side !== OrderSide.buy && order.side !== OrderSide.sell)
      ) {
        return { state: 'skipped', orderId, reason: 'not_submitted_limit' };
      }
      if (
        !order.limitPrice ||
        !order.reservationFeeRate ||
        (order.side === OrderSide.buy && !order.reservedAmount) ||
        (order.side === OrderSide.sell && !order.reservedQuantity)
      ) {
        // A submitted limit order must carry its reservation basis; a missing one
        // is an invariant breach, never a silent fill.
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Submitted limit order is missing its reservation basis.',
        );
      }

      // 3) Re-validate season / participant / asset (§17: no fill at/after endAt).
      const account = order.tradingAccount;
      if (!order.tradingAccountId || !account) {
        this.throwTradingScopeError(
          'TRADING_SCOPE_REPAIR_REQUIRED',
          'Order has no valid trading account scope.',
        );
      }
      const season = order.seasonParticipant?.season ?? null;
      if (account.mode === TradingAccountMode.season) {
        if (!order.seasonParticipant || !season) {
          this.throwTradingScopeError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Season order has no season participant.',
          );
        }
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
          return {
            state: 'skipped',
            orderId,
            reason: 'participant_not_active',
          };
        }
      } else if (
        order.seasonParticipantId !== null ||
        order.seasonParticipant !== null ||
        account.seasonParticipant !== null
      ) {
        this.throwTradingScopeError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order carries a season participant link.',
        );
      }
      if (!order.asset.isActive) {
        return { state: 'skipped', orderId, reason: 'asset_inactive' };
      }

      // 3b) Trading-account re-validation against the LOCKED rows. Scope
      // integrity problems (missing/mismatched links, foreign quote) are
      // structured errors — repair scripts must run, and the noisy retry is
      // the operator signal. A suspended/closed account is a normal skip:
      // automatic fills stop, the submitted order and its reservation stay.
      if (account.mode === TradingAccountMode.season) {
        const participantAccountId = order.seasonParticipant?.tradingAccountId;
        if (!participantAccountId) {
          this.throwLimitOrderError(
            limitOrderErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
            'Participant has no trading account link; run trading-accounts:repair-links.',
          );
        }
        if (
          order.tradingAccountId !== participantAccountId ||
          order.seasonParticipant?.tradingAccount?.id !== account.id ||
          order.seasonParticipant?.id !== order.seasonParticipantId ||
          account.seasonParticipant?.id !== order.seasonParticipantId
        ) {
          this.throwTradingScopeError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Order is scoped to a different trading account than its participant.',
          );
        }
      }
      if (account.status !== TradingAccountStatus.active) {
        return { state: 'skipped', orderId, reason: 'account_not_active' };
      }
      if (account.mode === TradingAccountMode.general) {
        if (!this.generalPerformance) {
          this.throwTradingScopeError(
            'INTERNAL_ERROR',
            'General account performance service is unavailable.',
          );
        }
        await this.generalPerformance.assertGeneralAccountReady(account, tx);
      }
      const effectiveNow =
        account.mode === TradingAccountMode.general
          ? await this.readTransactionWallClock(tx)
          : now;
      if (
        order.quote &&
        (((account.mode === TradingAccountMode.general ||
          order.quote.tradingAccountId !== null) &&
          order.quote.tradingAccountId !== order.tradingAccountId) ||
          order.quote.seasonParticipantId !== order.seasonParticipantId)
      ) {
        this.throwTradingScopeError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Order quote is scoped to a different trading account or participant.',
        );
      }
      const tradingAccountId = order.tradingAccountId;

      // 4) Re-verify the price basis reaches the limit (§19 step 12).
      if (
        (order.side === OrderSide.buy &&
          plan.executedPrice.gt(order.limitPrice)) ||
        (order.side === OrderSide.sell &&
          plan.executedPrice.lt(order.limitPrice))
      ) {
        return { state: 'skipped', orderId, reason: 'price_outside_limit' };
      }

      // 5) Actual amounts from the ACTUAL execution price and the PINNED fee
      // rate (never the live season rate).
      const amounts =
        order.side === OrderSide.buy
          ? calculateLimitFillAmounts({
              executedPrice: plan.executedPrice,
              quantity: order.quantity,
              reservationFeeRate: order.reservationFeeRate,
            })
          : calculateLimitSellFillAmounts({
              executedPrice: plan.executedPrice,
              quantity: order.quantity,
              reservationFeeRate: order.reservationFeeRate,
            });
      if (
        order.side === OrderSide.buy &&
        !isFillWithinReservation(
          amounts.netAmount,
          order.reservedAmount as Prisma.Decimal,
        )
      ) {
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
      let fxRate: Prisma.Decimal | null = null;
      if (order.currencyCode === CurrencyCode.USD) {
        const evidence = await this.resolveFxEvidenceSnapshot(tx, effectiveNow);
        if (!evidence) {
          return {
            state: 'skipped',
            orderId,
            reason: 'fx_evidence_unavailable',
          };
        }
        fxRateSnapshotId = evidence.id;
        fxRate = evidence.rate;
      }

      const netAmountText = formatDecimalScale(
        amounts.netAmount,
        monetaryScale,
      );
      const reservedAmountText = order.reservedAmount
        ? formatDecimalScale(order.reservedAmount, monetaryScale)
        : null;

      // 7) Settle wallet: debit the actual net, release the whole reservation,
      // in one guarded statement (balance still covers all other reservations).
      // The wallet must carry the ORDER's verified account scope — null or
      // foreign scope rolls the whole fill back before any money moves.
      const wallet = await tx.cashWallet.findUnique({
        where:
          order.seasonParticipantId === null
            ? {
                tradingAccountId_currencyCode: {
                  tradingAccountId,
                  currencyCode: order.currencyCode,
                },
              }
            : {
                seasonParticipantId_currencyCode: {
                  seasonParticipantId: order.seasonParticipantId,
                  currencyCode: order.currencyCode,
                },
              },
        select: { id: true, seasonParticipantId: true, tradingAccountId: true },
      });
      if (!wallet) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Cash wallet for the order reservation was not found.',
        );
      }
      assertCashWalletTradingAccountScope(wallet, {
        seasonParticipantId: order.seasonParticipantId,
        tradingAccountId,
      });
      if (order.side === OrderSide.buy) {
        const settled = await settleLimitBuyReservedCash(tx, {
          walletId: wallet.id,
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId,
          currencyCode: order.currencyCode,
          actualDebit: netAmountText,
          orderReservation: reservedAmountText as string,
        });
        if (settled !== 1) {
          // 작업 5 보완 3: classify before reporting. Scope corruption throws
          // its own structured 500 (repair-required / mismatch) from the shared
          // diagnosis; only genuinely concurrent updates or an actually
          // uncovered reservation reach the limit-order error codes below. The
          // whole fill rolls back either way.
          const reason = await diagnoseCashWalletMutationFailure(tx, {
            walletId: wallet.id,
            expected: {
              seasonParticipantId: order.seasonParticipantId,
              tradingAccountId,
              currencyCode: order.currencyCode,
            },
            requires: {
              reserved: reservedAmountText as string,
              balance: netAmountText,
            },
          });

          this.throwLimitOrderError(
            reason === 'conflict'
              ? limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT
              : limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
            reason === 'conflict'
              ? 'Wallet settlement failed due to a concurrent wallet update.'
              : 'Wallet settlement guard failed for the limit fill.',
          );
        }
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

      // 9) Position (same average-cost policy as market buy), scoped to the
      // order's verified account.
      if (order.side === OrderSide.buy) {
        await this.upsertBuyPosition(tx, {
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId,
          assetId: order.assetId,
          currencyCode: order.currencyCode,
          quantity: order.quantity,
          netAmount: amounts.netAmount,
        });
      } else {
        await this.settleSellPosition(tx, {
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId,
          assetId: order.assetId,
          currencyCode: order.currencyCode,
          quantity: order.quantity,
          netAmount: amounts.netAmount,
          fxRate,
        });
        const credited = await tx.cashWallet.updateMany({
          where: {
            id: wallet.id,
            seasonParticipantId: order.seasonParticipantId,
            tradingAccountId,
            currencyCode: order.currencyCode,
          },
          data: { balanceAmount: { increment: netAmountText } },
        });
        if (credited.count !== 1) {
          this.throwLimitOrderError(
            limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT,
            'Wallet changed while crediting the limit sell.',
          );
        }
      }

      // 10) Ledger row + order finalization.
      const walletAfter = await tx.cashWallet.findUniqueOrThrow({
        where: { id: wallet.id },
        select: { balanceAmount: true },
      });

      await tx.walletTransaction.create({
        data: {
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId,
          walletId: wallet.id,
          currencyCode: order.currencyCode,
          direction:
            order.side === OrderSide.buy
              ? WalletTransactionDirection.debit
              : WalletTransactionDirection.credit,
          txType:
            order.side === OrderSide.buy
              ? WalletTransactionType.order_buy
              : WalletTransactionType.order_sell,
          referenceType: WalletTransactionReferenceType.order,
          referenceId: order.id,
          amount: netAmountText,
          balanceAfter: formatDecimalScale(
            walletAfter.balanceAmount,
            monetaryScale,
          ),
          occurredAt: effectiveNow,
        },
        select: { id: true },
      });

      const executedPriceText = formatDecimalScale(
        plan.executedPrice,
        monetaryScale,
      );
      const flipped = await tx.order.updateMany({
        where: {
          id: order.id,
          seasonParticipantId: order.seasonParticipantId,
          tradingAccountId,
          status: OrderStatus.submitted,
        },
        data: {
          status: OrderStatus.executed,
          executedPrice: executedPriceText,
          grossAmount: formatDecimalScale(amounts.grossAmount, monetaryScale),
          feeAmount: formatDecimalScale(amounts.feeAmount, monetaryScale),
          netAmount: netAmountText,
          assetPriceSnapshotId,
          fxRateSnapshotId,
          limitOrderCandleEvidenceId,
          executedAt: effectiveNow,
          reservationReleasedAt: effectiveNow,
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
        effectiveNow,
        // The fill's verified account scope (작업 7 dual-write).
        tradingAccountId,
      );

      return {
        state: 'filled',
        orderId: order.id,
        seasonId: season?.id ?? null,
        seasonParticipantId: order.seasonParticipantId,
        path: plan.path,
        executedPrice: executedPriceText,
        netAmount: netAmountText,
      };
    });
  }

  /** Backward-compatible name retained for existing callers/tests. */
  async fillLimitBuyOrder(input: {
    orderId: string;
    now: Date;
    plan: LimitFillPlan;
  }): Promise<LimitFillOutcome> {
    return this.fillLimitOrder(input);
  }

  private async readTransactionWallClock(tx: ExecTx): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS "now"
    `;
    const now = rows[0]?.now;
    if (!now) {
      this.throwTradingScopeError(
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        'Database transaction clock is unavailable.',
      );
    }
    return now;
  }

  private async settleSellPosition(
    tx: ExecTx,
    input: {
      seasonParticipantId: string | null;
      tradingAccountId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
      fxRate: Prisma.Decimal | null;
    },
  ): Promise<void> {
    const position = await tx.position.findUnique({
      where:
        input.seasonParticipantId === null
          ? {
              tradingAccountId_assetId: {
                tradingAccountId: input.tradingAccountId,
                assetId: input.assetId,
              },
            }
          : {
              seasonParticipantId_assetId: {
                seasonParticipantId: input.seasonParticipantId,
                assetId: input.assetId,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        currencyCode: true,
        averageCost: true,
      },
    });
    if (
      !position ||
      position.seasonParticipantId !== input.seasonParticipantId ||
      position.tradingAccountId !== input.tradingAccountId ||
      position.currencyCode !== input.currencyCode
    ) {
      this.throwTradingScopeError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Limit-sell position is missing or mis-scoped.',
      );
    }
    const realized = roundDecimalHalfUp(
      input.netAmount.sub(position.averageCost.mul(input.quantity)),
      monetaryScale,
    );
    const realizedKrw =
      input.currencyCode === CurrencyCode.KRW
        ? realized
        : roundDecimalHalfUp(
            realized.mul(
              input.fxRate ??
                this.throwTradingScopeError(
                  'FX_RATE_UNAVAILABLE',
                  'USD limit-sell fill has no FX evidence.',
                ),
            ),
            monetaryScale,
          );
    const settled = await settleReservedPositionQuantity(tx, {
      positionId: position.id,
      seasonParticipantId: input.seasonParticipantId,
      tradingAccountId: input.tradingAccountId,
      assetId: input.assetId,
      quantity: formatDecimalScale(input.quantity, monetaryScale),
      realizedPnlDelta: formatDecimalScale(realized, monetaryScale),
      realizedPnlKrwDelta: formatDecimalScale(realizedKrw, monetaryScale),
    });
    if (settled !== 1) {
      this.throwLimitOrderError(
        limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
        'Position reservation does not cover the limit-sell fill.',
      );
    }
  }

  private async upsertBuyPosition(
    tx: ExecTx,
    input: {
      seasonParticipantId: string | null;
      /** VERIFIED account scope of the order being filled. */
      tradingAccountId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
    },
  ): Promise<string> {
    const existing = await tx.position.findUnique({
      where:
        input.seasonParticipantId === null
          ? {
              tradingAccountId_assetId: {
                tradingAccountId: input.tradingAccountId,
                assetId: input.assetId,
              },
            }
          : {
              seasonParticipantId_assetId: {
                seasonParticipantId: input.seasonParticipantId,
                assetId: input.assetId,
              },
            },
      select: {
        id: true,
        seasonParticipantId: true,
        tradingAccountId: true,
        quantity: true,
        averageCost: true,
      },
    });

    // Existing position must carry the SAME account scope as the order:
    // null → repair first, foreign → corruption. Both roll the fill back.
    if (existing && existing.tradingAccountId === null) {
      this.throwTradingScopeError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Position has no trading account scope; run trading-accounts:repair-trading-scope.',
      );
    }
    if (
      existing &&
      (existing.tradingAccountId !== input.tradingAccountId ||
        existing.seasonParticipantId !== input.seasonParticipantId)
    ) {
      this.throwTradingScopeError(
        'TRADING_ACCOUNT_SCOPE_MISMATCH',
        'Position belongs to a different trading account.',
      );
    }

    const { newQuantity, newAverageCost } = calculateBuyPositionAverageCost({
      netAmount: input.netAmount,
      quantity: input.quantity,
      existing,
    });

    if (!existing) {
      const created = await tx.position.create({
        data: {
          seasonParticipantId: input.seasonParticipantId,
          tradingAccountId: input.tradingAccountId,
          assetId: input.assetId,
          quantity: formatDecimalScale(newQuantity, monetaryScale),
          reservedQuantity: ZERO_MONEY,
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
        seasonParticipantId: input.seasonParticipantId,
        tradingAccountId: input.tradingAccountId,
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
  private async resolveFxEvidenceSnapshot(
    tx: ExecTx,
    now: Date,
  ): Promise<{ id: string; rate: Prisma.Decimal } | null> {
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
    return selection.state === 'selected'
      ? { id: selection.snapshot.id, rate: selection.snapshot.rate }
      : null;
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

  private throwTradingScopeError(code: string, message: string): never {
    throw new HttpException(
      { success: false, error: { code, message } },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
