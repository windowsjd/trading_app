import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AssetType,
  CurrencyCode,
  MarketCandleSyncMode,
} from '../generated/prisma/client';
import {
  findLastMarketSessionOfWeek,
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { PrismaService } from '../prisma/prisma.service';
import type { KoscomP3Cadence } from '../providers/koscom/koscom-budget-policy';
import { KoscomCallBudgetService } from '../providers/koscom/koscom-call-budget.service';
import { runWithKoscomCallCategory } from '../providers/koscom/koscom-call-context';
import { KoscomConfigService } from '../providers/koscom/koscom.config';
import { RedisService } from '../redis/redis.service';
import {
  FIVE_MINUTES_MS,
  kstDate,
  kstDayStartMs,
  krxDailyBridge,
  krxIntradayTickTimes,
  krxSessionSlotState,
  planKrxIntradayWindow,
  planKrxRepairWindow,
  slotAttempts,
  type KrxCentralPhase,
} from './krx-candle-collection.policy';
import {
  KRX_CENTRAL_CANDLES_CONFIG,
  resolveKrxObligationStart,
  type KrxCentralCandlesConfig,
} from './krx-central-candles.config';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';
import { MarketCandleSyncService } from './market-candle-sync.service';
import type { MarketCandleFeedResult } from './market-candle-sync.types';

const DAY_MS = 24 * 60 * 60_000;
const CONCURRENCY = 2;
// Post-close repair caps (design v2.1 §4.2 rule 5): per asset and per day.
const REPAIR_CALLS_PER_ASSET = 3;
const REPAIR_CALLS_PER_DAY = 300;
// 1d upkeep reads at most this far back from an unconfirmed frontier.
const DAILY_CATCH_UP_DAYS = 30;
const INTRADAY_BUDGET = { maxPages: 2, maxRows: 200, maxDurationMs: 15_000 };
const DAILY_BUDGET = { maxPages: 2, maxRows: 600, maxDurationMs: 15_000 };
// 1w upkeep is one request per asset per week (§5.5): a week labelled by
// its last session never reaches the terminal page, so no second page.
const WEEKLY_BUDGET = { ...DAILY_BUDGET, maxPages: 1 };

type TargetAsset = { id: string; symbol: string; obligationStartMs: number };

export type KrxCentralAssetOutcome = {
  assetId: string;
  symbol: string;
  status: 'proven' | 'partial' | 'skipped' | 'failed';
  reason?: string;
  heldSlots?: string[];
};

export type KrxCentralRunSummary = {
  phase: KrxCentralPhase;
  sessionDate: string | null;
  skippedReason?: string;
  assets: number;
  attempted: number;
  proven: number;
  partial: number;
  failed: number;
  providerPages: number;
  /** Assets with unproven required slots after this run (G4-I evidence). */
  unprovenAssets: KrxCentralAssetOutcome[];
};

/**
 * Central KRX candle collection (design v2.1 §3, §4.2; stage 3b): the only
 * writer of KRX intraday 5m candles while `KOSCOM_CENTRAL_CANDLES_ENABLED`.
 * Every provider request goes through the existing checkpointed
 * `MarketCandleSyncService.syncAsset` (per-asset/feed Redis lock, upsert,
 * checkpoint), with the stored-candle audit so evidence never claims a
 * closed required slot that has no closed KOSCOM candle.
 */
@Injectable()
export class KrxCentralCandleService {
  private readonly logger = new Logger(KrxCentralCandleService.name);
  private readonly instanceToken = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sync: MarketCandleSyncService,
    private readonly states: MarketCandleSyncStateRepository,
    private readonly redis: RedisService,
    @Inject(KRX_CENTRAL_CANDLES_CONFIG)
    private readonly config: KrxCentralCandlesConfig,
    @Optional() private readonly budget?: KoscomCallBudgetService,
    @Optional() private readonly koscomConfig?: KoscomConfigService,
  ) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  get tickDelayMs(): number {
    return this.config.tickDelayMs;
  }

  /**
   * Cluster-wide claim of one scheduled run (SET NX): exactly one instance
   * runs a given phase instant. Redis unavailable → nobody runs (fail closed).
   */
  async claimRun(phase: KrxCentralPhase, atMs: number): Promise<boolean> {
    try {
      return await this.redis.setNxPx(
        `koscom:krx-central:run:${phase}:${atMs}`,
        this.instanceToken,
        6 * 60 * 60_000,
      );
    } catch {
      return false;
    }
  }

  /**
   * Intraday tick (bucket end + delay): one bounded minute request per
   * obligated asset from its proof frontier (§4.2 rules 1–4).
   */
  async runIntradayTick(input: {
    now: Date;
    signal?: AbortSignal;
  }): Promise<KrxCentralRunSummary> {
    const session = this.todaySession(input.now);
    if (!session || input.now.getTime() <= session.openTime.getTime())
      return this.empty('intraday', session, 'NO_SESSION_IN_PROGRESS');
    const summary = this.empty('intraday', session);
    const assets = await this.targets(input.now);
    summary.assets = assets.length;
    // 3c (§7.6 step 2): under budget pressure every other bucket is skipped
    // (the next tick's window covers it); the closing tick always runs.
    const cadence = await this.budgetCadence(session, input.now, assets.length);
    const bucket = Math.floor(
      (input.now.getTime() -
        this.config.tickDelayMs -
        session.openTime.getTime()) /
        FIVE_MINUTES_MS,
    );
    if (
      cadence === 'blocked' ||
      (cadence === 'reduced' &&
        bucket % 2 === 1 &&
        input.now.getTime() < session.closeTime.getTime())
    )
      return {
        ...summary,
        skippedReason:
          cadence === 'blocked' ? 'BUDGET_P3_BLOCKED' : 'BUDGET_P3_REDUCED',
      };
    const startedAt = new Date();
    await forEachConcurrent(assets, CONCURRENCY, async (asset) => {
      if (input.signal?.aborted) return;
      const rows = await this.sessionRows(asset, session);
      const plan = planKrxIntradayWindow({
        session,
        nowMs: input.now.getTime(),
        rows,
        obligationStartMs: asset.obligationStartMs,
      });
      if (!plan) {
        this.record(
          summary,
          asset,
          plan,
          null,
          rows,
          session,
          input.now,
          startedAt,
        );
        return;
      }
      const feed = await this.syncFiveMinute(asset, plan, input, 'intraday');
      const after = await this.sessionRows(asset, session);
      this.record(
        summary,
        asset,
        plan,
        feed,
        after,
        session,
        input.now,
        startedAt,
      );
    });
    return summary;
  }

  /**
   * Post-close repair (§4.2 rule 5, same KST day only: the minute source is
   * trusted for the current day): re-requests unproven required slots, at
   * most 2 audited attempts per missing slot, 3 calls per asset and 300 per
   * day. What stays unproven is alerted and remains a visible gap.
   */
  async runRepair(input: {
    now: Date;
    signal?: AbortSignal;
  }): Promise<KrxCentralRunSummary> {
    const session = this.todaySession(input.now);
    if (!session || input.now.getTime() < session.closeTime.getTime())
      return this.empty('repair', session, 'SESSION_NOT_CLOSED');
    const summary = this.empty('repair', session);
    const assets = await this.targets(input.now);
    summary.assets = assets.length;
    const closeAt = session.closeTime;
    let dayCalls = await this.states.countAuditedRuns('5m', 'repair', closeAt);
    const startedAt = new Date();
    for (const asset of assets) {
      if (input.signal?.aborted) break;
      let rows = await this.sessionRows(asset, session);
      let assetCalls = rows.filter(
        (row) =>
          row.auditPhase === 'repair' &&
          row.createdAt.getTime() >= closeAt.getTime(),
      ).length;
      let last: MarketCandleFeedResult | null = null;
      while (
        assetCalls < REPAIR_CALLS_PER_ASSET &&
        dayCalls < REPAIR_CALLS_PER_DAY &&
        !input.signal?.aborted
      ) {
        const plan = planKrxRepairWindow({
          session,
          nowMs: input.now.getTime(),
          rows,
          obligationStartMs: asset.obligationStartMs,
        });
        if (!plan) break;
        last = await this.syncFiveMinute(asset, plan, input, 'repair');
        assetCalls += 1;
        dayCalls += 1;
        rows = await this.sessionRows(asset, session);
      }
      this.record(
        summary,
        asset,
        last ? {} : null,
        last,
        rows,
        session,
        input.now,
        startedAt,
        true,
      );
    }
    return summary;
  }

  /**
   * Post-close daily upkeep (§4.2 rule 6, §5.4): confirms today's daily bar
   * through the existing dated 1d audit (`inspectKisDailyEvidence`), and
   * on the week's last session the weekly bar while old apps still show it.
   */
  async runDaily(input: {
    now: Date;
    signal?: AbortSignal;
  }): Promise<KrxCentralRunSummary> {
    const session = this.todaySession(input.now);
    if (!session || input.now.getTime() < session.closeTime.getTime())
      return this.empty('daily', session, 'SESSION_NOT_CLOSED');
    const summary = this.empty('daily', session);
    const assets = await this.targets(input.now);
    summary.assets = assets.length;
    const weekly =
      this.config.weeklySyncEnabled &&
      findLastMarketSessionOfWeek('KRX', session.localDate)?.localDate ===
        session.localDate;
    const nowMs = input.now.getTime();
    const todayStart = kstDayStartMs(session.localDate);
    await forEachConcurrent(assets, CONCURRENCY, async (asset) => {
      if (input.signal?.aborted) return;
      const bridge = krxDailyBridge(nowMs);
      const today = await this.states.findCandleCoverage(
        asset.id,
        '1d',
        new Date(todayStart),
        input.now,
        { bridge },
      );
      const outcome: KrxCentralAssetOutcome = {
        assetId: asset.id,
        symbol: asset.symbol,
        status: 'proven',
      };
      if (!isCompleteTo(today, nowMs)) {
        const catchUpFrom = nowMs - DAILY_CATCH_UP_DAYS * DAY_MS;
        const frontier = await this.states.findCandleCoverage(
          asset.id,
          '1d',
          new Date(catchUpFrom),
          input.now,
          { bridge },
        );
        const fromMs = Math.min(
          todayStart,
          Math.max(
            catchUpFrom,
            frontier.contiguousCoveredTo?.getTime() ?? catchUpFrom,
          ),
        );
        summary.attempted += 1;
        const feed = await this.syncPeriod(asset, '1d', fromMs, input, 'daily');
        summary.providerPages += feed?.pagesFetched ?? 0;
        if (!feed?.coverageComplete) {
          outcome.status = feed ? 'partial' : 'failed';
          outcome.reason =
            feed?.errorCode ?? feed?.completionReason ?? 'SYNC_NOT_RUN';
        }
      }
      if (weekly) {
        const mondayStart = kstDayStartMs(mondayOf(session.localDate));
        const week = await this.states.findCandleCoverage(
          asset.id,
          '1w',
          new Date(mondayStart),
          input.now,
        );
        if (!isCompleteTo(week, nowMs)) {
          const feed = await this.syncPeriod(
            asset,
            '1w',
            mondayStart,
            input,
            'weekly',
          );
          summary.providerPages += feed?.pagesFetched ?? 0;
        }
      }
      if (outcome.status === 'proven') summary.proven += 1;
      else {
        if (outcome.status === 'failed') summary.failed += 1;
        else summary.partial += 1;
        summary.unprovenAssets.push(outcome);
      }
    });
    if (summary.unprovenAssets.length > 0)
      this.logger.warn(
        JSON.stringify({
          event: 'krx_central_daily_unconfirmed',
          sessionDate: session.localDate,
          assets: summary.unprovenAssets.map((entry) => entry.symbol),
        }),
      );
    return summary;
  }

  private async syncFiveMinute(
    asset: TargetAsset,
    plan: { fromMs: number; toMs: number },
    input: { now: Date; signal?: AbortSignal },
    phase: 'intraday' | 'repair',
  ): Promise<MarketCandleFeedResult | null> {
    try {
      const result = await runWithKoscomCallCategory(
        phase === 'repair' ? 'gap_repair' : 'minute',
        () =>
          this.sync.syncAsset({
            assetId: asset.id,
            targets: ['5m'],
            // repair keeps the planned `from`; incremental would recompute
            // it from the newest row and break the proof frontier (§4.2).
            mode: MarketCandleSyncMode.repair,
            from: new Date(plan.fromMs),
            to: new Date(plan.toMs),
            resume: false,
            now: input.now,
            signal: input.signal,
            budget: INTRADAY_BUDGET,
            krxAudit: { phase },
          }),
      );
      return result.feeds[0] ?? null;
    } catch {
      return null;
    }
  }

  private async syncPeriod(
    asset: TargetAsset,
    feed: '1d' | '1w',
    fromMs: number,
    input: { now: Date; signal?: AbortSignal },
    category: 'daily' | 'weekly',
  ): Promise<MarketCandleFeedResult | null> {
    if (fromMs >= input.now.getTime()) return null;
    try {
      const result = await runWithKoscomCallCategory(category, () =>
        this.sync.syncAsset({
          assetId: asset.id,
          targets: [feed],
          mode: MarketCandleSyncMode.repair,
          from: new Date(fromMs),
          to: input.now,
          resume: false,
          now: input.now,
          signal: input.signal,
          budget: feed === '1w' ? WEEKLY_BUDGET : DAILY_BUDGET,
        }),
      );
      return result.feeds[0] ?? null;
    } catch {
      return null;
    }
  }

  /** Normal unless the KOSCOM budget governor is enforced and pressed. */
  private async budgetCadence(
    session: MarketSessionWindow,
    now: Date,
    assets: number,
  ): Promise<KoscomP3Cadence> {
    const koscom = this.koscomConfig?.getConfig();
    if (!this.budget || !koscom?.budgetEnforcementEnabled) return 'normal';
    const remainingTicks = krxIntradayTickTimes(
      session,
      this.config.tickDelayMs,
    ).filter((atMs) => atMs >= now.getTime()).length;
    return this.budget.p3Cadence({
      namespace: koscom.namespace,
      caps: {
        dailyCap: koscom.budgetDailyLimit,
        monthlyCap: koscom.budgetMonthlyLimit,
      },
      projectedP3: assets * remainingTicks,
      now,
    });
  }

  /** Active domestic assets whose obligation has started (A ≤ now). */
  private async targets(now: Date): Promise<TargetAsset[]> {
    const assets = await this.prisma.asset.findMany({
      where: {
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
        isActive: true,
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true },
    });
    return assets.flatMap((asset) => {
      const start = resolveKrxObligationStart(this.config, asset.symbol);
      return start && start.getTime() <= now.getTime()
        ? [{ ...asset, obligationStartMs: start.getTime() }]
        : [];
    });
  }

  private sessionRows(asset: TargetAsset, session: MarketSessionWindow) {
    return this.states.findCheckpointsOverlapping(
      asset.id,
      '5m',
      session.openTime,
      session.closeTime,
      new Date(asset.obligationStartMs),
    );
  }

  private todaySession(now: Date): MarketSessionWindow | null {
    return resolveMarketSession(
      'KRX',
      kstDate(now.getTime()).replace(/-/gu, ''),
    );
  }

  private empty(
    phase: KrxCentralPhase,
    session: MarketSessionWindow | null,
    skippedReason?: string,
  ): KrxCentralRunSummary {
    return {
      phase,
      sessionDate: session?.localDate ?? null,
      ...(skippedReason ? { skippedReason } : {}),
      assets: 0,
      attempted: 0,
      proven: 0,
      partial: 0,
      failed: 0,
      providerPages: 0,
      unprovenAssets: [],
    };
  }

  private record(
    summary: KrxCentralRunSummary,
    asset: TargetAsset,
    plan: object | null,
    feed: MarketCandleFeedResult | null,
    rows: Awaited<ReturnType<KrxCentralCandleService['sessionRows']>>,
    session: MarketSessionWindow,
    now: Date,
    startedAt: Date,
    alertRemaining = false,
  ): void {
    if (plan) summary.attempted += 1;
    summary.providerPages += feed?.pagesFetched ?? 0;
    const state = krxSessionSlotState({
      session,
      nowMs: now.getTime(),
      rows,
      obligationStartMs: asset.obligationStartMs,
    });
    const unproven = state.unproven.map((slot) => new Date(slot).toISOString());
    if (state.unproven.length === 0) {
      summary.proven += 1;
      return;
    }
    const failedRun =
      plan !== null && (feed === null || feed.status !== 'completed');
    if (failedRun) summary.failed += 1;
    else summary.partial += 1;
    summary.unprovenAssets.push({
      assetId: asset.id,
      symbol: asset.symbol,
      status: failedRun ? 'failed' : 'partial',
      ...(failedRun ? { reason: feed?.errorCode ?? 'SYNC_FAILED' } : {}),
      heldSlots: state.held.map((slot) => new Date(slot).toISOString()),
    });
    // Alert once per slot: in the run whose own audit made it held (its
    // second audited miss was recorded by this run).
    const newlyHeld = state.held.filter(
      (slot) =>
        slotAttempts(rows, slot) === 2 &&
        rows.some(
          (row) =>
            row.auditFirstMissingMs === slot &&
            row.createdAt.getTime() >= startedAt.getTime(),
        ),
    );
    if (newlyHeld.length > 0 || (alertRemaining && unproven.length > 0))
      this.logger.warn(
        JSON.stringify({
          event: alertRemaining
            ? 'krx_central_slots_unproven_after_repair'
            : 'krx_central_slot_held',
          assetId: asset.id,
          symbol: asset.symbol,
          sessionDate: session.localDate,
          slots: alertRemaining
            ? unproven
            : newlyHeld.map((slot) => new Date(slot).toISOString()),
        }),
      );
  }
}

function isCompleteTo(
  coverage: { contiguousCoveredTo: Date | null; hasInteriorGap: boolean },
  toMs: number,
): boolean {
  return (
    coverage.contiguousCoveredTo !== null &&
    !coverage.hasInteriorGap &&
    coverage.contiguousCoveredTo.getTime() >= toMs
  );
}

function mondayOf(localDate: string): string {
  const day = new Date(`${localDate}T00:00:00Z`);
  const weekday = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - weekday * DAY_MS).toISOString().slice(0, 10);
}

async function forEachConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) await work(items[next++]);
    }),
  );
}
