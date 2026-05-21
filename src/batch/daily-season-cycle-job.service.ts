import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { SerializedBatchJobRun } from './batch.types';
import { BatchService } from './batch.service';
import { DailyPortfolioSnapshotJobService } from './daily-portfolio-snapshot-job.service';
import {
  DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME,
  DailyPortfolioSnapshotJobResult,
} from './daily-portfolio-snapshot-job.types';
import {
  DAILY_SEASON_CYCLE_JOB_NAME,
  DailySeasonCycleJobError,
  DailySeasonCycleJobInput,
  DailySeasonCycleJobRequestPayload,
  DailySeasonCycleJobResult,
  DailySeasonCycleJobRunResponse,
  DailySeasonCycleStep,
  DailySeasonCycleStepState,
} from './daily-season-cycle-job.types';
import { SeasonRankingJobService } from './season-ranking-job.service';
import {
  SEASON_RANKING_JOB_NAME,
  SeasonRankingJobResult,
} from './season-ranking-job.types';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Injectable()
export class DailySeasonCycleJobService {
  constructor(
    private readonly batchService: BatchService,
    private readonly dailyPortfolioSnapshotJobService: DailyPortfolioSnapshotJobService,
    private readonly seasonRankingJobService: SeasonRankingJobService,
  ) {}

  async run(
    input: DailySeasonCycleJobInput,
  ): Promise<DailySeasonCycleJobRunResponse> {
    const dryRun = input.dryRun === true;
    const requestedBy = this.parseOptionalText(input.requestedBy);
    const idempotencyKey = this.resolveIdempotencyKey(input);
    const requestPayload: DailySeasonCycleJobRequestPayload = {
      seasonId: this.parseOptionalText(input.seasonId) ?? null,
      snapshotDate: this.parseOptionalText(input.snapshotDate) ?? null,
      dryRun,
      requestedBy: requestedBy ?? null,
      idempotencyKey,
    };

    return this.batchService.runJob<
      DailySeasonCycleJobRequestPayload,
      DailySeasonCycleJobResult
    >({
      jobName: DAILY_SEASON_CYCLE_JOB_NAME,
      idempotencyKey,
      dryRun,
      requestedBy,
      requestPayload,
      handler: ({ idempotencyKey: cycleIdempotencyKey }) =>
        this.runDailySeasonCycleJob({
          input,
          dryRun,
          requestedBy,
          cycleIdempotencyKey,
        }),
    });
  }

  private async runDailySeasonCycleJob(params: {
    input: DailySeasonCycleJobInput;
    dryRun: boolean;
    requestedBy?: string;
    cycleIdempotencyKey: string;
  }): Promise<DailySeasonCycleJobResult> {
    const seasonId = this.parseRequiredText(params.input.seasonId, 'seasonId');
    const snapshotDate = this.parseSnapshotDate(params.input.snapshotDate);
    const result = this.createBaseResult({
      seasonId,
      snapshotDate,
      dryRun: params.dryRun,
    });
    const childIdempotencyKeys = this.createChildIdempotencyKeys(
      params.cycleIdempotencyKey,
    );

    let dailySnapshotResponse: DailySeasonCycleJobRunResponse;
    try {
      dailySnapshotResponse = await this.dailyPortfolioSnapshotJobService.run({
        seasonId,
        snapshotDate,
        dryRun: params.dryRun,
        requestedBy: params.requestedBy,
        idempotencyKey: childIdempotencyKeys.dailyPortfolioSnapshot,
      });
    } catch (error) {
      result.steps.dailyPortfolioSnapshot = this.failedDailyStep(error);
      result.steps.seasonRanking = this.notRunSeasonRankingStep();
      this.throwCycleFailure(
        httpStatusFromError(error),
        'DAILY_PORTFOLIO_SNAPSHOT_STEP_FAILED',
        'Daily portfolio snapshot step failed.',
        result,
      );
    }

    result.steps.dailyPortfolioSnapshot = this.succeededDailyStep(
      dailySnapshotResponse,
    );

    try {
      const seasonRankingResponse = await this.seasonRankingJobService.run({
        seasonId,
        snapshotDate,
        dryRun: params.dryRun,
        requestedBy: params.requestedBy,
        idempotencyKey: childIdempotencyKeys.seasonRanking,
      });
      result.steps.seasonRanking = this.succeededSeasonRankingStep(
        seasonRankingResponse,
      );
    } catch (error) {
      result.steps.seasonRanking = this.failedSeasonRankingStep(error);
      this.throwCycleFailure(
        httpStatusFromError(error),
        'SEASON_RANKING_STEP_FAILED',
        'Season ranking step failed.',
        result,
      );
    }

    return result;
  }

  private succeededDailyStep(
    response: DailySeasonCycleJobRunResponse,
  ): DailySeasonCycleJobResult['steps']['dailyPortfolioSnapshot'] {
    const result = response.data.run
      .resultPayloadJson as unknown as DailyPortfolioSnapshotJobResult | null;

    return {
      state: this.stepStateFromResponse(response),
      runId: response.data.run.id,
      deduplicated: response.data.deduplicated,
      skipped: response.data.skipped,
      summary: result
        ? {
            participants: result.participants,
            createdSnapshotIds: result.createdSnapshotIds,
          }
        : null,
      errors: result?.errors ?? [],
    };
  }

