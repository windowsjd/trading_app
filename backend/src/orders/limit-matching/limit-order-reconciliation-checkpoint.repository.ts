import { Injectable } from '@nestjs/common';
import {
  OrderSide,
  OrderStatus,
  OrderType,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LIMIT_ORDER_CANDLE_INTERVAL } from './limit-order-candle-eligibility';

/**
 * Durable state for the path-B sweep: the scan WATERMARKS and the DEFERRED
 * retry queue.
 *
 * TWO WATERMARKS, TWO JOBS
 * ------------------------
 * 1. INGEST-SEQUENCE watermark (`watermarkIngestSeq`) — the position the
 *    forward scan actually reads from. It is a position in the STORAGE order of
 *    candle rows (`market_candles.ingest_seq`, assigned by a database trigger),
 *    so a row written long after its market window closed still sorts after the
 *    watermark and is still scanned. Its invariant is:
 *
 *      every closed 5m candle whose ingest sequence is at or before the
 *      watermark has either a processed-candle row, or a deferred-candle row,
 *      or provably no order that could ever match it.
 *
 * 2. MARKET-TIME watermark (`watermarkOpenTime`, `watermarkCandleId`) — the
 *    position in the canonical `(openTime, id)` ordering the sweep has reached.
 *    It no longer gates the scan. It remains the bootstrap anchor and the
 *    retention-gap marker: "how far back in MARKET time is the sweep still
 *    responsible for" is the question retention answers against, and a storage
 *    position cannot answer it.
 *
 * Using the market-time position as the scan gate is what made a late-stored
 * candle unreachable: its openTime lies before a watermark that other assets'
 * on-time rows had already pushed forward, so the scan — which reads strictly
 * after the watermark — never returned it again.
 *
 * "provably no order" is sound because `candleMatchingEligibleFrom` is rounded
 * UP to the next 5-minute boundary at Create time: an order can never become
 * eligible for a window that had already closed when it was submitted. So a
 * window the sweep swept past with no eligible order can never acquire one
 * later, and stepping over it loses nothing.
 *
 * TWO-PHASE ADVANCE
 * -----------------
 * A sequence value is assigned when a row is INSERTED but only becomes visible
 * when its transaction COMMITS, so the highest value a run can see may still
 * have uncommitted holes below it. Advancing straight to it would step over a
 * row that commits a moment later. The highest observed value is therefore
 * recorded as PENDING and only becomes eligible as a ceiling on a later run,
 * once every write transaction that was in flight at the observation has
 * demonstrably resolved.
 */

export const LIMIT_ORDER_RECONCILIATION_SCOPE: string =
  LIMIT_ORDER_CANDLE_INTERVAL;

export type ReconciliationWatermark = {
  openTime: Date;
  /** NULL when the position is a pure time bound (bootstrap / gap re-anchor). */
  candleId: string | null;
};

/**
 * Storage-order position plus the two-phase advance state that guards it.
 * `pendingSeq` is the highest sequence value a previous run OBSERVED;
 * `pendingObservedAt` is the database clock at that observation.
 */
export type ReconciliationIngestPosition = {
  watermarkSeq: bigint | null;
  pendingSeq: bigint | null;
  pendingObservedAt: Date | null;
  lastScannedSeq: bigint | null;
};

export type ReconciliationCheckpoint = {
  scope: string;
  interval: string;
  watermark: ReconciliationWatermark | null;
  ingest: ReconciliationIngestPosition;
  lastScannedOpenTime: Date | null;
  lastScannedCloseTime: Date | null;
  /** ROW-SCAN heartbeat only; window completion has its own pair below. */
  lastRunAt: Date | null;
  lastSuccessfulRunAt: Date | null;
  /**
   * WINDOW-COMPLETION heartbeat, recorded independently of the row scan so a
   * completion pass that keeps failing can never hide behind a healthy
   * row-scan heartbeat. `successfulAt` moves ONLY when a pass completed
   * without throwing.
   */
  lastWindowCompletionRunAt: Date | null;
  lastWindowCompletionSuccessfulAt: Date | null;
  windowCompletionErrorCode: string | null;
  windowCompletionErrorMessage: string | null;
  windowCompletionConsecutiveFailures: number;
  degradedReason: string | null;
  gapDetectedAt: Date | null;
  gapFromOpenTime: Date | null;
  gapToOpenTime: Date | null;
  reservationMismatchCount: number;
  lastReservationMismatchAt: Date | null;
};

