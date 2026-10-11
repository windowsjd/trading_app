import { isFuturesOnlyAsset } from '../providers/binance/binance-product-catalog';
import { isStandaloneAccountMode } from '../trading-accounts/account-mode-policy';
import { createApiError } from '../common/api-error';
import {
  assertPendingChild,
  reconcileSpotProtection,
  liveProtection,
  protectionInclude,
} from '../conditional/conditional-state';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
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
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
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
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
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
import { requireOrderCashWalletScope } from './order-cash-wallet-policy';
import { OrdersService } from './orders.service';
import { findUsdKrwProviderSnapshotCandidates } from '../providers/fx-rate-snapshot-query';

import { resolveRegularSessionForEvent } from './market-calendar.policy';
import { getAssetTradingStatus } from './market-hours.policy';

import {
  rememberLimitExecutionStage,
  type LimitExecutionStage,
} from './limit-order-matching-diagnostics';

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
  tradingAccountId: true,
  assetId: true,
  side: true,
  orderType: true,
  status: true,
  quantity: true,
  limitPrice: true,
  currencyCode: true,
  cashWalletScope: true,
  reservedAmount: true,
  reservedQuantity: true,
  reservationFeeRate: true,
  submittedAt: true,
  asset: {
    select: {
      id: true,
      symbol: true,
      isActive: true,
      assetType: true,
      market: true,
      currencyCode: true,
      priceCurrency: true,
    },
  },
  quote: {
    select: {
      id: true,
      tradingAccountId: true,
      cashWalletScope: true,
    },
  },
  tradingAccount: {
    select: {
      id: true,
      mode: true,
      status: true,
      initialCapitalKrw: true,
      seasonParticipant: {
        select: {
          id: true,
          participantStatus: true,
          tradingAccountId: true,
          season: {
            select: { id: true, status: true, startAt: true, endAt: true },
          },
        },
      },
    },
  },
} as const;

