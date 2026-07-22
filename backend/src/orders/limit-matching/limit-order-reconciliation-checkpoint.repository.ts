import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LIMIT_ORDER_CANDLE_INTERVAL } from './limit-order-candle-eligibility';

/**
 * Durable state for the path-B sweep: the scan WATERMARK and the DEFERRED
 * retry queue.
 *
 * The watermark is a position in the canonical `(openTime, id)` ordering of
 * closed 5m candles, not a timestamp cursor. Its invariant is:
 *
 *   every closed 5m candle at or before the watermark has either a
 *   processed-candle row, or a deferred-candle row, or provably no order that
 *   could ever match it.
 *
 * "provably no order" is sound because `candleMatchingEligibleFrom` is rounded
 * UP to the next 5-minute boundary at Create time: an order can never become
 * eligible for a window that had already closed when it was submitted. So a
 * window the sweep swept past with no eligible order can never acquire one
 * later, and stepping over it loses nothing.
 */

export const LIMIT_ORDER_RECONCILIATION_SCOPE: string =
  LIMIT_ORDER_CANDLE_INTERVAL;

export type ReconciliationWatermark = {
  openTime: Date;
  /** NULL when the position is a pure time bound (bootstrap / gap re-anchor). */
  candleId: string | null;
};

export type ReconciliationCheckpoint = {
  scope: string;
  interval: string;
  watermark: ReconciliationWatermark | null;
  lastScannedOpenTime: Date | null;
  lastScannedCloseTime: Date | null;
  lastRunAt: Date | null;
  lastSuccessfulRunAt: Date | null;
  degradedReason: string | null;
  gapDetectedAt: Date | null;
  gapFromOpenTime: Date | null;
  gapToOpenTime: Date | null;
  reservationMismatchCount: number;
  lastReservationMismatchAt: Date | null;
};

export type DeferredCandleRow = {
  marketCandleId: string;
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
      lastScannedOpenTime: row.lastScannedOpenTime,
      lastScannedCloseTime: row.lastScannedCloseTime,
      lastRunAt: row.lastRunAt,
      lastSuccessfulRunAt: row.lastSuccessfulRunAt,
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

  async markRunSucceeded(now: Date, scope?: string): Promise<void> {
    await this.prisma.limitOrderReconciliationCheckpoint.updateMany({
      where: { scope: scope ?? LIMIT_ORDER_RECONCILIATION_SCOPE },
      data: { lastRunAt: now, lastSuccessfulRunAt: now },
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
   */
  async upsertDeferred(input: {
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
  }): Promise<void> {
    const message = input.errorMessage?.slice(0, 1000) ?? null;
    await this.prisma.limitOrderDeferredCandle.upsert({
      where: { marketCandleId: input.marketCandleId },
      create: {
        marketCandleId: input.marketCandleId,
        assetId: input.assetId,
        interval: input.interval,
        openTime: input.openTime,
        closeTime: input.closeTime,
        status: input.status ?? 'deferred',
        firstDeferredAt: input.now,
        lastDeferredAt: input.now,
        attemptCount: 1,
        lastErrorCode: input.errorCode,
        lastErrorMessage: message,
        nextRetryAt: input.nextRetryAt,
      },
      update: {
        status: input.status ?? 'deferred',
        lastDeferredAt: input.now,
        attemptCount: { increment: 1 },
        lastErrorCode: input.errorCode,
        lastErrorMessage: message,
        nextRetryAt: input.nextRetryAt,
      },
    });
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

  async resolveDeferred(marketCandleId: string): Promise<void> {
    await this.prisma.limitOrderDeferredCandle
      .delete({ where: { marketCandleId } })
      .catch((error: unknown) => {
        // Already resolved by a concurrent runner; nothing to undo.
        if (isRecordNotFoundError(error)) return undefined;
        throw error;
      });
  }

  async isDeferred(marketCandleId: string): Promise<boolean> {
    const row = await this.prisma.limitOrderDeferredCandle.findUnique({
      where: { marketCandleId },
      select: { marketCandleId: true },
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

function isUniqueConstraintError(error: unknown): boolean {
  return hasPrismaCode(error, 'P2002');
}

function isRecordNotFoundError(error: unknown): boolean {
  return hasPrismaCode(error, 'P2025');
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
