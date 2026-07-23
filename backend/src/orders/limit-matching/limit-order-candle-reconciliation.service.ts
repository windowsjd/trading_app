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
import {
  LimitOrderWindowCompletionService,
  type WindowCompletionSummary,
} from './limit-order-window-completion.service';

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
  /** Market-time marker after the run; null while no candle was ever swept. */
  watermarkOpenTime: string | null;
  watermarkCandleId: string | null;
  /** Storage-order scan position after the run. Decimal string, never a number. */
  watermarkIngestSeq: string | null;
  /** Highest storage-order value observed this run (the next run's ceiling). */
  observedIngestSeq: string | null;
  /**
   * True when the two-phase guard held the position back this run because
   * write transactions from the previous observation had not all resolved.
   */
  ingestCeilingHeld: boolean;
  gapDetected: boolean;
  degradedReason: string | null;
  /**
   * Per-asset window COMPLETION supervision (missing windows, no-trade
   * certification, per-asset gaps). Null when the completion service is not
   * wired (bare test rigs) or its pass failed this run.
   */
  windowCompletion: WindowCompletionSummary | null;
};

type CandleRow = CanonicalCandleRow & {
  /** Storage-order position of this row; see the class docstring. */
  ingestSeq: bigint;
  asset: {
    id: string;
    assetType: AssetType;
    market: string;
    isActive: boolean;
  };
};

/**
 * One consistent observation of the storage-order space, taken on the DATABASE
 * clock so nothing here is ever compared against a Node clock.
 */
