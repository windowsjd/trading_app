import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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

@Injectable()
export class OpsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly runner: OpsJobRunnerService,
    private readonly runService: OpsJobRunService,
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

    return this.runEnabledProviderJobs(now, baseInput, config, {
      respectInterval: false,
    });
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

    const binanceResult = await this.runProviderJobIfDue({
      jobName: OpsJobName.provider_binance_ingest,
      enabled: config.jobs[OpsJobName.provider_binance_ingest],
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
        this.runner.runProviderKisRestCurrentPriceIngestJob({
          ...baseInput,
          maxSnapshots: config.providerKisMaxSnapshots,
        }),
    });
    if (kisResult) {
      results.push(kisResult);
    }

    return results;
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
}

function isFiveMinuteBucketStart(now: Date): boolean {
  return now.getUTCMinutes() % 5 === 0;
}
