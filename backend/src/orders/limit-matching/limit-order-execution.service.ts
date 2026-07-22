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
import { calculateLimitOrderExecutionAmounts } from './limit-order-execution.policy';
import type { LimitOrderExecutionAmounts } from './limit-order-execution.policy';

export type LimitOrderExecutionResult =
  | {
      state: 'executed';
      seasonId: string;
      seasonParticipantId: string;
      orderId: string;
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

  async executeCandidate(input: {
    orderId: string;
    seasonParticipantId: string;
    streamId: string;
    event: LimitOrderPriceEvent;
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
      if (order.assetId !== input.event.assetId)
        return skipped('asset_mismatch');
      if (
        (order.asset.settlementCurrency ?? order.asset.currencyCode) !==
          order.currencyCode ||
        input.event.currencyCode !== order.currencyCode
      ) {
        return skipped('currency_mismatch');
      }
      if (!order.matchingActivationStreamId) {
        return skipped('matching_not_activated');
      }
      if (
        compareRedisStreamIds(
          order.matchingActivationStreamId,
          input.streamId,
        ) >= 0
      ) {
        return skipped('event_before_order_activation');
      }
      if (order.submittedAt > new Date(input.event.receivedAt)) {
        return skipped('event_received_before_order_submission');
      }

      const eventPrice = decimal(input.event.price, 'event price');
      if (!order.limitPrice || eventPrice.gt(order.limitPrice)) {
        return skipped('limit_price_not_reached');
      }
      if (order.asset.assetType !== AssetType.crypto) {
        const trading = getAssetTradingStatus(
          { assetType: order.asset.assetType, market: order.asset.market },
          new Date(input.event.providerEventAt),
        );
        if (!trading.tradable) return skipped(trading.reason.toLowerCase());
      }
      if (!order.reservedAmount || !order.reservationFeeRate) {
        throw new LimitOrderExecutionError(
          'LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT',
          'Limit order reservation basis is missing.',
        );
      }

      let amounts: LimitOrderExecutionAmounts;
      try {
        amounts = calculateLimitOrderExecutionAmounts({
          eventPrice,
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
      const { grossAmount, feeAmount, actualDebit } = amounts;

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

      const evidence = await this.ensureEvidenceSnapshot(tx, input.event);
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
          executedPrice: formatDecimalScale(eventPrice, monetaryScale),
          grossAmount: formatDecimalScale(grossAmount, monetaryScale),
          feeAmount: formatDecimalScale(feeAmount, monetaryScale),
          netAmount: formatDecimalScale(actualDebit, monetaryScale),
          assetPriceSnapshotId: evidence.id,
          executedAt: matchedAt,
          reservationReleasedAt: matchedAt,
          cancelReason: null,
          rejectedAt: null,
          rejectReason: null,
          triggerEventId: input.event.eventId,
          triggerEventAt: new Date(input.event.providerEventAt),
          matchedAt,
          matchingSource: 'live_trade_event',
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

function skipped(reason: string): LimitOrderExecutionResult {
  return { state: 'skipped', reason };
}
