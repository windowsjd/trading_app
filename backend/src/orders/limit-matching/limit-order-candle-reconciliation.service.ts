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
  from: string | null;
  to: string | null;
};

type CandleRow = CanonicalCandleRow & {
  asset: {
    id: string;
    assetType: AssetType;
    market: string;
    isActive: boolean;
  };
};

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
    if (!this.config.enabled) {
      return {
        enabled: false,
        scannedCandles: 0,
        processedCandles: 0,
        skippedCandles: 0,
        matchedOrders: 0,
        deferredCandles: 0,
        from: null,
        to: null,
      };
    }
    const lookbackMs = input.lookbackMs ?? this.config.lookbackMs;
    const from = new Date(input.now.getTime() - lookbackMs);
    // Only fully elapsed windows. `closeTime <= now` is guaranteed by the
    // isClosed flag, but the explicit bound keeps a clock-skewed writer from
    // presenting a future window as canonical.
    const to = new Date(input.now.getTime());
    const candles = await this.findUnprocessedCandles({
      from,
      to,
      limit: input.candleBatchSize ?? this.config.candleBatchSize,
    });

    const summary: LimitOrderCandleReconciliationSummary = {
      enabled: true,
      scannedCandles: candles.length,
      processedCandles: 0,
      skippedCandles: 0,
      matchedOrders: 0,
      deferredCandles: 0,
      from: from.toISOString(),
      to: to.toISOString(),
    };

    for (const candle of candles) {
      let outcome: Awaited<ReturnType<typeof this.processCandle>>;
      try {
        outcome = await this.processCandle(
          candle,
          input.orderBatchSize ?? this.config.orderBatchSize,
          input.now,
        );
      } catch (error) {
        // One asset's transient failure (a missing valuation price, a lock
        // timeout) must not stop the sweep for every other asset. No
        // processed-candle row is written, so this candle is retried on the
        // next tick; the failure is surfaced on the summary and in the log.
        summary.deferredCandles += 1;
        const code =
          error instanceof LimitOrderExecutionError ? error.code : null;
        const entry = JSON.stringify({
          event: 'limit_order_candle_sweep_deferred',
          assetId: candle.assetId,
          openTime: candle.openTime.toISOString(),
          code,
          error: error instanceof Error ? error.message : String(error),
        });
        // A reservation mismatch is an unresolved financial inconsistency, not
        // a transient blip: it never self-heals and needs an operator, so it is
        // logged at error level while the reservation stays untouched.
        if (code === 'LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH') {
          this.logger.error(entry);
        } else {
          this.logger.warn(entry);
        }
        continue;
      }
      if (outcome.state === 'deferred') {
        summary.deferredCandles += 1;
        continue;
      }
      summary.processedCandles += 1;
      summary.matchedOrders += outcome.matchedOrderCount;
      if (outcome.result === 'skipped') summary.skippedCandles += 1;
    }
    return summary;
  }

  private async processCandle(
    candle: CandleRow,
    orderBatchSize: number,
    now: Date,
  ): Promise<
    | {
        state: 'processed';
        result: 'matched' | 'skipped';
        matchedOrderCount: number;
      }
    | { state: 'deferred'; reason: string }
  > {
    const structural = checkCanonicalClosedCandle(candle);
    if (!structural.ok) {
      // Permanent defects are recorded as processed-with-reason so the same
      // broken row is not re-examined on every 60s tick, and stay visible as
      // an operational warning.
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
      return { state: 'deferred', reason: 'asset_inactive' };
    }

    if (candle.asset.assetType !== AssetType.crypto) {
      const session = this.resolveStockSession(candle);
      if (session === 'calendar_unavailable') {
        // Transient by definition: a calendar dataset can be added later.
        // No processed row is written, so the candle is retried next tick.
        this.logger.warn(
          JSON.stringify({
            event: 'limit_order_candle_calendar_unavailable',
            assetId: candle.assetId,
            market: candle.asset.market,
            openTime: candle.openTime.toISOString(),
          }),
        );
        return { state: 'deferred', reason: 'calendar_unavailable' };
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
    // and the fill.
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

  /**
   * Closed 5m rows in the lookback window that have no processed-candle row
   * and whose asset has at least one activated, still-open limit buy. The
   * NOT EXISTS on processed candles is what keeps a 60s tick from re-scanning
   * the same candles forever.
   */
  private findUnprocessedCandles(input: {
    from: Date;
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
          AND c."open_time" >= ${input.from}
          AND c."close_time" <= ${input.to}
          AND a."is_active" = true
          AND NOT EXISTS (
            SELECT 1 FROM "limit_order_processed_candles" p
            WHERE p."market_candle_id" = c."id"
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
      `.then((rows) =>
      rows.map((row) => ({
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
      })),
    );
  }
}

export const LIMIT_ORDER_CANDLE_WINDOW_MS = FIVE_MINUTES_MS;

function isUniqueConstraintError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'P2002'
  );
}