/**
 * Executes ONE limit-order fill in its own transaction. Season fills lock the
 * lifecycle authorization before Order. General fills take the account's
 * exclusive performance fence, then Order → CashWallet/Position → ledger.
 * Cancel does not take the account fence and still races on the Order row, so exactly one wins.
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
    /** Legacy caller cycle time; never used for execution. */
    now?: Date;
    plan: LimitFillPlan;
  }): Promise<LimitFillOutcome> {
    const { orderId, plan } = input;
    let stage: LimitExecutionStage = 'authorization_lock';
    let callbackFailure: unknown;
    const executeInTransaction = async (
      tx: ExecTx,
    ): Promise<LimitFillOutcome> => {
      const prelock = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          tradingAccountId: true,
          tradingAccount: {
            select: {
              mode: true,
              seasonParticipant: { select: { id: true } },
            },
          },
        },
      });
      if (
        prelock?.tradingAccountId &&
        isStandaloneAccountMode(prelock.tradingAccount?.mode)
      ) {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "trading_accounts"
          WHERE "id" = ${prelock.tradingAccountId}
          FOR UPDATE
        `;
      }
      if (prelock?.tradingAccount?.mode === TradingAccountMode.season) {
        const participantId = prelock.tradingAccount.seasonParticipant?.id;
        if (!participantId)
          this.throwTradingScopeError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Season order has no participant.',
          );
        const context = await lockSeasonTradingContext(tx, {
          seasonParticipantId: participantId,
        });
        if (context.account.id !== prelock.tradingAccountId)
          this.throwTradingScopeError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Order participant scope changed.',
          );
      }
      // 1) Authorization → Order → CashWallet/Position. Cancel locks only Order.
      stage = 'order_lock';
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
      `;
      if (locked.length !== 1) {
        return { state: 'skipped', orderId, reason: 'order_not_found' };
      }

      stage = 'order_validation';
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

      stage = 'transaction_clock';
      const protectionChild = await tx.protectionChild.findUnique({
        where: { orderId },
      });
      if (protectionChild)
        await assertPendingChild(
          tx,
          protectionChild.id,
          order.tradingAccountId,
          'spot',
        );
      if (order.side === 'buy') {
        const protection = await tx.protectionGroup.findFirst({
          where: {
            tradingAccountId: order.tradingAccountId,
            assetId: order.assetId,
            domain: 'spot',
            ...liveProtection,
          },
          include: protectionInclude,
        });
        if (
          protection &&
          ((protection.status === 'holding' &&
            protection.parentOrderId !== order.id) ||
            protection.children.length)
        )
          throw createApiError(
            'PROTECTION_CHILD_PENDING',
            'A conflicting protection intent prevents this increase.',
            409,
          );
      }
      const transactionNow = await this.readTransactionWallClock(tx);

      // 3) Re-validate season / participant / asset (§17: no fill at/after endAt).
      stage = 'scope_validation';
      const account = order.tradingAccount;
      if (!order.tradingAccountId || !account) {
        this.throwTradingScopeError(
          'TRADING_SCOPE_REPAIR_REQUIRED',
          'Order has no valid trading account scope.',
        );
      }
      const participant = account.seasonParticipant;
      const season = participant?.season ?? null;
      if (account.mode === TradingAccountMode.season) {
        if (!participant || !season) {
          this.throwTradingScopeError(
            'TRADING_ACCOUNT_SCOPE_MISMATCH',
            'Season order has no season participant.',
          );
        }
        if (
          season.status !== SeasonStatus.active ||
          transactionNow < season.startAt ||
          transactionNow >= season.endAt
        ) {
          return { state: 'skipped', orderId, reason: 'season_not_active' };
        }
        if (participant.participantStatus !== ParticipantStatus.active) {
          return {
            state: 'skipped',
            orderId,
            reason: 'participant_not_active',
          };
        }
      } else if (account.seasonParticipant !== null) {
        this.throwTradingScopeError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'General order carries a season participant link.',
        );
      }
      if (!order.asset.isActive || isFuturesOnlyAsset(order.asset)) {
        return { state: 'skipped', orderId, reason: 'asset_inactive' };
      }

      // 3b) Trading-account re-validation against the LOCKED rows. Scope
      // integrity problems (missing/mismatched links, foreign quote) are
      // structured errors — repair scripts must run, and the noisy retry is
      // the operator signal. A suspended/closed account is a normal skip:
      // automatic fills stop, the submitted order and its reservation stay.
      if (account.mode === TradingAccountMode.season) {
        const participantAccountId = participant?.tradingAccountId;
        if (!participantAccountId) {
          this.throwLimitOrderError(
            limitOrderErrorCodes.TRADING_ACCOUNT_LINK_INTEGRITY,
            'Participant has no trading account link; run trading-accounts:repair-links.',
          );
        }
        if (
          order.tradingAccountId !== participantAccountId ||
          participantAccountId !== account.id
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
      if (isStandaloneAccountMode(account.mode)) {
        if (!this.generalPerformance) {
          this.throwTradingScopeError(
            'INTERNAL_ERROR',
            'General account performance service is unavailable.',
          );
        }
        await this.generalPerformance.assertGeneralAccountReady(account, tx);
      }
      if (
        order.quote &&
        order.quote.tradingAccountId !== order.tradingAccountId
      ) {
        this.throwTradingScopeError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Order quote is scoped to a different trading account or participant.',
        );
      }
      const tradingAccountId = order.tradingAccountId;

      // Confirmed CLOSED permits historical regular-session candles, but a
      // missing current calendar cannot authorize either evidence path.
      stage = 'market_validation';
      const marketStatus = getAssetTradingStatus(order.asset, transactionNow);
      if (!marketStatus.tradable && marketStatus.reason !== 'MARKET_CLOSED') {
        return { state: 'skipped', orderId, reason: marketStatus.reason };
      }

      // Path A is an execution-time price; the cycle's exact evidence must
      // still be fresh and in the current stock session. Never refresh over
      // the network or silently substitute a different price in this fill.
      if (plan.path === 'snapshot') {
        stage = 'snapshot_validation';
        const market = getAssetTradingStatus(order.asset, transactionNow);
        if (!market.tradable)
          return { state: 'skipped', orderId, reason: 'market_not_open' };
        const eligibility = resolveAssetProviderEligibility({
          workflow: 'orders_execute',
          asset: order.asset,
        });
        const evidence = await tx.assetPriceSnapshot.findUnique({
          where: { id: plan.assetPriceSnapshotId },
        });
        if (
          !eligibility.eligible ||
          !evidence ||
          evidence.assetId !== order.assetId ||
          evidence.currencyCode !==
            (order.asset.priceCurrency ?? order.asset.currencyCode) ||
          evidence.effectiveAt < order.submittedAt ||
          !evidence.price.eq(plan.executedPrice)
        ) {
          return {
            state: 'skipped',
            orderId,
            reason: 'price_evidence_unavailable',
          };
        }
        const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
          asset: order.asset,
          workflow: 'orders_execute',
          candidates: [evidence],
          expectedSourceNames: eligibility.sourceNames,
          now: transactionNow,
          freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
          isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
        });
        if (selection.state !== 'selected')
          return {
            state: 'skipped',
            orderId,
            reason: 'price_evidence_unavailable',
          };
      } else {
        // Path B is historical touch evidence. Its close is evidenceAt, not
        // the execution time: no current 10-second price freshness/session gate.
        stage = 'candle_validation';
        const evidenceAt = plan.candle.closeTime;
        const session =
          order.asset.assetType === AssetType.crypto
            ? null
            : resolveRegularSessionForEvent(order.asset, plan.candle.openTime);
        if (
          evidenceAt > transactionNow ||
          plan.candle.sourceUpdatedAt > transactionNow ||
          plan.candle.finalizedAt > transactionNow ||
          evidenceAt.getTime() !== plan.candle.openTime.getTime() + 300_000 ||
          (order.asset.assetType !== AssetType.crypto &&
            (!session || evidenceAt > session.closeTime)) ||
          !plan.executedPrice.eq(order.limitPrice) ||
          !this.candleEvidence.selectTriggerCandleForOrder([plan.candle], {
            submittedAt: order.submittedAt,
            limitPrice: order.limitPrice,
            side: order.side,
            seasonEndAt: season?.endAt ?? null,
          })
        ) {
          return {
            state: 'skipped',
            orderId,
            reason: 'candle_evidence_invalid',
          };
        }
      }

      stage = 'amounts_validation';
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
      stage = 'fx_evidence';
      let fxRateSnapshotId: string | null = null;
      let fxRate: Prisma.Decimal | null = null;
      if (order.currencyCode === CurrencyCode.USD) {
        const evidence = await this.resolveFxEvidenceSnapshot(
          tx,
          transactionNow,
        );
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
      stage = 'wallet_settlement';
      const cashWalletScope = requireOrderCashWalletScope(
        order.cashWalletScope,
        order.currencyCode,
      );
      if (order.quote && order.quote.cashWalletScope !== cashWalletScope) {
        this.throwTradingScopeError(
          'TRADING_ACCOUNT_SCOPE_MISMATCH',
          'Order and quote cash provenance disagree.',
        );
      }
      const wallet = await tx.cashWallet.findUnique({
        where: {
          tradingAccountId_walletScope_currencyCode: {
            walletScope: cashWalletScope,
            tradingAccountId,
            currencyCode: order.currencyCode,
          },
        },
        select: { walletScope: true, id: true, tradingAccountId: true },
      });
      if (!wallet) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.ORDER_RESERVATION_INCONSISTENT,
          'Cash wallet for the order reservation was not found.',
        );
      }
      assertCashWalletTradingAccountScope(wallet, {
        tradingAccountId,
        walletScope: cashWalletScope,
      });
      if (order.side === OrderSide.buy) {
        const settled = await settleLimitBuyReservedCash(tx, {
          walletId: wallet.id,
          walletScope: cashWalletScope,
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
              tradingAccountId,
              walletScope: cashWalletScope,
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

      stage = 'candle_evidence_persistence';
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

      stage = 'position_settlement';
      // 9) Position (same average-cost policy as market buy), scoped to the
      // order's verified account.
      if (order.side === OrderSide.buy) {
        await this.upsertBuyPosition(tx, {
          tradingAccountId,
          assetId: order.assetId,
          currencyCode: order.currencyCode,
          quantity: order.quantity,
          netAmount: amounts.netAmount,
        });
      } else {
        await this.settleSellPosition(tx, {
          tradingAccountId,
          assetId: order.assetId,
          currencyCode: order.currencyCode,
          quantity: order.quantity,
          netAmount: amounts.netAmount,
          fxRate,
        });
        stage = 'wallet_credit';
        const credited = await tx.cashWallet.updateMany({
          where: {
            walletScope: cashWalletScope,
            id: wallet.id,
            tradingAccountId,
            currencyCode: order.currencyCode,
          },
          data: { balanceAmount: { increment: netAmountText } },
        });
        if (credited.count !== 1) {
          await diagnoseCashWalletMutationFailure(tx, {
            walletId: wallet.id,
            expected: {
              tradingAccountId,
              walletScope: cashWalletScope,
              currencyCode: order.currencyCode,
            },
          });
          this.throwLimitOrderError(
            limitOrderErrorCodes.ORDER_RESERVATION_CONFLICT,
            'Wallet changed while crediting the limit sell.',
          );
        }
      }

      stage = 'ledger_order_finalization';
      // 10) Ledger row + order finalization.
      const walletAfter = await tx.cashWallet.findUniqueOrThrow({
        where: { id: wallet.id },
        select: { walletScope: true, balanceAmount: true },
      });

      await tx.walletTransaction.create({
        data: {
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
          occurredAt: transactionNow,
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
          executedAt: transactionNow,
          reservationReleasedAt: transactionNow,
        },
      });
      if (flipped.count !== 1) {
        this.throwLimitOrderError(
          limitOrderErrorCodes.LIMIT_ORDER_EXECUTION_CONFLICT,
          'Order state changed while filling.',
        );
      }

      stage = 'portfolio_snapshot';
      await reconcileSpotProtection(
        tx,
        tradingAccountId,
        order.assetId,
        order.id,
        transactionNow,
      );
      // 11) Equity snapshot — reuse the market path's exact valuation so a
      // limit fill and a market fill leave identical portfolio state.
      await this.ordersService.recordOrderExecutedPortfolioSnapshotInTransaction(
        tx,
        participant?.id ?? null,
        transactionNow,
        // Persist the snapshot under the fill's verified account owner.
        tradingAccountId,
      );

      return {
        state: 'filled',
        orderId: order.id,
        seasonId: season?.id ?? null,
        seasonParticipantId: participant?.id ?? null,
        path: plan.path,
        executedPrice: executedPriceText,
        netAmount: netAmountText,
      };
    };
    return this.prisma
      .$transaction((tx) =>
        executeInTransaction(tx).catch((error: unknown) => {
          callbackFailure = error;
          rememberLimitExecutionStage(error, stage);
          throw error;
        }),
      )
      .catch((error: unknown) => {
        // Begin/commit failures occur outside the callback. Keep callback stages
        // when present, without wrapping or changing the thrown exception.
        if (error !== callbackFailure)
          rememberLimitExecutionStage(error, 'transaction');
        throw error;
      });
  }

  /** Backward-compatible name retained for existing callers/tests. */
  async fillLimitBuyOrder(input: {
    orderId: string;
    /** Legacy caller cycle time; never used for execution. */
    now?: Date;
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
      tradingAccountId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
      fxRate: Prisma.Decimal | null;
    },
  ): Promise<void> {
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
        currencyCode: true,
        averageCost: true,
      },
    });
    if (
      !position ||
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
      /** VERIFIED account scope of the order being filled. */
      tradingAccountId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
    },
  ): Promise<string> {
    const existing = await tx.position.findUnique({
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
        averageCost: true,
      },
    });

    // Existing position must carry the SAME account scope as the order:
    // null → repair first, foreign → corruption. Both roll the fill back.
    if (existing && existing.tradingAccountId === null) {
      this.throwTradingScopeError(
        'TRADING_SCOPE_REPAIR_REQUIRED',
        'Position has no canonical trading account scope.',
      );
    }
    if (existing && existing.tradingAccountId !== input.tradingAccountId) {
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

    const candidates = await findUsdKrwProviderSnapshotCandidates(tx, {
      sourceNames: eligibility.sourceNames,
      take: 10,
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
