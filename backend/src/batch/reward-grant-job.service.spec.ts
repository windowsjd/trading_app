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
import { RewardGrantJobService } from './reward-grant-job.service';
import {
  REWARD_GRANT_JOB_NAME,
  REWARD_POLICY_GATE_CLOSED,
  REWARD_POLICY_GATE_CLOSED_MESSAGE,
} from './reward-grant-job.types';

type BatchServiceMock = {
  runJob: jest.Mock;
};

const BATCH_STARTED_AT = new Date('2026-05-22T01:02:03.000Z');

describe('RewardGrantJobService', () => {
  it('uses BatchService.runJob with the fixed jobName and generated idempotencyKey', async () => {
    const { service, batchService } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        dryRun: true,
        requestedBy: 'operator',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: REWARD_GRANT_JOB_NAME,
        idempotencyKey: 'reward-grant:season-1',
        dryRun: true,
        requestedBy: 'operator',
        requestPayload: {
          seasonId: 'season-1',
          grantDate: null,
          dryRun: true,
          requestedBy: 'operator',
          idempotencyKey: 'reward-grant:season-1',
        },
      }),
    );
  });

  it('uses grantDate in the generated idempotencyKey when provided', async () => {
    const { service, batchService } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        grantDate: '2026-05-22',
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'reward-grant:season-1:2026-05-22',
        requestPayload: expect.objectContaining({
          grantDate: '2026-05-22',
          idempotencyKey: 'reward-grant:season-1:2026-05-22',
        }),
      }),
    );
  });

  it('keeps an explicit idempotencyKey when provided', async () => {
    const { service, batchService } = createService();

    await expect(
      service.run({
        seasonId: 'season-1',
        dryRun: true,
        idempotencyKey: 'manual-key',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    expect(batchService.runJob).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'manual-key',
      }),
    );
  });

  it.each([true, false])(
    'returns REWARD_POLICY_GATE_CLOSED for dryRun=%s without reward writes',
    async (dryRun) => {
      const { service, prisma } = createService();
      const response = await captureHttpExceptionResponse(
        service.run({
          seasonId: 'season-1',
          dryRun,
        }),
      );

      expect(response.error).toEqual({
        code: REWARD_POLICY_GATE_CLOSED,
        message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
      });
      expect(response.data.resultPayloadJson).toMatchObject({
        seasonId: 'season-1',
        dryRun,
        reason: REWARD_POLICY_GATE_CLOSED,
        message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
        participants: {
          total: 0,
          eligible: 0,
          wouldGrant: 0,
          granted: 0,
        },
        rewardRows: {
          total: {
            wouldCreate: 0,
            created: 0,
          },
        },
        userBadges: {
          wouldCreate: 0,
          created: 0,
        },
        topGranted: [],
        topRewards: [],
        errors: [
          {
            code: REWARD_POLICY_GATE_CLOSED,
            message: REWARD_POLICY_GATE_CLOSED_MESSAGE,
          },
        ],
      });
      expect(response.data.resultPayloadJson.grantTimestamp).toBe(
        BATCH_STARTED_AT.toISOString(),
      );
      expectNoRewardWrites(prisma);
    },
  );
});

function createService() {
  const prisma = createPrismaMock();
  const batchService = createBatchServiceMock(BATCH_STARTED_AT);
  const service = new RewardGrantJobService(
    batchService as never,
    prisma as never,
  );

  return {
    service,
    prisma,
    batchService,
  };
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
    season: {
      findUnique: jest.fn(),
    },
    seasonParticipant: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    badge: {
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    userBadge: {
      create: jest.fn(),
    },
    seasonReward: {
      create: jest.fn(),
    },
  };
}

function createBatchServiceMock(startedAt: Date): BatchServiceMock {
  return {
    runJob: jest.fn(async (params) =>
      params.handler({
        runId: 'batch-run-1',
        jobName: params.jobName,
        idempotencyKey: params.idempotencyKey,
        dryRun: params.dryRun,
        startedAt,
      }),
    ),
  };
}

async function captureHttpExceptionResponse(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error('Expected promise to reject.');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;
    expect(httpError.getStatus()).toBe(HttpStatus.CONFLICT);

    return httpError.getResponse() as {
      error: {
        code: string;
        message: string;
      };
      data: {
        resultPayloadJson: Record<string, unknown>;
      };
    };
  }
}

function expectNoRewardWrites(prisma: ReturnType<typeof createPrismaMock>) {
  expect(prisma.$queryRaw).not.toHaveBeenCalled();
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.season.findUnique).not.toHaveBeenCalled();
  expect(prisma.seasonParticipant.findMany).not.toHaveBeenCalled();
  expect(prisma.seasonParticipant.updateMany).not.toHaveBeenCalled();
  expect(prisma.badge.create).not.toHaveBeenCalled();
  expect(prisma.badge.update).not.toHaveBeenCalled();
  expect(prisma.badge.upsert).not.toHaveBeenCalled();
  expect(prisma.userBadge.create).not.toHaveBeenCalled();
  expect(prisma.seasonReward.create).not.toHaveBeenCalled();
}
