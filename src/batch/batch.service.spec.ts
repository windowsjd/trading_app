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
        errorCode: 'NOOP_FAILED',
        errorMessage: 'boom',
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
        errorCode: 'NOOP_FAILED',
        errorMessage: 'boom',
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

    await expectDuplicateError(
      'BATCH_JOB_RETRY_REQUIRES_NEW_IDEMPOTENCY_KEY',
    );
  });

  it('rejects invalid list query values', async () => {
    await expect(service.listJobRuns({ status: 'done' })).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
    });
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
