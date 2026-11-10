import { evidenceFloor } from '../common/pending-order-modification';
import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  OrderSide,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import {
  isPositiveDecimal,
  PROVIDER_SOURCE_NAMES,
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  selectUsExtendedHoursExecutionSnapshot,
} from '../providers/source-eligibility.policy';
import { UsdKrwRefreshService } from '../providers/usd-krw-refresh.service';
import { usExtendedHoursLimitMatchingEnabled } from './us-extended-hours.config';
import {
  resolveUsExtendedHoursWindow,
  type UsExtendedHoursWindow,
} from './us-extended-hours.policy';
import {
  readLimitOrderMatchingConfig,
  type LimitOrderMatchingConfig,
} from './limit-order-matching.config';
import {
  LimitOrderCandidateRepository,
  type LimitMatchCandidate,
  type LimitMatchCursor,
} from './limit-order-candidate.repository';
import {
  LimitOrderCandleEvidenceService,
  type ClosedCandleEvaluation,
} from './limit-order-candle-evidence.service';
import {
  LimitOrderExecutionService,
  type ContinuousLimitFillPlan,
} from './limit-order-execution.service';
import {
  addLimitMatchingSample,
  boundLimitMatchingSample,
  classifyLimitExecutionError,
  countReason,
  createLimitMatchingDiagnostics,
  EXECUTION_SKIP_REASONS,
  observedReason,
  SNAPSHOT_SELECTION_REASONS,
  type CandleOrderExclusionReason,
  type FxPreparationOutcome,
  type PathAReason,
  type PathBReason,
  type SnapshotSelectionReason,
} from './limit-order-matching-diagnostics';

/** Bound DB reads independently of the number of fill attempts. */
const SCANS_PER_ATTEMPT = 4;
const MAX_SCANS_PER_CYCLE = 1_000;
const CANDIDATE_PAGE_SIZE = 200;
/** After a failed USD/KRW preparation, the matcher waits this long before
 * asking the FX providers again (fills keep re-selecting committed FX). */
export const LIMIT_MATCHING_FX_RETRY_MS = 60_000;

export type LimitMatchingSummary = {
  assetsScanned: number;
  candidatesScanned: number;
  ordersConsidered: number;
  filledPathA: number;
  filledPathB: number;
  skipped: number;
  errors: number;
  batchExhausted: boolean;
  scanExhausted: boolean;
  diagnostics: ReturnType<typeof createLimitMatchingDiagnostics>;
};

type PathASnapshotEvaluation = {
  snapshot: { id: string; price: Prisma.Decimal; effectiveAt: Date } | null;
  reason: SnapshotSelectionReason;
};
type FillPlanDecision = {
  plan: ContinuousLimitFillPlan | null;
  pathA: PathAReason;
  pathB: PathBReason;
  candleOrderExclusions: Partial<Record<CandleOrderExclusionReason, number>>;
};

/**
 * One matching cycle: for each asset with fillable submitted limit orders,
 * evaluate path A (fresh provider snapshot) then path B (closed 5m candle
 * touch), and fill the qualifying orders — each in its own transaction, oldest
 * first. Single-instance execution is the scheduler's OpsJobLock, not this
 * service. This service reads and decides; the execution service does the
 * money under row locks.
 */
