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
  // Asset-scoped codes: the failure names ONE asset's safety net, so only
  // that asset's new quotes/creates are refused. Everything else — other
  // assets, cancel, cleanup, market orders, FX — keeps flowing.
  assetGapDetected: 'LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED',
  assetFinalizerStale: 'LIMIT_ORDER_CANDLE_FINALIZER_STALE',
  assetBacklogExceeded: 'LIMIT_ORDER_CANDLE_ASSET_BACKLOG_EXCEEDED',
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

    // Runner liveness. `lastSuccessfulRunAt` is written on every completed
    // sweep, including one that legitimately found nothing to do, so a quiet
    // market never trips this — only a scheduler that stopped ticking does.
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

    // A degraded reason that is not a gap (permanently parked work, a
    // repeatedly failing dependency) still means the safety net is not whole.
    if (checkpoint.degradedReason) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
        reason: `Candle reconciliation is degraded: ${checkpoint.degradedReason}.`,
      };
    }

    const backlog = await this.checkpoints.readBacklog();
    const total = backlog.openCount + backlog.permanentCount;
    if (total > this.config.maxDeferredBacklog) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
        reason: `Candle reconciliation has ${total} deferred candle(s), above the ${this.config.maxDeferredBacklog} limit.`,
      };
    }
    if (backlog.permanentCount > 0) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
        reason: `Candle reconciliation has ${backlog.permanentCount} candle(s) parked as permanently unprocessable.`,
      };
    }
    if (backlog.oldestFirstDeferredAt) {
      const deferredAge =
        now.getTime() - backlog.oldestFirstDeferredAt.getTime();
      if (deferredAge > this.config.maxDeferredAgeMs) {
        return {
          code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
          reason: `The oldest deferred candle has been unprocessed for ${deferredAge}ms, above the ${this.config.maxDeferredAgeMs}ms limit.`,
        };
      }
    }

    return null;
  }

  /**
   * Asset-scoped verdict from the window-completion checkpoint plus the
   * asset's own deferred rows.
   *
   * A MISSING checkpoint passes: checkpoints exist only for assets with
   * activated path-B orders, and a first order on a fresh asset owes nothing
   * to any window that closed before its creation — eligibility is rounded UP
   * at create time. The checkpoint appears with the first sweep after the
   * order exists.
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
          reason: `Candle retention passed an unresolved window of this asset at ${checkpoint.gapDetectedAt.toISOString()}: ${
            checkpoint.degradedReason ?? 'unknown reason'
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
    }

    const deferred = await this.checkpoints.countAssetDeferred(assetId);
    if (deferred > this.config.maxAssetDeferredBacklog) {
      return {
        code: LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetBacklogExceeded,
        reason: `This asset has ${deferred} deferred candle(s), above the ${this.config.maxAssetDeferredBacklog} limit.`,
      };
    }
    return null;
  }
}
