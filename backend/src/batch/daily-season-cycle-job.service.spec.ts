jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    BatchJobStatus: {
      pending: 'pending',
      running: 'running',
      succeeded: 'succeeded',
      failed: 'failed',
      skipped: 'skipped',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: {
      Decimal,
      JsonNull: null,
    },
    PrismaClient: class PrismaClient {},
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
  };
});

import { HttpException, HttpStatus } from '@nestjs/common';
import { DailySeasonCycleJobService } from './daily-season-cycle-job.service';
import {
  DAILY_SEASON_CYCLE_JOB_NAME,
  DailySeasonCycleJobResult,
} from './daily-season-cycle-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

type ChildJobMock = {
  run: jest.Mock;
};

describe('DailySeasonCycleJobService', () => {
  const startedAt = new Date('2026-05-21T00:00:30.000Z');
  const snapshotDate = '2026-05-21';

  it('runs child daily snapshot and season ranking jobs in order with dryRun=true', async () => {
    const { service, batchService, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(
      dailyResponse({ dryRun: true, wouldCreate: 1 }),
    );
    rankingJob.run.mockResolvedValue(
      rankingResponse({ dryRun: true, wouldCreate: 1 }),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
      requestedBy: 'operator',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: DAILY_SEASON_CYCLE_JOB_NAME,
        idempotencyKey: 'daily-season-cycle:season-1:2026-05-21',
        dryRun: true,
        requestedBy: 'operator',
      }),
    );
    expect(dailyJob.run).toHaveBeenCalledWith({
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
      requestedBy: 'operator',
      idempotencyKey:
        'daily-season-cycle:season-1:2026-05-21:daily-portfolio-snapshot',
    });
    expect(rankingJob.run).toHaveBeenCalledWith({
      seasonId: 'season-1',
      snapshotDate,
      dryRun: true,
      requestedBy: 'operator',
      idempotencyKey: 'daily-season-cycle:season-1:2026-05-21:season-ranking',
    });
    expect(dailyJob.run.mock.invocationCallOrder[0]).toBeLessThan(
      rankingJob.run.mock.invocationCallOrder[0],
    );
    expect(result.steps.dailyPortfolioSnapshot.summary).toMatchObject({
      participants: {
        wouldCreate: 1,
      },
    });
    expect(result.steps.seasonRanking.summary).toMatchObject({
      rankings: {
        wouldCreate: 1,
      },
    });
  });

  it('runs child jobs with dryRun=false', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(
      dailyResponse({ dryRun: false, created: 1 }),
    );
    rankingJob.run.mockResolvedValue(
      rankingResponse({ dryRun: false, created: 1 }),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(dailyJob.run).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
      }),
    );
    expect(rankingJob.run).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
      }),
    );
    expect(result.steps.dailyPortfolioSnapshot.summary).toMatchObject({
      createdSnapshotIds: ['snapshot-1'],
    });
    expect(result.steps.seasonRanking.summary).toMatchObject({
      createdRankingIds: ['ranking-1'],
    });
  });

  it('keeps an explicit cycle idempotencyKey', async () => {
    const { service, batchService, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(dailyResponse());
    rankingJob.run.mockResolvedValue(rankingResponse());

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
      idempotencyKey: 'manual-cycle-key',
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-cycle-key',
      }),
    );
    expect(dailyJob.run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-cycle-key:daily-portfolio-snapshot',
      }),
    );
    expect(rankingJob.run).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-cycle-key:season-ranking',
      }),
    );
  });

  it('does not run season ranking when daily snapshot job has a job-level failure', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockRejectedValue(
      childFailure({
        runId: 'daily-run-failed',
        code: 'SEASON_NOT_FOUND',
        message: 'Season not found.',
        status: HttpStatus.NOT_FOUND,
      }),
    );

    await expect(
      service.run({
        seasonId: 'missing-season',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });

    expect(rankingJob.run).not.toHaveBeenCalled();
  });

  it('includes not_run season ranking summary when daily snapshot job fails', async () => {
    const { service, dailyJob } = createService();
    dailyJob.run.mockRejectedValue(
      childFailure({
        runId: 'daily-run-failed',
        code: 'SEASON_STATUS_NOT_ALLOWED',
        message:
          'Daily portfolio snapshot job does not support upcoming seasons.',
        status: HttpStatus.BAD_REQUEST,
      }),
    );

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    );
    const result = response.data.resultPayloadJson as DailySeasonCycleJobResult;

    expect(result.steps.dailyPortfolioSnapshot).toMatchObject({
      state: 'failed',
      runId: 'daily-run-failed',
      errors: [
        {
          code: 'SEASON_STATUS_NOT_ALLOWED',
        },
      ],
    });
    expect(result.steps.seasonRanking).toMatchObject({
      state: 'not_run',
      runId: null,
    });
  });

  it('continues to season ranking when daily snapshot has participant-level failures only', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(
      dailyResponse({
        failed: 1,
        errors: [
          {
            seasonParticipantId: 'sp-fail',
            userId: 'user-fail',
            code: 'ASSET_PRICE_UNAVAILABLE',
            message: 'Asset price snapshot is unavailable.',
          },
        ],
      }),
    );
    rankingJob.run.mockResolvedValue(rankingResponse());

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(rankingJob.run).toHaveBeenCalled();
    expect(result.steps.dailyPortfolioSnapshot.state).toBe('succeeded');
    expect(result.steps.dailyPortfolioSnapshot.errors).toEqual([
      {
        seasonParticipantId: 'sp-fail',
        userId: 'user-fail',
        code: 'ASSET_PRICE_UNAVAILABLE',
        message: 'Asset price snapshot is unavailable.',
      },
    ]);
    expect(result.steps.seasonRanking.state).toBe('succeeded');
  });

  it('fails the cycle when season ranking job has a job-level failure', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(dailyResponse({ created: 1 }));
    rankingJob.run.mockRejectedValue(
      childFailure({
        runId: 'ranking-run-failed',
        code: 'BAD_REQUEST',
        message: 'snapshotDate must be YYYY-MM-DD.',
        status: HttpStatus.BAD_REQUEST,
      }),
    );

    const response = await captureHttpExceptionResponse(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    );
    const result = response.data.resultPayloadJson as DailySeasonCycleJobResult;

    expect(result.steps.dailyPortfolioSnapshot.state).toBe('succeeded');
    expect(result.steps.seasonRanking).toMatchObject({
      state: 'failed',
      runId: 'ranking-run-failed',
      errors: [
        {
          code: 'BAD_REQUEST',
        },
      ],
    });
  });

  it('reflects child deduplicated/skipped responses in the summary', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(
      dailyResponse({
        deduplicated: true,
        skipped: true,
        runId: 'daily-existing-run',
      }),
    );
    rankingJob.run.mockResolvedValue(
      rankingResponse({
        deduplicated: true,
        skipped: true,
        runId: 'ranking-existing-run',
      }),
    );

    const result = await runAndGetResult(service, {
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(result.steps.dailyPortfolioSnapshot).toMatchObject({
      state: 'skipped',
      runId: 'daily-existing-run',
      deduplicated: true,
      skipped: true,
    });
    expect(result.steps.seasonRanking).toMatchObject({
      state: 'skipped',
      runId: 'ranking-existing-run',
      deduplicated: true,
      skipped: true,
    });
  });

  it('rejects invalid snapshotDate as cycle-level BAD_REQUEST before child jobs', async () => {
    const { service, batchService, dailyJob, rankingJob } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate: '2026-02-31',
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(batchService.runJob).toHaveBeenCalled();
    expect(dailyJob.run).not.toHaveBeenCalled();
    expect(rankingJob.run).not.toHaveBeenCalled();
  });

  it('rejects missing seasonId as cycle-level BAD_REQUEST before child jobs', async () => {
    const { service, dailyJob, rankingJob } = createService();

    await expect(
      service.run({
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(dailyJob.run).not.toHaveBeenCalled();
    expect(rankingJob.run).not.toHaveBeenCalled();
  });

  it('delegates upcoming and settled season validation to the daily snapshot child step', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockRejectedValue(
      childFailure({
        runId: 'daily-status-failed',
        code: 'SEASON_STATUS_NOT_ALLOWED',
        message:
          'Daily portfolio snapshot job does not support settled seasons.',
        status: HttpStatus.BAD_REQUEST,
      }),
    );

    await expect(
      service.run({
        seasonId: 'season-1',
        snapshotDate,
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
    expect(dailyJob.run).toHaveBeenCalled();
    expect(rankingJob.run).not.toHaveBeenCalled();
  });

  it('uses BatchService.runJob as the cycle envelope', async () => {
    const { service, batchService, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(dailyResponse());
    rankingJob.run.mockResolvedValue(rankingResponse());

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: DAILY_SEASON_CYCLE_JOB_NAME,
        idempotencyKey: 'daily-season-cycle:season-1:2026-05-21',
      }),
    );
  });

  it('does not directly create provider, price, wallet, order, position, snapshot, or ranking rows', async () => {
    const { service, dailyJob, rankingJob } = createService();
    dailyJob.run.mockResolvedValue(dailyResponse());
    rankingJob.run.mockResolvedValue(rankingResponse());

    await service.run({
      seasonId: 'season-1',
      snapshotDate,
    });

    expect(dailyJob.run).toHaveBeenCalledTimes(1);
    expect(rankingJob.run).toHaveBeenCalledTimes(1);
  });

  function createService() {
    const batchService = createBatchServiceMock(startedAt);
    const dailyJob = {
      run: jest.fn(),
    };
    const rankingJob = {
      run: jest.fn(),
    };
    const service = new DailySeasonCycleJobService(
      batchService as never,
      dailyJob as never,
      rankingJob as never,
    );

    return {
      service,
      batchService,
      dailyJob,
      rankingJob,
    };
  }
});

function createBatchServiceMock(startedAt: Date): BatchServiceMock {
  return {
    runJob: jest.fn(async (params) => {
      const result = await params.handler({
        runId: 'cycle-run-1',
        jobName: params.jobName,
        idempotencyKey: params.idempotencyKey,
        dryRun: params.dryRun === true,
        startedAt,
      });

      return {
        success: true,
        data: {
          run: {
            id: 'cycle-run-1',
            jobName: params.jobName,
            idempotencyKey: params.idempotencyKey,
            status: 'succeeded',
            dryRun: params.dryRun === true,
            startedAt: startedAt.toISOString(),
            finishedAt: startedAt.toISOString(),
            requestedBy: params.requestedBy ?? null,
            requestPayloadJson: params.requestPayload ?? null,
            resultPayloadJson: result,
            errorCode: null,
            errorMessage: null,
            createdAt: startedAt.toISOString(),
            updatedAt: startedAt.toISOString(),
          },
          deduplicated: false,
          skipped: false,
        },
      };
    }),
  };
}

function dailyResponse(
  input: {
    dryRun?: boolean;
    runId?: string;
    deduplicated?: boolean;
    skipped?: boolean;
    created?: number;
    wouldCreate?: number;
    existing?: number;
    failed?: number;
    errors?: unknown[];
  } = {},
) {
  const dryRun = input.dryRun === true;

  return childSuccessResponse({
    runId: input.runId ?? 'daily-run-1',
    jobName: 'daily-portfolio-snapshot',
    idempotencyKey: 'daily-key',
    dryRun,
    deduplicated: input.deduplicated === true,
    skipped: input.skipped === true,
    resultPayloadJson: {
      seasonId: 'season-1',
      snapshotDate: '2026-05-21',
      dryRun,
      participants: {
        total: 1,
        created: input.created ?? 0,
        wouldCreate: input.wouldCreate ?? 0,
        existing: input.existing ?? 0,
        failed: input.failed ?? 0,
        skipped: 0,
      },
      createdSnapshotIds: input.created ? ['snapshot-1'] : [],
      errors: input.errors ?? [],
    },
  });
}

function rankingResponse(
  input: {
    dryRun?: boolean;
    runId?: string;
    deduplicated?: boolean;
    skipped?: boolean;
    created?: number;
    wouldCreate?: number;
  } = {},
) {
  const dryRun = input.dryRun === true;

  return childSuccessResponse({
    runId: input.runId ?? 'ranking-run-1',
    jobName: 'season-ranking',
    idempotencyKey: 'ranking-key',
    dryRun,
    deduplicated: input.deduplicated === true,
    skipped: input.skipped === true,
    resultPayloadJson: {
      seasonId: 'season-1',
      snapshotDate: '2026-05-21',
      dryRun,
      participants: {
        snapshotted: input.created || input.wouldCreate ? 1 : 0,
        missingSnapshots: 0,
      },
      rankings: {
        wouldCreate: input.wouldCreate ?? 0,
        created: input.created ?? 0,
        existing: 0,
        skipped: 0,
      },
      createdRankingIds: input.created ? ['ranking-1'] : [],
      topRanks: [],
      errors: [],
    },
  });
}

function childSuccessResponse(input: {
  runId: string;
  jobName: string;
  idempotencyKey: string;
  dryRun: boolean;
  deduplicated: boolean;
  skipped: boolean;
  resultPayloadJson: unknown;
}) {
  const now = new Date('2026-05-21T00:00:30.000Z').toISOString();

  return {
    success: true,
    data: {
      run: {
        id: input.runId,
        jobName: input.jobName,
        idempotencyKey: input.idempotencyKey,
        status: 'succeeded',
        dryRun: input.dryRun,
        startedAt: now,
        finishedAt: now,
        requestedBy: null,
        requestPayloadJson: null,
        resultPayloadJson: input.resultPayloadJson,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      },
      deduplicated: input.deduplicated,
      skipped: input.skipped,
    },
  };
}

function childFailure(input: {
  runId: string;
  code: string;
  message: string;
  status: HttpStatus;
}) {
  const now = new Date('2026-05-21T00:00:30.000Z').toISOString();

  return new HttpException(
    {
      success: false,
      error: {
        code: input.code,
        message: input.message,
      },
      data: {
        run: {
          id: input.runId,
          jobName: 'child-job',
          idempotencyKey: 'child-key',
          status: 'failed',
          dryRun: false,
          startedAt: now,
          finishedAt: now,
          requestedBy: null,
          requestPayloadJson: null,
          resultPayloadJson: null,
          errorCode: input.code,
          errorMessage: input.message,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
    input.status,
  );
}

async function runAndGetResult(
  service: DailySeasonCycleJobService,
  input: Parameters<DailySeasonCycleJobService['run']>[0],
): Promise<DailySeasonCycleJobResult> {
  const response = await service.run(input);

  return response.data.run
    .resultPayloadJson as unknown as DailySeasonCycleJobResult;
}

async function captureHttpExceptionResponse(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getResponse() as {
      data: {
        resultPayloadJson: DailySeasonCycleJobResult;
      };
    };
  }

  throw new Error('Expected HttpException.');
}
