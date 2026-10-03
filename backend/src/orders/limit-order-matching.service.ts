import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AssetPriceSourceType,
  OrderSide,
  Prisma,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import {
  isPositiveDecimal,
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../providers/source-eligibility.policy';
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
  type LimitFillPlan,
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
  type PathAReason,
  type PathBReason,
  type SnapshotSelectionReason,
} from './limit-order-matching-diagnostics';

/** Bound DB reads independently of the number of fill attempts. */
const SCANS_PER_ATTEMPT = 4;
const MAX_SCANS_PER_CYCLE = 1_000;
const CANDIDATE_PAGE_SIZE = 200;

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
  plan: LimitFillPlan | null;
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: LimitOrderCandidateRepository,
    private readonly candleEvidence: LimitOrderCandleEvidenceService,
    private readonly execution: LimitOrderExecutionService,
    @Optional()
    private readonly rankingRefresh?: RankingRefreshService,
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
    if (
      pathASnapshot &&
      pathASnapshot.effectiveAt >= candidate.submittedAt &&
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
      : pathASnapshot.effectiveAt < candidate.submittedAt
        ? 'before_submission'
        : 'limit_not_crossed';

    const trigger = this.candleEvidence.evaluateTriggerCandleForOrder(
      candleEvaluation.candles,
      {
        submittedAt: candidate.submittedAt,
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