  private succeededSeasonRankingStep(
    response: DailySeasonCycleJobRunResponse,
  ): DailySeasonCycleJobResult['steps']['seasonRanking'] {
    const result = response.data.run
      .resultPayloadJson as unknown as SeasonRankingJobResult | null;

    return {
      state: this.stepStateFromResponse(response),
      runId: response.data.run.id,
      deduplicated: response.data.deduplicated,
      skipped: response.data.skipped,
      summary: result
        ? {
            participants: result.participants,
            rankings: result.rankings,
            createdRankingIds: result.createdRankingIds,
            topRanks: result.topRanks,
            ...(result.reason ? { reason: result.reason } : {}),
            ...(result.message ? { message: result.message } : {}),
          }
        : null,
      errors: result?.errors ?? [],
    };
  }

  private failedDailyStep(
    error: unknown,
  ): DailySeasonCycleJobResult['steps']['dailyPortfolioSnapshot'] {
    return this.failedStep(error);
  }

  private failedSeasonRankingStep(
    error: unknown,
  ): DailySeasonCycleJobResult['steps']['seasonRanking'] {
    return this.failedStep(error);
  }

  private failedStep<TSummary>(
    error: unknown,
  ): DailySeasonCycleStep<TSummary, DailySeasonCycleJobError> {
    const failedRun = this.extractFailedRun(error);

    return {
      state: 'failed',
      runId: failedRun?.id ?? null,
      deduplicated: false,
      skipped: false,
      summary: null,
      errors: [this.extractError(error)],
    };
  }

  private notRunSeasonRankingStep(): DailySeasonCycleJobResult['steps']['seasonRanking'] {
    return {
      state: 'not_run',
      runId: null,
      deduplicated: false,
      skipped: false,
      summary: null,
      errors: [],
    };
  }

  private stepStateFromResponse(
    response: DailySeasonCycleJobRunResponse,
  ): DailySeasonCycleStepState {
    return response.data.skipped ? 'skipped' : 'succeeded';
  }

  private createBaseResult(input: {
    seasonId: string;
    snapshotDate: string;
    dryRun: boolean;
  }): DailySeasonCycleJobResult {
    return {
      seasonId: input.seasonId,
      snapshotDate: input.snapshotDate,
      dryRun: input.dryRun,
      steps: {
        dailyPortfolioSnapshot: {
          state: 'not_run',
          runId: null,
          deduplicated: false,
          skipped: false,
          summary: null,
          errors: [],
        },
        seasonRanking: this.notRunSeasonRankingStep(),
      },
    };
  }

  private createChildIdempotencyKeys(cycleIdempotencyKey: string) {
    return {
      dailyPortfolioSnapshot: `${cycleIdempotencyKey}:${DAILY_PORTFOLIO_SNAPSHOT_JOB_NAME}`,
      seasonRanking: `${cycleIdempotencyKey}:${SEASON_RANKING_JOB_NAME}`,
    };
  }

  private resolveIdempotencyKey(input: DailySeasonCycleJobInput): string {
    const explicitKey = this.parseOptionalText(input.idempotencyKey);
    if (explicitKey) {
      return explicitKey;
    }

    return `${DAILY_SEASON_CYCLE_JOB_NAME}:${this.toBusinessKeySegment(
      input.seasonId,
      'missing-season-id',
    )}:${this.toBusinessKeySegment(input.snapshotDate, 'missing-snapshot-date')}`;
  }

  private parseSnapshotDate(value: string | undefined): string {
    const text = this.parseRequiredText(value, 'snapshotDate');
    if (!DATE_ONLY_PATTERN.test(text)) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'snapshotDate must be YYYY-MM-DD.',
      );
    }

    const date = new Date(`${text}T00:00:00.000Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== text
    ) {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        'snapshotDate must be YYYY-MM-DD.',
      );
    }

    return text;
  }

  private parseRequiredText(value: unknown, fieldName: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.throwJobError(
        HttpStatus.BAD_REQUEST,
        'BAD_REQUEST',
        `${fieldName} is required.`,
      );
    }

    return value.trim();
  }

  private parseOptionalText(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private toBusinessKeySegment(value: unknown, fallback: string): string {
    return this.parseOptionalText(value) ?? fallback;
  }

  private extractFailedRun(error: unknown): SerializedBatchJobRun | null {
    const response = this.extractHttpExceptionResponse(error);
    if (
      !response ||
      !('data' in response) ||
      typeof response.data !== 'object'
    ) {
      return null;
    }

    const data = response.data;
    if (data === null || !('run' in data) || typeof data.run !== 'object') {
      return null;
    }

    return data.run as SerializedBatchJobRun;
  }

  private extractError(error: unknown): DailySeasonCycleJobError {
    const response = this.extractHttpExceptionResponse(error);
    if (
      response &&
      'error' in response &&
      typeof response.error === 'object' &&
      response.error !== null
    ) {
      const code =
        'code' in response.error && typeof response.error.code === 'string'
          ? response.error.code
          : 'CHILD_JOB_FAILED';
      const message =
        'message' in response.error &&
        typeof response.error.message === 'string'
          ? response.error.message
          : 'Child batch job failed.';

      return {
        code,
        message,
      };
    }

    return {
      code:
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'CHILD_JOB_FAILED',
      message:
        error instanceof Error && error.message.trim() !== ''
          ? error.message
          : 'Child batch job failed.',
    };
  }

  private extractHttpExceptionResponse(error: unknown) {
    if (!(error instanceof HttpException)) {
      return null;
    }

    const response = error.getResponse();
    return typeof response === 'object' && response !== null ? response : null;
  }

  private throwCycleFailure(
    status: HttpStatus,
    code: string,
    message: string,
    result: DailySeasonCycleJobResult,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
        data: {
          resultPayloadJson: result,
        },
      },
      status,
    );
  }

  private throwJobError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
      },
      status,
    );
  }
}

function httpStatusFromError(error: unknown): HttpStatus {
  return error instanceof HttpException
    ? error.getStatus()
    : HttpStatus.INTERNAL_SERVER_ERROR;
}
