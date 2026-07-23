import { Injectable, Logger, Optional } from '@nestjs/common';
import { AssetType, MarketCandleSyncMode } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MarketCandleSyncService } from '../../assets/market-candle-sync.service';
import { resolveStockMarketSessionState } from '../market-calendar.policy';
import {
  FIVE_MINUTES_MS,
  LIMIT_ORDER_CANDLE_INTERVAL,
} from './limit-order-candle-eligibility';
import { readLimitOrderCandleReconciliationConfig } from './limit-order-candle-reconciliation.config';

export type WindowCompletionSummary = {
  assetsEvaluated: number;
  windowsFinalized: number;
  windowsNoTrade: number;
  windowsOutsideSession: number;
  windowsRepaired: number;
  windowsPending: number;
  assetGapsDetected: number;
};

type CompletionAsset = {
  assetId: string;
  assetType: AssetType;
  market: string;
  earliestEligibleFrom: Date;
};

type CheckpointRow = {
  assetId: string;
  finalizedThroughCloseTime: Date;
  pendingWindowOpenTime: Date | null;
  pendingSince: Date | null;
  pendingAttemptCount: number;
  gapDetectedAt: Date | null;
};

/**
 * Sticky reason stamped on an asset gap raised by THIS supervisor (retention
 * passed a window whose row was never written), distinct from the reasons the
 * row sweep raises for candles that do exist.
 */
export const WINDOW_COMPLETION_GAP_REASON =
  'candle_retention_passed_unaccounted_window';

/**
 * Path-B WINDOW COMPLETION supervisor.
 *
 * `market_candles.ingest_seq` orders rows that EXIST; this service accounts
 * for windows whose row may be ABSENT. For every asset with an activated
 * path-B order it advances a durable per-asset cursor, in market-time order,
 * over the asset's 5m windows. A window may be passed only when it is
 * ACCOUNTED FOR:
 *
 *   finalized         a canonical closed row exists (the ingest-seq scan
 *                     processes it independently);
 *   no_trade          the provider CONFIRMED coverage of the window and
 *                     returned no candle. "No trades happened" is provider
 *                     evidence, never an inference from our own silence;
 *   outside_session   a stock-market window outside the calendar session;
 *   (bootstrap)       windows before the asset's earliest activated order are
 *                     vacuously complete — eligibility is rounded UP at
 *                     create time, so no earlier window is owed anything.
 *
 * Everything else — feed gap, finalizer failure, failed write, unreachable
 * provider — leaves the FIRST unaccounted window recorded as PENDING with
 * bounded REST-repair retries. The distinction between "no trade" and "no
 * feed" is therefore durable and explicit: a pending window is never recorded
 * as no-trade, and a no-trade window is never left pending.
 *
 * The pending window's AGE feeds the asset-scoped health gate
 * (LIMIT_ORDER_CANDLE_FINALIZER_STALE), and retention passing an unresolved
 * window becomes a sticky per-asset gap (LIMIT_ORDER_CANDLE_ASSET_GAP_
 * DETECTED). One asset's stall gates ONLY that asset; every other asset's
 * cursor and fills keep moving.
 *
 * The ingest-seq scan remains the fill path for rows that exist and is not
 * bounded by this cursor: a path-B fill is evidence-based (a canonical closed
 * row proving the low touched the limit) and pays the LIMIT price regardless
 * of which window fills first, so processing existing rows ahead of a stalled
 * sibling window changes no financial outcome. What this cursor adds is the
 * part the scan structurally cannot do: CONCLUDING something about absence.
 */
