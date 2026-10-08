jest.mock('../generated/prisma/client', () => ({
  BatchJobStatus: {
    pending: 'pending',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
  },
  Prisma: {
    JsonNull: null,
  },
  PrismaClient: class PrismaClient {},
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import { BatchJobStatus } from '../generated/prisma/client';
import { BatchService } from './batch.service';
import { ProviderHttpClient } from '../providers/provider-http.client';

type PrismaMock = {
  batchJobRun: {
    create: jest.Mock;
    update: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  asset: { create: jest.Mock };
  assetPriceSnapshot: { create: jest.Mock };
  cashWallet: { create: jest.Mock; update: jest.Mock };
  exchangeTransaction: { create: jest.Mock };
  fxRateSnapshot: { create: jest.Mock };
  order: { create: jest.Mock; update: jest.Mock };
  position: { create: jest.Mock; update: jest.Mock };
  walletTransaction: { create: jest.Mock };
  dailyPortfolioSnapshot: { create: jest.Mock; upsert: jest.Mock };
  seasonRanking: { create: jest.Mock; createMany: jest.Mock };
};

describe('BatchService', () => {
  let prisma: PrismaMock;
  let service: BatchService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new BatchService(prisma as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('separates successful preview metadata from failed result message projection', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockImplementation(async ({ data }) =>
      makeRun(data),
    );
    const message = 'Batch operation would run when dryRun is false.';
    await service.runJob({
      jobName: 'preview',
      idempotencyKey: 'preview-key',
      dryRun: true,
      handler: () => ({ message, count: 3 }),
    });
    expect(
      prisma.batchJobRun.update.mock.calls[0][0].data.resultPayloadJson,
    ).toEqual({ message, count: 3 });

    await expect(
      service.runJob({
        jobName: 'failed',
        idempotencyKey: 'failed-key',
        handler: () => {
          throw new HttpException(
            {
              success: false,
              error: { code: 'DECLARED_BATCH_FAILURE', message: 'Job failed.' },
              data: {
                resultPayloadJson: {
                  message:
                    'raw Provider https://provider.invalid/body 987654.12345678',
                  errors: [
                    'https://provider.invalid/private SELECT wallet_balance 987654.12345678',
                  ],
                  failures: [
                    { details: ['SELECT wallet_balance 987654.12345678'] },
                  ],
                  count: 3,
                },
              },
            },
            503,
          );
        },
      }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.batchJobRun.update.mock.calls[1][0].data).toMatchObject({
      errorCode: 'DECLARED_BATCH_FAILURE',
      resultPayloadJson: {
        message: 'Background operation failed.',
        count: 3,
        errors: ['Background operation failed.'],
        failures: [{ details: ['Background operation failed.'] }],
      },
    });
  });

  it('persists provider category/status without raw body and scrubs request/result/error text', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockImplementation(async ({ data }) =>
      makeRun(data),
    );
    const text = jest
      .fn()
      .mockResolvedValue('unlabeled-synthetic-batch-provider-body');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 502,
      text,
    } as unknown as Response);
    const failure = await service
      .runJob({
        jobName: 'provider-test',
        idempotencyKey: 'safe-key',
        requestPayload: { apiKey: 'synthetic-request-secret' },
        handler: () =>
          new ProviderHttpClient().getJson(
            'https://synthetic-private.test?key=fake-key',
            { provider: 'binance', timeoutMs: 1000 },
          ),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HttpException);
    expect(prisma.batchJobRun.update.mock.calls[0][0].data).toMatchObject({
      errorCode: 'PROVIDER_HTTP_ERROR',
      errorMessage: 'binance HTTP 502 (PROVIDER_HTTP_ERROR).',
    });
    expect(JSON.stringify(prisma.batchJobRun.create.mock.calls)).not.toContain(
      'synthetic-request-secret',
    );
    expect(JSON.stringify(prisma.batchJobRun.update.mock.calls)).not.toMatch(
      /unlabeled-synthetic|synthetic-private|fake-key/,
    );
    expect(
      JSON.stringify((failure as HttpException).getResponse()),
    ).not.toMatch(/unlabeled-synthetic|synthetic-private|fake-key/);

    await service.runJob({
      jobName: 'safe-result',
      idempotencyKey: 'safe-result-key',
      handler: () => ({
        rawPayload: 'synthetic-payload',
        note: '{"privateKey":"synthetic-text-secret"}',
        count: 1,
      }),
    });
    expect(
      prisma.batchJobRun.update.mock.calls[1][0].data.resultPayloadJson,
    ).toMatchObject({ rawPayload: '[REDACTED]', count: 1 });
    await service
      .runJob({
        jobName: 'safe-error',
        idempotencyKey: 'safe-error-key',
        handler: () => {
          throw new Error('Error: apiKey=synthetic-error-secret');
        },
      })
      .catch(() => {});
    expect(JSON.stringify(prisma.batchJobRun.update.mock.calls)).not.toMatch(
      /synthetic-payload|synthetic-text-secret|synthetic-error-secret/,
    );
    expect(text).not.toHaveBeenCalled();
  });

  it('creates a BatchJobRun and marks it succeeded with handler result', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.running,
        dryRun: true,
        requestPayloadJson: { input: true },
      }),
    );
    prisma.batchJobRun.update.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.succeeded,
        dryRun: true,
        requestPayloadJson: { input: true },
        resultPayloadJson: { ok: true },
        finishedAt: new Date('2026-05-19T00:00:01.000Z'),
      }),
    );
    const handler = jest.fn().mockResolvedValue({ ok: true });

    const response = await service.runJob({
      jobName: 'noop',
      idempotencyKey: 'noop:2026-05-19',
      dryRun: true,
      requestedBy: 'operator',
      requestPayload: { input: true },
      handler,
    });

    expect(prisma.batchJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        jobName: 'noop',
        idempotencyKey: 'noop:2026-05-19',
        status: BatchJobStatus.running,
        dryRun: true,
        requestedBy: 'operator',
        requestPayloadJson: { input: true },
      }),
    });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        jobName: 'noop',
        idempotencyKey: 'noop:2026-05-19',
        dryRun: true,
      }),
    );
    expect(prisma.batchJobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: BatchJobStatus.succeeded,
        resultPayloadJson: { ok: true },
      }),
    });
    expect(response).toMatchObject({
      success: true,
      data: {
        deduplicated: false,
        skipped: false,
        run: {
          status: BatchJobStatus.succeeded,
          dryRun: true,
          requestPayloadJson: { input: true },
          resultPayloadJson: { ok: true },
        },
      },
    });
  });

  it('marks the run failed and stores error code/message when handler fails', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.failed,
        errorCode: 'BATCH_JOB_FAILED',
        errorMessage: 'Background operation failed.',
        finishedAt: new Date('2026-05-19T00:00:01.000Z'),
      }),
    );
    const error = Object.assign(new Error('boom'), { code: 'NOOP_FAILED' });

    await expect(
      service.runJob({
        jobName: 'noop',
        idempotencyKey: 'noop:error',
        handler: () => {
          throw error;
        },
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    });

    expect(prisma.batchJobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: BatchJobStatus.failed,
        errorCode: 'BATCH_JOB_FAILED',
        errorMessage: 'Background operation failed.',
        resultPayloadJson: {
          failure: {
            code: 'BATCH_JOB_FAILED',
            message: 'Background operation failed.',
            safeCause: { category: 'unexpected_error', errorType: 'Error' },
          },
        },
      }),
    });
  });

  it('preserves handler HttpException status/code while storing failed run details', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.failed,
        errorCode: 'BAD_REQUEST',
        errorMessage: 'snapshotDate must be YYYY-MM-DD.',
        finishedAt: new Date('2026-05-19T00:00:01.000Z'),
      }),
    );

    const error = new HttpException(
      {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: 'snapshotDate must be YYYY-MM-DD.',
        },
      },
      HttpStatus.BAD_REQUEST,
    );

    await expect(
      service.runJob({
        jobName: 'daily-portfolio-snapshot',
        idempotencyKey: 'daily-portfolio-snapshot:season-1:bad-date',
        handler: () => {
          throw error;
        },
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });

    expect(prisma.batchJobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: BatchJobStatus.failed,
        errorCode: 'BAD_REQUEST',
        errorMessage: 'snapshotDate must be YYYY-MM-DD.',
      }),
    });
  });

  it('stores resultPayloadJson for failed runs when the handler provides a failure summary', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.failed,
        errorCode: 'DAILY_SEASON_CYCLE_FAILED',
        errorMessage: 'Daily season cycle failed.',
        resultPayloadJson: { step: 'dailyPortfolioSnapshot' },
        finishedAt: new Date('2026-05-19T00:00:01.000Z'),
      }),
    );

    const error = new HttpException(
      {
        success: false,
        error: {
          code: 'DAILY_SEASON_CYCLE_FAILED',
          message: 'Daily season cycle failed.',
        },
        data: {
          resultPayloadJson: {
            step: 'dailyPortfolioSnapshot',
          },
        },
      },
      HttpStatus.BAD_REQUEST,
    );

    await expect(
      service.runJob({
        jobName: 'daily-season-cycle',
        idempotencyKey: 'daily-season-cycle:season-1:2026-05-21',
        handler: () => {
          throw error;
        },
      }),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });

    expect(prisma.batchJobRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: expect.objectContaining({
        status: BatchJobStatus.failed,
        errorCode: 'DAILY_SEASON_CYCLE_FAILED',
        errorMessage: 'Daily season cycle failed.',
        resultPayloadJson: {
          step: 'dailyPortfolioSnapshot',
        },
      }),
    });
  });

  it('returns an already succeeded run without executing the handler again', async () => {
    prisma.batchJobRun.create.mockRejectedValue({ code: 'P2002' });
    prisma.batchJobRun.findUnique.mockResolvedValue(
      makeRun({
        status: BatchJobStatus.succeeded,
        resultPayloadJson: { ok: true },
      }),
    );
    const handler = jest.fn();

    const response = await service.runJob({
      jobName: 'noop',
      idempotencyKey: 'noop:dedupe',
      handler,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(response.data.deduplicated).toBe(true);
    expect(response.data.skipped).toBe(true);
    expect(response.data.run.status).toBe(BatchJobStatus.succeeded);
  });

  it('blocks duplicate running jobs', async () => {
    prisma.batchJobRun.create.mockRejectedValue({ code: 'P2002' });
    prisma.batchJobRun.findUnique.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );

    await expectDuplicateError('BATCH_JOB_ALREADY_RUNNING');
  });

  it('requires a new idempotencyKey for failed job retry', async () => {
    prisma.batchJobRun.create.mockRejectedValue({ code: 'P2002' });
    prisma.batchJobRun.findUnique.mockResolvedValue(
      makeRun({ status: BatchJobStatus.failed }),
    );

    await expectDuplicateError('BATCH_JOB_RETRY_REQUIRES_NEW_IDEMPOTENCY_KEY');
  });

  it('rejects invalid list query values', async () => {
    await expect(service.listJobRuns({ status: 'done' })).rejects.toMatchObject(
      {
        status: HttpStatus.BAD_REQUEST,
      },
    );
  });

  it('clamps list limit to 100 and applies jobName/status filters', async () => {
    prisma.batchJobRun.count.mockResolvedValue(1);
    prisma.batchJobRun.findMany.mockResolvedValue([
      makeRun({ status: BatchJobStatus.succeeded }),
    ]);

    const response = await service.listJobRuns({
      jobName: 'noop',
      status: BatchJobStatus.succeeded,
      limit: '500',
      offset: '2',
    });

    expect(prisma.batchJobRun.count).toHaveBeenCalledWith({
      where: {
        jobName: 'noop',
        status: BatchJobStatus.succeeded,
      },
    });
    expect(prisma.batchJobRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobName: 'noop',
          status: BatchJobStatus.succeeded,
        },
        take: 100,
        skip: 2,
      }),
    );
    expect(response.data.pagination).toEqual({
      limit: 100,
      offset: 2,
      total: 1,
      returned: 1,
      nextOffset: null,
    });
  });

  it('returns BATCH_JOB_RUN_NOT_FOUND when getJobRun cannot find a run', async () => {
    prisma.batchJobRun.findUnique.mockResolvedValue(null);

    await expect(service.getJobRun('missing')).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
  });

  it('does not directly create provider/trading business rows', async () => {
    prisma.batchJobRun.create.mockResolvedValue(
      makeRun({ status: BatchJobStatus.running }),
    );
    prisma.batchJobRun.update.mockResolvedValue(
      makeRun({ status: BatchJobStatus.succeeded }),
    );

    await service.runJob({
      jobName: 'noop',
      idempotencyKey: 'noop:no-business-writes',
      handler: () => ({ ok: true }),
    });

    expect(prisma.asset.create).not.toHaveBeenCalled();
    expect(prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.create).not.toHaveBeenCalled();
    expect(prisma.cashWallet.update).not.toHaveBeenCalled();
    expect(prisma.exchangeTransaction.create).not.toHaveBeenCalled();
    expect(prisma.fxRateSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.position.create).not.toHaveBeenCalled();
    expect(prisma.position.update).not.toHaveBeenCalled();
    expect(prisma.walletTransaction.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.dailyPortfolioSnapshot.upsert).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.create).not.toHaveBeenCalled();
    expect(prisma.seasonRanking.createMany).not.toHaveBeenCalled();
  });

  async function expectDuplicateError(code: string) {
    try {
      await service.runJob({
        jobName: 'noop',
        idempotencyKey: 'noop:duplicate',
        handler: jest.fn(),
      });
      throw new Error('Expected duplicate error.');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: {
          code,
        },
      });
    }
  }
});

function createPrismaMock(): PrismaMock {
  return {
    batchJobRun: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    asset: { create: jest.fn() },
    assetPriceSnapshot: { create: jest.fn() },
    cashWallet: { create: jest.fn(), update: jest.fn() },
    exchangeTransaction: { create: jest.fn() },
    fxRateSnapshot: { create: jest.fn() },
    order: { create: jest.fn(), update: jest.fn() },
    position: { create: jest.fn(), update: jest.fn() },
    walletTransaction: { create: jest.fn() },
    dailyPortfolioSnapshot: { create: jest.fn(), upsert: jest.fn() },
    seasonRanking: { create: jest.fn(), createMany: jest.fn() },
  };
}

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date('2026-05-19T00:00:00.000Z');

  return {
    id: 'run-1',
    jobName: 'noop',
    idempotencyKey: 'noop:2026-05-19',
    status: BatchJobStatus.running,
    dryRun: false,
    startedAt: now,
    finishedAt: null,
    requestedBy: null,
    requestPayloadJson: null,
    resultPayloadJson: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
