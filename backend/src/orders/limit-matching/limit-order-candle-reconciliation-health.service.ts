import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { readLimitOrderCandleReconciliationConfig } from './limit-order-candle-reconciliation.config';
import { LimitOrderReconciliationCheckpointRepository } from './limit-order-reconciliation-checkpoint.repository';

/**
 * Fail-closed gate for NEW limit quotes/creates driven by PATH B state.
 *
 * It is deliberately separate from the path-A matcher gate, and its codes are
 * distinct, because the two failures need different operator responses: a
 * path-A failure means live fills stopped, while a path-B failure means the
 * SAFETY NET under them stopped. An order accepted while the safety net is
 * blind can have its price touched with no fill and no alarm, so new orders
 * stop being accepted — but nothing else does.
 *
 * NEVER blocked by this gate:
 *   - a deployment with path B disabled (the gate is inert)
 *   - a quiet market, or a sweep that simply found no candle to process
 *   - market orders, FX, cancel, season-end / exclusion cleanup
 */
export type LimitOrderCandleReconciliationGateFailure = {
  code: string;
  reason: string;
};

export const LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES = {
  unavailable: 'LIMIT_ORDER_CANDLE_RECONCILIATION_UNAVAILABLE',
  stale: 'LIMIT_ORDER_CANDLE_RECONCILIATION_STALE',
  backlogExceeded: 'LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED',
  gapDetected: 'LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED',
  reservationMismatch: 'LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH',
  // WINDOW-COMPLETION heartbeat, separate from the row-scan heartbeat above:
  // the missing-window supervisor has never succeeded / stopped succeeding.
  // Global by nature — the pass covers every asset with activated orders.
  completionUnavailable: 'LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE',
  completionStale: 'LIMIT_ORDER_CANDLE_COMPLETION_STALE',
  // Asset-scoped codes: the failure names ONE asset's safety net, so only
  // that asset's new quotes/creates are refused. Everything else — other
  // assets, cancel, cleanup, market orders, FX — keeps flowing.
  assetGapDetected: 'LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED',
  assetFinalizerStale: 'LIMIT_ORDER_CANDLE_FINALIZER_STALE',
  assetBacklogExceeded: 'LIMIT_ORDER_CANDLE_ASSET_BACKLOG_EXCEEDED',
  assetPermanentFailure: 'LIMIT_ORDER_CANDLE_ASSET_PERMANENT_FAILURE',
  // Asset-scoped and distinct from an ordinary backlog on purpose: a queue
  // entry whose tracked candle revision was INFERRED by the provenance
  // backfill rather than observed. Until the sweep re-verifies it against the
  // candle's current revision, this asset may have an unexamined correction,
  // and the operator action ("wait for the next sweep, or investigate why it
  // cannot settle") differs from "the queue is too long".
  assetLegacyReviewRequired:
    'LIMIT_ORDER_CANDLE_LEGACY_DEFERRED_REVIEW_REQUIRED',
} as const;

@Injectable()
export class LimitOrderCandleReconciliationHealthService {
  private readonly config = readLimitOrderCandleReconciliationConfig();

  constructor(
    private readonly checkpoints: LimitOrderReconciliationCheckpointRepository,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Fail-closed gate. GLOBAL checks always run; when `assetId` is given, the
   * ASSET-SCOPED checks run as well: that asset's window-completion
   * checkpoint (missing-window gap, stalled finalizer) and its own deferred
   * backlog. A failure on asset X names asset X and blocks only asset X's new
   * quotes/creates — other assets stay tradable.
   */
  async assertAvailable(now = new Date(), assetId?: string): Promise<void> {
    const failure = await this.evaluate(now, assetId);
    if (!failure) return;
    throw new HttpException(
      {
        success: false,
        error: { code: failure.code, message: failure.reason },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async evaluate(
    now = new Date(),
    assetId?: string,
  ): Promise<LimitOrderCandleReconciliationGateFailure | null> {
    if (!this.config.enabled) return null;
    if (assetId) {
      const assetFailure = await this.evaluateAsset(assetId, now);
      if (assetFailure) return assetFailure;
    }

    const checkpoint = await this.checkpoints.find();
    if (!checkpoint) {
      // Path B is enabled but has never completed a bootstrap, so no sweep has
      // ever run. Accepting an order here would rely on a safety net that
      // demonstrably does not exist yet.
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
        reason:
          'The limit-order candle reconciliation checkpoint has not been established.',
      };
    }

    // A retention gap is sticky and operator-cleared: candles were removed
    // before path B examined them and cannot be recovered.
    if (checkpoint.gapDetectedAt) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.gapDetected,
        reason: `Candle reconciliation detected a retention gap at ${checkpoint.gapDetectedAt.toISOString()}: ${
          checkpoint.degradedReason ?? 'unknown reason'
        }.`,
      };
    }

    if (
      checkpoint.reservationMismatchCount >
      this.config.maxReservationMismatchCount
    ) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.reservationMismatch,
        reason: `Candle reconciliation recorded ${checkpoint.reservationMismatchCount} reservation mismatches, above the ${this.config.maxReservationMismatchCount} limit.`,
      };
    }

