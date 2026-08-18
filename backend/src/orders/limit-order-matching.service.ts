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
} from './limit-order-candidate.repository';
import { LimitOrderCandleEvidenceService } from './limit-order-candle-evidence.service';
import {
  LimitOrderExecutionService,
  type LimitFillPlan,
} from './limit-order-execution.service';

/** Upper bound on assets scanned per cycle. The fixed asset universe is tiny,
 * so this only guards against pathological data, never real load. */
const MAX_ASSET_SCAN = 1_000;

export type LimitMatchingSummary = {
  assetsScanned: number;
  ordersConsidered: number;
  filledPathA: number;
  filledPathB: number;
  skipped: number;
  errors: number;
  batchExhausted: boolean;
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
  }): Promise<LimitMatchingSummary> {
    const config = this.readConfig();
    const batchSize = input.batchSize ?? config.batchSize;
    const candleLookbackMs = input.candleLookbackMs ?? config.candleLookbackMs;
    const now = input.now;

    const summary: LimitMatchingSummary = {
      assetsScanned: 0,
      ordersConsidered: 0,
      filledPathA: 0,
      filledPathB: 0,
      skipped: 0,
      errors: 0,
      batchExhausted: false,
    };

    // Deduped set of participants whose rankings need a refresh after commit.
    const rankingTargets = new Map<
      string,
      { seasonId: string; participantId: string }
    >();

    let budget = batchSize;
    const assetIds = await this.candidates.findAssetIdsWithFillableLimitBuys(
      now,
      MAX_ASSET_SCAN,
    );

    for (const assetId of assetIds) {
      if (budget <= 0) {
        summary.batchExhausted = true;
        break;
      }
      summary.assetsScanned += 1;

      const candidates = await this.candidates.findFillableLimitBuysForAsset(
        assetId,
        now,
        budget,
      );
      if (candidates.length === 0) continue;

      const asset = candidates[0].asset;
      const pathASnapshot = await this.resolvePathASnapshot(asset, now);
      const eligibleCandles =
        await this.candleEvidence.findEligibleClosedCandlesForAsset(
          { assetType: asset.assetType, market: asset.market, id: asset.id },
          now,
          candleLookbackMs,
        );

      for (const candidate of candidates) {
        if (budget <= 0) {
          summary.batchExhausted = true;
          break;
        }
        const plan = this.buildFillPlan(
          candidate,
          pathASnapshot,
          eligibleCandles,
        );
        if (!plan) continue;

        summary.ordersConsidered += 1;
        budget -= 1;
        try {
          const outcome = await this.execution.fillLimitOrder({
            orderId: candidate.id,
            now,
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
          }
        } catch (error) {
          // Per-order isolation: one order's failure never aborts the rest of
          // the cycle. Transient failures are retried on the next cycle.
          summary.errors += 1;
          this.logger.error(
            JSON.stringify({
              event: 'limit_order_fill_failed',
              orderId: candidate.id,
              assetId,
              path: plan.path,
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
          );
        }
      }
    }

    // Ranking refresh AFTER the fills commit (fire-and-forget, deduped), exactly
    // like the market-order path — never awaited inside a fill transaction.
    for (const target of rankingTargets.values()) {
      this.refreshRankingAfterFill(target.seasonId, target.participantId);
    }

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
    pathASnapshot: { id: string; price: Prisma.Decimal } | null,
    eligibleCandles: Awaited<
      ReturnType<
        LimitOrderCandleEvidenceService['findEligibleClosedCandlesForAsset']
      >
    >,
  ): LimitFillPlan | null {
    const side = candidate.side ?? OrderSide.buy;
    if (
      pathASnapshot &&
      ((side === OrderSide.buy &&
        pathASnapshot.price.lte(candidate.limitPrice)) ||
        (side === OrderSide.sell &&
          pathASnapshot.price.gte(candidate.limitPrice)))
    ) {
      return {
        path: 'snapshot',
        executedPrice: pathASnapshot.price,
        assetPriceSnapshotId: pathASnapshot.id,
      };
    }

    const candle = this.candleEvidence.selectTriggerCandleForOrder(
      eligibleCandles,
      {
        submittedAt: candidate.submittedAt,
        limitPrice: candidate.limitPrice,
        side,
        seasonEndAt: candidate.seasonEndAt,
      },
    );
    if (candle) {
      return {
        path: 'candle',
        executedPrice: candidate.limitPrice,
        candle,
      };
    }
    return null;
  }

  /**
   * Latest VALID fresh provider snapshot for path A, or null. Reuses the exact
   * order-execute eligibility + market-session selection: admin_manual /
   * official_batch are rejected, stocks require an open session, crypto is 24h.
   */
  private async resolvePathASnapshot(
    asset: LimitMatchCandidate['asset'],
    now: Date,
  ): Promise<{ id: string; price: Prisma.Decimal } | null> {
    const eligibility = resolveAssetProviderEligibility({
      workflow: 'orders_execute',
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        market: asset.market,
        currencyCode: asset.currencyCode,
      },
    });
    if (!eligibility.eligible) return null;

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

    return selection.state === 'selected'
      ? { id: selection.snapshot.id, price: selection.snapshot.price }
      : null;
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
            error: error instanceof Error ? error.message : 'Unknown error',
          }),
        );
      });
  }
}
