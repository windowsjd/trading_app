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

/**
 * Whether a queue entry's tracked revision was OBSERVED or merely INFERRED.
 * The value alone cannot say: a backfilled revision and an observed one are
 * byte-identical, and a PERMANENT entry carrying an inferred revision silently
 * blocks that revision from both the forward scan and the retry loop.
 */
export type DeferredRevisionState =
  | 'current'
  | 'legacy_unknown'
  | 'legacy_orphan';

/**
 * Provenance-invariant shapes of a queue row, enforced at three layers: this
 * compile-time union, a runtime assertion in `upsertDeferred`, and the DB
 * CHECK constraint `limit_order_deferred_candles_revision_provenance_check`:
 *
 *   current         candleIngestSeq NOT NULL AND revisionVerifiedAt NOT NULL
 *   legacy_unknown  candleIngestSeq NULL AND revisionVerifiedAt NULL
 *   legacy_orphan   revisionVerifiedAt NULL (candleIngestSeq free: a NULL
 *                   when nothing was ever known, or the FORENSIC value the
 *                   row carried when its candle disappeared)
 */
export type UpsertDeferredInput = {
  marketCandleId: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  now: Date;
  nextRetryAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  status?: 'deferred' | 'permanent';
} & (
  | {
      /** This call read `candleIngestSeq` off the loaded candle row. */
      revisionObserved: true;
      candleIngestSeq: bigint;
      revisionState?: 'current';
    }
  | {
      /**
       * Nothing was read off a candle row: `candleIngestSeq` is at most a
       * FORENSIC value preserved from the stored row, never a new
       * observation, and no verification evidence is written.
       */
      revisionObserved: false;
      candleIngestSeq: bigint | null;
      revisionState?: 'legacy_unknown' | 'legacy_orphan';
    }
);

export type DeferredCandleRow = {
  marketCandleId: string;
  /**
   * Candle revision (MarketCandle.ingestSeq) this entry tracks. NULL on rows
   * whose revision was never observed — rows predating the column and rows the
   * provenance migration reset for re-verification. Read as "unknown =
   * lowest", so any concrete revision replaces it and it suppresses nothing.
   */
  candleIngestSeq: bigint | null;
  revisionState: string;
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
  /**
   * Entries whose tracked revision was never observed and that the provenance
   * migration therefore queued for re-verification. Non-zero means this
   * asset's safety net has an unsettled revision question, which is a distinct
   * operator action from an ordinary backlog and gets its own error code.
   */
  legacyReviewCount: number;
  oldestLegacyReviewAt: Date | null;
};

/**
 * A retention finding attributable to exactly ONE asset. Recorded on that
 * asset's window-completion checkpoint instead of the shared reconciliation
 * checkpoint, so the loss blocks that asset's new limit quotes/creates and
 * nothing else.
 */
