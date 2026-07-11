jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    provider_kis_ingest: 'provider_kis_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
    market_candle_retention: 'market_candle_retention',
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
  Prisma: {
    JsonNull: null,
  },
}));

import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
} from '../generated/prisma/client';
import { OpsJobRunService } from './ops-job-run.service';

describe('OpsJobRunService', () => {
  const startedAt = new Date('2026-06-08T00:00:00.000Z');
  const finishedAt = new Date('2026-06-08T00:00:02.500Z');

  const createPrisma = () => ({
    opsJobRun: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
  });

  const createService = () => {
    const prisma = createPrisma();

    return {
      prisma,
      service: new OpsJobRunService(prisma as never),
    };
  };

  it('creates a running run with redacted metadata', async () => {
    const { prisma, service } = createService();
    prisma.opsJobRun.create.mockResolvedValueOnce({ id: 'run-1' });

    await service.createRunning({
      jobName: OpsJobName.daily_portfolio_snapshot,
      trigger: OpsJobTrigger.test,
      requestedBy: ' operator-1 ',
      startedAt,
      lockKey: 'lock-1',
      dryRun: true,
      metadataJson: {
        rawPayloadJson: {
          secret: 'value',
        },
        note: 'safe',
      },
    });

    expect(prisma.opsJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: OpsJobName.daily_portfolio_snapshot,
        status: OpsJobRunStatus.running,
        trigger: OpsJobTrigger.test,
        requestedBy: 'operator-1',
        startedAt,
        lockKey: 'lock-1',
        dryRun: true,
        metadataJson: {
          rawPayloadJson: '[REDACTED]',
          note: 'safe',
        },
      }),
    });
  });

  it('records succeeded run duration and redacted result', async () => {
    const { prisma, service } = createService();
    prisma.opsJobRun.update.mockResolvedValueOnce({ id: 'run-1' });

    await service.recordSucceeded(
      {
        id: 'run-1',
        startedAt,
      },
      {
        finishedAt,
        resultJson: {
          sourceSummary: {
            providerApiUsed: true,
          },
          accessToken: 'secret-token',
        },
      },
    );

    expect(prisma.opsJobRun.update).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
      },
      data: expect.objectContaining({
        status: OpsJobRunStatus.succeeded,
        finishedAt,
        durationMs: 2500,
        resultJson: {
          sourceSummary: {
            providerApiUsed: true,
          },
          accessToken: '[REDACTED]',
        },
      }),
    });
  });

  it('records failed and locked terminal runs', async () => {
    const { prisma, service } = createService();
    prisma.opsJobRun.update.mockResolvedValueOnce({ id: 'failed-run' });
    prisma.opsJobRun.create.mockResolvedValueOnce({ id: 'locked-run' });

    await service.recordFailed(
      {
        id: 'run-1',
        startedAt,
      },
      {
        finishedAt,
        errorCode: 'BOOM',
        errorMessage: 'Job failed.',
      },
    );
    await service.recordLocked({
      jobName: OpsJobName.daily_portfolio_snapshot,
      trigger: OpsJobTrigger.test,
      startedAt,
      lockKey: 'lock-1',
      resultJson: {
        reason: 'LOCKED',
      },
    });

    expect(prisma.opsJobRun.update).toHaveBeenCalledWith({
      where: {
        id: 'run-1',
      },
      data: expect.objectContaining({
        status: OpsJobRunStatus.failed,
        errorCode: 'BOOM',
        errorMessage: 'Job failed.',
      }),
    });
    expect(prisma.opsJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: OpsJobRunStatus.locked,
        finishedAt: startedAt,
        durationMs: 0,
        resultJson: {
          reason: 'LOCKED',
        },
      }),
    });
  });

  it('finds only successful non-dry-run history for scheduler due checks', async () => {
    const { prisma, service } = createService();
    prisma.opsJobRun.findFirst.mockResolvedValueOnce(null);
    await service.findLatestSucceededRunForJob(
      OpsJobName.market_candle_retention,
    );
    expect(prisma.opsJobRun.findFirst).toHaveBeenCalledWith({
      where: {
        jobName: OpsJobName.market_candle_retention,
        status: OpsJobRunStatus.succeeded,
        dryRun: false,
      },
      orderBy: [{ finishedAt: 'desc' }, { startedAt: 'desc' }],
      select: {
        jobName: true,
        status: true,
        startedAt: true,
        finishedAt: true,
      },
    });
  });
});