@Injectable()
export class LimitOrderMatchingService {
  private readonly logger = new Logger(LimitOrderMatchingService.name);
  private nextCandidate: LimitMatchCursor | null = null;
  /** Earliest time the next USD/KRW preparation may call a provider. */
  private fxRetryNotBeforeMs = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: LimitOrderCandidateRepository,
    private readonly candleEvidence: LimitOrderCandleEvidenceService,
    private readonly execution: LimitOrderExecutionService,
    @Optional()
    private readonly rankingRefresh?: RankingRefreshService,
    @Optional()
    private readonly usdKrwRefresh?: UsdKrwRefreshService,
  ) {}

  private readConfig(): LimitOrderMatchingConfig {
    return readLimitOrderMatchingConfig();
  }

  /**
   * Cheap "is there anything to do" probe used by the scheduler to avoid
   * dispatching (and auditing) an idle cycle. True when at least one fillable
   * submitted limit order exists.
   */
  async hasFillableWork(now: Date): Promise<boolean> {
    const assetIds = await this.candidates.findAssetIdsWithFillableLimitBuys(
      now,
      1,
    );
    return assetIds.length > 0;
  }

  async matchDueLimitOrders(input: {
    now: Date;
    batchSize?: number;
    candleLookbackMs?: number;
    isLockOwned?: () => boolean;
  }): Promise<LimitMatchingSummary> {
    const config = this.readConfig();
    const batchSize = input.batchSize ?? config.batchSize;
    const candleLookbackMs = input.candleLookbackMs ?? config.candleLookbackMs;
    // Scheduler/evidence scan time only; each fill reads its own DB clock.
    const cycleNow = input.now;

    const summary: LimitMatchingSummary = {
      assetsScanned: 0,
      candidatesScanned: 0,
      ordersConsidered: 0,
      filledPathA: 0,
      filledPathB: 0,
      skipped: 0,
      errors: 0,
      batchExhausted: false,
      scanExhausted: false,
      diagnostics: createLimitMatchingDiagnostics(),
    };
    const diagnostics = summary.diagnostics;

    // Deduped set of participants whose rankings need a refresh after commit.
    const rankingTargets = new Map<
      string,
      { seasonId: string; participantId: string }
    >();
    const refreshRankingsAfterCommittedFills = () => {
      for (const target of rankingTargets.values()) {
        this.refreshRankingAfterFill(target.seasonId, target.participantId);
      }
    };

    let attemptsRemaining = batchSize;
    let scansRemaining = Math.min(
      batchSize * SCANS_PER_ATTEMPT,
      MAX_SCANS_PER_CYCLE,
    );
    const assetEvidence = new Map<
      string,
      {
        snapshot: PathASnapshotEvaluation;
        candles: ClosedCandleEvaluation;
      }
    >();
    // A US stock fill needs fill-time USD/KRW evidence ≤ 60 s old, which the
    // fill transaction selects itself. With extended-hours limit matching on
    // (its rollout switch, so both switches off keep the old behavior), the
    // matcher prepares it once per cycle, outside every transaction, before
    // the first US stock fill of any session (the LOC settlement pattern); a
    // failed preparation is not retried for a minute.
    const prepareFx = usExtendedHoursLimitMatchingEnabled();
    let fxPreparation: Promise<void> | null = null;
    const prepareUsdKrw = () =>
      (fxPreparation ??= this.prepareUsdKrwForFills(diagnostics));

    while (scansRemaining > 0 && attemptsRemaining > 0) {
      if (input.isLockOwned && !input.isLockOwned()) {
        refreshRankingsAfterCommittedFills();
        throw new Error('Ops job lock ownership was lost.');
      }
      const pageSize = Math.min(scansRemaining, CANDIDATE_PAGE_SIZE);
      const page = await this.candidates.findFillableLimitOrdersAfter(
        cycleNow,
        pageSize,
        this.nextCandidate,
      );
      if (page.length === 0) {
        this.nextCandidate = null;
        break;
      }

      for (const row of page) {
        // Progress includes no-plan orders, skipped fills, and execution errors.
        // It is a value keyset, so a removed cursor row is harmless.
        this.nextCandidate = row.cursor;
        summary.candidatesScanned += 1;
        scansRemaining -= 1;
        const candidate = row.candidate;
        if (!candidate) {
          countReason(
            diagnostics.candidateRejections,
            'candidate_shape_invalid',
          );
          addLimitMatchingSample(diagnostics, {
            orderId: row.cursor.id,
            assetId: row.assetId,
            phase: 'candidate',
            reason: 'candidate_shape_invalid',
          });
          continue;
        }

        let evidence = assetEvidence.get(row.assetId);
        if (!evidence) {
          evidence = {
            snapshot: await this.resolvePathASnapshot(
              candidate.asset,
              cycleNow,
            ),
            candles: await this.candleEvidence.evaluateClosedCandlesForAsset(
              {
                assetType: candidate.asset.assetType,
                market: candidate.asset.market,
                id: candidate.asset.id,
              },
              cycleNow,
              candleLookbackMs,
            ),
          };
          assetEvidence.set(row.assetId, evidence);
          summary.assetsScanned += 1;
          countReason(
            diagnostics.planning.snapshotSelections,
            evidence.snapshot.reason,
          );
          const candleCounts = diagnostics.planning.candleEvidence;
          candleCounts.calendarUnavailableAssets += Number(
            evidence.candles.calendarUnavailable,
          );
          candleCounts.rowsRead += evidence.candles.rowsRead;
          candleCounts.eligible += evidence.candles.candles.length;
          for (const [reason, count] of Object.entries(
            evidence.candles.exclusions,
          )) {
            countReason(
              candleCounts.exclusions,
              reason as keyof typeof candleCounts.exclusions,
              count,
            );
          }
        }

        const decision = this.buildFillPlan(
          candidate,
          evidence.snapshot,
          evidence.candles,
        );
        countReason(diagnostics.planning.pathA, decision.pathA);
        countReason(diagnostics.planning.pathB, decision.pathB);
        for (const [reason, count] of Object.entries(
          decision.candleOrderExclusions,
        )) {
          countReason(
            diagnostics.planning.candleOrderExclusions,
            reason as CandleOrderExclusionReason,
            count,
          );
        }
        const plan = decision.plan;
        if (!plan) {
          diagnostics.planning.noPlan += 1;
          addLimitMatchingSample(diagnostics, {
            orderId: candidate.id,
            assetId: row.assetId,
            phase: 'no_plan',
            pathA: decision.pathA,
            sourceSelectionReason: evidence.snapshot.reason,
            pathB: decision.pathB,
          });
          continue;
        }
        if (input.isLockOwned && !input.isLockOwned()) {
          refreshRankingsAfterCommittedFills();
          throw new Error('Ops job lock ownership was lost.');
        }
        summary.ordersConsidered += 1;
        attemptsRemaining -= 1;
        diagnostics.execution.attempts[plan.path] += 1;
        if (prepareFx && needsUsdKrwPreparation(candidate))
          await prepareUsdKrw();
        try {
          const outcome = await this.execution.fillLimitOrder({
            orderId: candidate.id,
            plan,
          });
          if (outcome.state === 'filled') {
            if (outcome.path === 'snapshot') summary.filledPathA += 1;
            else summary.filledPathB += 1;
            if (outcome.seasonId && outcome.seasonParticipantId) {
              rankingTargets.set(
                `${outcome.seasonId}:${outcome.seasonParticipantId}`,
                {
                  seasonId: outcome.seasonId,
                  participantId: outcome.seasonParticipantId,
                },
              );
            }
          } else {
            summary.skipped += 1;
            const reason = observedReason(
              outcome.reason,
              EXECUTION_SKIP_REASONS,
            );
            countReason(diagnostics.execution.skipReasons, reason);
            addLimitMatchingSample(diagnostics, {
              orderId: candidate.id,
              assetId: row.assetId,
              phase: 'execution_skip',
              path: plan.path,
              reason,
            });
          }
        } catch (error) {
          // Per-order isolation: one order's failure never aborts the rest of
          // the cycle. Transient failures are retried on the next cycle.
          summary.errors += 1;
          const failure = classifyLimitExecutionError(error);
          countReason(diagnostics.execution.errorReasons, failure.reason);
          countReason(diagnostics.execution.errorStages, failure.stage);
          diagnostics.execution.errorsByPath[plan.path] += 1;
          const sample = {
            orderId: candidate.id,
            assetId: row.assetId,
            phase: 'execution_error' as const,
            path: plan.path,
            ...failure,
          };
          addLimitMatchingSample(diagnostics, sample);
          this.logger.error(
            JSON.stringify({
              event: 'limit_order_fill_failed',
              ...boundLimitMatchingSample(sample),
            }),
          );
        }
        if (attemptsRemaining === 0) break;
      }
      if (attemptsRemaining === 0) break;
      if (page.length < pageSize) {
        this.nextCandidate = null;
        break;
      }
    }
    summary.batchExhausted = attemptsRemaining === 0;
    summary.scanExhausted = scansRemaining === 0;

    // Ranking refresh AFTER the fills commit (fire-and-forget, deduped), exactly
    // like the market-order path — never awaited inside a fill transaction.
    refreshRankingsAfterCommittedFills();

    return summary;
  }

  /**
   * Path A takes priority: if a fresh provider snapshot reaches the limit, fill
   * at the snapshot price. Otherwise path B: the earliest eligible closed 5m
   * candle whose buy-low/sell-high reached the limit, filled at the ORDER's
   * limitPrice.
   */
  private buildFillPlan(
    candidate: LimitMatchCandidate,
    snapshotEvaluation: PathASnapshotEvaluation,
    candleEvaluation: ClosedCandleEvaluation,
  ): FillPlanDecision {
    const pathASnapshot = snapshotEvaluation.snapshot;
    const side = candidate.side ?? OrderSide.buy;
    // Evidence must follow the submission, or the order's latest 설정 변경.
    const evidenceFrom = evidenceFloor(candidate, candidate.submittedAt);
    if (
      pathASnapshot &&
      pathASnapshot.effectiveAt >= evidenceFrom &&
      ((side === OrderSide.buy &&
        pathASnapshot.price.lte(candidate.limitPrice)) ||
        (side === OrderSide.sell &&
          pathASnapshot.price.gte(candidate.limitPrice)))
    ) {
      return {
        plan: {
          path: 'snapshot',
          executedPrice: pathASnapshot.price,
          assetPriceSnapshotId: pathASnapshot.id,
        },
        pathA: 'trigger_found',
        pathB: 'not_evaluated_path_a_selected',
        candleOrderExclusions: {},
      };
    }
    const pathA: PathAReason = !pathASnapshot
      ? 'snapshot_selection_failed'
      : pathASnapshot.effectiveAt < evidenceFrom
        ? 'before_submission'
        : 'limit_not_crossed';

    const trigger = this.candleEvidence.evaluateTriggerCandleForOrder(
      candleEvaluation.candles,
      {
        submittedAt: evidenceFrom,
        limitPrice: candidate.limitPrice,
        side,
        seasonEndAt: candidate.seasonEndAt,
      },
    );
    const candle = trigger.candle;
    if (candle) {
      return {
        plan: {
          path: 'candle',
          executedPrice: candidate.limitPrice,
          candle,
        },
        pathA,
        pathB: 'trigger_found',
        candleOrderExclusions: trigger.exclusions,
      };
    }
    return {
      plan: null,
      pathA,
      pathB: candleEvaluation.calendarUnavailable
        ? 'calendar_unavailable'
        : candleEvaluation.rowsRead === 0
          ? 'no_closed_candle_rows'
          : candleEvaluation.candles.length === 0
            ? 'all_candle_rows_excluded'
            : trigger.reason,
      candleOrderExclusions: trigger.exclusions,
    };
  }

  /**
   * Latest VALID fresh provider snapshot for path A, or null. Reuses the exact
   * order-execute eligibility + market-session selection: admin_manual /
   * official_batch are rejected, stocks require an open session, crypto is 24h.
   * A US stock inside its pre-market/after-hours (extended limit matching on)
   * takes that window's fresh extended-hours price instead.
   */
  private async resolvePathASnapshot(
    asset: LimitMatchCandidate['asset'],
    now: Date,
  ): Promise<PathASnapshotEvaluation> {
    const eligibility = resolveAssetProviderEligibility({
      workflow: 'orders_execute',
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: asset.currencyCode,
      },
    });
    if (!eligibility.eligible)
      return {
        snapshot: null,
        reason: observedReason(eligibility.reason, SNAPSHOT_SELECTION_REASONS),
      };

    const priceCurrency = asset.priceCurrency ?? asset.currencyCode;
    const extendedWindow =
      asset.assetType === AssetType.us_stock &&
      usExtendedHoursLimitMatchingEnabled()
        ? resolveUsExtendedHoursWindow(asset, now)
        : null;
    if (extendedWindow)
      return this.resolveExtendedHoursPathASnapshot(
        asset.id,
        priceCurrency,
        now,
        extendedWindow,
        eligibility.freshnessThresholdSeconds,
      );
    const candidates = await this.prisma.assetPriceSnapshot.findMany({
      where: {
        assetId: asset.id,
        currencyCode: priceCurrency,
        sourceType: AssetPriceSourceType.provider_api,
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 10,
      select: {
        id: true,
        price: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });

    const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
      asset: { assetType: asset.assetType, market: asset.market },
      workflow: 'orders_execute',
      candidates,
      expectedSourceNames: eligibility.sourceNames,
      now,
      freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });

    return {
      snapshot:
        selection.state === 'selected'
          ? {
              id: selection.snapshot.id,
              price: selection.snapshot.price,
              effectiveAt: selection.snapshot.effectiveAt,
            }
          : null,
      reason:
        selection.state === 'selected'
          ? 'selected'
          : observedReason(
              selection.decision.rejectedProviderReason ??
                selection.decision.fallbackReason,
              SNAPSHOT_SELECTION_REASONS,
            ),
    };
  }

  /**
   * Path A evidence inside a US pre-market/after-hours window: the newest
   * extended-hours rows of THIS window only (never a regular-session row,
   * never an earlier window's), at the regular 10 s execute freshness.
   */
  private async resolveExtendedHoursPathASnapshot(
    assetId: string,
    priceCurrency: CurrencyCode,
    now: Date,
    window: UsExtendedHoursWindow,
    freshnessThresholdSeconds: number,
  ): Promise<PathASnapshotEvaluation> {
    const candidates = await this.prisma.assetPriceSnapshot.findMany({
      where: {
        assetId,
        currencyCode: priceCurrency,
        sourceType: AssetPriceSourceType.provider_api,
        sourceName: PROVIDER_SOURCE_NAMES.usStockTiingoExtended,
        effectiveAt: { gte: window.startsAt, lte: now },
      },
      orderBy: [
        { effectiveAt: 'desc' },
        { capturedAt: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 10,
      select: {
        id: true,
        price: true,
        sourceType: true,
        sourceName: true,
        effectiveAt: true,
        capturedAt: true,
      },
    });
    const selection = selectUsExtendedHoursExecutionSnapshot({
      candidates,
      window,
      now,
      freshnessThresholdSeconds,
      isPositiveValue: (candidate) => isPositiveDecimal(candidate.price),
    });
    return {
      snapshot:
        selection.state === 'selected'
          ? {
              id: selection.snapshot.id,
              price: selection.snapshot.price,
              effectiveAt: selection.snapshot.effectiveAt,
            }
          : null,
      reason:
        selection.state === 'selected'
          ? 'selected'
          : observedReason(
              selection.decision.rejectedProviderReason ??
                selection.decision.fallbackReason,
              SNAPSHOT_SELECTION_REASONS,
            ),
    };
  }

  /**
   * Shared, bounded USD/KRW preparation (UsdKrwRefreshService: DB check
   * first, one in-flight refresh at a time). It never returns a rate: the
   * fill re-selects committed evidence ≤ 60 s old at its own DB clock and
   * skips (order and reservation unchanged) without it.
   */
  private async prepareUsdKrwForFills(
    diagnostics: LimitMatchingSummary['diagnostics'],
  ): Promise<void> {
    const outcome = await this.runUsdKrwPreparation();
    countReason(diagnostics.execution.fxPreparation, outcome);
  }

  private async runUsdKrwPreparation(): Promise<FxPreparationOutcome> {
    if (!this.usdKrwRefresh) return 'service_unavailable';
    if (Date.now() < this.fxRetryNotBeforeMs) return 'cooling_down';
    try {
      const prepared = await this.usdKrwRefresh.prepare('orders_execute');
      if (prepared.result !== 'unavailable') return prepared.result;
      this.fxRetryNotBeforeMs = Date.now() + LIMIT_MATCHING_FX_RETRY_MS;
      return 'unavailable';
    } catch {
      this.fxRetryNotBeforeMs = Date.now() + LIMIT_MATCHING_FX_RETRY_MS;
      return 'failed';
    }
  }

  private refreshRankingAfterFill(
    seasonId: string,
    seasonParticipantId: string,
  ): void {
    if (!this.rankingRefresh) return;
    void this.rankingRefresh
      .refreshCurrentRankingAfterParticipantChange(
        seasonId,
        seasonParticipantId,
      )
      .catch((error) => {
        this.logger.error(
          JSON.stringify({
            event: 'limit_order_fill_ranking_refresh_failed',
            seasonId,
            seasonParticipantId,
            ...classifyLimitExecutionError(error),
          }),
        );
      });
  }
}

/**
 * US stock fills settle in USD and attach fill-time USD/KRW evidence. Crypto
 * (also USD) keeps its existing behavior: this change is US stocks only.
 */
function needsUsdKrwPreparation(candidate: LimitMatchCandidate): boolean {
  return (
    candidate.asset.assetType === AssetType.us_stock &&
    candidate.currencyCode === CurrencyCode.USD
  );
}