export type DeferredCandleRow = {
  marketCandleId: string;
  /**
   * Candle revision (MarketCandle.ingestSeq) this entry tracks. NULL only on
   * rows that predate the column and whose candle row no longer exists (the
   * backfill stamped every row whose candle survived); read as "unknown =
   * lowest", so any concrete revision replaces it.
   */
  candleIngestSeq: bigint | null;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  status: string;
  firstDeferredAt: Date;
  lastDeferredAt: Date;
  attemptCount: number;
  lastErrorCode: string | null;
  nextRetryAt: Date;
};

export type DeferredBacklog = {
  openCount: number;
  permanentCount: number;
  oldestFirstDeferredAt: Date | null;
};

/** Per-asset queue state for the ASSET-scoped health gate. */
export type AssetDeferredBacklog = {
  deferredCount: number;
  permanentCount: number;
  oldestDeferredAt: Date | null;
  oldestPermanentAt: Date | null;
};

@Injectable()
export class LimitOrderReconciliationCheckpointRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    scope = LIMIT_ORDER_RECONCILIATION_SCOPE,
  ): Promise<ReconciliationCheckpoint | null> {
    const row = await this.prisma.limitOrderReconciliationCheckpoint.findUnique(
      { where: { scope } },
    );
    if (!row) return null;
    return {
      scope: row.scope,
      interval: row.interval,
      watermark: row.watermarkOpenTime
        ? { openTime: row.watermarkOpenTime, candleId: row.watermarkCandleId }
        : null,
      ingest: {
        watermarkSeq: row.watermarkIngestSeq,
        pendingSeq: row.pendingIngestSeq,
        pendingObservedAt: row.pendingIngestSeqObservedAt,
        lastScannedSeq: row.lastScannedIngestSeq,
      },
      lastScannedOpenTime: row.lastScannedOpenTime,
      lastScannedCloseTime: row.lastScannedCloseTime,
      lastRunAt: row.lastRunAt,
      lastSuccessfulRunAt: row.lastSuccessfulRunAt,
      lastWindowCompletionRunAt: row.lastWindowCompletionRunAt,
      lastWindowCompletionSuccessfulAt: row.lastWindowCompletionSuccessfulAt,
      windowCompletionErrorCode: row.windowCompletionErrorCode,
      windowCompletionErrorMessage: row.windowCompletionErrorMessage,
      windowCompletionConsecutiveFailures:
        row.windowCompletionConsecutiveFailures,
      degradedReason: row.degradedReason,
      gapDetectedAt: row.gapDetectedAt,
      gapFromOpenTime: row.gapFromOpenTime,
      gapToOpenTime: row.gapToOpenTime,
      reservationMismatchCount: row.reservationMismatchCount,
      lastReservationMismatchAt: row.lastReservationMismatchAt,
    };
  }

  /**
   * Creates the checkpoint row if it does not exist yet. Concurrent creators
   * are safe: the loser of the primary-key race simply reads the winner's row.
   */
  async ensure(input: {
    scope?: string;
    watermark: ReconciliationWatermark | null;
    ingestWatermarkSeq: bigint;
    pendingIngestSeq: bigint | null;
    pendingIngestSeqObservedAt: Date | null;
    now: Date;
  }): Promise<ReconciliationCheckpoint> {
    const scope = input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    await this.prisma.limitOrderReconciliationCheckpoint
      .create({
        data: {
          scope,
          interval: LIMIT_ORDER_CANDLE_INTERVAL,
          watermarkOpenTime: input.watermark?.openTime ?? null,
          watermarkCandleId: input.watermark?.candleId ?? null,
          watermarkIngestSeq: input.ingestWatermarkSeq,
          pendingIngestSeq: input.pendingIngestSeq,
          pendingIngestSeqObservedAt: input.pendingIngestSeqObservedAt,
          lastRunAt: input.now,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintError(error)) return undefined;
        throw error;
      });
    const checkpoint = await this.find(scope);
    if (!checkpoint) {
      throw new Error('Limit-order reconciliation checkpoint is missing.');
    }
    return checkpoint;
  }

  /**
   * Initializes the storage-order position on a checkpoint that predates it.
   *
   * A row written before the ingest-sequence columns existed carries NULL, and
   * NULL cannot be distinguished from "at the very beginning" by the scan. It
   * is adopted at 0 — deliberately the most conservative value, so the first
   * runs re-examine the whole sequence and RECOVER any candle the old
   * market-time watermark had already stepped over. Already-processed rows are
   * excluded by the scan's own filters, so the catch-up costs index walk, not
   * duplicate work, and each run stays bounded by `candleBatchSize`.
   *
   * Only ever writes when the column is still NULL, so it can never pull a
   * live position backwards.
   */
  async adoptIngestWatermark(input: {
    scope?: string;
    seq: bigint;
  }): Promise<boolean> {
    const scope = input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    const updated = await this.prisma.$executeRaw`
      UPDATE "limit_order_reconciliation_checkpoints"
      SET "watermark_ingest_seq" = ${seqParam(input.seq)}::bigint,
          "updated_at" = CURRENT_TIMESTAMP
      WHERE "scope" = ${scope}
        AND "watermark_ingest_seq" IS NULL
    `;
    return updated > 0;
  }

  /**
   * Advances the storage-order position MONOTONICALLY. A concurrent runner
   * that already moved further must never be pulled back.
   */
  async advanceIngestWatermark(input: {
    scope?: string;
    seq: bigint;
    lastScannedSeq: bigint | null;
  }): Promise<void> {
    const scope = input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    await this.prisma.$executeRaw`
      UPDATE "limit_order_reconciliation_checkpoints"
      SET
        "watermark_ingest_seq" = ${seqParam(input.seq)}::bigint,
        -- GREATEST ignores NULLs, so a run that scanned nothing keeps the
        -- previous high-water mark instead of erasing it.
        "last_scanned_ingest_seq" = GREATEST(
          "last_scanned_ingest_seq",
          ${seqParam(input.lastScannedSeq)}::bigint
        ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "scope" = ${scope}
        AND (
          "watermark_ingest_seq" IS NULL
          OR "watermark_ingest_seq" < ${seqParam(input.seq)}::bigint
        )
    `;
  }

  /**
   * Records the highest sequence value this run OBSERVED, with the database
   * clock at the observation. Monotonic: an older observation must never
   * overwrite a newer one, or the two-phase guard would let the ceiling move
   * backwards and then forwards again across concurrent runners.
   */
  async recordPendingIngestSeq(input: {
    scope?: string;
    seq: bigint;
    observedAt: Date;
  }): Promise<void> {
    const scope = input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    await this.prisma.$executeRaw`
      UPDATE "limit_order_reconciliation_checkpoints"
      SET
        "pending_ingest_seq" = ${seqParam(input.seq)}::bigint,
        "pending_ingest_seq_observed_at" = ${input.observedAt},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "scope" = ${scope}
        AND (
          "pending_ingest_seq" IS NULL
          OR "pending_ingest_seq" < ${seqParam(input.seq)}::bigint
        )
    `;
  }

  /**
   * Advances the watermark MONOTONICALLY. A concurrent runner that already
   * moved the position further must never be pulled back, so the update is
   * conditional on the stored position still being at or before the new one.
   */
  async advanceWatermark(input: {
    scope?: string;
    watermark: ReconciliationWatermark;
    lastScannedOpenTime: Date | null;
    lastScannedCloseTime: Date | null;
  }): Promise<void> {
    const scope = input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    await this.prisma.$executeRaw`
      UPDATE "limit_order_reconciliation_checkpoints"
      SET
        "watermark_open_time" = ${input.watermark.openTime},
        "watermark_candle_id" = ${input.watermark.candleId},
        "last_scanned_open_time" = ${input.lastScannedOpenTime},
        "last_scanned_close_time" = ${input.lastScannedCloseTime},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "scope" = ${scope}
        AND (
          "watermark_open_time" IS NULL
          OR "watermark_open_time" < ${input.watermark.openTime}
          OR (
            "watermark_open_time" = ${input.watermark.openTime}
            AND COALESCE("watermark_candle_id", '') <= ${input.watermark.candleId ?? ''}
          )
        )
    `;
  }

  async markRunStarted(now: Date, scope?: string): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: { lastRunAt: now },
    });
  }

  /**
   * ROW-SCAN success only. This heartbeat says "the sweep over candle rows
   * that exist completed"; it deliberately says NOTHING about the
   * window-completion pass, which records its own heartbeat below — a
   * completion failure must never be laundered into overall success.
   */
  async markRunSucceeded(now: Date, scope?: string): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: { lastRunAt: now, lastSuccessfulRunAt: now },
    });
  }

  async markWindowCompletionStarted(now: Date, scope?: string): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: { lastWindowCompletionRunAt: now },
    });
  }

  async markWindowCompletionSucceeded(
    now: Date,
    scope?: string,
  ): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: {
        lastWindowCompletionSuccessfulAt: now,
        windowCompletionErrorCode: null,
        windowCompletionErrorMessage: null,
        windowCompletionConsecutiveFailures: 0,
      },
    });
  }

  /** Records the failure; `lastWindowCompletionSuccessfulAt` is NOT touched. */
  async markWindowCompletionFailed(input: {
    now: Date;
    errorCode: string;
    errorMessage: string | null;
    scope?: string;
  }): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: {
        windowCompletionErrorCode: input.errorCode,
        windowCompletionErrorMessage:
          input.errorMessage?.slice(0, 1000) ?? null,
        windowCompletionConsecutiveFailures: { increment: 1 },
      },
    });
  }

  /**
   * Records a retention gap. STICKY: the first detection wins and is never
   * overwritten or cleared by the sweep, because candles that retention
   * removed before path B examined them cannot be recovered — only an operator
   * can decide the exposure is settled.
   */
  async recordGap(input: {
    scope?: string;
    detectedAt: Date;
    fromOpenTime: Date | null;
    toOpenTime: Date | null;
    reason: string;
  }): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: {
        scope: input.scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE,
        gapDetectedAt: null,
      },
      data: {
        gapDetectedAt: input.detectedAt,
        gapFromOpenTime: input.fromOpenTime,
        gapToOpenTime: input.toOpenTime,
        degradedReason: input.reason,
      },
    });
  }

  async recordReservationMismatch(now: Date, scope?: string): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: {
        reservationMismatchCount: { increment: 1 },
        lastReservationMismatchAt: now,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Deferred queue
  // -------------------------------------------------------------------------

  /**
   * Enqueues or re-schedules a candle the sweep could not finish. This MUST
   * succeed before the watermark is allowed to pass the candle: the durable
   * row is the only thing that keeps the retry alive once the position moves.
   *
   * REVISION-AWARE, decided atomically inside one conditional upsert against
   * the STORED row (a read-then-write pair would race a concurrent runner):
   *
   *   incoming revision > stored   REVISION REPLACEMENT. The entry is
   *                                re-pointed at the new revision: candle
   *                                metadata (asset/interval/window) adopted,
   *                                status set from the caller (reactivating a
   *                                PERMANENT entry back to retryable),
   *                                attempt budget restarted at 1, error
   *                                fields replaced, and firstDeferredAt reset
   *                                so backlog age describes the revision
   *                                actually being retried. A NULL stored
   *                                revision reads as "unknown = lowest".
   *   incoming revision = stored   RETRY. attemptCount increments,
   *                                firstDeferredAt is preserved,
   *                                lastDeferredAt/nextRetryAt/error move. An
   *                                incoming NULL (candle row gone) also lands
   *                                here and never erases a stored revision.
   *   incoming revision < stored   NO-OP. A late callback for a superseded
   *                                revision must not overwrite the newer
   *                                entry's state.
   */
  async upsertDeferred(input: {
    marketCandleId: string;
    candleIngestSeq: bigint | null;
    assetId: string;
    interval: string;
    openTime: Date;
    closeTime: Date;
    now: Date;
    nextRetryAt: Date;
    errorCode: string | null;
    errorMessage: string | null;
    status?: 'deferred' | 'permanent';
  }): Promise<void> {
    const message = input.errorMessage?.slice(0, 1000) ?? null;
    const status = input.status ?? 'deferred';
    await this.prisma.$executeRaw`
      INSERT INTO "limit_order_deferred_candles" AS d (
        "market_candle_id", "candle_ingest_seq", "asset_id", "interval",
        "open_time", "close_time", "status", "first_deferred_at",
        "last_deferred_at", "attempt_count", "last_error_code",
        "last_error_message", "next_retry_at", "created_at", "updated_at"
      ) VALUES (
        ${input.marketCandleId},
        ${seqParam(input.candleIngestSeq)}::bigint,
        ${input.assetId},
        ${input.interval},
        ${input.openTime},
        ${input.closeTime},
        ${status},
        ${input.now},
        ${input.now},
        1,
        ${input.errorCode},
        ${message},
        ${input.nextRetryAt},
        ${input.now},
        ${input.now}
      )
      ON CONFLICT ("market_candle_id") DO UPDATE SET
        "candle_ingest_seq" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."candle_ingest_seq"
          ELSE d."candle_ingest_seq"
        END,
        "asset_id" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."asset_id" ELSE d."asset_id"
        END,
        "interval" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."interval" ELSE d."interval"
        END,
        "open_time" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."open_time" ELSE d."open_time"
        END,
        "close_time" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."close_time" ELSE d."close_time"
        END,
        "first_deferred_at" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."first_deferred_at" ELSE d."first_deferred_at"
        END,
        "attempt_count" = CASE
          WHEN EXCLUDED."candle_ingest_seq" IS NOT NULL
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN 1 ELSE d."attempt_count" + 1
        END,
        "status" = EXCLUDED."status",
        "last_deferred_at" = EXCLUDED."last_deferred_at",
        "last_error_code" = EXCLUDED."last_error_code",
        "last_error_message" = EXCLUDED."last_error_message",
        "next_retry_at" = EXCLUDED."next_retry_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE NOT (
        EXCLUDED."candle_ingest_seq" IS NOT NULL
        AND d."candle_ingest_seq" IS NOT NULL
        AND EXCLUDED."candle_ingest_seq" < d."candle_ingest_seq"
      )
    `;
  }

  /** Due, still-retryable deferrals, oldest window first. */
  findDueDeferred(input: {
    now: Date;
    limit: number;
  }): Promise<DeferredCandleRow[]> {
    return this.prisma.limitOrderDeferredCandle.findMany({
      where: { status: 'deferred', nextRetryAt: { lte: input.now } },
      orderBy: [{ openTime: 'asc' }, { marketCandleId: 'asc' }],
      take: input.limit,
      select: {
        marketCandleId: true,
        candleIngestSeq: true,
        assetId: true,
        interval: true,
        openTime: true,
        closeTime: true,
        status: true,
        firstDeferredAt: true,
        lastDeferredAt: true,
        attemptCount: true,
        lastErrorCode: true,
        nextRetryAt: true,
      },
    });
  }

  /**
   * Removes the queue entry after the candle was processed.
   *
   * Revision-guarded: only entries at or below the revision that was actually
   * processed (or with an unknown NULL revision) are removed. A concurrent
   * runner that already re-pointed the entry at a HIGHER revision keeps its
   * entry — deleting it would silently drop the newer revision's retry.
   */
  async resolveDeferred(
    marketCandleId: string,
    processedIngestSeq?: bigint | null,
  ): Promise<void> {
    await this.prisma.limitOrderDeferredCandle.deleteMany({
      where:
        processedIngestSeq === undefined || processedIngestSeq === null
          ? { marketCandleId }
          : {
              marketCandleId,
              OR: [
                { candleIngestSeq: null },
                { candleIngestSeq: { lte: processedIngestSeq } },
              ],
            },
    });
  }

  async isDeferred(marketCandleId: string): Promise<boolean> {
    const row = await this.prisma.limitOrderDeferredCandle.findUnique({
      where: { marketCandleId },
      select: { marketCandleId: true },
    });
    return row !== null;
  }

  /**
   * The asset's window-completion checkpoint, read for the asset-scoped
   * health gate. Interval-fixed to the path-B 5m scope.
   */
  async findWindowCompletion(assetId: string): Promise<{
    pendingWindowOpenTime: Date | null;
    pendingSince: Date | null;
    lastErrorCode: string | null;
    degradedReason: string | null;
    gapDetectedAt: Date | null;
  } | null> {
    return this.prisma.marketCandleFinalizationCheckpoint.findUnique({
      where: {
        assetId_interval: {
          assetId,
          interval: LIMIT_ORDER_RECONCILIATION_SCOPE,
        },
      },
      select: {
        pendingWindowOpenTime: true,
        pendingSince: true,
        lastErrorCode: true,
        degradedReason: true,
        gapDetectedAt: true,
      },
    });
  }

  /**
   * One asset's queue state for the ASSET-scoped health gate: deferred and
   * permanent counts plus the age anchors, in a single round trip.
   */
  async readAssetBacklog(assetId: string): Promise<AssetDeferredBacklog> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        deferredCount: number;
        permanentCount: number;
        oldestDeferredAt: Date | null;
        oldestPermanentAt: Date | null;
      }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'deferred')::int AS "deferredCount",
        COUNT(*) FILTER (WHERE "status" = 'permanent')::int AS "permanentCount",
        MIN("first_deferred_at") FILTER (WHERE "status" = 'deferred') AS "oldestDeferredAt",
        MIN("first_deferred_at") FILTER (WHERE "status" = 'permanent') AS "oldestPermanentAt"
      FROM "limit_order_deferred_candles"
      WHERE "asset_id" = ${assetId}
    `;
    const row = rows[0];
    return {
      deferredCount: row?.deferredCount ?? 0,
      permanentCount: row?.permanentCount ?? 0,
      oldestDeferredAt: row?.oldestDeferredAt ?? null,
      oldestPermanentAt: row?.oldestPermanentAt ?? null,
    };
  }

  /**
   * Whether the asset currently has a path-B-activated submitted limit buy.
   * The asset-scoped gate uses this to decide what a MISSING window-completion
   * checkpoint means: nothing is owed without such an order (pass); with one,
   * an absent checkpoint means the safety net never accounted for the asset
   * (fail closed).
   */
  async hasSubmittedPathBOrder(assetId: string): Promise<boolean> {
    const row = await this.prisma.order.findFirst({
      where: {
        assetId,
        orderType: OrderType.limit,
        side: OrderSide.buy,
        status: OrderStatus.submitted,
        candleMatchingEligibleFrom: { not: null },
      },
      select: { id: true },
    });
    return row !== null;
  }

  async readBacklog(): Promise<DeferredBacklog> {
    const [open, permanent, oldest] = await Promise.all([
      this.prisma.limitOrderDeferredCandle.count({
        where: { status: 'deferred' },
      }),
      this.prisma.limitOrderDeferredCandle.count({
        where: { status: 'permanent' },
      }),
      this.prisma.limitOrderDeferredCandle.findFirst({
        orderBy: { firstDeferredAt: 'asc' },
        select: { firstDeferredAt: true },
      }),
    ]);
    return {
      openCount: open,
      permanentCount: permanent,
      oldestFirstDeferredAt: oldest?.firstDeferredAt ?? null,
    };
  }
}

/**
 * Binds a storage-sequence value as TEXT with an explicit `::bigint` cast.
 *
 * A JS `bigint` reaches PostgreSQL through several layers (Prisma's raw-query
 * serializer, then the pg driver), and how each one renders it has changed
 * across versions. The decimal string plus a cast is exact on every one of
 * them, and the cast is a constant expression, so the ingest-sequence index is
 * still used. NULL passes through as a typed NULL.
 */
function seqParam(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function isUniqueConstraintError(error: unknown): boolean {
  return hasPrismaCode(error, 'P2002');
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
