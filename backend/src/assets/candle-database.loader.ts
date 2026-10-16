import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  MarketCandleSyncStatus,
  Prisma,
  type MarketCandle,
} from '../generated/prisma/client';
import { resolveMarketSession } from '../orders/market-calendar.policy';
import { KOSCOM_MINUTE_SOURCE } from '../providers/koscom/koscom.config';
import { resolvePeriodWindowForDate } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { TIINGO_INTRADAY_CANDLE_SOURCE } from '../providers/tiingo/tiingo.config';
import { newYorkDate } from '../providers/tiingo/tiingo-candle-normalizer';
import {
  usCandleRowFilter,
  usCandlesFromTiingo,
  usCheckpointFilter,
} from './us-candle-provider';
import {
  FIVE_MINUTES_MS,
  kstDate,
  kstDayStartMs,
  krxDailyBridge,
  krxFiveMinuteBridge,
  requiredFiveMinuteSlotStarts,
} from './krx-candle-collection.policy';
import {
  KRX_CENTRAL_CANDLES_CONFIG,
  resolveKrxObligationStart,
  type KrxCentralCandlesConfig,
} from './krx-central-candles.config';
import type {
  AssetCandlesAsset,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import {
  MarketCandleSyncStateRepository,
  type CandleCoverageEvidence,
  type CandleCoverageOptions,
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
  /**
   * KRX central mode, 5m-sourced windows starting before the obligation
   * start A (design v2.1 §4.2 rule 10, log/G4 only): `pre_obligation` when
   * everything after A is proven, `post_obligation` when it is not.
   */
  obligation?: 'pre_obligation' | 'post_obligation' | null;
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
    @Optional()
    @Inject(KRX_CENTRAL_CANDLES_CONFIG)
    private readonly krxCentral?: KrxCentralCandlesConfig,
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
    const krxEvidence = this.krxCentralEvidence(asset, plan, query.clock);
    // US stocks: only the current provider's checkpoints are evidence.
    const usTiingo = usCandlesFromTiingo(asset);
    const usEvidence =
      usCheckpointFilter(asset, plan.sourceInterval) ?? undefined;
    const evidence = krxEvidence ?? usEvidence;
    const [coverage, latestCheckpoint] = await Promise.all([
      coverageTo.getTime() > plan.sourceRange.from.getTime()
        ? this.syncStates.findCandleCoverage(
            plan.assetId,
            plan.sourceInterval,
            plan.sourceRange.from,
            coverageTo,
            ...(evidence ? [evidence] : []),
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
        usEvidence,
      ),
    ]);
    const hasBlockingCheckpoint =
      latestCheckpoint !== null &&
      latestCheckpoint.status !== MarketCandleSyncStatus.completed;
    const coverageStatus = this.classifyCoverage(coverage, coverageTo);
    const completedCoverage = coverageStatus === 'complete';

    let rows: PersistedResponseCandle[];
    let sourceProviders: string[] | undefined;
    let droppedIncompleteBuckets = 0;
    if (plan.history) {
      const merged = await this.loadLongFourHour(
        asset,
        query,
        plan,
        plan.history,
      );
      rows = merged.rows;
      sourceProviders = merged.sourceProviders;
      droppedIncompleteBuckets = merged.droppedIncompleteBuckets;
    } else if (plan.requiresAggregation) {
      const stored = await this.findRows(asset, {
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
      if (asset.assetType === 'domestic_stock') {
        const first = rows[0]?.openTime.getTime();
        const last = rows.at(-1) as
          | (PersistedResponseCandle & { closeTime?: Date })
          | undefined;
        const end =
          last?.closeTime?.getTime() ?? plan.requestedRange.to.getTime();
        sourceProviders = [
          ...new Set(
            stored
              .filter(
                (r) =>
                  first !== undefined &&
                  r.openTime.getTime() >= first &&
                  r.openTime.getTime() < end,
              )
              .map((r) => r.sourceProvider),
          ),
        ];
      }
    } else {
      let stored = await this.findRows(asset, {
        assetId: plan.assetId,
        interval: plan.sourceInterval,
        from: plan.requestedRange.from,
        to: plan.requestedRange.to,
      });
      if (krxEvidence && plan.sourceInterval === '1d')
        stored = await this.withKrxDailyInProgress(plan, stored, query.clock);
      else if (usTiingo && plan.sourceInterval === '1d')
        stored = await this.withUsDailyInProgress(plan, stored, query.clock);
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
      if (asset.assetType === 'domestic_stock') {
        const first = rows[0]?.openTime.getTime();
        const last = rows.at(-1) as
          | (PersistedResponseCandle & { closeTime?: Date })
          | undefined;
        const end =
          last?.closeTime?.getTime() ?? plan.requestedRange.to.getTime();
        sourceProviders = [
          ...new Set(
            stored
              .filter(
                (r) =>
                  first !== undefined &&
                  r.openTime.getTime() >= first &&
                  r.openTime.getTime() < end,
              )
              .map((r) => r.sourceProvider),
          ),
        ];
      }
    }

    const response = this.responses.buildPersisted(
      asset,
      query,
      rows,
      sourceProviders,
    );
    // KRX central mode (rule 8): fresh exactly when everything that can
    // exist as confirmed data is proven — there is no refresh to trigger.
    const fresh = krxEvidence
      ? coverageStatus === 'complete'
      : this.isFresh(rows, coverage.newestCompletedAt, plan, query.clock);
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
      ...(krxEvidence
        ? {
            obligation: await this.classifyObligation(
              asset,
              plan,
              coverageTo,
              krxEvidence,
            ),
          }
        : {}),
    };
  }

  /** KRX central evidence rules (design v2.1 §4.2 rule 7), else undefined. */
  private krxCentralEvidence(
    asset: AssetCandlesAsset,
    plan: CandleReadPlan,
    clock: Date,
  ): CandleCoverageOptions | undefined {
    if (!this.krxCentral?.enabled || asset.assetType !== 'domestic_stock')
      return undefined;
    if (plan.sourceInterval === '5m') {
      const start = resolveKrxObligationStart(this.krxCentral, asset.symbol);
      // Checkpoints from before A (e.g. legacy KIS/on-demand runs, F26) are
      // never evidence; the data itself is untouched.
      return {
        bridge: krxFiveMinuteBridge(clock.getTime()),
        ...(start ? { createdAtOrAfter: start } : {}),
      };
    }
    if (plan.sourceInterval === '1d')
      return { bridge: krxDailyBridge(clock.getTime()) };
    return {};
  }

  /**
   * Rule 10 (log/G4 only): a 5m-sourced window that starts before A is
   * re-judged from A with the same rules. Proven after A = initial history
   * (`pre_obligation`); a hole after A is a collection defect.
   */
  private async classifyObligation(
    asset: AssetCandlesAsset,
    plan: CandleReadPlan,
    coverageTo: Date,
    evidence: CandleCoverageOptions,
  ): Promise<'pre_obligation' | 'post_obligation' | null> {
    const start = evidence.createdAtOrAfter;
    if (
      plan.sourceInterval !== '5m' ||
      !start ||
      plan.sourceRange.from.getTime() >= start.getTime() ||
      coverageTo.getTime() <= start.getTime()
    )
      return null;
    const afterStart = await this.syncStates.findCandleCoverage(
      plan.assetId,
      '5m',
      start,
      coverageTo,
      evidence,
    );
    const status = this.classifyCoverage(afterStart, coverageTo);
    return status === 'insufficient' ? 'post_obligation' : 'pre_obligation';
  }

  /**
   * Stored rows of the window. US stocks read only the current provider's
   * rows: on Tiingo a KIS row from before the switch (same window keys) is
   * never served, and after a rollback to KIS no Tiingo row is.
   */
  private async findRows(
    asset: AssetCandlesAsset,
    input: Parameters<MarketCandlesRepository['findRange']>[0],
  ): Promise<MarketCandle[]> {
    const rows = await this.repository.findRange(input);
    const keep = usCandleRowFilter(asset);
    return keep ? rows.filter(keep) : rows;
  }

  /**
   * US stocks on Tiingo: today's in-progress daily bar comes from today's
   * stored Tiingo 5m bars until the end-of-day row arrives (about 17:30 New
   * York) — never from price snapshots, never interpolated (the KRX central
   * rule). Tiingo bars land with the scheduled sync (every 10 minutes), so
   * the newest stored bar trails the clock: the bar is built from the stored
   * prefix of today, i.e. only while every required slot from the open
   * through the newest stored bar is stored (a missing slot hides it).
   */
  private async withUsDailyInProgress(
    plan: CandleReadPlan,
    stored: MarketCandle[],
    clock: Date,
  ): Promise<MarketCandle[]> {
    const session = resolveMarketSession(
      'US',
      newYorkDate(clock.getTime()).replace(/-/gu, ''),
    );
    if (!session || clock.getTime() <= session.openTime.getTime())
      return stored;
    const window = resolvePeriodWindowForDate(
      'US',
      session.localDate.replace(/-/gu, ''),
      '1d',
    );
    if (!window) return stored;
    const dayStart = window.openTime.getTime();
    if (
      dayStart < plan.requestedRange.from.getTime() ||
      dayStart >= plan.requestedRange.to.getTime()
    )
      return stored;
    if (
      stored.some((row) => row.openTime.getTime() === dayStart && row.isClosed)
    )
      return stored;
    const others = stored.filter((row) => row.openTime.getTime() !== dayStart);
    const fiveMinute = (
      await this.repository.findRange({
        assetId: plan.assetId,
        interval: '5m',
        from: session.openTime,
        to: new Date(
          Math.max(
            session.openTime.getTime() + 1,
            Math.min(clock.getTime(), session.closeTime.getTime()),
          ),
        ),
      })
    ).filter(
      (row) =>
        row.sourceProvider === TIINGO_INTRADAY_CANDLE_SOURCE && row.isClosed,
    );
    if (fiveMinute.length === 0) return others;
    const storedSlots = new Set(
      fiveMinute.map((row) => row.openTime.getTime()),
    );
    const newestStored = Math.max(...storedSlots);
    const complete = requiredFiveMinuteSlotStarts(session).every(
      (slot) => slot > newestStored || storedSlots.has(slot),
    );
    if (!complete) return others;
    return [
      ...others,
      dailyFromFiveMinute(fiveMinute, dayStart, window.closeTime.getTime()),
    ];
  }

  /**
   * KRX central mode (design v2.1 §4.5, product approval P2): today's
   * in-progress daily bar is built at read time from today's stored KOSCOM
   * 5m candles, never from price snapshots. Only when EVERY closed required
   * slot of today is stored; otherwise no in-progress bar is shown (no
   * interpolation). The confirmed post-close daily bar replaces it.
   */
  private async withKrxDailyInProgress(
    plan: CandleReadPlan,
    stored: MarketCandle[],
    clock: Date,
  ): Promise<MarketCandle[]> {
    const session = resolveMarketSession(
      'KRX',
      kstDate(clock.getTime()).replace(/-/gu, ''),
    );
    if (!session || clock.getTime() <= session.openTime.getTime())
      return stored;
    const dayStart = kstDayStartMs(session.localDate);
    if (
      dayStart < plan.requestedRange.from.getTime() ||
      dayStart >= plan.requestedRange.to.getTime()
    )
      return stored;
    const confirmed = stored.find(
      (row) => row.openTime.getTime() === dayStart && row.isClosed,
    );
    if (confirmed) return stored;
    const others = stored.filter((row) => row.openTime.getTime() !== dayStart);
    const fiveMinute = (
      await this.repository.findRange({
        assetId: plan.assetId,
        interval: '5m',
        from: session.openTime,
        to: new Date(
          Math.max(
            session.openTime.getTime() + 1,
            Math.min(clock.getTime(), session.closeTime.getTime()),
          ),
        ),
      })
    ).filter((row) => row.sourceProvider === KOSCOM_MINUTE_SOURCE);
    const closedSlots = new Set(
      fiveMinute
        .filter((row) => row.isClosed)
        .map((row) => row.openTime.getTime()),
    );
    const complete = requiredFiveMinuteSlotStarts(session).every(
      (slot) =>
        slot + FIVE_MINUTES_MS > clock.getTime() || closedSlots.has(slot),
    );
    if (!complete || fiveMinute.length === 0) return others;
    return [
      ...others,
      dailyFromFiveMinute(fiveMinute, dayStart, dayStart + 24 * 60 * 60_000),
    ];
  }

  /**
   * Long-range 4h (`range=96d`). Each 4h bucket comes from exactly ONE source:
   *  1. the in-progress (current) bucket → 5m aggregation (live path);
   *  2. a stored COMPLETED '4h' row (Spot native kline / KRX verified KOSCOM
   *     10-minute history) → that row;
   *  3. otherwise a complete, closed 5m-aggregated bucket of the recent window
   *     → that aggregate (e.g. today's finished 09:00 KRX bucket before the
   *     post-close verification, or history not backfilled yet).
   * An incomplete bucket without a stored row is dropped (never interpolated),
   * and the same openTime is never returned twice.
   */
  private async loadLongFourHour(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan,
    history: NonNullable<CandleReadPlan['history']>,
  ): Promise<{
    rows: PersistedResponseCandle[];
    sourceProviders: string[] | undefined;
    droppedIncompleteBuckets: number;
  }> {
    const [storedHistory, storedFiveMinute] = await Promise.all([
      this.findRows(asset, {
        assetId: plan.assetId,
        interval: history.interval,
        from: plan.requestedRange.from,
        to: plan.requestedRange.to,
      }),
      this.findRows(asset, {
        assetId: plan.assetId,
        interval: '5m',
        from: plan.sourceRange.from,
        to: plan.sourceRange.to,
      }),
    ]);
    const clockMs = query.clock.getTime();
    const byOpenTime = new Map<
      number,
      { row: PersistedResponseCandle; providers: string[] }
    >();
    for (const row of storedHistory) {
      if (!row.isClosed || row.closeTime.getTime() > clockMs) continue;
      byOpenTime.set(row.openTime.getTime(), {
        row,
        providers: [row.sourceProvider],
      });
    }
    const aggregated = this.aggregation.aggregateCandles({
      assetType: plan.assetType,
      interval: '4h',
      candles: storedFiveMinute,
      from: history.recentRange.from,
      to: history.recentRange.to,
      now: query.clock,
    });
    let droppedIncompleteBuckets = 0;
    for (const candle of aggregated.candles) {
      const openMs = candle.openTime.getTime();
      const usable = candle.isCurrent || (candle.complete && candle.isClosed);
      if (byOpenTime.has(openMs) && !candle.isCurrent) continue;
      if (!usable) {
        droppedIncompleteBuckets += 1;
        continue;
      }
      const closeMs = candle.closeTime.getTime();
      byOpenTime.set(openMs, {
        row: candle,
        providers: [
          ...new Set(
            storedFiveMinute
              .filter(
                (source) =>
                  source.openTime.getTime() >= openMs &&
                  source.openTime.getTime() < closeMs,
              )
              .map((source) => source.sourceProvider),
          ),
        ],
      });
    }
    const ordered = [...byOpenTime.entries()].sort((a, b) => a[0] - b[0]);
    const selected = this.latest(ordered, plan.limit);
    return {
      rows: selected.map(([, entry]) => entry.row),
      sourceProviders:
        asset.assetType === 'domestic_stock'
          ? [...new Set(selected.flatMap(([, entry]) => entry.providers))]
          : undefined,
      droppedIncompleteBuckets,
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

/**
 * An in-progress daily bar from one session's stored 5m rows (oldest first):
 * first open, extreme high/low, last close, summed volume (amount only when
 * every row has one). Never closed: the provider's daily row replaces it.
 */
function dailyFromFiveMinute(
  fiveMinute: MarketCandle[],
  dayStart: number,
  dayEnd: number,
): MarketCandle {
  const first = fiveMinute[0];
  const last = fiveMinute[fiveMinute.length - 1];
  return {
    ...first,
    interval: '1d',
    openTime: new Date(dayStart),
    closeTime: new Date(dayEnd),
    open: first.open,
    high: Prisma.Decimal.max(...fiveMinute.map((row) => row.high)),
    low: Prisma.Decimal.min(...fiveMinute.map((row) => row.low)),
    close: last.close,
    volume: fiveMinute.reduce(
      (sum, row) => sum.add(row.volume),
      new Prisma.Decimal(0),
    ),
    amount: fiveMinute.every((row) => row.amount !== null)
      ? fiveMinute.reduce(
          (sum, row) => sum.add(row.amount as Prisma.Decimal),
          new Prisma.Decimal(0),
        )
      : null,
    isClosed: false,
    sourceUpdatedAt: new Date(
      Math.max(...fiveMinute.map((row) => row.sourceUpdatedAt.getTime())),
    ),
  };
}
