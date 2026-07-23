import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  ParticipantStatus,
  Prisma,
  SnapshotReason,
  WalletTransactionDirection,
  WalletTransactionReferenceType,
  WalletTransactionType,
  SeasonStatus,
} from '../../generated/prisma/client';
import {
  formatDecimalScale,
  monetaryScale,
  roundDecimalHalfUp,
} from '../../fx/fx-decimal-policy';
import { PortfolioValuationService } from '../../portfolio/portfolio-valuation.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RankingRefreshService,
  calculateMaxDrawdown,
} from '../../ranking/ranking-refresh.service';
import { settleLimitBuyReservedCash } from '../../wallets/cash-wallet-atomic';
import { getAssetTradingStatus } from '../market-hours.policy';
import type { LimitOrderPriceEvent } from './limit-order-price-event.types';
import { compareRedisStreamIds } from './limit-order-event-stream.service';
import {
  calculateLimitOrderCandleExecutionAmounts,
  calculateLimitOrderExecutionAmounts,
  LimitOrderCandleReservationMismatchError,
} from './limit-order-execution.policy';
import type { LimitOrderExecutionAmounts } from './limit-order-execution.policy';

export const LIMIT_ORDER_CANDLE_POLICY_VERSION = 1;

/**
 * Source-specific half of a fill. Everything after eligibility — locking,
 * amounts, wallet settlement, position, ledger, order finalization, equity
 * snapshot, ranking refresh — is shared, so path B adds no second copy of the
 * financial code.
 */
export type LimitOrderTrigger =
  | {
      source: 'live_trade_event';
      streamId: string;
      event: LimitOrderPriceEvent;
    }
  | {
      source: 'closed_5m_candle';
      candle: {
        id: string;
        assetId: string;
        interval: string;
        openTime: Date;
        closeTime: Date;
        low: Prisma.Decimal;
        sourceProvider: string;
        sourceUpdatedAt: Date;
        finalizedAt: Date;
        /**
         * Storage revision (MarketCandle.ingestSeq) the sweep read this
         * candle at. Evidence is scoped to it: a corrected candle gets a NEW
         * evidence row, and rows written for earlier revisions stay verbatim.
         */
        ingestSeq: bigint;
      };
    };

export type LimitOrderExecutionResult =
  | {
      state: 'executed';
      seasonId: string;
      seasonParticipantId: string;
      orderId: string;
      source: LimitOrderTrigger['source'];
    }
  | { state: 'skipped'; reason: string };

export class LimitOrderExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LimitOrderExecutionError';
  }
}

const ORDER_SELECT = {
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
  matchingActivationStreamId: true,
  candleMatchingEligibleFrom: true,
  submittedAt: true,
  asset: {
    select: {
      id: true,
      symbol: true,
      market: true,
      assetType: true,
      currencyCode: true,
      settlementCurrency: true,
      isActive: true,
    },
  },
  seasonParticipant: {
    select: {
      id: true,
      participantStatus: true,
      season: {
        select: {
          id: true,
          status: true,
          startAt: true,
          endAt: true,
        },
      },
    },
  },
} as const;

@Injectable()
export class LimitOrderExecutionService {
  private readonly logger = new Logger(LimitOrderExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly valuation: PortfolioValuationService,
    private readonly ranking: RankingRefreshService,
  ) {}

  /** Path A entry point (live trade event). */
  executeCandidate(input: {
    orderId: string;
    seasonParticipantId: string;
    streamId: string;
    event: LimitOrderPriceEvent;
  }): Promise<LimitOrderExecutionResult> {
    return this.execute({
      orderId: input.orderId,
      seasonParticipantId: input.seasonParticipantId,
      trigger: {
        source: 'live_trade_event',
        streamId: input.streamId,
        event: input.event,
      },
    });
  }

