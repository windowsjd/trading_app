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
import { ProviderHttpClient } from '../providers/provider-http.client';

describe('OpsJobRunService', () => {
  it('stores an unknown background code through the safe boundary without raw DB/financial text', async () => {
    const { prisma, service } = createService();
    await service.recordFailed({ id: 'run-1', startedAt } as never, {
      errorCode: 'NEW_SYNTHETIC_BACKGROUND_ERROR',
      errorMessage:
        'SELECT wallet_balance postgres://fake:fake@db.invalid/db 987654.12345678',
      resultJson: {
        message: 'raw Provider https://provider.invalid/body 987654.12345678',
        exception: new Error('Authorization Bearer fake-token'),
        accountId: 'account-1',
        count: 3,
      },
    });
    const data = prisma.opsJobRun.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      errorCode: 'NEW_SYNTHETIC_BACKGROUND_ERROR',
      errorMessage: 'Background operation failed.',
      resultJson: {
        message: 'Background operation failed.',
        accountId: 'account-1',
        count: 3,
      },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /SELECT|db.invalid|provider.invalid|987654|fake-token|diagnostic/,
    );
  });
  afterEach(() => jest.restoreAllMocks());
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

  it('persists safe provider failures and redacts free-form and structured metadata', async () => {
    const { prisma, service } = createService();
    const text = jest.fn().mockResolvedValue('unlabeled-synthetic-body');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 503,
      text,
    } as unknown as Response);
    const error = (await new ProviderHttpClient()
      .getJson('https://synthetic-private.test?authkey=fake-key', {
        provider: 'exchange_rate_api',
        timeoutMs: 1000,
      })
      .catch((failure: unknown) => failure)) as {
      code: string;
      message: string;
    };
    const run = { id: 'run-safe', startedAt: new Date() };
    await service.recordFailed(run as never, {
      errorCode: error.code,
      errorMessage: error.message,
      resultJson: {
        provider: 'exchange_rate_api',
        errorMessage: error.message,
        privateKey: 'synthetic-private-key',
        rawPayload: 'synthetic-payload',
        note: '{"refreshToken":"synthetic-token"}',
      },
    });
    const data = prisma.opsJobRun.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      errorCode: 'PROVIDER_HTTP_ERROR',
      errorMessage: 'exchange_rate_api HTTP 503 (PROVIDER_HTTP_ERROR).',
      resultJson: { privateKey: '[REDACTED]', rawPayload: '[REDACTED]' },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /unlabeled-synthetic-body|synthetic-private|synthetic-payload|synthetic-token|fake-key/,
    );
    await service.recordFailed(run as never, {
      errorCode: 'OPS_JOB_FAILED',
      errorMessage: 'Error: {"apiKey":"synthetic-text-secret"}',
    });
    expect(JSON.stringify(prisma.opsJobRun.update.mock.calls)).not.toContain(
      'synthetic-text-secret',
    );
    expect(text).not.toHaveBeenCalled();
  });

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
