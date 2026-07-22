import { Injectable, Logger } from '@nestjs/common';
import { AssetType, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveStockMarketSessionState } from '../market-calendar.policy';
import { LimitOrderCandidateRepository } from './limit-order-candidate.repository';
import {
  checkCanonicalClosedCandle,
  FIVE_MINUTES_MS,
  LIMIT_ORDER_CANDLE_INTERVAL,
  type CanonicalCandleRow,
} from './limit-order-candle-eligibility';
import { readLimitOrderCandleReconciliationConfig } from './limit-order-candle-reconciliation.config';
import {
  LimitOrderExecutionError,
  LimitOrderExecutionService,
} from './limit-order-execution.service';
import { LimitOrderMatchBoundaryService } from './limit-order-match-boundary.service';
import {
  LIMIT_ORDER_RECONCILIATION_SCOPE,
  LimitOrderReconciliationCheckpointRepository,
  type ReconciliationWatermark,
} from './limit-order-reconciliation-checkpoint.repository';

export class LimitOrderCandleReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LimitOrderCandleReconciliationError';
  }
}

export type LimitOrderCandleReconciliationSummary = {
  enabled: boolean;
  scannedCandles: number;
  processedCandles: number;
  skippedCandles: number;
  matchedOrders: number;
  deferredCandles: number;
  /** Deferred rows retried this run (a subset of the durable queue). */
  retriedCandles: number;
  /** Deferred rows that succeeded on retry and left the queue. */
  recoveredCandles: number;
  /** Deferred rows that exhausted their retry budget this run. */
  permanentCandles: number;
  from: string | null;
  to: string | null;
  /** Durable position after the run; null while no candle was ever swept. */
  watermarkOpenTime: string | null;
  watermarkCandleId: string | null;
  gapDetected: boolean;
  degradedReason: string | null;
};

type CandleRow = CanonicalCandleRow & {
  asset: {
    id: string;
    assetType: AssetType;
    market: string;
    isActive: boolean;
  };
};

type ProcessOutcome =
  | {
      state: 'processed';
      result: 'matched' | 'skipped';
      matchedOrderCount: number;
    }
  | { state: 'deferred'; reason: string; code: string | null };

/**
 * Path B — the confirmed 5-minute candle safety net.
 *
 * It exists only for the case where a real trade DID touch the limit price but
 * the corresponding live event never reached the Redis Stream (provider gap,
 * publisher restart, XADD failure). It is NOT a replacement for path A and is
 * never allowed to run without it.
 *
 * Flow, per candle:
 *   canonical closed 5m row -> structural validation -> low <= limitPrice
 *   -> candle strictly after the order's first eligible window
 *   -> still-submitted orders -> fill AT THE LIMIT PRICE -> candle evidence
 *   -> processed-candle row (only after every batch committed).
 *
 * DURABLE SCAN POSITION
 * ---------------------
 * The sweep used to read `now - lookbackMs .. now` on every tick. Any candle
 * that stayed unprocessed longer than the lookback simply fell out of the
 * window and was never examined again — a permanent, silent miss on a
 * financial safety net, and exactly the failure a safety net exists to prevent.
 *
 * The scan is now anchored on a durable WATERMARK
 * (limit_order_reconciliation_checkpoints) plus a durable DEFERRED QUEUE
 * (limit_order_deferred_candles):
 *
 *   - the scan starts strictly after the watermark, never at `now - lookback`;
 *   - the watermark only advances over candles that became durable, i.e. that
 *     have a processed-candle row, or a deferred-candle row, or provably no
 *     order that could ever match them;
 *   - a candle that fails is enqueued for bounded retry BEFORE the watermark
 *     passes it, so one bad asset delays one candle instead of blocking every
 *     later candle behind it;
 *   - the watermark additionally lags `watermarkSafetyLagMs` behind now, so it
 *     never steps over a window whose canonical closed row the finalizer has
 *     not written yet;
 *   - if candle retention removes rows the watermark has not reached, that is
 *     reported as a GAP (sticky, operator-cleared) and fails NEW limit
 *     quotes/creates closed. It is never silently skipped.
 *
 * `lookbackMs` survives only as a BOOTSTRAP/catch-up bound and a warning
 * threshold — never as a reason to drop an unprocessed candle.
 */