@Injectable()
export class LimitOrderWindowCompletionService {
  private readonly logger = new Logger(LimitOrderWindowCompletionService.name);
  private readonly config = readLimitOrderCandleReconciliationConfig();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly sync?: MarketCandleSyncService,
  ) {}

  async supervise(now: Date): Promise<WindowCompletionSummary> {
    const summary: WindowCompletionSummary = {
      assetsEvaluated: 0,
      windowsFinalized: 0,
      windowsNoTrade: 0,
      windowsOutsideSession: 0,
      windowsRepaired: 0,
      windowsPending: 0,
      assetGapsDetected: 0,
    };
    const assets = await this.findCompletionAssets();
    let repairBudget = this.config.completionRepairBudgetPerSweep;
    for (const asset of assets) {
      summary.assetsEvaluated += 1;
      repairBudget = await this.superviseAsset(
        asset,
        now,
        repairBudget,
        summary,
      );
    }
    return summary;
  }

  /** Assets that currently OWE window completion: activated path-B orders. */
  private async findCompletionAssets(): Promise<CompletionAsset[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        assetId: string;
        assetType: AssetType;
        market: string;
        earliestEligibleFrom: Date;
      }>
    >`
      SELECT
        o."asset_id" AS "assetId",
        a."asset_type" AS "assetType",
        a."market",
        MIN(o."candle_matching_eligible_from") AS "earliestEligibleFrom"
      FROM "orders" o
      JOIN "assets" a ON a."id" = o."asset_id"
      WHERE o."order_type" = 'limit'
        AND o."side" = 'buy'
        AND o."status" = 'submitted'
        AND o."candle_matching_eligible_from" IS NOT NULL
        AND a."is_active" = true
      GROUP BY o."asset_id", a."asset_type", a."market"
      ORDER BY o."asset_id" ASC
    `;
    return rows;
  }

  private async superviseAsset(
    asset: CompletionAsset,
    now: Date,
    repairBudget: number,
    summary: WindowCompletionSummary,
  ): Promise<number> {
    const checkpoint = await this.ensureCheckpoint(asset, now);
    // A sticky gap is operator-owned; the cursor does not move under it.
    if (checkpoint.gapDetectedAt) {
      await this.touchEvaluated(asset.assetId, now);
      return repairBudget;
    }

    // Only windows already older than the safety lag are evaluated: the
    // finalizer legitimately needs finalizeGrace + write time, and calling
    // a window "missing" while it is still being written would spend repair
    // budget on nothing.
    const evaluateUpTo = now.getTime() - this.config.watermarkSafetyLagMs;
    let cursor = checkpoint.finalizedThroughCloseTime;
    let pending = {
      openTime: checkpoint.pendingWindowOpenTime,
      since: checkpoint.pendingSince,
      attempts: checkpoint.pendingAttemptCount,
    };
    let advancedTo: Date | null = null;
    let stopReason: { code: string; message: string } | null = null;

    for (let step = 0; step < this.config.completionWindowBatchSize; step++) {
      const openTime = cursor;
      const closeTime = new Date(openTime.getTime() + FIVE_MINUTES_MS);
      if (closeTime.getTime() > evaluateUpTo) break;

      const verdict = await this.accountForWindow(
        asset,
        openTime,
        closeTime,
        repairBudget,
        now,
      );
      if (verdict.state === 'accounted') {
        if (verdict.how === 'finalized') summary.windowsFinalized += 1;
        if (verdict.how === 'no_trade') summary.windowsNoTrade += 1;
        if (verdict.how === 'outside_session')
          summary.windowsOutsideSession += 1;
        if (verdict.repaired) summary.windowsRepaired += 1;
        repairBudget = verdict.repairBudget;
        cursor = closeTime;
        advancedTo = closeTime;
        pending = { openTime: null, since: null, attempts: 0 };
        await this.recordWindowAccounted(
          asset.assetId,
          verdict.how,
          verdict.repaired,
        );
        continue;
      }
      // Unaccountable window: durable pending marker, cursor stops HERE for
      // this asset. Other assets keep going; the sweep keeps going.
      repairBudget = verdict.repairBudget;
      summary.windowsPending += 1;
      const firstSeen =
        pending.openTime?.getTime() === openTime.getTime()
          ? (pending.since ?? now)
          : now;
      pending = {
        openTime,
        since: firstSeen,
        attempts:
          pending.openTime?.getTime() === openTime.getTime()
            ? pending.attempts + (verdict.attempted ? 1 : 0)
            : verdict.attempted
              ? 1
              : 0,
      };
      stopReason = verdict.reason;
      break;
    }

    // Retention passing the still-unaccounted window is an unrecoverable,
    // asset-scoped loss: sticky gap, operator-cleared.
    const retentionHorizon = new Date(
      now.getTime() - this.config.candleRetentionDays * 86_400_000,
    );
    const gapped =
      pending.openTime !== null &&
      pending.openTime.getTime() < retentionHorizon.getTime();
    if (gapped) summary.assetGapsDetected += 1;

    await this.prisma.$executeRaw`
      UPDATE "market_candle_finalization_checkpoints"
      SET
        "finalized_through_close_time" = ${cursor},
        "finalized_through_open_time" = ${new Date(cursor.getTime() - FIVE_MINUTES_MS)},
        "last_evaluated_at" = ${now},
        "last_advanced_at" = COALESCE(
          ${advancedTo === null ? null : now}::timestamptz,
          "last_advanced_at"
        ),
        "pending_window_open_time" = ${pending.openTime}::timestamptz,
        "pending_since" = ${pending.since}::timestamptz,
        "pending_attempt_count" = ${pending.attempts},
        "last_error_code" = ${stopReason?.code ?? null},
        "degraded_reason" = ${stopReason?.message ?? null},
        "gap_detected_at" = CASE
          WHEN "gap_detected_at" IS NOT NULL THEN "gap_detected_at"
          WHEN ${gapped} THEN ${now}::timestamptz
          ELSE NULL
        END,
        "gap_from_open_time" = CASE
          WHEN "gap_detected_at" IS NOT NULL THEN "gap_from_open_time"
          WHEN ${gapped} THEN ${pending.openTime}::timestamptz
          ELSE NULL
        END,
        "gap_to_open_time" = CASE
          WHEN "gap_detected_at" IS NOT NULL THEN "gap_to_open_time"
          WHEN ${gapped} THEN ${retentionHorizon}::timestamptz
          ELSE NULL
        END,
        -- Sticky, unlike "degraded_reason" a few lines above, which this
        -- statement overwrites on every pass with the current stop reason.
        -- An operator clearing a gap needs the reason it was RAISED with.
        "gap_reason" = CASE
          WHEN "gap_detected_at" IS NOT NULL THEN "gap_reason"
          WHEN ${gapped} THEN ${WINDOW_COMPLETION_GAP_REASON}
          ELSE NULL
        END,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "asset_id" = ${asset.assetId}
        AND "interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
        AND "finalized_through_close_time" <= ${cursor}
    `;
    if (gapped && !checkpoint.gapDetectedAt) {
      this.logger.error(
        JSON.stringify({
          event: 'limit_order_asset_window_retention_gap',
          assetId: asset.assetId,
          pendingWindowOpenTime: pending.openTime?.toISOString(),
          retentionHorizon: retentionHorizon.toISOString(),
        }),
      );
    }
    return repairBudget;
  }

  /**
   * One window's verdict. NEVER records no-trade from our own silence: the
   * only no-trade evidence accepted is a provider cursor that CONFIRMED the
   * window's range and returned no candle.
   */
  private async accountForWindow(
    asset: CompletionAsset,
    openTime: Date,
    closeTime: Date,
    repairBudget: number,
    now: Date,
  ): Promise<
    | {
        state: 'accounted';
        how: 'finalized' | 'no_trade' | 'outside_session';
        repaired: boolean;
        repairBudget: number;
      }
    | {
        state: 'pending';
        attempted: boolean;
        reason: { code: string; message: string };
        repairBudget: number;
      }
  > {
    // Stock markets: only calendar-session windows are owed a candle.
    if (asset.assetType !== AssetType.crypto) {
      const session = resolveStockMarketSessionState(
        { assetType: asset.assetType, market: asset.market },
        openTime,
      );
      if (!session || session.state === 'calendar_unavailable') {
        // Cannot even decide whether the window was tradable. Do not advance
        // and do not call it no-trade; a calendar dataset can be added later.
        return {
          state: 'pending',
          attempted: false,
          reason: {
            code: 'LIMIT_ORDER_WINDOW_CALENDAR_UNAVAILABLE',
            message: 'calendar_unavailable',
          },
          repairBudget,
        };
      }
      const current = session.currentSession;
      const inside =
        current !== null &&
        openTime.getTime() >= current.openTime.getTime() &&
        closeTime.getTime() <= current.closeTime.getTime();
      if (!inside) {
        return {
          state: 'accounted',
          how: 'outside_session',
          repaired: false,
          repairBudget,
        };
      }
    }

    if (await this.hasCanonicalClosedRow(asset.assetId, openTime)) {
      return {
        state: 'accounted',
        how: 'finalized',
        repaired: false,
        repairBudget,
      };
    }

    // Row missing. The certifier is a bounded REST repair: either it restores
    // the canonical row, or the provider cursor confirms the range held no
    // candle (explicit no-trade), or the window stays pending.
    if (!this.sync) {
      return {
        state: 'pending',
        attempted: false,
        reason: {
          code: 'LIMIT_ORDER_WINDOW_REPAIR_UNWIRED',
          message: 'candle sync service is not wired',
        },
        repairBudget,
      };
    }
    if (repairBudget <= 0) {
      return {
        state: 'pending',
        attempted: false,
        reason: {
          code: 'LIMIT_ORDER_WINDOW_REPAIR_BUDGET',
          message: 'repair budget exhausted this sweep',
        },
        repairBudget,
      };
    }

    try {
      const result = await this.sync.syncAsset({
        assetId: asset.assetId,
        targets: ['5m'],
        mode: MarketCandleSyncMode.repair,
        from: openTime,
        to: closeTime,
        resume: false,
        now,
        budget: { maxPages: 3, maxRows: 1_000, maxDurationMs: 15_000 },
      });
      const remaining = repairBudget - 1;
      if (await this.hasCanonicalClosedRow(asset.assetId, openTime)) {
        return {
          state: 'accounted',
          how: 'finalized',
          repaired: true,
          repairBudget: remaining,
        };
      }
      const feed = result.feeds.find((entry) => entry.interval === '5m');
      const covered =
        feed?.coverageComplete === true &&
        feed.coveredFrom !== null &&
        feed.coveredTo !== null &&
        feed.coveredFrom.getTime() <= openTime.getTime() &&
        feed.coveredTo.getTime() >= closeTime.getTime();
      if (covered) {
        // Provider evidence: the range was fully served and holds no candle.
        return {
          state: 'accounted',
          how: 'no_trade',
          repaired: false,
          repairBudget: remaining,
        };
      }
      return {
        state: 'pending',
        attempted: true,
        reason: {
          code: feed?.errorCode ?? 'LIMIT_ORDER_WINDOW_UNCONFIRMED',
          message: 'repair produced neither a candle nor confirmed coverage',
        },
        repairBudget: remaining,
      };
    } catch (error) {
      return {
        state: 'pending',
        attempted: true,
        reason: {
          code: 'LIMIT_ORDER_WINDOW_REPAIR_FAILED',
          message: error instanceof Error ? error.name : 'repair failed',
        },
        repairBudget: repairBudget - 1,
      };
    }
  }

  private async hasCanonicalClosedRow(
    assetId: string,
    openTime: Date,
  ): Promise<boolean> {
    const row = await this.prisma.marketCandle.findFirst({
      where: {
        assetId,
        interval: LIMIT_ORDER_CANDLE_INTERVAL,
        openTime,
        isClosed: true,
      },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * Bootstrap: the cursor anchors at the asset's earliest activated order
   * window. Everything before it is vacuously complete — eligibility is
   * rounded UP to the next boundary at create time, so no earlier window can
   * ever owe this asset a fill.
   */
  private async ensureCheckpoint(
    asset: CompletionAsset,
    now: Date,
  ): Promise<CheckpointRow> {
    const existing = await this.findCheckpoint(asset.assetId);
    if (existing) return existing;
    const anchor = alignToWindow(asset.earliestEligibleFrom);
    await this.prisma.marketCandleFinalizationCheckpoint
      .create({
        data: {
          assetId: asset.assetId,
          interval: LIMIT_ORDER_CANDLE_INTERVAL,
          finalizedThroughCloseTime: anchor,
          finalizedThroughOpenTime: new Date(
            anchor.getTime() - FIVE_MINUTES_MS,
          ),
          lastEvaluatedAt: now,
        },
      })
      .catch((error: unknown) => {
        // Concurrent bootstrap: the loser reads the winner's row below.
        if (!isUniqueConstraintError(error)) throw error;
      });
    const checkpoint = await this.findCheckpoint(asset.assetId);
    if (!checkpoint) {
      throw new Error(
        `Window completion checkpoint for ${asset.assetId} is missing.`,
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'limit_order_window_checkpoint_bootstrapped',
        assetId: asset.assetId,
        anchor: anchor.toISOString(),
      }),
    );
    return checkpoint;
  }

  private async findCheckpoint(assetId: string): Promise<CheckpointRow | null> {
    const row = await this.prisma.marketCandleFinalizationCheckpoint.findUnique(
      {
        where: {
          assetId_interval: {
            assetId,
            interval: LIMIT_ORDER_CANDLE_INTERVAL,
          },
        },
        select: {
          assetId: true,
          finalizedThroughCloseTime: true,
          pendingWindowOpenTime: true,
          pendingSince: true,
          pendingAttemptCount: true,
          gapDetectedAt: true,
        },
      },
    );
    return row;
  }

  private async touchEvaluated(assetId: string, now: Date): Promise<void> {
    await this.prisma.marketCandleFinalizationCheckpoint.updateMany({
      where: { assetId, interval: LIMIT_ORDER_CANDLE_INTERVAL },
      data: { lastEvaluatedAt: now },
    });
  }

  private async recordWindowAccounted(
    assetId: string,
    how: 'finalized' | 'no_trade' | 'outside_session',
    repaired: boolean,
  ): Promise<void> {
    const data =
      how === 'no_trade'
        ? { noTradeWindowCount: { increment: 1 } }
        : how === 'outside_session'
          ? { outsideSessionWindowCount: { increment: 1 } }
          : repaired
            ? { repairedWindowCount: { increment: 1 } }
            : null;
    if (!data) return;
    await this.prisma.marketCandleFinalizationCheckpoint.updateMany({
      where: { assetId, interval: LIMIT_ORDER_CANDLE_INTERVAL },
      data,
    });
  }
}

function alignToWindow(value: Date): Date {
  return new Date(
    Math.floor(value.getTime() / FIVE_MINUTES_MS) * FIVE_MINUTES_MS,
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