export type AssetRetentionGap = {
  assetId: string;
  interval?: string;
  detectedAt: Date;
  fromOpenTime: Date | null;
  toOpenTime: Date | null;
  reason: string;
  marketCandleId?: string | null;
  candleIngestSeq?: bigint | null;
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

  /**
   * Records a retention gap against ONE asset's window-completion checkpoint.
   *
   * Why this exists next to `recordGap`: two of the sweep's three retention
   * signals — a deferred entry whose candle row disappeared, and an unscanned
   * matchable candle older than the retention horizon — name exactly one
   * asset. Recording them on the shared checkpoint failed every other asset's
   * new limit orders for a loss they had no part in. Only the sweep's own
   * market-time watermark falling behind retention is genuinely global, and
   * that one still goes through `recordGap`.
   *
   * STICKY, exactly like the global gap: the first detection wins and is never
   * overwritten or cleared here, because retention-removed candles cannot be
   * recovered and only an operator can decide the exposure is settled. Later
   * detections on an already-gapped asset are no-ops, so a re-running sweep
   * (or a new owner) never rewrites the original evidence.
   *
   * The row is created when absent: a gap can be found for an asset the
   * completion supervisor has not bootstrapped yet, and losing the alarm
   * because there was nowhere to put it is the one outcome that must not
   * happen. `finalizedThroughCloseTime` is anchored at the gap window so the
   * cursor cannot claim to have accounted for anything it has not.
   *
   * Returns whether THIS call recorded a new sticky gap ('inserted') or was a
   * no-op because the asset already carried one ('already_exists'). The
   * distinction feeds the sweep summary (`assetGapsDetected` counts genuinely
   * NEW findings, not re-sightings) and the batch-progression logging; it does
   * NOT change the first-detection-wins policy — an existing gap is still
   * never overwritten here.
   */
  async recordAssetGap(
    input: AssetRetentionGap,
  ): Promise<'inserted' | 'already_exists'> {
    const interval = input.interval ?? LIMIT_ORDER_RECONCILIATION_SCOPE;
    const anchor = input.fromOpenTime ?? input.detectedAt;
    const ingestSeq = seqParam(input.candleIngestSeq ?? null);
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "market_candle_finalization_checkpoints" AS f (
        "asset_id", "interval", "finalized_through_close_time",
        "last_evaluated_at", "gap_detected_at", "gap_from_open_time",
        "gap_to_open_time", "gap_reason", "gap_market_candle_id",
        "gap_candle_ingest_seq", "created_at", "updated_at"
      ) VALUES (
        ${input.assetId},
        ${interval},
        ${anchor},
        ${input.detectedAt},
        ${input.detectedAt},
        ${input.fromOpenTime},
        ${input.toOpenTime},
        ${input.reason},
        ${input.marketCandleId ?? null},
        ${ingestSeq}::bigint,
        ${input.detectedAt},
        ${input.detectedAt}
      )
      ON CONFLICT ("asset_id", "interval") DO UPDATE SET
        "gap_detected_at" = EXCLUDED."gap_detected_at",
        "gap_from_open_time" = EXCLUDED."gap_from_open_time",
        "gap_to_open_time" = EXCLUDED."gap_to_open_time",
        "gap_reason" = EXCLUDED."gap_reason",
        "gap_market_candle_id" = EXCLUDED."gap_market_candle_id",
        "gap_candle_ingest_seq" = EXCLUDED."gap_candle_ingest_seq",
        "last_evaluated_at" = EXCLUDED."last_evaluated_at",
        "updated_at" = EXCLUDED."updated_at"
      WHERE f."gap_detected_at" IS NULL
    `;
    // INSERT counts 1; DO UPDATE on a not-yet-gapped row counts 1; a conflict
    // whose WHERE guard rejected the update (gap already present) counts 0.
    return affected > 0 ? 'inserted' : 'already_exists';
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
   * REVISION VALUE AND OBSERVATION PROOF ARE SEPARATE INPUTS. A non-NULL
   * `candleIngestSeq` alone must never be read as "this call observed the
   * revision on a candle row": a caller preserving a FORENSIC value (a
   * missing-candle retry passing the stored sequence back) carries a value it
   * did not observe. `revisionObserved` is the explicit proof bit:
   *
   *   revisionObserved: true    the caller LOADED the candle row and read
   *                             `candleIngestSeq` off it in this call. Only
   *                             these calls may create/refresh trusted
   *                             provenance: revision_state = 'current' and
   *                             revision_verified_at = CURRENT_TIMESTAMP
   *                             (DATABASE clock — the provenance-authority
   *                             timestamp migrations compare against their
   *                             own DB-clock state; an application clock here
   *                             would re-create the clock-skew ambiguity the
   *                             provenance columns exist to remove).
   *   revisionObserved: false   nothing was read off a candle row. The call
   *                             NEVER writes revision_verified_at, never
   *                             promotes to 'current', and never moves the
   *                             stored revision; it may force a legacy state
   *                             (`legacy_orphan` for a re-verification entry
   *                             whose candle disappeared) while preserving
   *                             the stored sequence as forensic evidence.
   *
   * REVISION-AWARE, decided atomically inside one conditional upsert against
   * the STORED row (a read-then-write pair would race a concurrent runner).
   * For an OBSERVED revision:
   *
   *   incoming revision > stored   REVISION REPLACEMENT. The entry is
   *                                re-pointed at the new revision: candle
   *                                metadata (asset/interval/window) adopted,
   *                                status set from the caller (reactivating a
   *                                PERMANENT entry back to retryable),
   *                                attempt budget restarted at 1, error
   *                                fields replaced, firstDeferredAt reset,
   *                                state 'current', verifiedAt stamped. A
   *                                NULL stored revision reads as
   *                                "unknown = lowest", which is how a
   *                                legacy_unknown entry is promoted back to
   *                                trusted once actually re-observed.
   *   incoming revision = stored   RETRY. attemptCount increments,
   *                                firstDeferredAt is preserved,
   *                                lastDeferredAt/nextRetryAt/error move,
   *                                verifiedAt refreshes (this call did
   *                                observe the revision).
   *   incoming revision < stored   NO-OP. A late callback for a superseded
   *                                revision must not overwrite the newer
   *                                entry's state.
   *
   * An UNOBSERVED call only moves retry bookkeeping (status, attempt+1,
   * error, nextRetryAt) and — when forced — the legacy state; stored
   * revision, state (unless forced) and verifiedAt are preserved, so an
   * unverified entry can never be promoted to trusted by an absence, and a
   * legacy_orphan can never acquire a verification timestamp it did not earn.
   *
   * The business timestamps (first/lastDeferredAt, nextRetryAt) stay on the
   * caller's clock — they describe sweep scheduling, not provenance.
   */
  async upsertDeferred(input: UpsertDeferredInput): Promise<void> {
    const message = input.errorMessage?.slice(0, 1000) ?? null;
    const status = input.status ?? 'deferred';
    const observed = input.revisionObserved;
    // NULL means "derive/preserve"; a value forces a legacy state.
    const forcedRevisionState = input.revisionState ?? null;

    // The type narrows these, but callers outside the compiler (tests, JS)
    // must hit the same wall: the invalid combinations below are exactly the
    // rows the DB CHECK constraint rejects, and failing here names the caller
    // instead of surfacing as an opaque constraint violation.
    if (observed) {
      if (input.candleIngestSeq === null) {
        throw new Error(
          'upsertDeferred: an observed revision requires a concrete candleIngestSeq.',
        );
      }
      if (forcedRevisionState !== null && forcedRevisionState !== 'current') {
        throw new Error(
          `upsertDeferred: an observed revision cannot force revisionState '${forcedRevisionState}'.`,
        );
      }
    } else {
      if (forcedRevisionState === 'current') {
        throw new Error(
          "upsertDeferred: revisionState 'current' requires an observed revision.",
        );
      }
      if (
        input.candleIngestSeq !== null &&
        forcedRevisionState === 'legacy_unknown'
      ) {
        throw new Error(
          "upsertDeferred: 'legacy_unknown' carries no revision; pass candleIngestSeq null.",
        );
      }
    }

    await this.prisma.$executeRaw`
      INSERT INTO "limit_order_deferred_candles" AS d (
        "market_candle_id", "candle_ingest_seq", "asset_id", "interval",
        "open_time", "close_time", "status", "first_deferred_at",
        "last_deferred_at", "attempt_count", "last_error_code",
        "last_error_message", "next_retry_at", "revision_state",
        "revision_verified_at", "created_at", "updated_at"
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
        -- Observed inserts are trusted 'current'. Unobserved inserts carry no
        -- proof: the forced legacy state when given, otherwise
        -- 'legacy_unknown' for an unknown revision and 'legacy_orphan' for a
        -- forensic value whose candle this call did not read (the one way an
        -- unobserved insert can hold a concrete sequence).
        CASE
          WHEN ${observed} THEN 'current'
          ELSE COALESCE(
            ${forcedRevisionState},
            CASE
              WHEN ${seqParam(input.candleIngestSeq)}::bigint IS NULL
              THEN 'legacy_unknown' ELSE 'legacy_orphan'
            END
          )
        END,
        CASE WHEN ${observed} THEN CURRENT_TIMESTAMP ELSE NULL END,
        ${input.now},
        ${input.now}
      )
      ON CONFLICT ("market_candle_id") DO UPDATE SET
        "revision_state" = CASE
          WHEN ${forcedRevisionState}::text IS NOT NULL
          THEN ${forcedRevisionState}
          WHEN ${observed} THEN 'current'
          ELSE d."revision_state"
        END,
        -- Verification evidence moves ONLY on observation. A forced legacy
        -- state explicitly drops it (a legacy row has, by definition, no
        -- trusted observation), and an unobserved call preserves whatever
        -- evidence the row already carried.
        "revision_verified_at" = CASE
          WHEN ${forcedRevisionState}::text IS NOT NULL THEN NULL
          WHEN ${observed} THEN CURRENT_TIMESTAMP
          ELSE d."revision_verified_at"
        END,
        "candle_ingest_seq" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."candle_ingest_seq"
          -- A forced legacy_unknown carries no revision (DB CHECK); a forced
          -- legacy_orphan keeps the stored value as forensic evidence.
          WHEN ${forcedRevisionState}::text = 'legacy_unknown' THEN NULL
          ELSE d."candle_ingest_seq"
        END,
        "asset_id" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."asset_id" ELSE d."asset_id"
        END,
        "interval" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."interval" ELSE d."interval"
        END,
        "open_time" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."open_time" ELSE d."open_time"
        END,
        "close_time" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."close_time" ELSE d."close_time"
        END,
        "first_deferred_at" = CASE
          WHEN ${observed}
            AND (d."candle_ingest_seq" IS NULL
              OR EXCLUDED."candle_ingest_seq" > d."candle_ingest_seq")
          THEN EXCLUDED."first_deferred_at" ELSE d."first_deferred_at"
        END,
        "attempt_count" = CASE
          WHEN ${observed}
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
        revisionState: true,
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
    gapReason: string | null;
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
        // The sweep rewrites `degradedReason` on every pass; `gapReason` is
        // the sticky field the gate should quote for a gap.
        degradedReason: true,
        gapDetectedAt: true,
        gapReason: true,
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
        legacyReviewCount: number;
        oldestLegacyReviewAt: Date | null;
      }>
    >`
      SELECT
        COUNT(*) FILTER (WHERE "status" = 'deferred')::int AS "deferredCount",
        COUNT(*) FILTER (WHERE "status" = 'permanent')::int AS "permanentCount",
        MIN("first_deferred_at") FILTER (WHERE "status" = 'deferred') AS "oldestDeferredAt",
        MIN("first_deferred_at") FILTER (WHERE "status" = 'permanent') AS "oldestPermanentAt",
        -- A row is under legacy review when its revision provenance is not
        -- FULLY trusted: a non-current state, OR a 'current' row missing
        -- either half of its proof (concrete revision + verification
        -- evidence). The DB CHECK forbids new rows of the latter shape, but
        -- the gate must also fail closed on data that predates the
        -- constraint or arrives while it is not yet validated.
        COUNT(*) FILTER (
          WHERE "revision_state" <> 'current'
            OR "revision_verified_at" IS NULL
            OR "candle_ingest_seq" IS NULL
        )::int AS "legacyReviewCount",
        MIN("first_deferred_at") FILTER (
          WHERE "revision_state" <> 'current'
            OR "revision_verified_at" IS NULL
            OR "candle_ingest_seq" IS NULL
        ) AS "oldestLegacyReviewAt"
      FROM "limit_order_deferred_candles"
      WHERE "asset_id" = ${assetId}
    `;
    const row = rows[0];
    return {
      deferredCount: row?.deferredCount ?? 0,
      permanentCount: row?.permanentCount ?? 0,
      oldestDeferredAt: row?.oldestDeferredAt ?? null,
      oldestPermanentAt: row?.oldestPermanentAt ?? null,
      legacyReviewCount: row?.legacyReviewCount ?? 0,
      oldestLegacyReviewAt: row?.oldestLegacyReviewAt ?? null,
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
