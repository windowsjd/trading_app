import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  AssetType,
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
} from '../generated/prisma/client';
import {
  getOpsSchedulerConfig,
  getSchedulerBusinessDate,
  getSchedulerLocalDateTime,
  OpsSchedulerConfig,
} from './ops-config';
import {
  OpsJobRunnerResponse,
  OpsJobRunnerInput,
  OpsJobRunnerService,
} from './ops-job-runner.service';
import { OpsJobRunService } from './ops-job-run.service';
import { MarketSnapshotHealthService } from '../providers/market-snapshot-health.service';
import { ProviderConfigService } from '../providers/provider-config.service';
import {
  MarketCandleReconciliationService,
  type ReconciliationMarket,
} from '../assets/market-candle-reconciliation.service';
import {
  findLatestCompletedMarketSession,
  isLastMarketSessionOfWeek,
  resolveStockMarketSessionState,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { LimitOrderMatchingService } from '../orders/limit-order-matching.service';

@Injectable()
export class OpsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private interval: NodeJS.Timeout | null = null;
  private limitOrderMatchingInterval: NodeJS.Timeout | null = null;
  /** Prevents same-process tick overlap of the candle sync job (see below). */
  private marketCandleSyncInFlight = false;
  /** Guards against a slow matching cycle overlapping the next dedicated tick. */
  private limitOrderMatchingRunning = false;

  constructor(
    private readonly runner: OpsJobRunnerService,
    private readonly runService: OpsJobRunService,
    @Optional()
    private readonly marketSnapshotHealthService?: MarketSnapshotHealthService,
    @Optional()
    private readonly providerConfigService?: ProviderConfigService,
    @Optional()
    private readonly marketCandleReconciliationService?: MarketCandleReconciliationService,
    @Optional()
    private readonly limitOrderMatchingService?: LimitOrderMatchingService,
  ) {}

  onModuleInit() {
    const config = getOpsSchedulerConfig();
    if (config.providerIngestionRunOnStartup) {
      const startupAt = new Date();
      void Promise.resolve().then(() => {
        void this.runStartupProviderJobs(startupAt);
      });
    }
    if (config.marketCandleRetention.runOnStartup) {
      const startupAt = new Date();
      void Promise.resolve().then(() => {
        void this.runMarketCandleRetentionIfDue(startupAt, config).catch(
          (error: unknown) => {
            console.warn('Market candle retention startup check failed.', {
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          },
        );
      });
    }
    if (
      config.marketCandleReconciliation.enabled &&
      config.marketCandleReconciliation.startupCatchUpEnabled
    ) {
      const startupAt = new Date();
      void Promise.resolve().then(() => {
        void this.runStartupCandleReconciliation(startupAt, config).catch(
          (error: unknown) => {
            console.warn('Market candle reconciliation catch-up failed.', {
              error: error instanceof Error ? error.message : 'Unknown error',
            });
          },
        );
      });
    }

    if (!config.enabled) {
      return;
    }

    this.interval = setInterval(() => {
      void this.runEnabledJobs(new Date()).catch((error: unknown) => {
        console.warn('Ops scheduler tick failed.', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      });
    }, config.tickIntervalMs);

    // Limit-order matching runs on its OWN dedicated interval, NOT the shared
    // tick: it must poll every few seconds while a fresh provider snapshot is
    // still fresh, and lowering the shared tick would change every other job's
    // cadence. Every other job stays on tickIntervalMs, untouched.
    if (config.jobs[OpsJobName.limit_order_matching]) {
      this.limitOrderMatchingInterval = setInterval(() => {
        void this.runLimitOrderMatchingTick(new Date());
      }, config.limitOrderMatchingIntervalMs);
    }
  }

  onModuleDestroy() {
    this.clearInterval();
  }

  clearInterval() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.limitOrderMatchingInterval) {
      clearInterval(this.limitOrderMatchingInterval);
      this.limitOrderMatchingInterval = null;
    }
  }

  /**
   * Dedicated limit-order matching tick. Pre-gates on whether ANY fillable
   * submitted limit buy exists so an idle system writes no audit rows, and
   * skips a tick while the previous cycle is still running (a slow cycle must
   * not stack). Single-instance execution is still the OpsJobLock inside the
   * runner — this guard is only per-process overlap protection.
   */
  async runLimitOrderMatchingTick(now = new Date()): Promise<void> {
    const service = this.limitOrderMatchingService;
    if (!service || this.limitOrderMatchingRunning) return;
    const config = getOpsSchedulerConfig();
    if (!config.enabled || !config.jobs[OpsJobName.limit_order_matching])
      return;

    this.limitOrderMatchingRunning = true;
    try {
      if (!(await service.hasFillableWork(now))) return;
      await this.runner.runLimitOrderMatchingJob({
        trigger: OpsJobTrigger.scheduler,
        requestedBy: 'scheduler',
        dryRun: false,
        lockTtlSeconds: config.lockTtlSeconds,
        maxAttempts: config.maxAttempts,
        now: now.toISOString(),
        batchSize: config.limitOrderMatchBatchSize,
      });
    } catch (error) {
      console.warn('Limit-order matching tick failed.', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.limitOrderMatchingRunning = false;
    }
  }

  isIntervalRegistered() {
    return this.interval !== null;
  }

  async runEnabledJobs(now = new Date()): Promise<OpsJobRunnerResponse[]> {
    const config = getOpsSchedulerConfig();
    if (!config.enabled) {
      return [];
    }

    const results: OpsJobRunnerResponse[] = [];
    const baseInput = {
      trigger: OpsJobTrigger.scheduler,
      requestedBy: 'scheduler',
      dryRun: false,
      lockTtlSeconds: config.lockTtlSeconds,
      maxAttempts: config.maxAttempts,
    };

    results.push(
      ...(await this.runEnabledProviderJobs(now, baseInput, config, {
        respectInterval: true,
      })),
    );

    if (config.jobs[OpsJobName.daily_portfolio_snapshot]) {
      results.push(
        await this.runner.runDailyPortfolioSnapshotJob({
          ...baseInput,
          seasonId: process.env.SCHEDULER_DAILY_SNAPSHOT_SEASON_ID,
          snapshotDate: getSchedulerBusinessDate(now, config.timezone),
        }),
      );
    }

    if (config.jobs[OpsJobName.season_lifecycle_transition]) {
      results.push(
        await this.runner.runSeasonLifecycleTransitionJob({
          ...baseInput,
          now: now.toISOString(),
        }),
      );
    }

    if (config.jobs[OpsJobName.season_ranking_generation]) {
      results.push(
        await this.runner.runSeasonRankingGenerationJob({
          ...baseInput,
          now: now.toISOString(),
          createEquitySnapshots: isFiveMinuteBucketStart(now),
        }),
      );
    }

    if (config.jobs[OpsJobName.season_settlement]) {
      results.push(
        await this.runner.runSeasonSettlementJob({
          ...baseInput,
          now: now.toISOString(),
        }),
      );
    }

    if (config.jobs[OpsJobName.reward_marker]) {
      results.push(await this.runner.runRewardMarkerJob(baseInput));
    }

    const retention = await this.runMarketCandleRetentionIfDue(now, config);
    if (retention) results.push(retention);

    for (const market of ['KRX', 'US', 'CRYPTO'] as const) {
      const reconciliation = await this.runMarketCandleReconciliationIfDue(
        now,
        market,
        config,
      );
      if (reconciliation) results.push(reconciliation);
    }

    // Last on purpose: a candle sync sweep can take minutes on a cold store
    // and must not delay the cheap snapshot/season jobs of the same tick.
    const candleSync = await this.runMarketCandleSyncIfDue(
      now,
      baseInput,
      config,
    );
    if (candleSync) results.push(candleSync);

    return results;
  }

  /**
   * Scheduled incremental upkeep of the persisted candle feeds. Reuses the
   * SAME checkpointed Ops job the operator API triggers (job-level DB lock,
   * per-asset/feed Redis backfill locks, budgets, coverage checkpoints) with
   * mode=incremental: warm assets re-fetch their tail from the latest stored
   * row minus the revision overlap, and an asset with an empty store falls
   * back to the feed-default lookback (35d for 5m), so cold assets self-seed
   * over successive runs. This is what keeps the 35-day 5m baseline — which
   * the 15m/30m/1h/4h charts are aggregated from — moving forward without an
   * operator re-running `candle:baseline`.
   *
   * The in-process flag guards against tick overlap: a cold-start sweep can
   * outlast the shared tick interval, and without the guard every following
   * tick would burn a run attempt on the busy Ops job lock. Cross-instance
   * mutual exclusion stays the Ops DB job lock, unchanged.
   *
   * Unlike the provider snapshot jobs, a FAILED run does NOT become due
   * again on the next tick. The runner records the whole run as failed when
   * ANY of the ~120 asset/feed sweeps failed (one transient KIS hiccup is
   * enough), so failed-fast-retry would degrade the 10-minute cadence to a
   * per-tick retry loop against the shared KIS budget. Baseline upkeep is
   * not latency-critical; the flaky feed simply retries on the next
   * interval, resuming from its checkpoint.
   */
  async runMarketCandleSyncIfDue(
    now: Date,
    baseInput: OpsJobRunnerInput,
    config: OpsSchedulerConfig = getOpsSchedulerConfig(),
  ): Promise<OpsJobRunnerResponse | undefined> {
    if (!config.marketCandleSync.enabled) return undefined;
    if (this.marketCandleSyncInFlight) return undefined;
    this.marketCandleSyncInFlight = true;
    try {
      const latestRun = await this.runService.findLatestRunForJob(
        OpsJobName.market_candle_sync,
      );
      if (latestRun) {
        const lastRunAt = latestRun.finishedAt ?? latestRun.startedAt;
        if (
          now.getTime() - lastRunAt.getTime() <
          config.marketCandleSync.intervalSeconds * 1000
        ) {
          return undefined;
        }
      }
      try {
        return await this.runner.runMarketCandleSyncJob({
          ...baseInput,
          mode: 'incremental',
          continueOnError: true,
          now: now.toISOString(),
        });
      } catch {
        // Recorded on the run row; the next interval retries from checkpoints.
        return undefined;
      }
    } finally {
      this.marketCandleSyncInFlight = false;
    }
  }

  async runStartupCandleReconciliation(
    now: Date,
    config: OpsSchedulerConfig = getOpsSchedulerConfig(),
  ): Promise<OpsJobRunnerResponse[]> {
    if (
      !config.marketCandleReconciliation.enabled ||
      !config.marketCandleReconciliation.startupCatchUpEnabled
    ) {
      return [];
    }
    const results: OpsJobRunnerResponse[] = [];
    for (const market of ['KRX', 'US', 'CRYPTO'] as const) {
      const result = await this.runMarketCandleReconciliationIfDue(
        now,
        market,
        config,
        true,
      );
      if (result) results.push(result);
    }
    return results;
  }

  async runMarketCandleReconciliationIfDue(
    now: Date,
    market: Exclude<ReconciliationMarket, 'ALL'>,
    config: OpsSchedulerConfig = getOpsSchedulerConfig(),
    startup = false,
  ): Promise<OpsJobRunnerResponse | undefined> {
    const reconciliation = config.marketCandleReconciliation;
    const enabled =
      market === 'KRX'
        ? reconciliation.krx.enabled
        : market === 'US'
          ? reconciliation.us.enabled
          : reconciliation.crypto.enabled;
    if (!reconciliation.enabled || !enabled) return undefined;

    let stockSession: MarketSessionWindow | null = null;
    let stockTimezone: string | null = null;
    if (market !== 'CRYPTO') {
      stockTimezone = market === 'KRX' ? 'Asia/Seoul' : 'America/New_York';
      // Explicit tri-state judgement: a scheduled empty day (weekend or
      // full-day holiday) is NOT the same condition as a year with no
      // calendar dataset — the latter must stay observable, never be
      // silently absorbed into "market closed today".
      const sessionState = resolveStockMarketSessionState(
        {
          assetType:
            market === 'KRX'
              ? ('domestic_stock' as AssetType)
              : ('us_stock' as AssetType),
          market,
        },
        now,
      );
      if (!sessionState || sessionState.state === 'calendar_unavailable') {
        this.warnCalendarCoverageMissing(market, now, stockTimezone, startup);
        return undefined;
      }
      stockSession = sessionState.currentSession;
      // Weekend or full-day closure: scheduled no-data — no provider work.
      // A startup catch-up must not turn a full-day closure into a scheduled
      // reconciliation run. Manual reconciliation retains its own explicit
      // bounded-range path in the runner.
      if (!stockSession) return undefined;
    }

    const latest =
      await this.runService.findLatestSucceededReconciliationRun(market);
    if (startup) {
      const lastAt = latest?.finishedAt ?? latest?.startedAt;
      const withinCatchUpBound =
        lastAt !== undefined &&
        now.getTime() - lastAt.getTime() <=
          reconciliation.maxCatchUpHours * 3_600_000;
      const covered = withinCatchUpBound
        ? await this.marketCandleReconciliationService?.hasRecentCanonicalCoverage(
            market,
            now,
          )
        : false;
      if (withinCatchUpBound && covered === true) return undefined;
    } else if (market === 'CRYPTO') {
      const lastAt = latest?.finishedAt ?? latest?.startedAt;
      if (
        lastAt &&
        now.getTime() - lastAt.getTime() <
          reconciliation.crypto.intervalSeconds * 1_000
      ) {
        return undefined;
      }
    } else {
      const session = stockSession;
      const timezone = stockTimezone;
      if (!session || !timezone) return undefined;
      const schedule =
        market === 'KRX' ? reconciliation.krx : reconciliation.us;
      const dueAt = new Date(
        session.closeTime.getTime() + schedule.graceMinutes * 60_000,
      );
      if (now.getTime() < dueAt.getTime()) return undefined;
      if (
        latest &&
        getSchedulerBusinessDate(latest.startedAt, timezone) ===
          getSchedulerBusinessDate(now, timezone)
      ) {
        return undefined;
      }
    }

    const timezone =
      market === 'KRX'
        ? 'Asia/Seoul'
        : market === 'US'
          ? 'America/New_York'
          : 'UTC';
    const businessDate = getSchedulerBusinessDate(now, timezone);
    const targets = this.reconciliationTargets(market, now, latest?.finishedAt);
    return this.runner.runMarketCandleReconciliationJob({
      trigger: OpsJobTrigger.scheduler,
      requestedBy: 'scheduler',
      dryRun: false,
      lockTtlSeconds: config.lockTtlSeconds,
      maxAttempts: config.maxAttempts,
      now: now.toISOString(),
      market,
      targets,
      maxAssets: reconciliation.maxAssets,
      maxPages: reconciliation.maxPages,
      continueOnError: true,
      metadataJson: { reconciliationMarket: market, businessDate, startup },
    });
  }

  // Last business date a coverage-missing warning was emitted per market:
  // the scheduler ticks every minute, so an uncovered year would otherwise
  // repeat the same warning ~1440×/day. One structured warning per market
  // per local business date keeps the condition observable without noise.
  private readonly calendarWarningByMarket = new Map<string, string>();

  private warnCalendarCoverageMissing(
    market: Exclude<ReconciliationMarket, 'ALL'>,
    now: Date,
    timezone: string,
    startup: boolean,
  ) {
    const businessDate = getSchedulerBusinessDate(now, timezone);
    if (!startup && this.calendarWarningByMarket.get(market) === businessDate) {
      return;
    }
    this.calendarWarningByMarket.set(market, businessDate);
    console.warn(
      'Market candle reconciliation skipped: no calendar dataset covers the current date.',
      {
        reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
        market,
        businessDate,
        startup,
      },
    );
  }

  private reconciliationTargets(
    market: Exclude<ReconciliationMarket, 'ALL'>,
    now: Date,
    previousFinishedAt?: Date | null,
  ): string[] {
    if (market !== 'CRYPTO') {
      const session = findLatestCompletedMarketSession(
        {
          assetType:
            market === 'KRX'
              ? ('domestic_stock' as AssetType)
              : ('us_stock' as AssetType),
          market,
        },
        now,
        370,
      );
      return session && isLastMarketSessionOfWeek(session)
        ? ['5m', '1d', '1w']
        : ['5m', '1d'];
    }
    const targets = ['5m'];
    if (!previousFinishedAt || utcDate(previousFinishedAt) !== utcDate(now)) {
      targets.push('1d');
    }
    if (!previousFinishedAt || utcWeek(previousFinishedAt) !== utcWeek(now)) {
      targets.push('1w');
    }
    return targets;
  }

  async runMarketCandleRetentionIfDue(
    now: Date,
    config: OpsSchedulerConfig = getOpsSchedulerConfig(),
  ): Promise<OpsJobRunnerResponse | undefined> {
    if (!config.marketCandleRetention.enabled) return undefined;
    const local = getSchedulerLocalDateTime(now, config.timezone);
    const scheduledMinute =
      config.marketCandleRetention.hour * 60 +
      config.marketCandleRetention.minute;
    if (local.hour * 60 + local.minute < scheduledMinute) return undefined;

    const businessDate = getSchedulerBusinessDate(now, config.timezone);
    const latestSucceeded = await this.runService.findLatestSucceededRunForJob(
      OpsJobName.market_candle_retention,
    );
    if (
      latestSucceeded &&
      getSchedulerBusinessDate(latestSucceeded.startedAt, config.timezone) ===
        businessDate
    ) {
      return undefined;
    }

    return this.runner.runMarketCandleRetentionJob({
      trigger: OpsJobTrigger.scheduler,
      requestedBy: 'scheduler',
      dryRun: false,
      lockTtlSeconds: config.lockTtlSeconds,
      maxAttempts: config.maxAttempts,
      now: now.toISOString(),
      retentionDays: config.marketCandleRetention.retentionDays,
      batchSize: config.marketCandleRetention.batchSize,
      metadataJson: { businessDate },
    });
  }

  async runStartupProviderJobs(
    now = new Date(),
  ): Promise<OpsJobRunnerResponse[]> {
    const config = getOpsSchedulerConfig();
    const baseInput = {
      trigger: OpsJobTrigger.scheduler,
      requestedBy: 'scheduler',
      dryRun: false,
      lockTtlSeconds: config.lockTtlSeconds,
      maxAttempts: config.maxAttempts,
    };

    const results = await this.runEnabledProviderJobs(now, baseInput, config, {
      respectInterval: false,
    });
    await this.warnOnStartupMarketSnapshotHealth(results);

    return results;
  }

  private async runEnabledProviderJobs(
    now: Date,
    baseInput: OpsJobRunnerInput,
    config: OpsSchedulerConfig,
    options: { respectInterval: boolean },
  ): Promise<OpsJobRunnerResponse[]> {
    const results: OpsJobRunnerResponse[] = [];
    const fxResult = await this.runProviderJobIfDue({
      jobName: OpsJobName.provider_fx_ingest,
      enabled: config.jobs[OpsJobName.provider_fx_ingest],
      intervalSeconds:
        config.providerIntervalsSeconds[OpsJobName.provider_fx_ingest],
      now,
      respectInterval: options.respectInterval,
      run: () => this.runner.runProviderFxIngestJob(baseInput),
    });
    if (fxResult) {
      results.push(fxResult);
    }

    const binanceWebSocketStreamingEnabled =
      this.isBinanceWebSocketStreamingEnabled();
    const binanceResult = await this.runProviderJobIfDue({
      jobName: OpsJobName.provider_binance_ingest,
      enabled:
        config.jobs[OpsJobName.provider_binance_ingest] &&
        !binanceWebSocketStreamingEnabled,
      intervalSeconds:
        config.providerIntervalsSeconds[OpsJobName.provider_binance_ingest],
      now,
      respectInterval: options.respectInterval,
      run: () => this.runner.runProviderBinanceIngestJob(baseInput),
    });
    if (binanceResult) {
      results.push(binanceResult);
    }

    const kisResult = await this.runProviderJobIfDue({
      jobName: OpsJobName.provider_kis_ingest,
      enabled: config.jobs[OpsJobName.provider_kis_ingest],
      intervalSeconds:
        config.providerIntervalsSeconds[OpsJobName.provider_kis_ingest],
      now,
      respectInterval: options.respectInterval,
      run: () =>
        this.runner.runProviderKisIngestJob({
          ...baseInput,
          maxSnapshots: config.providerKisMaxSnapshots,
          kisPriceIngestionMode: config.providerKisPriceIngestionMode,
          now: now.toISOString(),
        }),
    });
    if (kisResult) {
      results.push(kisResult);
    }

    return results;
  }

  private isBinanceWebSocketStreamingEnabled(): boolean {
    try {
      return Boolean(
        this.providerConfigService?.getConfig().binance.wsStreamingEnabled,
      );
    } catch {
      return false;
    }
  }

  private async runProviderJobIfDue(input: {
    jobName: OpsJobName;
    enabled: boolean;
    intervalSeconds: number;
    now: Date;
    respectInterval: boolean;
    run: () => Promise<OpsJobRunnerResponse>;
  }): Promise<OpsJobRunnerResponse | undefined> {
    if (!input.enabled) {
      return undefined;
    }

    if (
      input.respectInterval &&
      !(await this.isProviderJobDue(
        input.jobName,
        input.intervalSeconds,
        input.now,
      ))
    ) {
      return undefined;
    }

    try {
      return await input.run();
    } catch {
      return undefined;
    }
  }

  private async isProviderJobDue(
    jobName: OpsJobName,
    intervalSeconds: number,
    now: Date,
  ) {
    const latestRun = await this.runService.findLatestRunForJob(jobName);
    if (!latestRun) {
      return true;
    }

    if (latestRun.status === OpsJobRunStatus.failed) {
      return true;
    }

    const lastRunAt = latestRun.finishedAt ?? latestRun.startedAt;
    return now.getTime() - lastRunAt.getTime() >= intervalSeconds * 1000;
  }

  private async warnOnStartupMarketSnapshotHealth(
    results: OpsJobRunnerResponse[],
  ) {
    if (!this.marketSnapshotHealthService || results.length === 0) {
      return;
    }

    try {
      const health =
        await this.marketSnapshotHealthService.checkActiveAssetCoverage();
      if (health.status === 'pass') {
        return;
      }

      console.warn('Market snapshot health check failed after startup run.', {
        status: health.status,
        coverage: health.coverage,
        fxUsdKrw: {
          state: health.fxUsdKrw.state,
          required: health.fxUsdKrw.required,
          reason: health.fxUsdKrw.reason,
        },
        targetSummary: {
          targetSource: health.targetSummary.targetSource,
          activeAssetCount: health.targetSummary.activeAssetCount,
          binanceSymbolCount: health.targetSummary.binanceSymbolCount,
          kisDomesticSymbolCount: health.targetSummary.kisDomesticSymbolCount,
          kisUsSymbolCount: health.targetSummary.kisUsSymbolCount,
          unsupportedAssetCount: health.targetSummary.unsupportedAssets.length,
        },
        unavailableAssets: health.unavailableAssets.map((asset) => ({
          assetId: asset.assetId,
          symbol: asset.symbol,
          reason: asset.reason,
        })),
      });
    } catch (error) {
      console.warn(
        'Market snapshot health check failed to run after startup.',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      );
    }
  }
}

function isFiveMinuteBucketStart(now: Date): boolean {
  return now.getUTCMinutes() % 5 === 0;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function utcWeek(value: Date): string {
  const date = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${date.getUTCFullYear()}-${String(week).padStart(2, '0')}`;
}
