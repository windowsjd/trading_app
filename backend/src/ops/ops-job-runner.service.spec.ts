jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_lifecycle_transition: 'season_lifecycle_transition',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
  },
  OpsJobRunStatus: {
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
    locked: 'locked',
  },
  OpsJobTrigger: {
    scheduler: 'scheduler',
    operator: 'operator',
    manual_script: 'manual_script',
    test: 'test',
  },
}));

jest.mock('../batch/daily-portfolio-snapshot-job.service', () => ({
  DailyPortfolioSnapshotJobService: class DailyPortfolioSnapshotJobService {},
}));
jest.mock('../batch/season-lifecycle-transition-job.service', () => ({
  SeasonLifecycleTransitionJobService: class SeasonLifecycleTransitionJobService {},
}));
jest.mock('../batch/season-settlement-job.service', () => ({
  SeasonSettlementJobService: class SeasonSettlementJobService {},
}));
jest.mock('../ranking/ranking-refresh.service', () => ({
  RankingRefreshService: class RankingRefreshService {},
}));

import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
} from '../generated/prisma/client';
import { OpsJobRunnerService } from './ops-job-runner.service';

describe('OpsJobRunnerService', () => {
  const startedAt = new Date('2026-06-08T00:00:00.000Z');
  const serializedRun = (
    overrides: Partial<{
      id: string;
      jobName: OpsJobName;
      status: OpsJobRunStatus;
      resultJson: unknown;
    }> = {},
  ) => ({
    id: overrides.id ?? 'run-1',
    jobName: overrides.jobName ?? OpsJobName.daily_portfolio_snapshot,
    status: overrides.status ?? OpsJobRunStatus.succeeded,
    trigger: OpsJobTrigger.test,
    requestedBy: null,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    lockKey: null,
    idempotencyKey: null,
    dryRun: true,
    attempt: 1,
    maxAttempts: 1,
    errorCode: null,
    errorMessage: null,
    resultJson: overrides.resultJson ?? null,
    metadataJson: null,
    createdAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
  });

  const createService = () => {
    const dailyPortfolioSnapshotJobService = {
      run: jest.fn(),
    };
    const seasonLifecycleTransitionJobService = {
      run: jest.fn(),
    };
    const seasonSettlementJobService = {
      run: jest.fn(),
    };
    const rankingRefreshService = {
      refreshCurrentRankingsForActiveSeasons: jest.fn(),
    };
    const prisma = {
      season: {
        findMany: jest.fn(),
      },
    };
    const lockService = {
      acquireLock: jest.fn(),
      releaseLock: jest.fn(),
    };
    const runService = {
      recordSkipped: jest.fn(),
      recordLocked: jest.fn(),
      createRunning: jest.fn(),
      recordSucceeded: jest.fn(),
      recordFailed: jest.fn(),
      serializeRun: jest.fn((run) => run.serialized ?? serializedRun()),
    };

    return {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      seasonLifecycleTransitionJobService,
      seasonSettlementJobService,
      rankingRefreshService,
      prisma,
      service: new OpsJobRunnerService(
        dailyPortfolioSnapshotJobService as never,
        seasonLifecycleTransitionJobService as never,
        seasonSettlementJobService as never,
        rankingRefreshService as never,
        prisma as never,
        lockService as never,
        runService as never,
      ),
    };
  };

  it('records provider ingestion as skipped/not implemented', async () => {
    const { runService, service } = createService();
    runService.recordSkipped.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_fx_ingest,
        status: OpsJobRunStatus.skipped,
      }),
    });

    const response = await service.runProviderFxIngestJob({
      trigger: OpsJobTrigger.test,
      dryRun: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        skipped: true,
      },
    });
    expect(runService.recordSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: OpsJobName.provider_fx_ingest,
        resultJson: expect.objectContaining({
          reason: 'NOT_IMPLEMENTED',
        }),
      }),
    );
  });

  it.each([
    [
      OpsJobName.provider_fx_ingest,
      (service: OpsJobRunnerService) => service.runProviderFxIngestJob,
    ],
    [
      OpsJobName.provider_binance_ingest,
      (service: OpsJobRunnerService) => service.runProviderBinanceIngestJob,
    ],
    [
      OpsJobName.reward_marker,
      (service: OpsJobRunnerService) => service.runRewardMarkerJob,
    ],
  ])(
    'keeps %s as skipped/NOT_IMPLEMENTED instead of fake success',
    async (jobName, selectRunner) => {
      const { dailyPortfolioSnapshotJobService, runService, service } =
        createService();
      runService.recordSkipped.mockResolvedValueOnce({
        serialized: serializedRun({
          jobName,
          status: OpsJobRunStatus.skipped,
          resultJson: {
            reason: 'NOT_IMPLEMENTED',
          },
        }),
      });

      const response = await selectRunner(service).call(service, {
        trigger: OpsJobTrigger.test,
        dryRun: true,
      });

      expect(response).toMatchObject({
        success: true,
        data: {
          skipped: true,
          run: {
            status: OpsJobRunStatus.skipped,
            resultJson: {
              reason: 'NOT_IMPLEMENTED',
            },
          },
        },
      });
      expect(runService.recordSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          jobName,
          dryRun: true,
          resultJson: expect.objectContaining({
            reason: 'NOT_IMPLEMENTED',
          }),
        }),
      );
      expect(runService.createRunning).not.toHaveBeenCalled();
      expect(dailyPortfolioSnapshotJobService.run).not.toHaveBeenCalled();
    },
  );

  it('runs daily snapshot through the existing batch service and releases lock', async () => {
    const {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: 'owner-1',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-1',
      startedAt,
    });
    dailyPortfolioSnapshotJobService.run.mockResolvedValueOnce({
      success: true,
      data: {
        run: {
          id: 'batch-run-1',
          status: 'succeeded',
          dryRun: true,
          resultPayloadJson: {
            sourceSummary: {
              providerApiUsed: true,
            },
          },
        },
        deduplicated: false,
        skipped: false,
      },
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun(),
    });

    const response = await service.runDailyPortfolioSnapshotJob({
      trigger: OpsJobTrigger.test,
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
      lockTtlSeconds: 600,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(dailyPortfolioSnapshotJobService.run).toHaveBeenCalledWith({
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
      requestedBy: undefined,
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-1',
        startedAt,
      },
      {
        resultJson: expect.objectContaining({
          batchRunId: 'batch-run-1',
          resultPayloadJson: {
            sourceSummary: {
              providerApiUsed: true,
            },
          },
        }),
      },
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: 'owner-1',
    });
  });

  it('records locked run when daily snapshot lock is active', async () => {
    const {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: false,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: null,
      activeOwnerId: 'owner-active',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.recordLocked.mockResolvedValueOnce({
      serialized: serializedRun({
        status: OpsJobRunStatus.locked,
      }),
    });

    const response = await service.runDailyPortfolioSnapshotJob({
      trigger: OpsJobTrigger.test,
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: true,
        skipped: true,
      },
    });
    expect(dailyPortfolioSnapshotJobService.run).not.toHaveBeenCalled();
    expect(runService.recordLocked).toHaveBeenCalledWith(
      expect.objectContaining({
        resultJson: expect.objectContaining({
          reason: 'LOCKED',
          activeOwnerId: 'owner-active',
        }),
      }),
    );
  });

  it('runs current ranking refresh with explicit scheduled equity snapshot flag', async () => {
    const { lockService, rankingRefreshService, runService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'season_ranking_generation:current',
      ownerId: 'owner-ranking',
      expiresAt: new Date('2026-06-08T00:11:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-ranking',
      startedAt,
    });
    rankingRefreshService.refreshCurrentRankingsForActiveSeasons.mockResolvedValueOnce(
      {
        seasonsProcessed: 1,
      },
    );
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.season_ranking_generation,
      }),
    });

    await service.runSeasonRankingGenerationJob({
      trigger: OpsJobTrigger.scheduler,
      now: '2026-06-08T00:05:00.000Z',
      createEquitySnapshots: true,
    });

    expect(
      rankingRefreshService.refreshCurrentRankingsForActiveSeasons,
    ).toHaveBeenCalledWith(new Date('2026-06-08T00:05:00.000Z'), {
      createEquitySnapshots: true,
    });
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'season_ranking_generation:current',
      ownerId: 'owner-ranking',
    });
  });
});