  /**
   * Shared execution. Path A and path B differ only in `trigger`; both take
   * the same lock order (Participant SHARE -> Season SHARE -> Order UPDATE ->
   * Wallet -> Position) and both finalize the order with the same guarded
   * statements, so two concurrent paths against one order can never both
   * succeed: the loser finds status != submitted under `FOR UPDATE`.
   */
  async execute(input: {
    orderId: string;
    seasonParticipantId: string;
    trigger: LimitOrderTrigger;
  }): Promise<LimitOrderExecutionResult> {
    const result = await this.prisma.$transaction(async (tx) => {
      // Compatible global lock graph:
      // Participant(SHARE) -> Season(SHARE) -> Order(UPDATE) -> Wallet -> Position.
      const participantRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "season_participants"
        WHERE "id" = ${input.seasonParticipantId}
        FOR SHARE
      `;
      if (participantRows.length !== 1) return skipped('participant_missing');

      const seasonRows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT s."id"
        FROM "seasons" s
        JOIN "season_participants" sp ON sp."season_id" = s."id"
        WHERE sp."id" = ${input.seasonParticipantId}
        FOR SHARE OF s
      `;
      if (seasonRows.length !== 1) return skipped('season_missing');

      const lockedOrders = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "orders"
        WHERE "id" = ${input.orderId}
          AND "season_participant_id" = ${input.seasonParticipantId}
        FOR UPDATE
      `;
      if (lockedOrders.length !== 1) return skipped('order_missing');

      const order = await tx.order.findUnique({
        where: { id: input.orderId },
        select: ORDER_SELECT,
      });
      if (!order) return skipped('order_missing');

      if (
        order.status !== OrderStatus.submitted ||
        order.orderType !== OrderType.limit ||
        order.side !== OrderSide.buy
      ) {
        return skipped('order_not_submitted_limit_buy');
      }
      if (
        order.seasonParticipant.participantStatus !== ParticipantStatus.active
      ) {
        return skipped('participant_not_active');
      }
      const season = order.seasonParticipant.season;
      if (season.status !== SeasonStatus.active) {
        return skipped('season_not_active');
      }
      if (!order.asset.isActive) return skipped('asset_inactive');
      if (order.assetId !== triggerAssetId(input.trigger))
        return skipped('asset_mismatch');
      if (
        (order.asset.settlementCurrency ?? order.asset.currencyCode) !==
        order.currencyCode
      ) {
        return skipped('currency_mismatch');
      }
      if (!order.limitPrice) return skipped('limit_price_missing');
      if (!order.reservedAmount || !order.reservationFeeRate) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT',
          'Limit order reservation basis is missing.',
        );
      }

      const eligibility = this.assertTriggerEligibility(order, input.trigger);
      if (eligibility.state === 'skipped') return eligibility;

      let amounts: LimitOrderExecutionAmounts;
      if (input.trigger.source === 'live_trade_event') {
        try {
          amounts = calculateLimitOrderExecutionAmounts({
            eventPrice: eligibility.executedPrice,
            quantity: order.quantity,
            reservationFeeRate: order.reservationFeeRate,
            reservedAmount: order.reservedAmount,
          });
        } catch {
          throw new LimitOrderExecutionError(
            'LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT',
            'Actual debit exceeds the order reservation.',
          );
        }
      } else {
        try {
          amounts = calculateLimitOrderCandleExecutionAmounts({
            limitPrice: order.limitPrice,
            quantity: order.quantity,
            reservationFeeRate: order.reservationFeeRate,
            reservedAmount: order.reservedAmount,
          });
        } catch (error) {
          // No extra debit, no silent correction, no fill: the reservation
          // stays put and an operator resolves the inconsistency.
          throw new LimitOrderExecutionError(
            'LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH',
            error instanceof LimitOrderCandleReservationMismatchError
              ? error.message
              : 'Path-B debit does not equal the order reservation.',
          );
        }
      }
      const { grossAmount, feeAmount, actualDebit, executedPrice } = amounts;

      const wallets = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "cash_wallets"
        WHERE "season_participant_id" = ${order.seasonParticipantId}
          AND "currency_code" = ${order.currencyCode}::"CurrencyCode"
        FOR UPDATE
      `;
      const walletId = wallets[0]?.id;
      if (!walletId) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT',
          'Cash wallet is missing.',
        );
      }
      await tx.$queryRaw`
        SELECT "id" FROM "positions"
        WHERE "season_participant_id" = ${order.seasonParticipantId}
          AND "asset_id" = ${order.assetId}
        FOR UPDATE
      `;

      // clock_timestamp(), unlike transaction_timestamp()/now(), advances
      // while a transaction waits. Read it only after the last potentially
      // blocking financial row lock so a wallet wait cannot carry an order
      // past Season.endAt under a stale time.
      const nowRows = await tx.$queryRaw<Array<{ now: Date }>>`
        SELECT clock_timestamp() AS "now"
      `;
      const matchedAt = nowRows[0]?.now;
      if (!matchedAt) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_CONFLICT',
          'Database transaction clock is unavailable.',
        );
      }
      if (matchedAt < season.startAt || matchedAt >= season.endAt) {
        return skipped('season_not_active');
      }

      // Exactly one evidence link per fill. Path A upserts the exact provider
      // trade snapshot; path B reuses/creates the candle evidence row shared
      // by every order that candle fills and creates NO AssetPriceSnapshot.
      const evidence =
        input.trigger.source === 'live_trade_event'
          ? {
              assetPriceSnapshotId: (
                await this.ensureEvidenceSnapshot(tx, input.trigger.event)
              ).id,
              candleEvidenceId: null as string | null,
              triggerEventId: input.trigger.event.eventId as string | null,
              triggerEventAt: new Date(input.trigger.event.providerEventAt),
              matchingSource: 'live_trade_event' as const,
            }
          : {
              assetPriceSnapshotId: null as string | null,
              candleEvidenceId: (
                await this.ensureCandleEvidence(tx, input.trigger.candle)
              ).id,
              triggerEventId: null as string | null,
              // The candle's close instant is the moment the touch became
              // observable; it is audit/display data, never an ordering input.
              triggerEventAt: input.trigger.candle.closeTime,
              matchingSource: 'closed_5m_candle' as const,
            };
      const debit = await settleLimitBuyReservedCash(tx, {
        walletId,
        seasonParticipantId: order.seasonParticipantId,
        currencyCode: order.currencyCode,
        actualDebit: formatDecimalScale(actualDebit, monetaryScale),
        orderReservation: formatDecimalScale(
          order.reservedAmount,
          monetaryScale,
        ),
      });
      if (debit !== 1) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT',
          'Wallet balance/reservation invariant rejected the settlement.',
        );
      }
      const postWallet = await tx.cashWallet.findUnique({
        where: { id: walletId },
        select: { balanceAmount: true },
      });
      if (!postWallet) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT',
          'Cash wallet disappeared during settlement.',
        );
      }

      await this.updateBuyPosition(tx, {
        seasonParticipantId: order.seasonParticipantId,
        assetId: order.assetId,
        currencyCode: order.currencyCode,
        quantity: order.quantity,
        netAmount: actualDebit,
      });
      await tx.walletTransaction.create({
        data: {
          seasonParticipantId: order.seasonParticipantId,
          walletId,
          currencyCode: order.currencyCode,
          direction: WalletTransactionDirection.debit,
          txType: WalletTransactionType.order_buy,
          referenceType: WalletTransactionReferenceType.order,
          referenceId: order.id,
          amount: formatDecimalScale(actualDebit, monetaryScale),
          balanceAfter: formatDecimalScale(
            postWallet.balanceAmount,
            monetaryScale,
          ),
          occurredAt: matchedAt,
        },
      });

      const finalized = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.submitted },
        data: {
          status: OrderStatus.executed,
          executedPrice: formatDecimalScale(executedPrice, monetaryScale),
          grossAmount: formatDecimalScale(grossAmount, monetaryScale),
          feeAmount: formatDecimalScale(feeAmount, monetaryScale),
          netAmount: formatDecimalScale(actualDebit, monetaryScale),
          assetPriceSnapshotId: evidence.assetPriceSnapshotId,
          limitOrderCandleEvidenceId: evidence.candleEvidenceId,
          executedAt: matchedAt,
          reservationReleasedAt: matchedAt,
          cancelReason: null,
          rejectedAt: null,
          rejectReason: null,
          triggerEventId: evidence.triggerEventId,
          triggerEventAt: evidence.triggerEventAt,
          matchedAt,
          matchingSource: evidence.matchingSource,
          updatedAt: matchedAt,
        },
      });
      if (finalized.count !== 1) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_CONFLICT',
          'Order state changed during automatic execution.',
        );
      }

      await this.recordEquitySnapshot(tx, order.seasonParticipantId, matchedAt);
      return {
        state: 'executed' as const,
        seasonId: season.id,
        seasonParticipantId: order.seasonParticipantId,
        orderId: order.id,
        source: input.trigger.source,
      };
    });

    if (result.state === 'executed') {
      void this.ranking
        .refreshCurrentRankingAfterParticipantChange(
          result.seasonId,
          result.seasonParticipantId,
        )
        .catch((error: unknown) => {
          this.logger.error(
            `Ranking refresh failed after limit-order execution ${result.orderId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    return result;
  }

  /**
   * Source-specific eligibility, evaluated against the LOCKED order row.
   *
   * Path A ordering is decided ONLY by Redis Stream IDs. Order.submittedAt is
   * a PostgreSQL clock_timestamp() while event.receivedAt is a Node process
   * clock, so comparing them across two hosts would drop perfectly valid
   * events (or accept invalid ones) purely from clock skew. The stream ID is a
   * single-writer monotonic sequence produced by one Redis instance and is the
   * authoritative before/after answer. Timestamps stay for audit, display and
   * anomaly detection only.
   */
  private assertTriggerEligibility(
    order: {
      limitPrice: Prisma.Decimal | null;
      currencyCode: CurrencyCode;
      matchingActivationStreamId: string | null;
      candleMatchingEligibleFrom: Date | null;
      asset: { assetType: AssetType; market: string };
      seasonParticipant: { season: { endAt: Date } };
    },
    trigger: LimitOrderTrigger,
  ):
    | { state: 'eligible'; executedPrice: Prisma.Decimal }
    | { state: 'skipped'; reason: string } {
    const limitPrice = order.limitPrice as Prisma.Decimal;
    if (trigger.source === 'live_trade_event') {
      const event = trigger.event;
      if (event.currencyCode !== order.currencyCode) {
        return skipped('currency_mismatch');
      }
      if (!order.matchingActivationStreamId) {
        return skipped('matching_not_activated');
      }
      if (
        compareRedisStreamIds(
          order.matchingActivationStreamId,
          trigger.streamId,
        ) >= 0
      ) {
        return skipped('event_before_order_activation');
      }
      const eventPrice = decimal(event.price, 'event price');
      if (eventPrice.gt(limitPrice)) return skipped('limit_price_not_reached');
      if (order.asset.assetType !== AssetType.crypto) {
        const trading = getAssetTradingStatus(
          { assetType: order.asset.assetType, market: order.asset.market },
          new Date(event.providerEventAt),
        );
        if (!trading.tradable) return skipped(trading.reason.toLowerCase());
      }
      return { state: 'eligible', executedPrice: eventPrice };
    }

    const candle = trigger.candle;
    if (candle.interval !== '5m') return skipped('candle_interval_unsupported');
    if (!order.candleMatchingEligibleFrom) {
      return skipped('candle_matching_not_activated');
    }
    // The candle that was already running when the order was submitted is
    // never used: its low may have happened before the order existed.
    if (candle.openTime < order.candleMatchingEligibleFrom) {
      return skipped('candle_before_order_activation');
    }
    // No retroactive fill from a window that closed after the season ended.
    if (candle.closeTime > order.seasonParticipant.season.endAt) {
      return skipped('candle_after_season_end');
    }
    if (!candle.low.isFinite() || candle.low.lte(0)) {
      return skipped('candle_low_invalid');
    }
    if (candle.low.gt(limitPrice)) return skipped('limit_price_not_reached');
    if (order.asset.assetType !== AssetType.crypto) {
      // Stocks: the candle itself must belong to a tradable session. Its open
      // instant is inside the window, so it is the session-defining point.
      const trading = getAssetTradingStatus(
        { assetType: order.asset.assetType, market: order.asset.market },
        candle.openTime,
      );
      if (!trading.tradable) return skipped(trading.reason.toLowerCase());
    }
    // Path B always fills AT THE LIMIT PRICE, never at the candle low.
    return { state: 'eligible', executedPrice: limitPrice };
  }

  /**
   * One IMMUTABLE evidence row per (candle, storage revision), shared by
   * every order that REVISION fills. Concurrent creation is resolved by the
   * composite unique index, so a retry never produces a second row for the
   * same revision.
   *
   * Within ONE revision the low is a constant, so an existing row whose low
   * differs from the trigger is a genuine inconsistency and still fails
   * closed. A DIFFERENT revision (a corrected candle) is not a mismatch — it
   * gets its own row, and rows written for earlier revisions are never
   * touched, so the audit trail of what each order actually filled against
   * is preserved verbatim.
   */
  private async ensureCandleEvidence(
    tx: Prisma.TransactionClient,
    candle: Extract<
      LimitOrderTrigger,
      { source: 'closed_5m_candle' }
    >['candle'],
  ): Promise<{ id: string }> {
    const existing = await tx.limitOrderCandleEvidence.findUnique({
      where: {
        marketCandleId_candleIngestSeq: {
          marketCandleId: candle.id,
          candleIngestSeq: candle.ingestSeq,
        },
      },
      select: { id: true, triggerLowPrice: true, openTime: true },
    });
    if (existing) {
      if (
        !existing.triggerLowPrice.eq(candle.low) ||
        existing.openTime.getTime() !== candle.openTime.getTime()
      ) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_CANDLE_EVIDENCE_MISMATCH',
          'Existing candle evidence does not match the canonical candle.',
        );
      }
      return { id: existing.id };
    }
    return tx.limitOrderCandleEvidence.create({
      data: {
        marketCandleId: candle.id,
        candleIngestSeq: candle.ingestSeq,
        assetId: candle.assetId,
        interval: candle.interval,
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        triggerLowPrice: formatDecimalScale(candle.low, monetaryScale),
        executionPricePolicy: 'limit_price',
        provider: candle.sourceProvider.split('_')[0] ?? candle.sourceProvider,
        sourceName: candle.sourceProvider,
        sourceUpdatedAt: candle.sourceUpdatedAt,
        finalizedAt: candle.finalizedAt,
        policyVersion: LIMIT_ORDER_CANDLE_POLICY_VERSION,
      },
      select: { id: true },
    });
  }

  private async ensureEvidenceSnapshot(
    tx: Prisma.TransactionClient,
    event: LimitOrderPriceEvent,
  ): Promise<{ id: string }> {
    const evidence = await tx.assetPriceSnapshot.upsert({
      where: { providerEventKey: event.eventId },
      update: {},
      create: {
        assetId: event.assetId,
        price: event.price,
        priceKrw: event.currencyCode === CurrencyCode.KRW ? event.price : null,
        currencyCode: event.currencyCode,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: event.sourceName,
        sourceTimestamp: new Date(event.providerEventAt),
        effectiveAt: new Date(event.providerEventAt),
        capturedAt: new Date(event.receivedAt),
        providerEventKey: event.eventId,
        providerEventAt: new Date(event.providerEventAt),
        note: `limit-order live trade evidence (${event.provider})`,
      },
      select: {
        id: true,
        assetId: true,
        price: true,
        currencyCode: true,
        sourceType: true,
        sourceName: true,
        sourceTimestamp: true,
        effectiveAt: true,
        capturedAt: true,
        providerEventAt: true,
      },
    });
    const providerEventAt = new Date(event.providerEventAt).getTime();
    const receivedAt = new Date(event.receivedAt).getTime();
    if (
      evidence.assetId !== event.assetId ||
      !evidence.price.eq(event.price) ||
      evidence.currencyCode !== event.currencyCode ||
      evidence.sourceType !== AssetPriceSourceType.provider_api ||
      evidence.sourceName !== event.sourceName ||
      evidence.sourceTimestamp?.getTime() !== providerEventAt ||
      evidence.effectiveAt.getTime() !== providerEventAt ||
      evidence.capturedAt.getTime() !== receivedAt ||
      evidence.providerEventAt?.getTime() !== providerEventAt
    ) {
      throw new LimitOrderExecutionError(
        'LIMIT_ORDER_EVENT_INVALID',
        'Existing provider event evidence does not match the stream event.',
      );
    }
    return { id: evidence.id };
  }

  private async updateBuyPosition(
    tx: Prisma.TransactionClient,
    input: {
      seasonParticipantId: string;
      assetId: string;
      currencyCode: CurrencyCode;
      quantity: Prisma.Decimal;
      netAmount: Prisma.Decimal;
    },
  ): Promise<void> {
    const position = await tx.position.findUnique({
      where: {
        seasonParticipantId_assetId: {
          seasonParticipantId: input.seasonParticipantId,
          assetId: input.assetId,
        },
      },
      select: {
        id: true,
        quantity: true,
        averageCost: true,
        currencyCode: true,
      },
    });
    if (!position) {
      await tx.position.create({
        data: {
          id: randomUUID(),
          seasonParticipantId: input.seasonParticipantId,
          assetId: input.assetId,
          quantity: formatDecimalScale(input.quantity, monetaryScale),
          averageCost: formatDecimalScale(
            roundDecimalHalfUp(
              input.netAmount.div(input.quantity),
              monetaryScale,
            ),
            monetaryScale,
          ),
          currencyCode: input.currencyCode,
          realizedPnl: '0.00000000',
          realizedPnlKrw: '0.00000000',
        },
      });
      return;
    }
    if (position.currencyCode !== input.currencyCode) {
      throw new LimitOrderExecutionError(
        'LIMIT_ORDER_EXECUTION_CONFLICT',
        'Position currency does not match order currency.',
      );
    }
    const quantity = roundDecimalHalfUp(
      position.quantity.add(input.quantity),
      monetaryScale,
    );
    const averageCost = roundDecimalHalfUp(
      position.averageCost
        .mul(position.quantity)
        .add(input.netAmount)
        .div(quantity),
      monetaryScale,
    );
    await tx.position.update({
      where: { id: position.id },
      data: {
        quantity: formatDecimalScale(quantity, monetaryScale),
        averageCost: formatDecimalScale(averageCost, monetaryScale),
      },
    });
  }

  private async recordEquitySnapshot(
    tx: Prisma.TransactionClient,
    participantId: string,
    capturedAt: Date,
  ): Promise<void> {
    const value = await this.valuation.calculateSeasonParticipantValuation(
      participantId,
      capturedAt,
      'limit_order_execution',
      tx,
    );
    await tx.equitySnapshot.create({
      data: {
        seasonParticipantId: participantId,
        totalAssetKrw: value.totalAssetKrw,
        returnRate: value.returnRate,
        krwCash: value.krwCash,
        usdCashKrw: value.usdCashKrw,
        domesticStockValueKrw: value.domesticStockValueKrw,
        usStockValueKrw: value.usStockValueKrw,
        cryptoValueKrw: value.cryptoValueKrw,
        snapshotReason: SnapshotReason.order_executed,
        capturedAt,
      },
    });
    const history = await tx.equitySnapshot.findMany({
      where: { seasonParticipantId: participantId },
      select: { totalAssetKrw: true, capturedAt: true },
    });
    await tx.seasonParticipant.update({
      where: { id: participantId },
      data: {
        totalAssetKrw: value.totalAssetKrw,
        totalReturnRate: value.returnRate,
        maxDrawdown: formatDecimalScale(calculateMaxDrawdown(history), 8),
        totalFillCount: { increment: 1 },
      },
    });
  }
}

function decimal(value: string, label: string): Prisma.Decimal {
  try {
    const parsed = new Prisma.Decimal(value);
    if (!parsed.isFinite() || parsed.lte(0)) throw new Error();
    return parsed;
  } catch {
    throw new LimitOrderExecutionError(
      'LIMIT_ORDER_EVENT_INVALID',
      `${label} must be a positive decimal.`,
    );
  }
}

function skipped(reason: string): { state: 'skipped'; reason: string } {
  return { state: 'skipped', reason };
}

function triggerAssetId(trigger: LimitOrderTrigger): string {
  return trigger.source === 'live_trade_event'
    ? trigger.event.assetId
    : trigger.candle.assetId;
}
