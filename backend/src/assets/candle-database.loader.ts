import { Inject, Injectable } from '@nestjs/common';
import { MarketCandleSyncStatus } from '../generated/prisma/client';
import type {
  AssetCandlesAsset,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import {
  MarketCandleSyncStateRepository,
  type CandleCoverageEvidence,
} from './market-candle-sync-state.repository';
import { MarketCandlesRepository } from './market-candles.repository';
import {
  CandleReadPlanBuilder,
  type CandleReadPlan,
} from './candle-read-plan.builder';
import {
  CandleResponseBuilder,
  type PersistedResponseCandle,
} from './candle-response.builder';
import {
  CANDLE_SERVING_CONFIG,
  type CandleServingConfig,
} from './candle-serving.config';

export type CandleDatabaseState =
  | 'confirmed_empty'
  | 'missing'
  | 'available'
  | 'incomplete';

/**
 * How confirmed sync coverage relates to the requested window:
 *  - `complete`     — confirmed from the requested start up to the clock;
 *  - `stale_tail`   — the history is confirmed, only the recent tail (within
 *                     `coverageTailToleranceMs`) has not been re-confirmed
 *                     since the last sync. Normal between incremental runs;
 *  - `insufficient` — coverage does not start at the requested `from`, has an
 *                     interior hole, or lags far behind the clock.
 */
export type CandleCoverageStatus = 'complete' | 'stale_tail' | 'insufficient';

export type CandleDatabaseLoadResult = {
  plan: CandleReadPlan;
  state: CandleDatabaseState;
  fresh: boolean;
  /** True only for `complete` coverage (the strict, historical meaning). */
  completedCoverage: boolean;
  coverageStatus: CandleCoverageStatus;
  /** How far confirmed coverage reaches contiguously from the requested start. */
  coveredTo: Date | null;
  hasCoverageInteriorGap: boolean;
  hasBlockingCheckpoint: boolean;
  droppedIncompleteBuckets: number;
  /** Usable candles the store actually produced for this window. */
  storedCandleCount: number;
  response: ReturnType<CandleResponseBuilder['buildPersisted']> | null;
};

@Injectable()
export class CandleDatabaseLoader {
  constructor(
    private readonly plans: CandleReadPlanBuilder,
    private readonly repository: MarketCandlesRepository,
    private readonly syncStates: MarketCandleSyncStateRepository,
    private readonly aggregation: MarketCandleAggregationService,
    private readonly responses: CandleResponseBuilder,
    @Inject(CANDLE_SERVING_CONFIG)
    private readonly config: CandleServingConfig,
  ) {}

  async load(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    plan = this.plans.build(asset, query),
  ): Promise<CandleDatabaseLoadResult> {
    if (!plan.managedByPersistence || plan.sourceInterval === null) {
      return {
        plan,
        state: 'missing',
        fresh: false,
        completedCoverage: false,
        coverageStatus: 'insufficient',
        coveredTo: null,
        hasCoverageInteriorGap: false,
        hasBlockingCheckpoint: false,
        droppedIncompleteBuckets: 0,
        storedCandleCount: 0,
        response: null,
      };
    }

    // Coverage evidence must span the requested range, clamped at the query
    // clock: candles beyond `now` cannot exist yet, so a checkpoint whose
    // provider-confirmed range ends at its own sync time still covers a
    // request whose range nominally extends past the clock. Only
    // coverage-audited checkpoints qualify, and the evidence is the UNION of
    // them: a long range is covered by the seeded baseline run plus the
    // incremental runs that confirmed the tail since (see
    // findCompletedCoverageUnion).
    const coverageTo = new Date(
      Math.min(plan.sourceRange.to.getTime(), query.clock.getTime()),
    );
    const [coverage, latestCheckpoint] = await Promise.all([
      coverageTo.getTime() > plan.sourceRange.from.getTime()
        ? this.syncStates.findCandleCoverage(
            plan.assetId,
            plan.sourceInterval,
            plan.sourceRange.from,
            coverageTo,
          )
        : Promise.resolve<CandleCoverageEvidence>({
            startsAtRequestedFrom: false,
            contiguousCoveredTo: null,
            newestCompletedAt: null,
            hasInteriorGap: false,
          }),
      this.syncStates.findLatestOverlapping(
        plan.assetId,
        plan.sourceInterval,
        plan.sourceRange.from,
        plan.sourceRange.to,
      ),
    ]);
    const hasBlockingCheckpoint =
      latestCheckpoint !== null &&
      latestCheckpoint.status !== MarketCandleSyncStatus.completed;
    const coverageStatus = this.classifyCoverage(coverage, coverageTo);
    const completedCoverage = coverageStatus === 'complete';

    let rows: PersistedResponseCandle[];
    let droppedIncompleteBuckets = 0;
    if (plan.requiresAggregation) {
      const stored = await this.repository.findRange({
        assetId: plan.assetId,
        interval: '5m',
        from: plan.sourceRange.from,
        to: plan.sourceRange.to,
      });
      const aggregated = this.aggregation.aggregateCandles({
        assetType: plan.assetType,
        interval: plan.targetInterval as '15m' | '30m' | '1h' | '4h',
        candles: stored,
        from: plan.requestedRange.from,
        to: plan.requestedRange.to,
        now: query.clock,
      });
      const usable = aggregated.candles.filter((candle) => {
        if (candle.isCurrent) return true;
        if (candle.complete && candle.isClosed) return true;
        droppedIncompleteBuckets += 1;
        return false;
      });
      rows = this.latest(usable, plan.limit);
    } else {
      const stored = await this.repository.findRange({
        assetId: plan.assetId,
        interval: plan.sourceInterval,
        from: plan.requestedRange.from,
        to: plan.requestedRange.to,
      });
      const usable = stored.filter((candle) => {
        if (
          candle.isClosed ||
          candle.closeTime.getTime() > query.clock.getTime()
        ) {
          return true;
        }
        droppedIncompleteBuckets += 1;
        return false;
      });
      rows = this.latest(usable, plan.limit);
    }

    const response = this.responses.buildPersisted(asset, query, rows);
    const fresh = this.isFresh(
      rows,
      coverage.newestCompletedAt,
      plan,
      query.clock,
    );
    // `available` still means "the store fully answers this request". A
    // stale tail is NOT a hole: the history is confirmed and only the last
    // stretch has not been re-confirmed since the previous sync, so it stays
    // servable (the caller refreshes it because `fresh` is false).
    const trustworthy =
      (coverageStatus === 'complete' || coverageStatus === 'stale_tail') &&
      !hasBlockingCheckpoint &&
      droppedIncompleteBuckets === 0;
    let state: CandleDatabaseState;
    if (rows.length === 0) {
      state = trustworthy && completedCoverage ? 'confirmed_empty' : 'missing';
    } else if (trustworthy) {
      state = 'available';
    } else {
      state = 'incomplete';
    }

    return {
      plan,
      state,
      fresh,
      completedCoverage,
      coverageStatus,
      coveredTo: coverage.contiguousCoveredTo,
      hasCoverageInteriorGap: coverage.hasInteriorGap,
      hasBlockingCheckpoint,
      droppedIncompleteBuckets,
      storedCandleCount: rows.length,
      response,
    };
  }

  /**
   * Coverage classification. The tail tolerance exists because a checkpoint
   * confirms coverage only up to its own finish time: one minute after an
   * incremental sync the window is already "not confirmed to now", and
   * demanding exact-to-the-clock coverage would make every long window
   * permanently unservable between syncs.
   */
  private classifyCoverage(
    coverage: CandleCoverageEvidence,
    coverageTo: Date,
  ): CandleCoverageStatus {
    if (!coverage.startsAtRequestedFrom || !coverage.contiguousCoveredTo) {
      return 'insufficient';
    }
    // A hole inside the window is never tolerated, however recent it is.
    if (coverage.hasInteriorGap) return 'insufficient';
    const missingTailMs =
      coverageTo.getTime() - coverage.contiguousCoveredTo.getTime();
    if (missingTailMs <= 0) return 'complete';
    return missingTailMs <= this.config.coverageTailToleranceMs
      ? 'stale_tail'
      : 'insufficient';
  }

  private latest<T>(rows: readonly T[], limit: number): T[] {
    return rows.length > limit ? rows.slice(rows.length - limit) : [...rows];
  }

  private isFresh(
    rows: readonly PersistedResponseCandle[],
    completedAt: Date | null,
    plan: CandleReadPlan,
    now: Date,
  ): boolean {
    if (
      plan.requestedRange.to.getTime() <
      now.getTime() - this.config.currentFreshnessMs
    ) {
      return true;
    }
    let newestUpdate = completedAt?.getTime() ?? 0;
    for (const row of rows as readonly (PersistedResponseCandle & {
      sourceUpdatedAt?: Date;
    })[]) {
      newestUpdate = Math.max(
        newestUpdate,
        row.sourceUpdatedAt?.getTime() ?? 0,
      );
    }
    return newestUpdate >= now.getTime() - this.config.currentFreshnessMs;
  }
}
