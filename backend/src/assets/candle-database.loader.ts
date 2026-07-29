import { Inject, Injectable } from '@nestjs/common';
import { MarketCandleSyncStatus } from '../generated/prisma/client';
import type {
  AssetCandlesAsset,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';
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

export type CandleDatabaseLoadResult = {
  plan: CandleReadPlan;
  state: CandleDatabaseState;
  fresh: boolean;
  completedCoverage: boolean;
  hasBlockingCheckpoint: boolean;
  droppedIncompleteBuckets: number;
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
        hasBlockingCheckpoint: false,
        droppedIncompleteBuckets: 0,
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
        ? this.syncStates.findCompletedCoverageUnion(
            plan.assetId,
            plan.sourceInterval,
            plan.sourceRange.from,
            coverageTo,
          )
        : Promise.resolve({ covered: false, newestCompletedAt: null }),
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
    const completedCoverage = coverage.covered;

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
    let state: CandleDatabaseState;
    if (rows.length === 0) {
      state =
        completedCoverage &&
        !hasBlockingCheckpoint &&
        droppedIncompleteBuckets === 0
          ? 'confirmed_empty'
          : 'missing';
    } else if (
      completedCoverage &&
      !hasBlockingCheckpoint &&
      droppedIncompleteBuckets === 0
    ) {
      state = 'available';
    } else {
      state = 'incomplete';
    }

    return {
      plan,
      state,
      fresh,
      completedCoverage,
      hasBlockingCheckpoint,
      droppedIncompleteBuckets,
      response,
    };
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