@Injectable()
export class LimitOrderCandleReconciliationService {
  private readonly logger = new Logger(
    LimitOrderCandleReconciliationService.name,
  );
  private readonly config = readLimitOrderCandleReconciliationConfig();

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: LimitOrderCandidateRepository,
    private readonly execution: LimitOrderExecutionService,
    private readonly boundary: LimitOrderMatchBoundaryService,
    private readonly checkpoints: LimitOrderReconciliationCheckpointRepository,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async reconcile(input: {
    now: Date;
    lookbackMs?: number;
    candleBatchSize?: number;
    orderBatchSize?: number;
  }): Promise<LimitOrderCandleReconciliationSummary> {
    if (!this.config.enabled) return disabledSummary();

    const now = input.now;
    const orderBatchSize = input.orderBatchSize ?? this.config.orderBatchSize;
    const candleBatchSize =
      input.candleBatchSize ?? this.config.candleBatchSize;
    const bootstrapLookbackMs = input.lookbackMs ?? this.config.lookbackMs;

    const checkpoint = await this.ensureCheckpoint(now, bootstrapLookbackMs);
    await this.checkpoints.markRunStarted(now);

    const summary: LimitOrderCandleReconciliationSummary = {
      enabled: true,
      scannedCandles: 0,
      processedCandles: 0,
      skippedCandles: 0,
      matchedOrders: 0,
      deferredCandles: 0,
      retriedCandles: 0,
      recoveredCandles: 0,
      permanentCandles: 0,
      from: checkpoint.watermark?.openTime.toISOString() ?? null,
      to: now.toISOString(),
      watermarkOpenTime: checkpoint.watermark?.openTime.toISOString() ?? null,
      watermarkCandleId: checkpoint.watermark?.candleId ?? null,
      gapDetected: checkpoint.gapDetectedAt !== null,
      degradedReason: checkpoint.degradedReason,
    };

    // Retention may have removed rows the watermark has not reached yet. This
    // is checked BEFORE the sweep so the gap is durable even if the sweep
    // itself then fails.
    const gap = await this.detectRetentionGap(checkpoint.watermark, now);
    if (gap) {
      summary.gapDetected = true;
      summary.degradedReason = gap.reason;
    }

    // 1. Durable retry queue first: the oldest unfinished work goes before new
    //    windows, and a due retry must not be starved by a busy live stream.
    await this.runDeferredRetries(now, orderBatchSize, summary);

    // 2. New windows strictly after the watermark.
    await this.runForwardScan(
      checkpoint.watermark,
      now,
      candleBatchSize,
      orderBatchSize,
      summary,
    );

    await this.checkpoints.markRunSucceeded(now);
    const latest = await this.checkpoints.find();
    summary.watermarkOpenTime =
      latest?.watermark?.openTime.toISOString() ?? summary.watermarkOpenTime;
    summary.watermarkCandleId =
      latest?.watermark?.candleId ?? summary.watermarkCandleId;
    summary.gapDetected = latest?.gapDetectedAt != null || summary.gapDetected;
    summary.degradedReason = latest?.degradedReason ?? summary.degradedReason;
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  /**
   * Establishes the first durable position.
   *
   * The anchor is the EARLIEST window any currently-activated path-B order
   * could still need, i.e. `MIN(candle_matching_eligible_from)` over submitted
   * limit buys. Orders with `candle_matching_eligible_from IS NULL` are
   * deliberately excluded: they are pre-path-B rows and are never retroactively
   * activated against historical candles.
   *
   * With no such order there is nothing path B could owe anyone, so the
   * position starts at the present instead of scanning the entire candle
   * history of the database.
   *
   * `lookbackMs` is NOT a floor here. Clamping the anchor forward to
   * `now - lookbackMs` would silently re-create the exact loss this whole
   * design removes: an order whose eligible window is older than the lookback
   * would be skipped on the first run and never revisited. The bound that
   * genuinely limits what can be reached is RETENTION, and an anchor older
   * than the retained candle head is reported as a gap rather than quietly
   * moved forward. The lookback survives only as a warning threshold on how
   * much catch-up a first run is about to do; per-run work stays bounded by
   * `candleBatchSize`, so a long catch-up is spread over ticks instead of
   * being dropped.
   */
  private async ensureCheckpoint(now: Date, bootstrapLookbackMs: number) {
    const existing = await this.checkpoints.find();
    if (existing) return existing;

    const earliestEligible = await this.findEarliestEligibleFrom();
    const safeBound = new Date(
      now.getTime() - this.config.watermarkSafetyLagMs,
    );
    // One millisecond before the first needed window, so that window itself is
    // strictly after the position and is therefore included by the scan.
    const watermark: ReconciliationWatermark = earliestEligible
      ? { openTime: new Date(earliestEligible.getTime() - 1), candleId: null }
      : { openTime: safeBound, candleId: null };

    const checkpoint = await this.checkpoints.ensure({ watermark, now });
    if (
      earliestEligible &&
      now.getTime() - earliestEligible.getTime() > bootstrapLookbackMs
    ) {
      // Not an error: the sweep WILL work through it. It is worth an operator's
      // attention because the first runs will be doing catch-up rather than
      // steady-state work.
      this.logger.warn(
        JSON.stringify({
          event: 'limit_order_candle_bootstrap_long_catchup',
          earliestEligibleFrom: earliestEligible.toISOString(),
          catchUpMs: now.getTime() - earliestEligible.getTime(),
          lookbackMs: bootstrapLookbackMs,
        }),
      );
    }
    this.logger.log(
      JSON.stringify({
        event: 'limit_order_candle_checkpoint_bootstrapped',
        watermarkOpenTime: checkpoint.watermark?.openTime.toISOString() ?? null,
        hadActiveOrders: earliestEligible !== null,
      }),
    );
    return checkpoint;
  }

  private async findEarliestEligibleFrom(): Promise<Date | null> {
    const rows = await this.prisma.$queryRaw<Array<{ earliest: Date | null }>>`
      SELECT MIN("candle_matching_eligible_from") AS "earliest"
      FROM "orders"
      WHERE "order_type" = 'limit'
        AND "side" = 'buy'
        AND "status" = 'submitted'
        AND "candle_matching_eligible_from" IS NOT NULL
    `;
    return rows[0]?.earliest ?? null;
  }

  // ---------------------------------------------------------------------------
  // Retention gap
  // ---------------------------------------------------------------------------

  /**
   * Two independent gap signals, both exact:
   *
   * 1. The durable position has fallen behind the candle RETENTION HORIZON.
   *    Past that point the retention job is provably deleting windows the
   *    sweep never examined, and they can never be examined again.
   *
   *    The comparison is against the retention POLICY, not against the oldest
   *    surviving row. "The oldest retained candle starts after the watermark"
   *    is also true, entirely harmlessly, whenever candle history simply
   *    begins later than the watermark — a newly stored asset, a market with
   *    no trades in the window, a freshly provisioned database. Treating that
   *    as a gap would fail every new limit order closed on a healthy system.
   *
   * 2. A candle sitting in the durable retry queue whose market_candles row
   *    has disappeared. That is the same loss observed from the other side,
   *    and it is why the queue deliberately carries no foreign key.
   */
  private async detectRetentionGap(
    watermark: ReconciliationWatermark | null,
    now: Date,
  ): Promise<{ reason: string } | null> {
    if (!watermark) return null;

    const retentionHorizon = new Date(
      now.getTime() - this.config.candleRetentionDays * 86_400_000,
    );
    if (watermark.openTime.getTime() < retentionHorizon.getTime()) {
      const reason = 'candle_retention_passed_watermark';
      await this.checkpoints.recordGap({
        detectedAt: now,
        fromOpenTime: watermark.openTime,
        toOpenTime: retentionHorizon,
        reason,
      });
      this.logger.error(
        JSON.stringify({
          event: 'limit_order_candle_retention_gap',
          watermarkOpenTime: watermark.openTime.toISOString(),
          retentionHorizon: retentionHorizon.toISOString(),
          retentionDays: this.config.candleRetentionDays,
        }),
      );
      return { reason };
    }

    const orphan = await this.prisma.$queryRaw<
      Array<{ marketCandleId: string; openTime: Date }>
    >`
      SELECT d."market_candle_id" AS "marketCandleId", d."open_time" AS "openTime"
      FROM "limit_order_deferred_candles" d
      WHERE NOT EXISTS (
        SELECT 1 FROM "market_candles" c WHERE c."id" = d."market_candle_id"
      )
      ORDER BY d."open_time" ASC
      LIMIT 1
    `;
    const missing = orphan[0];
    if (missing) {
      const reason = 'deferred_candle_retention_removed';
      await this.checkpoints.recordGap({
        detectedAt: now,
        fromOpenTime: missing.openTime,
        toOpenTime: missing.openTime,
        reason,
      });
      this.logger.error(
        JSON.stringify({
          event: 'limit_order_candle_deferred_row_missing',
          marketCandleId: missing.marketCandleId,
          openTime: missing.openTime.toISOString(),
        }),
      );
      return { reason };
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Deferred retry stage
  // ---------------------------------------------------------------------------

  private async runDeferredRetries(
    now: Date,
    orderBatchSize: number,
    summary: LimitOrderCandleReconciliationSummary,
  ): Promise<void> {
    const due = await this.checkpoints.findDueDeferred({
      now,
      limit: this.config.deferredRetryBatchSize,
    });
    for (const deferred of due) {
      summary.retriedCandles += 1;
      const candle = await this.loadCandle(deferred.marketCandleId);
      if (!candle) {
        // The row vanished under retention. detectRetentionGap already raised
        // the alarm; park the entry so it stops consuming retry budget while
        // staying visible as backlog.
        await this.checkpoints.upsertDeferred({
          marketCandleId: deferred.marketCandleId,
          assetId: deferred.assetId,
          interval: deferred.interval,
          openTime: deferred.openTime,
          closeTime: deferred.closeTime,
          now,
          nextRetryAt: this.nextRetryAt(now, deferred.attemptCount + 1),
          errorCode: 'LIMIT_ORDER_CANDLE_ROW_MISSING',
          errorMessage: 'The market candle row no longer exists.',
          status: 'permanent',
        });
        summary.permanentCandles += 1;
        continue;
      }

      const outcome = await this.processCandleGuarded(
        candle,
        orderBatchSize,
        now,
      );
      if (outcome.state === 'processed') {
        await this.checkpoints.resolveDeferred(deferred.marketCandleId);
        summary.recoveredCandles += 1;
        summary.processedCandles += 1;
        summary.matchedOrders += outcome.matchedOrderCount;
        if (outcome.result === 'skipped') summary.skippedCandles += 1;
        continue;
      }

      const attempt = deferred.attemptCount + 1;
      const exhausted = attempt >= this.config.deferredMaxAttempts;
      await this.checkpoints.upsertDeferred({
        marketCandleId: candle.id,
        assetId: candle.assetId,
        interval: candle.interval,
        openTime: candle.openTime,
        closeTime: candle.closeTime,
        now,
        nextRetryAt: this.nextRetryAt(now, attempt),
        errorCode: outcome.code,
        errorMessage: outcome.reason,
        status: exhausted ? 'permanent' : 'deferred',
      });
      summary.deferredCandles += 1;
      if (exhausted) summary.permanentCandles += 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Forward scan
  // ---------------------------------------------------------------------------

  private async runForwardScan(
    watermark: ReconciliationWatermark | null,
    now: Date,
    candleBatchSize: number,
    orderBatchSize: number,
    summary: LimitOrderCandleReconciliationSummary,
  ): Promise<void> {
    const candles = await this.findUnprocessedCandles({
      after: watermark,
      to: now,
      limit: candleBatchSize,
    });
    summary.scannedCandles = candles.length;
    summary.from = candles[0]?.openTime.toISOString() ?? summary.from ?? null;

    let lastHandled: CandleRow | null = null;
    for (const candle of candles) {
      const outcome = await this.processCandleGuarded(
        candle,
        orderBatchSize,
        now,
      );
      if (outcome.state === 'processed') {
        summary.processedCandles += 1;
        summary.matchedOrders += outcome.matchedOrderCount;
        if (outcome.result === 'skipped') summary.skippedCandles += 1;
      } else {
        // Durable enqueue BEFORE the position may pass this candle. If the
        // enqueue itself fails the watermark stops here, which is the safe
        // direction: the candle is simply re-scanned next tick.
        await this.checkpoints.upsertDeferred({
          marketCandleId: candle.id,
          assetId: candle.assetId,
          interval: candle.interval,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          now,
          nextRetryAt: this.nextRetryAt(now, 1),
          errorCode: outcome.code,
          errorMessage: outcome.reason,
        });
        summary.deferredCandles += 1;
      }
      lastHandled = candle;
    }

    await this.advancePosition({
      lastHandled,
      exhausted: candles.length < candleBatchSize,
      now,
      summary,
    });
  }

  /**
   * Moves the durable position forward.
   *
   * Two bounds apply, and the SMALLER wins:
   *   1. the last candle this run actually made durable (processed or
   *      deferred). Never past a candle whose outcome is unknown.
   *   2. the safety lag. A window that closed moments ago may not have its
   *      canonical row written yet, and stepping over a window whose row is
   *      still missing would lose it permanently.
   *
   * When the batch was NOT truncated the run demonstrably reached the end of
   * the eligible range, so the position may skip ahead over windows that had
   * no matching order at all — those can never acquire one later.
   */
  private async advancePosition(input: {
    lastHandled: CandleRow | null;
    exhausted: boolean;
    now: Date;
    summary: LimitOrderCandleReconciliationSummary;
  }): Promise<void> {
    const safeBound = new Date(
      input.now.getTime() - this.config.watermarkSafetyLagMs,
    );

    // Bound 1: the last candle this run actually made durable, and only if its
    // window is already older than the safety lag.
    const handled: ReconciliationWatermark | null =
      input.lastHandled &&
      input.lastHandled.closeTime.getTime() <= safeBound.getTime()
        ? {
            openTime: input.lastHandled.openTime,
            candleId: input.lastHandled.id,
          }
        : null;

    // Bound 2 applies only to a batch that was NOT truncated: the run reached
    // the end of the eligible range, so every window up to the safety lag is
    // accounted for — including windows with no matching order, which can
    // never acquire one later. A truncated batch must stop at bound 1.
    const head = input.exhausted
      ? await this.findLatestClosedCandleBefore(safeBound)
      : null;

    const target =
      head && (!handled || comparePosition(head, handled) > 0) ? head : handled;
    if (!target) return;

    await this.checkpoints.advanceWatermark({
      watermark: target,
      lastScannedOpenTime: input.lastHandled?.openTime ?? target.openTime,
      lastScannedCloseTime: input.lastHandled?.closeTime ?? null,
    });
    input.summary.watermarkOpenTime = target.openTime.toISOString();
    input.summary.watermarkCandleId = target.candleId;
  }

  // ---------------------------------------------------------------------------
  // Per-candle work
  // ---------------------------------------------------------------------------

  /**
   * `processCandle` with its failure modes normalized into a deferral. One
   * asset's transient failure (a missing valuation price, a lock timeout) must
   * never stop the sweep for every other asset, and must never be silently
   * dropped either — the caller turns this into a durable retry row.
   */
  private async processCandleGuarded(
    candle: CandleRow,
    orderBatchSize: number,
    now: Date,
  ): Promise<ProcessOutcome> {
    try {
      return await this.processCandle(candle, orderBatchSize, now);
    } catch (error) {
      const code =
        error instanceof LimitOrderExecutionError ? error.code : null;
      const message = error instanceof Error ? error.message : String(error);
      const entry = JSON.stringify({
        event: 'limit_order_candle_sweep_deferred',
        assetId: candle.assetId,
        openTime: candle.openTime.toISOString(),
        code,
        error: message,
      });
      // A reservation mismatch is an unresolved financial inconsistency, not a
      // transient blip: it never self-heals and needs an operator, so it is
      // logged at error level, counted durably, and gates new orders, while
      // the reservation itself stays untouched.
      if (code === 'LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH') {
        this.logger.error(entry);
        await this.checkpoints
          .recordReservationMismatch(now)
          .catch(() => undefined);
      } else {
        this.logger.warn(entry);
      }
      return { state: 'deferred', reason: message, code };
    }
  }

  private async processCandle(
    candle: CandleRow,
    orderBatchSize: number,
    now: Date,
  ): Promise<ProcessOutcome> {
    const structural = checkCanonicalClosedCandle(candle);
    if (!structural.ok) {
      // Permanent defects are recorded as processed-with-reason so the same
      // broken row is not re-examined on every tick, and stay visible as an
      // operational warning.
      this.logger.warn(
        JSON.stringify({
          event: 'limit_order_candle_rejected',
          assetId: candle.assetId,
          openTime: candle.openTime.toISOString(),
          reason: structural.reason,
        }),
      );
      await this.recordProcessed(candle, now, 0, 'skipped', structural.reason);
      return { state: 'processed', result: 'skipped', matchedOrderCount: 0 };
    }
    if (!candle.asset.isActive) {
      return { state: 'deferred', reason: 'asset_inactive', code: null };
    }

    if (candle.asset.assetType !== AssetType.crypto) {
      const session = this.resolveStockSession(candle);
      if (session === 'calendar_unavailable') {
        // Transient by definition: a calendar dataset can be added later. The
        // candle goes to the durable retry queue instead of relying on a
        // sliding window still covering it when the dataset lands.
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_candle_calendar_unavailable',
            assetId: candle.assetId,
            market: candle.asset.market,
            openTime: candle.openTime.toISOString(),
          }),
        );
        return {
          state: 'deferred',
          reason: 'calendar_unavailable',
          code: null,
        };
      }
      if (session === 'outside_session') {
        await this.recordProcessed(
          candle,
          now,
          0,
          'skipped',
          'candle_outside_market_session',
        );
        return { state: 'processed', result: 'skipped', matchedOrderCount: 0 };
      }
    }

    // The whole candle sweep runs under the SAME boundary mutex Create and the
    // path-A poller use, so a create cannot commit between the candidate query
    // and the fill. Each acquisition owns its own PostgreSQL session, so the
    // poller running concurrently in this process blocks here rather than
    // silently sharing the lock.
    const lease = await this.boundary.acquireSession();
    let matchedOrderCount = 0;
    try {
      const alreadyProcessed =
        await this.prisma.limitOrderProcessedCandle.findUnique({
          where: { marketCandleId: candle.id },
          select: { marketCandleId: true },
        });
      if (alreadyProcessed) {
        return { state: 'processed', result: 'skipped', matchedOrderCount: 0 };
      }

      let previousCandidateIds = '';
      for (;;) {
        const candidates = await this.candidates.findCandleCandidates({
          assetId: candle.assetId,
          candleLow: candle.low.toString(),
          candleOpenTime: candle.openTime,
          candleCloseTime: candle.closeTime,
          batchSize: orderBatchSize,
        });
        if (candidates.length === 0) break;
        const candidateIds = candidates.map((row) => row.id).join(',');
        if (candidateIds === previousCandidateIds) {
          throw new LimitOrderExecutionError(
            'LIMIT_ORDER_EXECUTION_CONFLICT',
            'Path-B candidate batch made no progress.',
          );
        }
        previousCandidateIds = candidateIds;
        for (const candidate of candidates) {
          const result = await this.execution.execute({
            orderId: candidate.id,
            seasonParticipantId: candidate.seasonParticipantId,
            trigger: {
              source: 'closed_5m_candle',
              candle: {
                id: candle.id,
                assetId: candle.assetId,
                interval: candle.interval,
                openTime: candle.openTime,
                closeTime: candle.closeTime,
                low: candle.low,
                sourceProvider: candle.sourceProvider,
                sourceUpdatedAt: candle.sourceUpdatedAt,
                finalizedAt: candle.sourceUpdatedAt,
              },
            },
          });
          if (result.state === 'executed') matchedOrderCount += 1;
        }
      }

      // Written ONLY after every candidate batch committed. A crash before
      // this point re-runs the candle; already executed orders are skipped by
      // the status guard, so the re-run is idempotent.
      await this.recordProcessed(
        candle,
        now,
        matchedOrderCount,
        matchedOrderCount > 0 ? 'matched' : 'skipped',
        matchedOrderCount > 0 ? null : 'no_eligible_orders',
      );
    } finally {
      await lease.release();
    }
    return {
      state: 'processed',
      result: matchedOrderCount > 0 ? 'matched' : 'skipped',
      matchedOrderCount,
    };
  }

  private resolveStockSession(
    candle: CandleRow,
  ): 'tradable' | 'outside_session' | 'calendar_unavailable' {
    const state = resolveStockMarketSessionState(
      { assetType: candle.asset.assetType, market: candle.asset.market },
      candle.openTime,
    );
    if (!state || state.state === 'calendar_unavailable') {
      return 'calendar_unavailable';
    }
    const session = state.currentSession;
    if (!session) return 'outside_session';
    // The window must lie inside the session, not merely overlap its edge.
    return candle.openTime.getTime() >= session.openTime.getTime() &&
      candle.closeTime.getTime() <= session.closeTime.getTime()
      ? 'tradable'
      : 'outside_session';
  }

  private recordProcessed(
    candle: CandleRow,
    processedAt: Date,
    matchedOrderCount: number,
    result: 'matched' | 'skipped',
    skipReason: string | null,
  ): Promise<unknown> {
    return this.prisma.limitOrderProcessedCandle
      .create({
        data: {
          marketCandleId: candle.id,
          assetId: candle.assetId,
          interval: candle.interval,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          processedAt,
          matchedOrderCount,
          result,
          skipReason,
        },
      })
      .catch((error: unknown) => {
        // A concurrent worker already recorded the same candle. The unique
        // primary key is what makes the sweep idempotent.
        if (isUniqueConstraintError(error)) return undefined;
        throw error;
      });
  }

  /** Bounded exponential backoff; attempt 1 waits the base delay. */
  private nextRetryAt(now: Date, attempt: number): Date {
    const exponent = Math.min(Math.max(attempt, 1) - 1, 20);
    const delay = Math.min(
      this.config.deferredRetryMaxDelayMs,
      this.config.deferredRetryBaseDelayMs * 2 ** exponent,
    );
    return new Date(now.getTime() + delay);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Closed 5m rows strictly AFTER the durable position that have no
   * processed-candle row, are not already in the durable retry queue, and
   * whose asset has at least one activated, still-open limit buy that the
   * window could fill.
   */
  private findUnprocessedCandles(input: {
    after: ReconciliationWatermark | null;
    to: Date;
    limit: number;
  }): Promise<CandleRow[]> {
    const afterOpenTime = input.after?.openTime ?? null;
    const afterCandleId = input.after?.candleId ?? null;
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        assetId: string;
        interval: string;
        openTime: Date;
        closeTime: Date;
        open: Prisma.Decimal;
        high: Prisma.Decimal;
        low: Prisma.Decimal;
        close: Prisma.Decimal;
        isClosed: boolean;
        sourceProvider: string;
        sourceUpdatedAt: Date;
        assetType: AssetType;
        market: string;
        assetIsActive: boolean;
      }>
    >`
        SELECT
          c."id",
          c."asset_id" AS "assetId",
          c."interval",
          c."open_time" AS "openTime",
          c."close_time" AS "closeTime",
          c."open",
          c."high",
          c."low",
          c."close",
          c."is_closed" AS "isClosed",
          c."source_provider" AS "sourceProvider",
          c."source_updated_at" AS "sourceUpdatedAt",
          a."asset_type" AS "assetType",
          a."market",
          a."is_active" AS "assetIsActive"
        FROM "market_candles" c
        JOIN "assets" a ON a."id" = c."asset_id"
        WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
          AND c."is_closed" = true
          AND (
            ${afterOpenTime}::timestamptz IS NULL
            OR c."open_time" > ${afterOpenTime}::timestamptz
            OR (
              c."open_time" = ${afterOpenTime}::timestamptz
              AND (${afterCandleId}::text IS NULL OR c."id" > ${afterCandleId}::text)
            )
          )
          AND c."close_time" <= ${input.to}
          AND a."is_active" = true
          AND NOT EXISTS (
            SELECT 1 FROM "limit_order_processed_candles" p
            WHERE p."market_candle_id" = c."id"
          )
          AND NOT EXISTS (
            SELECT 1 FROM "limit_order_deferred_candles" d
            WHERE d."market_candle_id" = c."id"
          )
          AND EXISTS (
            SELECT 1 FROM "orders" o
            WHERE o."asset_id" = c."asset_id"
              AND o."order_type" = 'limit'
              AND o."side" = 'buy'
              AND o."status" = 'submitted'
              AND o."candle_matching_eligible_from" IS NOT NULL
              AND o."candle_matching_eligible_from" <= c."open_time"
              AND o."limit_price" >= c."low"
          )
        ORDER BY c."open_time" ASC, c."id" ASC
        LIMIT ${input.limit}
      `.then((rows) => rows.map(toCandleRow));
  }

  private loadCandle(marketCandleId: string): Promise<CandleRow | null> {
    return this.prisma.$queryRaw<
      Array<{
        id: string;
        assetId: string;
        interval: string;
        openTime: Date;
        closeTime: Date;
        open: Prisma.Decimal;
        high: Prisma.Decimal;
        low: Prisma.Decimal;
        close: Prisma.Decimal;
        isClosed: boolean;
        sourceProvider: string;
        sourceUpdatedAt: Date;
        assetType: AssetType;
        market: string;
        assetIsActive: boolean;
      }>
    >`
        SELECT
          c."id",
          c."asset_id" AS "assetId",
          c."interval",
          c."open_time" AS "openTime",
          c."close_time" AS "closeTime",
          c."open",
          c."high",
          c."low",
          c."close",
          c."is_closed" AS "isClosed",
          c."source_provider" AS "sourceProvider",
          c."source_updated_at" AS "sourceUpdatedAt",
          a."asset_type" AS "assetType",
          a."market",
          a."is_active" AS "assetIsActive"
        FROM "market_candles" c
        JOIN "assets" a ON a."id" = c."asset_id"
        WHERE c."id" = ${marketCandleId}
      `.then((rows) => (rows[0] ? toCandleRow(rows[0]) : null));
  }

  /** Latest canonical closed window whose close time is at or before `bound`. */
  private findLatestClosedCandleBefore(
    bound: Date,
  ): Promise<ReconciliationWatermark | null> {
    return this.prisma.$queryRaw<Array<{ id: string; openTime: Date }>>`
      SELECT c."id", c."open_time" AS "openTime"
      FROM "market_candles" c
      WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
        AND c."is_closed" = true
        AND c."close_time" <= ${bound}
      ORDER BY c."open_time" DESC, c."id" DESC
      LIMIT 1
    `.then((rows) =>
      rows[0] ? { openTime: rows[0].openTime, candleId: rows[0].id } : null,
    );
  }
}

export const LIMIT_ORDER_CANDLE_WINDOW_MS = FIVE_MINUTES_MS;
export { LIMIT_ORDER_RECONCILIATION_SCOPE };

function comparePosition(
  left: ReconciliationWatermark,
  right: ReconciliationWatermark,
): number {
  const delta = left.openTime.getTime() - right.openTime.getTime();
  if (delta !== 0) return delta < 0 ? -1 : 1;
  const leftId = left.candleId ?? '';
  const rightId = right.candleId ?? '';
  if (leftId === rightId) return 0;
  return leftId < rightId ? -1 : 1;
}

function toCandleRow(row: {
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  isClosed: boolean;
  sourceProvider: string;
  sourceUpdatedAt: Date;
  assetType: AssetType;
  market: string;
  assetIsActive: boolean;
}): CandleRow {
  return {
    id: row.id,
    assetId: row.assetId,
    interval: row.interval,
    openTime: row.openTime,
    closeTime: row.closeTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    isClosed: row.isClosed,
    sourceProvider: row.sourceProvider,
    sourceUpdatedAt: row.sourceUpdatedAt,
    asset: {
      id: row.assetId,
      assetType: row.assetType,
      market: row.market,
      isActive: row.assetIsActive,
    },
  };
}

function disabledSummary(): LimitOrderCandleReconciliationSummary {
  return {
    enabled: false,
    scannedCandles: 0,
    processedCandles: 0,
    skippedCandles: 0,
    matchedOrders: 0,
    deferredCandles: 0,
    retriedCandles: 0,
    recoveredCandles: 0,
    permanentCandles: 0,
    from: null,
    to: null,
    watermarkOpenTime: null,
    watermarkCandleId: null,
    gapDetected: false,
    degradedReason: null,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2002'
  );
}
