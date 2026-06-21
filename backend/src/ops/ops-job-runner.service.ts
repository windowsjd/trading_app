import { HttpException, Injectable } from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRun,
  OpsJobTrigger,
  SeasonStatus,
} from '../generated/prisma/client';
import { DailyPortfolioSnapshotJobService } from '../batch/daily-portfolio-snapshot-job.service';
import { SeasonLifecycleTransitionJobService } from '../batch/season-lifecycle-transition-job.service';
import { SeasonSettlementJobService } from '../batch/season-settlement-job.service';
import { SEASON_SETTLEMENT_JOB_NAME } from '../batch/season-settlement-job.types';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import { PrismaService } from '../prisma/prisma.service';
import { getOpsSchedulerConfig } from './ops-config';
import { OpsJobLockService } from './ops-job-lock.service';
import { OpsJobRunService, SerializedOpsJobRun } from './ops-job-run.service';

export type OpsJobRunnerResponse =
  | {
      success: true;
      data: {
        run: SerializedOpsJobRun;
        locked: boolean;
        skipped: boolean;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
      data: {
        run: SerializedOpsJobRun;
      };
    };

export type OpsJobRunnerInput = {
  trigger?: OpsJobTrigger;
  requestedBy?: string | null;
  dryRun?: boolean;
  idempotencyKey?: string | null;
  metadataJson?: unknown;
  lockTtlSeconds?: number;
  maxAttempts?: number;
};

export type DailySnapshotOpsJobInput = OpsJobRunnerInput & {
  seasonId?: string | null;
  snapshotDate?: string | null;
};

export type TimedOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  createEquitySnapshots?: boolean;
};

@Injectable()
export class OpsJobRunnerService {
  constructor(
    private readonly dailyPortfolioSnapshotJobService: DailyPortfolioSnapshotJobService,
    private readonly seasonLifecycleTransitionJobService: SeasonLifecycleTransitionJobService,
    private readonly seasonSettlementJobService: SeasonSettlementJobService,
    private readonly rankingRefreshService: RankingRefreshService,
    private readonly prisma: PrismaService,
    private readonly lockService: OpsJobLockService,
    private readonly runService: OpsJobRunService,
  ) {}

  runProviderFxIngestJob(input: OpsJobRunnerInput = {}) {
    return this.recordNotImplemented(
      OpsJobName.provider_fx_ingest,
      input,
      'Provider FX ingestion remains script/operator-run only in this gate.',
    );
  }

  runProviderBinanceIngestJob(input: OpsJobRunnerInput = {}) {
    return this.recordNotImplemented(
      OpsJobName.provider_binance_ingest,
      input,
      'Provider Binance ingestion remains script/operator-run only in this gate.',
    );
  }

  runSeasonRankingGenerationJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_ranking_generation,
      input,
      'season_ranking_generation:current',
      async () =>
        this.rankingRefreshService.refreshCurrentRankingsForActiveSeasons(now, {
          createEquitySnapshots: input.createEquitySnapshots === true,
        }),
    );
  }

  runSeasonLifecycleTransitionJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_lifecycle_transition,
      input,
      'season_lifecycle_transition:current',
      async () =>
        this.seasonLifecycleTransitionJobService.run({
          now: now.toISOString(),
          dryRun: input.dryRun === true,
          requestedBy: input.requestedBy ?? undefined,
          idempotencyKey:
            input.idempotencyKey ??
            `season-lifecycle-transition:${now.toISOString()}`,
        }),
    );
  }

  runSeasonSettlementJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_settlement,
      input,
      'season_settlement:ended',
      async () => {
        const seasons = await this.prisma.season.findMany({
          where: {
            status: SeasonStatus.ended,
          },
          orderBy: [{ endAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            endAt: true,
          },
        });
        const settled: Array<{
          seasonId: string;
          settlementDate: string;
          batchRunId: string;
          batchStatus: string;
        }> = [];

        for (const season of seasons) {
          const settlementDate = this.formatDateOnly(season.endAt);
          const batchResponse = await this.seasonSettlementJobService.run({
            seasonId: season.id,
            settlementDate,
            dryRun: input.dryRun === true,
            requestedBy: input.requestedBy ?? undefined,
            idempotencyKey: `${SEASON_SETTLEMENT_JOB_NAME}:${season.id}:${settlementDate}:${now.toISOString()}`,
          });
          settled.push({
            seasonId: season.id,
            settlementDate,
            batchRunId: batchResponse.data.run.id,
            batchStatus: batchResponse.data.run.status,
          });
        }

        return {
          seasonsProcessed: seasons.length,
          settled,
        };
      },
    );
  }

  runRewardMarkerJob(input: OpsJobRunnerInput = {}) {
    return this.recordNotImplemented(
      OpsJobName.reward_marker,
      input,
      'Scheduler-driven reward marker automation is not implemented in this gate.',
    );
  }

  async runDailyPortfolioSnapshotJob(
    input: DailySnapshotOpsJobInput,
  ): Promise<OpsJobRunnerResponse> {
    const jobName = OpsJobName.daily_portfolio_snapshot;
    const trigger = input.trigger ?? OpsJobTrigger.manual_script;
    const dryRun = input.dryRun === true;
    const seasonId = this.optionalString(input.seasonId);
    const snapshotDate = this.optionalString(input.snapshotDate);

    if (!seasonId || !snapshotDate) {
      const skipped = await this.runService.recordSkipped({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'NOT_CONFIGURED',
          message:
            'seasonId and snapshotDate are required for daily snapshot ops job.',
        },
      });

      return this.successResponse(skipped, { skipped: true });
    }

    const lockKey = this.buildDailySnapshotLockKey(seasonId, snapshotDate);
    const lock = await this.lockService.acquireLock({
      jobName,
      lockKey,
      ttlSeconds: input.lockTtlSeconds ?? this.defaultLockTtlSeconds(),
    });

    if (!lock.acquired) {
      const locked = await this.runService.recordLocked({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'LOCKED',
          activeOwnerId: lock.activeOwnerId,
          expiresAt: lock.expiresAt?.toISOString() ?? null,
        },
      });

      return this.successResponse(locked, { locked: true, skipped: true });
    }

    const run = await this.runService.createRunning({
      jobName,
      trigger,
      requestedBy: input.requestedBy,
      lockKey,
      dryRun,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
      metadataJson: input.metadataJson,
    });

    try {
      const batchResponse = await this.dailyPortfolioSnapshotJobService.run({
        seasonId,
        snapshotDate,
        dryRun,
        requestedBy: input.requestedBy ?? undefined,
      });
      const succeeded = await this.runService.recordSucceeded(run, {
        resultJson: {
          batchRunId: batchResponse.data.run.id,
          batchStatus: batchResponse.data.run.status,
          dryRun: batchResponse.data.run.dryRun,
          resultPayloadJson: batchResponse.data.run.resultPayloadJson,
          deduplicated: batchResponse.data.deduplicated,
          skipped: batchResponse.data.skipped,
        },
      });

      return this.successResponse(succeeded);
    } catch (error) {
      const failure = this.extractFailure(error);
      const failed = await this.runService.recordFailed(run, {
        errorCode: failure.code,
        errorMessage: failure.message,
        resultJson: failure.resultJson,
      });

      return {
        success: false,
        error: {
          code: failure.code,
          message: failure.message,
        },
        data: {
          run: this.runService.serializeRun(failed),
        },
      };
    } finally {
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
    }
  }

  buildDailySnapshotLockKey(seasonId: string, snapshotDate: string) {
    return `daily_portfolio_snapshot:${seasonId}:${snapshotDate}`;
  }

  private async runLockedOpsJob(
    jobName: OpsJobName,
    input: OpsJobRunnerInput,
    lockKey: string,
    handler: () => Promise<unknown>,
  ): Promise<OpsJobRunnerResponse> {
    const trigger = input.trigger ?? OpsJobTrigger.manual_script;
    const dryRun = input.dryRun === true;
    const lock = await this.lockService.acquireLock({
      jobName,
      lockKey,
      ttlSeconds: input.lockTtlSeconds ?? this.defaultLockTtlSeconds(),
    });

    if (!lock.acquired) {
      const locked = await this.runService.recordLocked({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'LOCKED',
          activeOwnerId: lock.activeOwnerId,
          expiresAt: lock.expiresAt?.toISOString() ?? null,
        },
      });

      return this.successResponse(locked, { locked: true, skipped: true });
    }

    const run = await this.runService.createRunning({
      jobName,
      trigger,
      requestedBy: input.requestedBy,
      lockKey,
      dryRun,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
      metadataJson: input.metadataJson,
    });

    try {
      const resultJson = dryRun
        ? {
            dryRun: true,
            message: `${jobName} would run when dryRun is false.`,
          }
        : await handler();
      const succeeded = await this.runService.recordSucceeded(run, {
        resultJson,
      });

      return this.successResponse(succeeded);
    } catch (error) {
      const failure = this.extractFailure(error);
      const failed = await this.runService.recordFailed(run, {
        errorCode: failure.code,
        errorMessage: failure.message,
        resultJson: failure.resultJson,
      });

      return {
        success: false,
        error: {
          code: failure.code,
          message: failure.message,
        },
        data: {
          run: this.runService.serializeRun(failed),
        },
      };
    } finally {
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
    }
  }

  private async recordNotImplemented(
    jobName: OpsJobName,
    input: OpsJobRunnerInput,
    message: string,
  ): Promise<OpsJobRunnerResponse> {
    const skipped = await this.runService.recordSkipped({
      jobName,
      trigger: input.trigger ?? OpsJobTrigger.manual_script,
      requestedBy: input.requestedBy,
      dryRun: input.dryRun === true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
      metadataJson: input.metadataJson,
      resultJson: {
        reason: 'NOT_IMPLEMENTED',
        message,
      },
    });

    return this.successResponse(skipped, { skipped: true });
  }

  private successResponse(
    run: OpsJobRun,
    flags: { locked?: boolean; skipped?: boolean } = {},
  ): OpsJobRunnerResponse {
    return {
      success: true,
      data: {
        run: this.runService.serializeRun(run),
        locked: flags.locked === true,
        skipped: flags.skipped === true,
      },
    };
  }

  private extractFailure(error: unknown): {
    code: string;
    message: string;
    resultJson?: unknown;
  } {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      return {
        code: this.extractHttpErrorField(response, 'code') ?? 'OPS_JOB_FAILED',
        message:
          this.extractHttpErrorField(response, 'message') ?? 'Ops job failed.',
        resultJson: this.extractHttpResultPayload(response),
      };
    }

    if (error instanceof Error && error.message.trim() !== '') {
      return {
        code: 'OPS_JOB_FAILED',
        message: error.message,
      };
    }

    return {
      code: 'OPS_JOB_FAILED',
      message: 'Ops job failed.',
    };
  }

  private extractHttpErrorField(
    response: string | object,
    fieldName: 'code' | 'message',
  ) {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('error' in response) ||
      typeof response.error !== 'object' ||
      response.error === null ||
      !(fieldName in response.error)
    ) {
      return undefined;
    }

    const value = response.error[fieldName];
    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : undefined;
  }

  private extractHttpResultPayload(response: string | object): unknown {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('data' in response) ||
      typeof response.data !== 'object' ||
      response.data === null ||
      !('resultPayloadJson' in response.data)
    ) {
      return undefined;
    }

    return response.data.resultPayloadJson;
  }

  private optionalString(value: string | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = value.trim();
    return normalized === '' ? null : normalized;
  }

  private defaultLockTtlSeconds() {
    return getOpsSchedulerConfig().lockTtlSeconds;
  }

  private defaultMaxAttempts() {
    return getOpsSchedulerConfig().maxAttempts;
  }

  private parseOptionalDate(value: string | null | undefined) {
    const text = this.optionalString(value);
    if (!text) {
      return undefined;
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private formatDateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }
}
