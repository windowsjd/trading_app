import { Injectable } from '@nestjs/common';
import { AssetType, OrderSide, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  resolveRegularSessionForEvent,
  type MarketCalendarAsset,
} from './market-calendar.policy';
import {
  firstEligibleCandleOpen,
  isCandleWithinLookback,
} from './limit-order-candle-policy';

const CANDLE_INTERVAL = '5m';
const EXECUTION_PRICE_POLICY = 'limit_price';
const EVIDENCE_POLICY_VERSION = 1;

/**
 * A closed 5-minute candle that is a valid path-B trigger source for an asset:
 * it is closed, within the lookback window, and (for stocks) its whole window
 * lies inside a valid trading session. Whether it actually fills a given order
 * still depends on that order's firstEligibleCandleOpen, season endAt, and
 * limit price — see {@link LimitOrderCandleEvidenceService.selectTriggerCandleForOrder}.
 */
export type EligibleClosedCandle = {
  marketCandleId: string;
  openTime: Date;
  closeTime: Date;
  low: Prisma.Decimal;
  high?: Prisma.Decimal;
  sourceProvider: string;
  sourceUpdatedAt: Date;
  finalizedAt: Date;
};

export type CandleTriggerOrder = {
  submittedAt: Date;
  limitPrice: Prisma.Decimal;
  side?: OrderSide;
  /** Season.endAt of the order's season — no candle may close after it (§17). */
  seasonEndAt: Date | null;
};

/**
 * Path-B closed-candle evidence: it decides which closed 5m candle (if any)
 * proves an order's limit was touched, and persists ONE shared evidence row
 * per candle window. It never reads a provider price and never fills an order;
 * the caller (execution service) records the fill.
 */
@Injectable()
export class LimitOrderCandleEvidenceService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Closed 5m candles usable as path-B triggers for an asset RIGHT NOW: closed,
   * within the lookback window, and — for stocks — with the whole window inside
   * a valid trading session (holiday / calendar-gap candles are excluded,
   * fail-closed). Crypto has no session and keeps every closed candle in range.
   * Ordered oldest-first so the earliest eligible candle is picked per order.
   */
  async findEligibleClosedCandlesForAsset(
    asset: MarketCalendarAsset & { id: string },
    now: Date,
    lookbackMs: number,
  ): Promise<EligibleClosedCandle[]> {
    const lookbackFloor = new Date(now.getTime() - lookbackMs);
    const rows = await this.prisma.marketCandle.findMany({
      where: {
        assetId: asset.id,
        interval: CANDLE_INTERVAL,
        isClosed: true,
        openTime: { gte: lookbackFloor, lte: now },
      },
      orderBy: [{ openTime: 'asc' }],
      select: {
        id: true,
        openTime: true,
        closeTime: true,
        low: true,
        high: true,
        sourceProvider: true,
        sourceUpdatedAt: true,
        updatedAt: true,
      },
    });

    const isStock =
      asset.assetType === AssetType.domestic_stock ||
      asset.assetType === AssetType.us_stock;

    const eligible: EligibleClosedCandle[] = [];
    for (const row of rows) {
      if (!isCandleWithinLookback(row.openTime, now, lookbackMs)) continue;

      if (isStock) {
        // The whole window must lie inside one valid session. A candle whose
        // open is outside a session (holiday, pre/post market, uncovered
        // calendar) or whose close spills past the session close is not used.
        const session = resolveRegularSessionForEvent(asset, row.openTime);
        if (!session) continue;
        if (row.closeTime.getTime() > session.closeTime.getTime()) continue;
      }

      eligible.push({
        marketCandleId: row.id,
        openTime: row.openTime,
        closeTime: row.closeTime,
        low: row.low,
        high: row.high,
        sourceProvider: row.sourceProvider,
        sourceUpdatedAt: row.sourceUpdatedAt,
        finalizedAt: row.updatedAt,
      });
    }
    return eligible;
  }

  /**
   * The earliest closed candle that triggers a fill for one order, or null.
   * A candle triggers when: its window opened at/after the order's first
   * eligible boundary (never the partial candle the order was submitted into),
   * it closes no later than the order's season endAt, and its low reached the
   * limit price. `candles` must be the oldest-first list from
   * {@link findEligibleClosedCandlesForAsset}.
   */
  selectTriggerCandleForOrder(
    candles: readonly EligibleClosedCandle[],
    order: CandleTriggerOrder,
  ): EligibleClosedCandle | null {
    const firstEligibleOpenMs = firstEligibleCandleOpen(
      order.submittedAt,
    ).getTime();
    for (const candle of candles) {
      if (candle.openTime.getTime() < firstEligibleOpenMs) continue;
      // §17: no candle that closes after the season end may fill.
      if (
        order.seasonEndAt &&
        candle.closeTime.getTime() > order.seasonEndAt.getTime()
      ) {
        continue;
      }
      if (
        ((order.side ?? OrderSide.buy) === OrderSide.buy &&
          candle.low.lte(order.limitPrice)) ||
        (order.side === OrderSide.sell &&
          candle.high?.gte(order.limitPrice) === true)
      ) {
        return candle;
      }
    }
    return null;
  }

  /**
   * Persists (or reuses) the shared evidence row for a candle window inside the
   * fill transaction. Identity is (asset, interval, window, provider): every
   * order the same candle fills references the same row. The row denormalizes
   * the candle facts so the fill stays reproducible after retention removes the
   * candle. The per-order execution price is NOT stored here — it is the
   * order's own limitPrice (Order.executedPrice); this row records only the
   * touch evidence and the fill-price policy.
   */
  async findOrCreateEvidenceInTransaction(
    tx: Prisma.TransactionClient,
    candle: EligibleClosedCandle,
    assetId: string,
  ): Promise<string> {
    const evidence = await tx.limitOrderCandleEvidence.upsert({
      where: {
        assetId_interval_openTime_provider: {
          assetId,
          interval: CANDLE_INTERVAL,
          openTime: candle.openTime,
          provider: candle.sourceProvider,
        },
      },
      create: {
        marketCandleId: candle.marketCandleId,
        assetId,
        interval: CANDLE_INTERVAL,
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        triggerLowPrice: candle.low,
        triggerHighPrice: candle.high ?? null,
        executionPricePolicy: EXECUTION_PRICE_POLICY,
        provider: candle.sourceProvider,
        sourceName: candle.sourceProvider,
        sourceUpdatedAt: candle.sourceUpdatedAt,
        finalizedAt: candle.finalizedAt,
        policyVersion: EVIDENCE_POLICY_VERSION,
      },
      update: { triggerHighPrice: candle.high ?? undefined },
      select: { id: true },
    });
    return evidence.id;
  }
}