type IngestObservation = {
  dbNow: Date;
  /**
   * Highest sequence value the watermark may reach given what is visible now.
   * Bounded below the first row that is NOT yet sweepable (a closed row whose
   * window ends in the future, which clock skew or a bad backfill can produce),
   * so such a row is never stepped over.
   */
  ceiling: bigint;
  /** Oldest write transaction currently open, or null when not observable. */
  oldestWriteXactStart: Date | null;
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
 * The scan is anchored on a durable WATERMARK
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
 *   - if candle retention removes rows the watermark has not reached, that is
 *     reported as a GAP (sticky, operator-cleared) and fails NEW limit
 *     quotes/creates closed. It is never silently skipped.
 *
 * `lookbackMs` survives only as a BOOTSTRAP/catch-up bound and a warning
 * threshold — never as a reason to drop an unprocessed candle.
 *
 * STORAGE ORDER, NOT MARKET ORDER
 * -------------------------------
 * That watermark used to be a position in the canonical `(openTime, id)`
 * ordering — MARKET time. Rows, however, appear in STORAGE time, and one
 * global market-time position across every asset made late-stored candles
 * unreachable:
 *
 *   asset A's 10:00 window is written late (provider gap, finalizer restart,
 *   REST backfill); asset B's 10:05 window is written on time; the sweep
 *   advances the single global watermark past 10:05; A's row finally lands
 *   with openTime 10:00, which is now BEFORE the watermark, so the scan —
 *   which reads strictly after it — never returns that row again.
 *
 * `watermarkSafetyLagMs` bounded how long the sweep waits, never how late a
 * row may be stored, so it could only shrink that window, not close it.
 *
 * The forward scan is therefore driven by `market_candles.ingest_seq`, a
 * monotonic value a database trigger assigns when a row is written and
 * re-assigns when the row changes in a way that can change a matching decision
 * (it becomes closed, its low or its window moves). A late-stored candle
 * always carries a sequence value ABOVE the watermark, so it is always
 * scanned, however old its window is. The market-time watermark is still
 * maintained, now purely as the bootstrap anchor and the retention-gap marker.
 *
 * The advance is TWO-PHASE, because a sequence value is assigned at INSERT but
 * only becomes visible at COMMIT: the highest value a run observes may still
 * have uncommitted holes below it. A run records what it observed and only a
 * LATER run may use that as a ceiling, once every write transaction that was
 * in flight at the observation has demonstrably resolved. See
 * `resolveIngestCeiling`.
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
    // Optional so bare test rigs that only exercise the row-scan path keep
    // working; production wiring always provides it.
    private readonly windowCompletion?: LimitOrderWindowCompletionService,
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

    const observation = await this.observeIngestSpace(now);
    const checkpoint = await this.ensureCheckpoint(
      now,
      bootstrapLookbackMs,
      observation,
    );
    const ingestWatermark = await this.resolveIngestWatermark(checkpoint);
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
      watermarkIngestSeq: ingestWatermark.toString(),
      observedIngestSeq: observation.ceiling.toString(),
      ingestCeilingHeld: false,
      gapDetected: checkpoint.gapDetectedAt !== null,
      degradedReason: checkpoint.degradedReason,
      windowCompletion: null,
    };

    // Retention may have removed rows the watermark has not reached yet. This
    // is checked BEFORE the sweep so the gap is durable even if the sweep
    // itself then fails.
    const gap = await this.detectRetentionGap(
      checkpoint.watermark,
      ingestWatermark,
      now,
    );
    if (gap) {
      summary.gapDetected = true;
      summary.degradedReason = gap.reason;
    }

    // 1. WINDOW COMPLETION first: account for windows whose candle row may be
    //    ABSENT — the one thing the row scan below structurally cannot see.
    //    Per-asset cursors, per-asset pendings, per-asset gaps; one stalled
    //    asset never stops another. A supervision failure is logged and the
    //    row sweep continues: existing-row fills must not be hostage to the
    //    absence detector, and the asset gate stays fail-closed through the
    //    ageing pending markers either way.
    if (this.windowCompletion) {
      summary.windowCompletion = await this.windowCompletion
        .supervise(now)
        .catch((error: unknown) => {
          this.logger.error(
            JSON.stringify({
              event: 'limit_order_window_completion_failed',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
          return null;
        });
    }

    // 2. Durable retry queue: the oldest unfinished work goes before new
    //    windows, and a due retry must not be starved by a busy live stream.
    await this.runDeferredRetries(now, orderBatchSize, summary);

    // 3. Rows stored after the storage-order position, oldest first.
    await this.runForwardScan(
      { checkpoint, ingestWatermark, observation },
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
    summary.watermarkIngestSeq =
      latest?.ingest.watermarkSeq?.toString() ?? summary.watermarkIngestSeq;
    summary.gapDetected = latest?.gapDetectedAt != null || summary.gapDetected;
    summary.degradedReason = latest?.degradedReason ?? summary.degradedReason;
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Storage-order observation
  // ---------------------------------------------------------------------------

  /**
   * One round trip, one clock. Reads:
   *
   *   - the database clock, which every later comparison is made against;
   *   - the highest sequence value the watermark may reach. That is normally
   *     MAX(ingest_seq) over canonical closed 5m rows, but it is capped just
   *     below the FIRST row that is not sweepable yet (a closed row whose
   *     window ends in the future). Taking the plain maximum would let the
   *     watermark step over such a row and lose it, since the scan filters it
   *     out until its window has actually ended;
   *   - the oldest currently open WRITE transaction. A row inserted by a
   *     transaction that is still open carries a sequence value that is not
   *     visible yet, so the two-phase guard must not treat an observation as
   *     settled while such a transaction from before it is still running.
   *     `pg_stat_activity` hides other backends' `xact_start` from
   *     unprivileged roles, in which case this reads NULL and the elapsed-time
   *     bound alone applies.
   */
  private async observeIngestSpace(now: Date): Promise<IngestObservation> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        dbNow: Date;
        maxSeq: bigint | null;
        firstUnsweepableSeq: bigint | null;
        oldestWriteXactStart: Date | null;
      }>
    >`
      SELECT
        clock_timestamp() AS "dbNow",
        (
          SELECT MAX(c."ingest_seq")
          FROM "market_candles" c
          WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
            AND c."is_closed" = true
        ) AS "maxSeq",
        (
          SELECT MIN(c."ingest_seq")
          FROM "market_candles" c
          WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
            AND c."is_closed" = true
            AND c."close_time" > ${now}
        ) AS "firstUnsweepableSeq",
        (
          SELECT MIN(a."xact_start")
          FROM "pg_stat_activity" a
          WHERE a."datname" = current_database()
            AND a."backend_xid" IS NOT NULL
            AND a."xact_start" IS NOT NULL
        ) AS "oldestWriteXactStart"
    `;
    const row = rows[0];
    const maxSeq = row?.maxSeq ?? 0n;
    const firstUnsweepable = row?.firstUnsweepableSeq ?? null;
    const ceiling =
      firstUnsweepable === null
        ? maxSeq
        : bigintMin(maxSeq, firstUnsweepable - 1n);
    return {
      dbNow: row?.dbNow ?? now,
      ceiling: ceiling < 0n ? 0n : ceiling,
      oldestWriteXactStart: row?.oldestWriteXactStart ?? null,
    };
  }

  /**
   * The storage-order position to scan from, adopting 0 for a checkpoint row
   * that predates the column. See
   * `LimitOrderReconciliationCheckpointRepository.adoptIngestWatermark`.
   */
  private async resolveIngestWatermark(checkpoint: {
    ingest: { watermarkSeq: bigint | null };
  }): Promise<bigint> {
    if (checkpoint.ingest.watermarkSeq !== null) {
      return checkpoint.ingest.watermarkSeq;
    }
    const adopted = await this.checkpoints.adoptIngestWatermark({ seq: 0n });
    if (adopted) {
      this.logger.warn(
        JSON.stringify({
          event: 'limit_order_candle_ingest_watermark_adopted',
          adoptedSeq: '0',
          reason:
            'checkpoint predates the storage-order position; re-scanning from the beginning',
        }),
      );
    }
    return (await this.checkpoints.find())?.ingest.watermarkSeq ?? 0n;
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
  private async ensureCheckpoint(
    now: Date,
    bootstrapLookbackMs: number,
    observation: IngestObservation,
  ) {
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

    // Storage-order anchor. With an activated path-B order the sweep owes
    // someone a window whose row may have been stored at any point, so it
    // starts at the beginning of the sequence; the scan's own filters keep
    // that bounded to rows an order could actually match. With no such order
    // there is nothing owed and the position starts at the present.
    const checkpoint = await this.checkpoints.ensure({
      watermark,
      ingestWatermarkSeq: earliestEligible ? 0n : observation.ceiling,
      // Seed the two-phase guard so the SECOND run can already advance,
      // instead of spending one extra tick establishing a ceiling.
      pendingIngestSeq: observation.ceiling,
      pendingIngestSeqObservedAt: observation.dbNow,
      now,
    });
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
        watermarkIngestSeq: checkpoint.ingest.watermarkSeq?.toString() ?? null,
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
   *
   * 3. A candle the STORAGE-order position has not reached whose window is
   *    already older than the retention horizon AND that an activated order
   *    could still match. Signal 1 alone cannot see this: the market-time
   *    marker moves with the newest windows the sweep touched, so a single
   *    very old row stored late sits far behind it while the marker itself
   *    looks perfectly current. The eligible-order condition is what keeps
   *    this exact rather than noisy — a genuinely old window that no order
   *    could ever match is not an exposure, and turning it into a sticky alarm
   *    would fail every new limit order closed on a healthy system.
   */
  private async detectRetentionGap(
    watermark: ReconciliationWatermark | null,
    ingestWatermark: bigint,
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

    const unscanned = await this.findOldestUnscannedMatchableCandle(
      ingestWatermark,
      now,
    );
    if (
      unscanned &&
      unscanned.openTime.getTime() < retentionHorizon.getTime()
    ) {
      const reason = 'candle_retention_passed_unscanned_candle';
      await this.checkpoints.recordGap({
        detectedAt: now,
        fromOpenTime: unscanned.openTime,
        toOpenTime: retentionHorizon,
        reason,
      });
      this.logger.error(
        JSON.stringify({
          event: 'limit_order_candle_unscanned_retention_gap',
          marketCandleId: unscanned.id,
          openTime: unscanned.openTime.toISOString(),
          ingestSeq: unscanned.ingestSeq.toString(),
          ingestWatermarkSeq: ingestWatermark.toString(),
          retentionHorizon: retentionHorizon.toISOString(),
        }),
      );
      return { reason };
    }
    return null;
  }

  /**
   * Oldest window (by market time) that the storage-order position has not
   * reached and that an activated order could still match. Uses exactly the
   * scan's eligibility conditions, so it can never report a row the sweep
   * would have ignored anyway.
   */
  private findOldestUnscannedMatchableCandle(
    ingestWatermark: bigint,
    to: Date,
  ): Promise<{ id: string; openTime: Date; ingestSeq: bigint } | null> {
    return this.prisma.$queryRaw<
      Array<{ id: string; openTime: Date; ingestSeq: bigint }>
    >`
        SELECT c."id", c."open_time" AS "openTime", c."ingest_seq" AS "ingestSeq"
        FROM "market_candles" c
        JOIN "assets" a ON a."id" = c."asset_id"
        WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
          AND c."is_closed" = true
          AND c."ingest_seq" IS NOT NULL
          AND c."ingest_seq" > ${ingestWatermark.toString()}::bigint
          AND c."close_time" <= ${to}
          AND a."is_active" = true
          AND NOT EXISTS (
            SELECT 1 FROM "limit_order_processed_candles" p
            WHERE p."market_candle_id" = c."id"
              -- Revision-aware: a processed row only covers the revision it
              -- recorded. A corrected candle (higher ingest_seq) reappears.
              AND p."candle_ingest_seq" >= c."ingest_seq"
          )
          -- A candle already in the durable retry queue is tracked, not lost.
          -- Its own disappearance is signal 2, and a queue that stops draining
          -- is the deferred-backlog health gate. Alarming on it here as well
          -- would turn ordinary retry latency into a sticky, operator-cleared
          -- gap that fails every new limit order closed.
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
        ORDER BY c."open_time" ASC
        LIMIT 1
      `.then((rows) => rows[0] ?? null);
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
    position: {
      checkpoint: {
        ingest: { pendingSeq: bigint | null; pendingObservedAt: Date | null };
      };
      ingestWatermark: bigint;
      observation: IngestObservation;
    },
    now: Date,
    candleBatchSize: number,
    orderBatchSize: number,
    summary: LimitOrderCandleReconciliationSummary,
  ): Promise<void> {
    const candles = await this.findUnprocessedCandles({
      afterIngestSeq: position.ingestWatermark,
      to: now,
      limit: candleBatchSize,
    });
    summary.scannedCandles = candles.length;
    summary.from = candles[0]?.openTime.toISOString() ?? summary.from ?? null;

    // The last row in STORAGE order is not the furthest window in MARKET
    // order — that is the whole reason this scan exists. The market-time
    // marker therefore tracks the greatest window handled, not the last one.
    let lastHandledSeq: bigint | null = null;
    let furthestHandled: CandleRow | null = null;
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
      lastHandledSeq = candle.ingestSeq;
      if (
        !furthestHandled ||
        comparePosition(
          { openTime: candle.openTime, candleId: candle.id },
          {
            openTime: furthestHandled.openTime,
            candleId: furthestHandled.id,
          },
        ) > 0
      ) {
        furthestHandled = candle;
      }
    }

    await this.advanceIngestPosition({
      current: position.ingestWatermark,
      pendingSeq: position.checkpoint.ingest.pendingSeq,
      pendingObservedAt: position.checkpoint.ingest.pendingObservedAt,
      observation: position.observation,
      lastHandledSeq,
      truncated: candles.length >= candleBatchSize,
      summary,
    });

    await this.advancePosition({
      lastHandled: furthestHandled,
      exhausted: candles.length < candleBatchSize,
      now,
      summary,
    });
  }

  /**
   * Moves the STORAGE-order position forward, under the two-phase guard.
   *
   * A sequence value is assigned when a row is INSERTED but becomes visible
   * only when its transaction COMMITS. The highest value visible right now can
   * therefore still have holes below it, and stepping onto it would skip
   * whatever fills those holes a moment later — the very failure this whole
   * position exists to prevent, just moved from market time into storage time.
   *
   * So the ceiling is never this run's own observation. It is the value a
   * PREVIOUS run observed, and only once both hold:
   *
   *   1. at least `ingestSettleGraceMs` of database time has passed since that
   *      observation, and
   *   2. no write transaction that was already open at that observation is
   *      still running (checked exactly when `pg_stat_activity` exposes it;
   *      when the role cannot see it, condition 1 is the bound).
   *
   * Every transaction in flight at the observation has then resolved, and this
   * run's scan — which read strictly above the OLD watermark — has already
   * returned whatever they committed.
   *
   * Within that ceiling the position advances to:
   *   - the last row actually handled, when the batch was truncated (rows
   *     beyond it were never examined), or
   *   - the ceiling itself otherwise, which correctly steps over rows the scan
   *     filtered out because no order could ever match them.
   */
  private async advanceIngestPosition(input: {
    current: bigint;
    pendingSeq: bigint | null;
    pendingObservedAt: Date | null;
    observation: IngestObservation;
    lastHandledSeq: bigint | null;
    truncated: boolean;
    summary: LimitOrderCandleReconciliationSummary;
  }): Promise<void> {
    const ceiling = this.resolveIngestCeiling(input);
    if (ceiling === null) {
      input.summary.ingestCeilingHeld = true;
    }

    const candidate = input.truncated
      ? input.lastHandledSeq
      : (ceiling ?? input.current);
    const bounded =
      candidate === null
        ? input.current
        : ceiling === null
          ? input.current
          : bigintMin(candidate, ceiling);

    if (bounded > input.current) {
      await this.checkpoints.advanceIngestWatermark({
        seq: bounded,
        lastScannedSeq: input.lastHandledSeq,
      });
      input.summary.watermarkIngestSeq = bounded.toString();
    }

    // Recorded LAST, so this run's own observation can only ever be used as a
    // ceiling by a later run.
    await this.checkpoints.recordPendingIngestSeq({
      seq: input.observation.ceiling,
      observedAt: input.observation.dbNow,
    });
  }

  /** The settled ceiling, or null when the guard holds the position back. */
  private resolveIngestCeiling(input: {
    pendingSeq: bigint | null;
    pendingObservedAt: Date | null;
    observation: IngestObservation;
  }): bigint | null {
    const { pendingSeq, pendingObservedAt, observation } = input;
    if (pendingSeq === null || pendingObservedAt === null) return null;
    const elapsedMs = observation.dbNow.getTime() - pendingObservedAt.getTime();
    if (elapsedMs < this.config.ingestSettleGraceMs) return null;
    if (
      observation.oldestWriteXactStart !== null &&
      observation.oldestWriteXactStart.getTime() <= pendingObservedAt.getTime()
    ) {
      // A write transaction older than the observation is still open, so a row
      // it inserted may still appear below the pending value.
      return null;
    }
    // Never above what is actually visible now: the pending value is a bound,
    // not a promise that those rows still exist.
    return bigintMin(pendingSeq, observation.ceiling);
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
      // REVISION-AWARE dedupe: a processed row blocks re-examination only for
      // the revision it covers. A corrected candle carries a HIGHER ingestSeq
      // and is examined again; the status guard on orders keeps the re-run
      // additive-only (an order executed under the previous revision can
      // never fill twice), so only orders the correction NEWLY qualifies are
      // touched.
      const alreadyProcessed =
        await this.prisma.limitOrderProcessedCandle.findUnique({
          where: { marketCandleId: candle.id },
          select: { candleIngestSeq: true },
        });
      if (
        alreadyProcessed &&
        alreadyProcessed.candleIngestSeq >= candle.ingestSeq
      ) {
        return { state: 'processed', result: 'skipped', matchedOrderCount: 0 };
      }
      const isRevisionRerun = alreadyProcessed !== null;

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
                ingestSeq: candle.ingestSeq,
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
      if (isRevisionRerun) {
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_candle_revision_reprocessed',
            marketCandleId: candle.id,
            assetId: candle.assetId,
            openTime: candle.openTime.toISOString(),
            candleIngestSeq: candle.ingestSeq.toString(),
            newlyMatchedOrders: matchedOrderCount,
          }),
        );
      }
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

  private async recordProcessed(
    candle: CandleRow,
    processedAt: Date,
    matchedOrderCount: number,
    result: 'matched' | 'skipped',
    skipReason: string | null,
  ): Promise<void> {
    await this.prisma.limitOrderProcessedCandle
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
          candleIngestSeq: candle.ingestSeq,
          firstProcessedAt: processedAt,
        },
      })
      .catch(async (error: unknown) => {
        if (!isUniqueConstraintError(error)) throw error;
        // Either a concurrent worker recorded the SAME revision (idempotent
        // no-op — the monotonic guard below refuses to move backwards), or
        // this run reprocessed a NEWER revision of an already-recorded
        // candle: advance the row to the revision just covered, keeping the
        // first-processed instant and accumulating the match count for audit.
        await this.prisma.$executeRaw`
          UPDATE "limit_order_processed_candles"
          SET
            "candle_ingest_seq" = ${candle.ingestSeq.toString()}::bigint,
            "processed_at" = ${processedAt},
            "matched_order_count" = "matched_order_count" + ${matchedOrderCount},
            "result" = ${result},
            "skip_reason" = ${skipReason},
            "revision_count" = "revision_count" + 1
          WHERE "market_candle_id" = ${candle.id}
            AND "candle_ingest_seq" < ${candle.ingestSeq.toString()}::bigint
        `;
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
   * Closed 5m rows STORED after the durable position that have no
   * processed-candle row, are not already in the durable retry queue, and
   * whose asset has at least one activated, still-open limit buy that the
   * window could fill.
   *
   * Ordered by `ingest_seq`, not by `open_time`: the ordering must be the one
   * the watermark advances through, or a row could sit permanently between the
   * scan's ordering and the position's.
   */
  private findUnprocessedCandles(input: {
    afterIngestSeq: bigint;
    to: Date;
    limit: number;
  }): Promise<CandleRow[]> {
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
        ingestSeq: bigint;
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
          c."ingest_seq" AS "ingestSeq",
          a."asset_type" AS "assetType",
          a."market",
          a."is_active" AS "assetIsActive"
        FROM "market_candles" c
        JOIN "assets" a ON a."id" = c."asset_id"
        WHERE c."interval" = ${LIMIT_ORDER_CANDLE_INTERVAL}
          AND c."is_closed" = true
          AND c."ingest_seq" IS NOT NULL
          AND c."ingest_seq" > ${input.afterIngestSeq.toString()}::bigint
          AND c."close_time" <= ${input.to}
          AND a."is_active" = true
          AND NOT EXISTS (
            SELECT 1 FROM "limit_order_processed_candles" p
            WHERE p."market_candle_id" = c."id"
              -- Revision-aware: a processed row only covers the revision it
              -- recorded. A corrected candle (higher ingest_seq) reappears.
              AND p."candle_ingest_seq" >= c."ingest_seq"
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
        ORDER BY c."ingest_seq" ASC
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
        ingestSeq: bigint | null;
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
          c."ingest_seq" AS "ingestSeq",
          a."asset_type" AS "assetType",
          a."market",
          a."is_active" AS "assetIsActive"
        FROM "market_candles" c
        JOIN "assets" a ON a."id" = c."asset_id"
        WHERE c."id" = ${marketCandleId}
      `.then((rows) =>
      rows[0]
        ? toCandleRow({ ...rows[0], ingestSeq: rows[0].ingestSeq ?? 0n })
        : null,
    );
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
  ingestSeq: bigint;
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
    ingestSeq: row.ingestSeq,
    asset: {
      id: row.assetId,
      assetType: row.assetType,
      market: row.market,
      isActive: row.assetIsActive,
    },
  };
}

function bigintMin(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
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
    watermarkIngestSeq: null,
    observedIngestSeq: null,
    ingestCeilingHeld: false,
    gapDetected: false,
    degradedReason: null,
    windowCompletion: null,
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
