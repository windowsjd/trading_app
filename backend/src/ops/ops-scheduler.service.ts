import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OpsJobName, OpsJobTrigger } from '../generated/prisma/client';
import { getOpsSchedulerConfig, getSchedulerBusinessDate } from './ops-config';
import {
  OpsJobRunnerResponse,
  OpsJobRunnerService,
} from './ops-job-runner.service';

@Injectable()
export class OpsSchedulerService implements OnModuleInit, OnModuleDestroy {
  private interval: NodeJS.Timeout | null = null;

  constructor(private readonly runner: OpsJobRunnerService) {}

  onModuleInit() {
    const config = getOpsSchedulerConfig();
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

    if (config.jobs[OpsJobName.provider_fx_ingest]) {
      results.push(await this.runner.runProviderFxIngestJob(baseInput));
    }

    if (config.jobs[OpsJobName.provider_binance_ingest]) {
      results.push(await this.runner.runProviderBinanceIngestJob(baseInput));
    }

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
}

function isFiveMinuteBucketStart(now: Date): boolean {
  return now.getUTCMinutes() % 5 === 0;
}
