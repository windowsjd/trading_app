import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
} from '../generated/prisma/client';
import {
  getOpsSchedulerConfig,
  getSchedulerBusinessDate,
  OpsSchedulerConfig,
  ProviderOpsJobName,
} from './ops-config';
import {
  OpsJobRunnerResponse,
  OpsJobRunnerInput,
  OpsJobRunnerService,
} from './ops-job-runner.service';
import { OpsJobRunService } from './ops-job-run.service';
import { MarketSnapshotHealthService } from '../providers/market-snapshot-health.service';
import { ProviderConfigService } from '../providers/provider-config.service';

@Injectable()
export class OpsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly runner: OpsJobRunnerService,
    private readonly runService: OpsJobRunService,
    @Optional()
    private readonly marketSnapshotHealthService?: MarketSnapshotHealthService,
    @Optional()
    private readonly providerConfigService?: ProviderConfigService,
  ) {}

  onModuleInit() {
    const config = getOpsSchedulerConfig();
    if (config.providerIngestionRunOnStartup) {
      const startupAt = new Date();
      void Promise.resolve().then(() => {
        void this.runStartupProviderJobs(startupAt);
      });
    }

    if (!config.enabled) {
      return;
    }

    this.interval = setInterval(() => {
      void this.runEnabledJobs(new Date());
    }, config.tickIntervalMs);
  }

  onModuleDestroy() {
    this.clearInterval();
  }

  clearInterval() {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
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

    return results;
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
    jobName: ProviderOpsJobName;
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
    jobName: ProviderOpsJobName,
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