    // ROW-SCAN runner liveness. `lastSuccessfulRunAt` is written on every
    // completed sweep, including one that legitimately found nothing to do,
    // so a quiet market never trips this — only a scheduler that stopped
    // ticking does.
    const heartbeat = checkpoint.lastSuccessfulRunAt;
    if (!heartbeat) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
        reason:
          'The limit-order candle reconciliation sweep has never completed a run.',
      };
    }
    const age = now.getTime() - heartbeat.getTime();
    if (age > this.config.healthMaxAgeMs) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.stale,
        reason: `The candle reconciliation sweep last completed ${age}ms ago, above the ${this.config.healthMaxAgeMs}ms limit.`,
      };
    }

    // WINDOW-COMPLETION liveness, checked SEPARATELY: the missing-window
    // supervisor records its own heartbeat, and a pass that keeps failing
    // must block new orders even while the row scan above stays perfectly
    // healthy. `lastWindowCompletionRunAt` doubles as the wiring signal — a
    // deployment that has never even started a completion pass while the row
    // scan is alive means the supervisor is not running, which is exactly
    // the "safety net is blind to absent rows" condition.
    const completionHeartbeat = checkpoint.lastWindowCompletionSuccessfulAt;
    if (!completionHeartbeat) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionUnavailable,
        reason:
          'The limit-order window completion pass has never completed successfully.',
      };
    }
    // A failed pass is an outage NOW, even when the previous success is still
    // inside the age window. Looking only at the success timestamp would keep
    // admitting new orders for up to `completionHealthMaxAgeMs` after the
    // supervisor just proved it could not account for missing windows. The
    // failure counter/error are the normal durable signal; runAt > successfulAt
    // is the fail-closed fallback when persisting the detailed failure itself
    // failed after markWindowCompletionStarted() committed.
    const completionRunFailed =
      checkpoint.windowCompletionConsecutiveFailures > 0 ||
      checkpoint.windowCompletionErrorCode !== null ||
      (checkpoint.lastWindowCompletionRunAt !== null &&
        checkpoint.lastWindowCompletionRunAt.getTime() >
          completionHeartbeat.getTime());
    if (completionRunFailed) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionUnavailable,
        reason: `The latest window completion pass failed (${
          checkpoint.windowCompletionErrorCode ?? 'completion did not finish'
        }, ${checkpoint.windowCompletionConsecutiveFailures} consecutive failure(s)).`,
      };
    }
    const completionAge = now.getTime() - completionHeartbeat.getTime();
    if (completionAge > this.config.completionHealthMaxAgeMs) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionStale,
        reason: `The window completion pass last succeeded ${completionAge}ms ago (${
          checkpoint.windowCompletionErrorCode ?? 'no recorded error'
        }, ${checkpoint.windowCompletionConsecutiveFailures} consecutive failure(s)), above the ${this.config.completionHealthMaxAgeMs}ms limit.`,
      };
    }

    // A degraded reason that is not a gap (permanently parked work, a
    // repeatedly failing dependency) still means the safety net is not whole.
    if (checkpoint.degradedReason) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
        reason: `Candle reconciliation is degraded: ${checkpoint.degradedReason}.`,
      };
    }

    // EMERGENCY GLOBAL tier only. Per-asset failures (a permanent entry, an
    // over-age deferral, a per-asset backlog) are contained by the
    // asset-scoped gate below and deliberately do NOT appear here: one
    // asset's stuck candle must not block every other asset's new orders.
    // What remains global is total queue size threatening system capacity.
    const backlog = await this.checkpoints.readBacklog();
    const total = backlog.openCount + backlog.permanentCount;
    if (total > this.config.maxDeferredBacklog) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
        reason: `Candle reconciliation has ${total} deferred/permanent candle(s) across all assets, above the emergency ${this.config.maxDeferredBacklog} limit.`,
      };
    }

    return null;
  }

  /**
   * Asset-scoped verdict from the window-completion checkpoint plus the
   * asset's own deferred/permanent queue entries.
   *
   * A MISSING checkpoint passes ONLY while the asset has no activated path-B
   * order: nothing is owed to any window that closed before the first order
   * (eligibility is rounded UP at create time). With a submitted path-B order
   * present, an absent checkpoint means the completion supervisor has never
   * accounted for this asset — fail closed. Create bootstraps the checkpoint
   * inside the create transaction, so in the steady state this only trips on
   * pre-bootstrap legacy orders or an operator-deleted checkpoint.
   */
  private async evaluateAsset(
    assetId: string,
    now: Date,
  ): Promise<LimitOrderCandleReconciliationGateFailure | null> {
    const checkpoint = await this.checkpoints.findWindowCompletion(assetId);
    if (checkpoint) {
      if (checkpoint.gapDetectedAt) {
        return {
          code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetGapDetected,
          // `gapReason` is the sticky field stamped when the gap was RAISED.
          // `degradedReason` is the completion supervisor's current stop
          // reason and is rewritten on every pass, so it is only a fallback
          // for gaps recorded before that field existed.
          reason: `Candle retention passed an unresolved window of this asset at ${checkpoint.gapDetectedAt.toISOString()}: ${
            checkpoint.gapReason ??
            checkpoint.degradedReason ??
            'unknown reason'
          }.`,
        };
      }
      if (checkpoint.pendingSince) {
        const pendingAge = now.getTime() - checkpoint.pendingSince.getTime();
        if (pendingAge > this.config.assetFinalizerStaleMs) {
          return {
            code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetFinalizerStale,
            reason: `A 5m window of this asset has been unaccounted for ${pendingAge}ms (${
              checkpoint.lastErrorCode ?? 'unknown cause'
            }), above the ${this.config.assetFinalizerStaleMs}ms limit.`,
          };
        }
      }
    } else if (await this.checkpoints.hasSubmittedPathBOrder(assetId)) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionUnavailable,
        reason:
          'This asset has an activated path-B order but no window-completion checkpoint; the safety net has never accounted for it.',
      };
    }

    const backlog = await this.checkpoints.readAssetBacklog(assetId);
    // Reported BEFORE the generic permanent/backlog checks below, because a
    // legacy entry lands in one of those buckets too and the generic message
    // would send the operator looking for a stuck candle rather than for the
    // re-verification the provenance migration queued. Both block the asset;
    // only this one says why.
    if (backlog.legacyReviewCount > 0) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetLegacyReviewRequired,
        reason: `This asset has ${backlog.legacyReviewCount} candle queue entry/entries whose tracked revision was never verified (oldest since ${
          backlog.oldestLegacyReviewAt?.toISOString() ?? 'unknown'
        }); the safety net re-checks them against the current candle revision before new orders are accepted.`,
      };
    }
    // A permanent entry is an unresolved financial exposure on THIS asset: a
    // window whose fill decision could not be made and will not be retried.
    // It blocks this asset's new orders until an operator (or a candle
    // correction, which reactivates the entry) settles it — and ONLY this
    // asset's: the global gate deliberately no longer reacts to it.
    if (backlog.permanentCount > 0) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetPermanentFailure,
        reason: `This asset has ${backlog.permanentCount} candle(s) parked as permanently unprocessable (oldest since ${
          backlog.oldestPermanentAt?.toISOString() ?? 'unknown'
        }).`,
      };
    }
    if (backlog.deferredCount > this.config.maxAssetDeferredBacklog) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetBacklogExceeded,
        reason: `This asset has ${backlog.deferredCount} deferred candle(s), above the ${this.config.maxAssetDeferredBacklog} limit.`,
      };
    }
    if (backlog.oldestDeferredAt) {
      const deferredAge = now.getTime() - backlog.oldestDeferredAt.getTime();
      if (deferredAge > this.config.maxDeferredAgeMs) {
        return {
          code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetBacklogExceeded,
          reason: `This asset's oldest deferred candle has been unprocessed for ${deferredAge}ms, above the ${this.config.maxDeferredAgeMs}ms limit.`,
        };
      }
    }
    return null;
  }
}
