jest.mock('../generated/prisma/client', () => ({
  BadgeType: {
    tier_badge: 'tier_badge',
    ranker_trophy: 'ranker_trophy',
  },
  OperatorAuditResult: {
    success: 'success',
    failure: 'failure',
  },
  PrismaClient: class PrismaClient {},
  RewardFulfillmentStatus: {
    pending: 'pending',
    processing: 'processing',
    fulfilled: 'fulfilled',
    failed: 'failed',
    canceled: 'canceled',
  },
  SeasonRewardType: {
    internal: 'internal',
    badge: 'badge',
    trophy: 'trophy',
  },
  SeasonStatus: {
    active: 'active',
    upcoming: 'upcoming',
    ended: 'ended',
    settled: 'settled',
  },
  UserRole: {
    user: 'user',
    operator: 'operator',
    admin: 'admin',
  },
  UserStatus: {
    active: 'active',
    suspended: 'suspended',
    deleted: 'deleted',
  },
}));

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  BadgeType,
  OperatorAuditResult,
  RewardFulfillmentStatus,
  SeasonRewardType,
  SeasonStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import { OperatorAuditService } from '../operator/operator-audit.service';
import { RewardFulfillmentService } from './reward-fulfillment.service';

describe('RewardFulfillmentService', () => {
  const now = new Date('2026-06-09T00:00:00.000Z');
  const operatorActor = {
    userId: 'operator-1',
    role: UserRole.operator,
  };
  const adminActor = {
    userId: 'admin-1',
    role: UserRole.admin,
  };
  const userActor = {
    userId: 'user-actor-1',
    role: UserRole.user,
  };

  const createBody = {
    seasonId: 'season-1',
    seasonParticipantId: 'participant-1',
    rewardType: SeasonRewardType.internal,
    rewardCode: 'manual_reward_2026_001',
    rewardName: '시즌 보상',
    rewardValueJson: {
      kind: 'internal',
      note: 'reward policy TBD',
      accessToken: 'must-redact',
    },
    idempotencyKey: 'idem-1',
    reason: 'manual internal reward',
  };

  const fulfillmentRecord = (
    overrides: Partial<{
      id: string;
      seasonId: string;
      seasonParticipantId: string;
      userId: string;
      rewardType: SeasonRewardType;
      rewardCode: string;
      rewardName: string;
      rewardValueJson: unknown;
      status: RewardFulfillmentStatus;
      seasonRewardId: string | null;
      idempotencyKey: string;
      requestHash: string;
      requestedByUserId: string;
      processedByUserId: string | null;
      canceledByUserId: string | null;
      requestedAt: Date;
      processingStartedAt: Date | null;
      fulfilledAt: Date | null;
      failedAt: Date | null;
      canceledAt: Date | null;
      errorCode: string | null;
      errorMessage: string | null;
      createdAt: Date;
      updatedAt: Date;
    }> = {},
  ) => ({
    id: overrides.id ?? 'fulfillment-1',
    seasonId: overrides.seasonId ?? 'season-1',
    seasonParticipantId: overrides.seasonParticipantId ?? 'participant-1',
    userId: overrides.userId ?? 'target-user-1',
    rewardType: overrides.rewardType ?? SeasonRewardType.internal,
    rewardCode: overrides.rewardCode ?? 'manual_reward_2026_001',
    rewardName: overrides.rewardName ?? '시즌 보상',
    rewardValueJson:
      overrides.rewardValueJson === undefined
        ? { kind: 'internal', note: 'reward policy TBD' }
        : overrides.rewardValueJson,
    status: overrides.status ?? RewardFulfillmentStatus.pending,
    seasonRewardId: overrides.seasonRewardId ?? null,
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    requestHash: overrides.requestHash ?? 'hash-1',
    requestedByUserId: overrides.requestedByUserId ?? operatorActor.userId,
    processedByUserId: overrides.processedByUserId ?? null,
    canceledByUserId: overrides.canceledByUserId ?? null,
    requestedAt: overrides.requestedAt ?? now,
    processingStartedAt: overrides.processingStartedAt ?? null,
    fulfilledAt: overrides.fulfilledAt ?? null,
    failedAt: overrides.failedAt ?? null,
    canceledAt: overrides.canceledAt ?? null,
    errorCode: overrides.errorCode ?? null,
    errorMessage: overrides.errorMessage ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  });

  const createService = () => {
    const prisma = {
      rewardFulfillmentRequest: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      season: {
        findUnique: jest.fn(),
      },
      seasonParticipant: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      seasonReward: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      badge: {
        upsert: jest.fn(),
      },
      userBadge: {
        upsert: jest.fn(),
      },
      operatorAuditLog: {
        create: jest.fn().mockResolvedValue({
          id: 'audit-1',
          createdAt: now,
        }),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation((callback) => callback(prisma));
    const auditService = new OperatorAuditService(prisma as never);
    const service = new RewardFulfillmentService(
      prisma as never,
      auditService,
    );

    return { prisma, service };
  };

  const mockCreatePreconditions = (
    prisma: ReturnType<typeof createService>['prisma'],
    options: {
      seasonStatus?: SeasonStatus;
      userStatus?: UserStatus;
      participantSeasonId?: string;
      existingRequest?: unknown;
      existingReward?: unknown;
    } = {},
  ) => {
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(null);
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: options.seasonStatus ?? SeasonStatus.settled,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
      seasonId: options.participantSeasonId ?? 'season-1',
      userId: 'target-user-1',
      user: {
        id: 'target-user-1',
        status: options.userStatus ?? UserStatus.active,
      },
    });
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      options.existingRequest ?? null,
    );
    prisma.seasonReward.findUnique.mockResolvedValueOnce(
      options.existingReward ?? null,
    );
  };

  const expectHttpError = async (
    promise: Promise<unknown>,
    status: HttpStatus,
    code: string,
  ) => {
    try {
      await promise;
      throw new Error('Expected request to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(status);
      expect(httpError.getResponse()).toMatchObject({
        success: false,
        error: {
          code,
        },
      });
    }
  };

  it.each([
    ['operator', operatorActor],
    ['admin', adminActor],
  ])('creates pending fulfillment as %s and redacts rewardValueJson secrets', async (_label, actor) => {
    const { prisma, service } = createService();
    mockCreatePreconditions(prisma);
    prisma.rewardFulfillmentRequest.create.mockResolvedValueOnce(
      fulfillmentRecord({
        requestedByUserId: actor.userId,
        rewardValueJson: {
          kind: 'internal',
          note: 'reward policy TBD',
          accessToken: '[REDACTED]',
        },
      }),
    );

    const response = await service.createFulfillment(actor, createBody, {
      requestId: 'request-1',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        fulfillment: {
          id: 'fulfillment-1',
          status: RewardFulfillmentStatus.pending,
          rewardType: SeasonRewardType.internal,
          rewardCode: 'manual_reward_2026_001',
          seasonRewardId: null,
        },
        replayed: false,
      },
    });
    expect(prisma.rewardFulfillmentRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seasonId: 'season-1',
          seasonParticipantId: 'participant-1',
          userId: 'target-user-1',
          rewardType: SeasonRewardType.internal,
          idempotencyKey: 'idem-1',
          requestHash: expect.any(String),
          rewardValueJson: expect.objectContaining({
            accessToken: '[REDACTED]',
          }),
        }),
      }),
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.create',
          result: OperatorAuditResult.success,
          metadataJson: expect.objectContaining({
            rewardValueJson: expect.objectContaining({
              accessToken: '[REDACTED]',
            }),
          }),
        }),
      }),
    );
    expect(JSON.stringify(prisma.operatorAuditLog.create.mock.calls)).not.toMatch(
      /must-redact|passwordHash|refreshToken|accessToken":"must/i,
    );
  });

  it('rejects user create access and invalid create body with failure audit', async () => {
    const { prisma, service } = createService();

    await expectHttpError(
      service.createFulfillment(userActor, createBody),
      HttpStatus.FORBIDDEN,
      'OPERATOR_REQUIRED',
    );
    expect(prisma.rewardFulfillmentRequest.create).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.create.failed',
          errorCode: 'OPERATOR_REQUIRED',
        }),
      }),
    );

    await expectHttpError(
      service.createFulfillment(operatorActor, {
        ...createBody,
        rewardType: 'cash',
      }),
      HttpStatus.BAD_REQUEST,
      'INVALID_REWARD_TYPE',
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.create.failed',
          errorCode: 'INVALID_REWARD_TYPE',
        }),
      }),
    );
  });

  it('rejects season/participant/target validation failures on create', async () => {
    const expectCreateFailure = async (
      options: Parameters<typeof mockCreatePreconditions>[1],
      code: string,
    ) => {
      const { prisma, service } = createService();
      mockCreatePreconditions(prisma, options);

      await expectHttpError(
        service.createFulfillment(operatorActor, createBody),
        HttpStatus.CONFLICT,
        code,
      );
    };

    await expectCreateFailure(
      { seasonStatus: SeasonStatus.active },
      'SEASON_NOT_SETTLED',
    );
    await expectCreateFailure(
      { participantSeasonId: 'other-season' },
      'SEASON_PARTICIPANT_MISMATCH',
    );
    await expectCreateFailure(
      { userStatus: UserStatus.suspended },
      'TARGET_USER_NOT_ACTIVE',
    );
  });

  it('replays same actor idempotency and conflicts on changed request hash', async () => {
    const { prisma, service } = createService();
    mockCreatePreconditions(prisma);
    const created = fulfillmentRecord();
    prisma.rewardFulfillmentRequest.create.mockResolvedValueOnce(created);
    const first = await service.createFulfillment(operatorActor, createBody);
    const createdHash =
      prisma.rewardFulfillmentRequest.create.mock.calls[0][0].data.requestHash;

    expect(first.data.replayed).toBe(false);

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ requestHash: createdHash }),
    );
    const replay = await service.createFulfillment(operatorActor, createBody);
    expect(replay.data.replayed).toBe(true);
    expect(prisma.rewardFulfillmentRequest.create).toHaveBeenCalledTimes(1);

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ requestHash: 'different-hash' }),
    );
    await expectHttpError(
      service.createFulfillment(operatorActor, createBody),
      HttpStatus.CONFLICT,
      'REWARD_FULFILLMENT_IDEMPOTENCY_CONFLICT',
    );
  });

  it('blocks duplicate seasonParticipantId + rewardCode requests and existing rewards', async () => {
    const { prisma, service } = createService();
    mockCreatePreconditions(prisma, {
      existingRequest: { id: 'existing-request' },
    });

    await expectHttpError(
      service.createFulfillment(operatorActor, createBody),
      HttpStatus.CONFLICT,
      'REWARD_FULFILLMENT_DUPLICATE',
    );

    mockCreatePreconditions(prisma, {
      existingReward: { id: 'existing-season-reward' },
    });
    await expectHttpError(
      service.createFulfillment(operatorActor, createBody),
      HttpStatus.CONFLICT,
      'REWARD_FULFILLMENT_DUPLICATE',
    );
  });

  it.each([
    RewardFulfillmentStatus.pending,
    RewardFulfillmentStatus.failed,
  ])('fulfills %s request and creates SeasonReward once', async (status) => {
    const { prisma, service } = createService();
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ status }),
    );
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.settled,
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'target-user-1',
      status: UserStatus.active,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
      seasonId: 'season-1',
      userId: 'target-user-1',
    });
    prisma.seasonReward.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    prisma.rewardFulfillmentRequest.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    prisma.seasonReward.create.mockResolvedValueOnce({
      id: 'season-reward-1',
    });
    prisma.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.rewardFulfillmentRequest.update.mockResolvedValueOnce(
      fulfillmentRecord({
        status: RewardFulfillmentStatus.fulfilled,
        seasonRewardId: 'season-reward-1',
        fulfilledAt: new Date('2026-06-09T00:01:00.000Z'),
        processedByUserId: operatorActor.userId,
      }),
    );

    const response = await service.fulfill(operatorActor, 'fulfillment-1', {
      reason: 'grant now',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        fulfillment: {
          status: RewardFulfillmentStatus.fulfilled,
          seasonRewardId: 'season-reward-1',
        },
        replayed: false,
      },
    });
    expect(prisma.rewardFulfillmentRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'fulfillment-1',
          status: {
            in: [
              RewardFulfillmentStatus.pending,
              RewardFulfillmentStatus.failed,
            ],
          },
        },
        data: expect.objectContaining({
          status: RewardFulfillmentStatus.processing,
          processedByUserId: operatorActor.userId,
        }),
      }),
    );
    expect(prisma.seasonReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          seasonParticipantId: 'participant-1',
          rewardCode: 'manual_reward_2026_001',
          fulfillmentRequestId: 'fulfillment-1',
        }),
      }),
    );
    expect(prisma.seasonParticipant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'participant-1',
        rewardGrantedAt: null,
      },
      data: {
        rewardGrantedAt: expect.any(Date),
      },
    });
    expect(prisma.badge.upsert).not.toHaveBeenCalled();
    expect(prisma.userBadge.upsert).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.fulfill',
          result: OperatorAuditResult.success,
        }),
      }),
    );
  });

  it('fulfills badge rewards by creating SeasonReward and UserBadge atomically', async () => {
    const { prisma, service } = createService();
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({
        rewardType: SeasonRewardType.badge,
        rewardCode: 'TIER_GOLD',
        rewardName: 'Gold Badge',
        rewardValueJson: null,
      }),
    );
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.settled,
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'target-user-1',
      status: UserStatus.active,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
      seasonId: 'season-1',
      userId: 'target-user-1',
    });
    prisma.seasonReward.findUnique.mockResolvedValueOnce(null);
    prisma.rewardFulfillmentRequest.updateMany.mockResolvedValueOnce({
      count: 1,
    });
    prisma.seasonReward.create.mockResolvedValueOnce({
      id: 'season-reward-1',
    });
    prisma.seasonParticipant.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.badge.upsert.mockResolvedValueOnce({
      id: 'badge-gold',
    });
    prisma.userBadge.upsert.mockResolvedValueOnce({
      id: 'user-badge-gold',
    });
    prisma.rewardFulfillmentRequest.update.mockResolvedValueOnce(
      fulfillmentRecord({
        rewardType: SeasonRewardType.badge,
        rewardCode: 'TIER_GOLD',
        rewardName: 'Gold Badge',
        rewardValueJson: null,
        status: RewardFulfillmentStatus.fulfilled,
        seasonRewardId: 'season-reward-1',
        fulfilledAt: new Date('2026-06-09T00:01:00.000Z'),
        processedByUserId: operatorActor.userId,
      }),
    );

    const response = await service.fulfill(operatorActor, 'fulfillment-1', {
      reason: 'grant badge now',
    });

    expect(response.data.fulfillment.status).toBe(
      RewardFulfillmentStatus.fulfilled,
    );
    expect(prisma.seasonReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rewardType: SeasonRewardType.badge,
          rewardCode: 'TIER_GOLD',
          rewardName: 'Gold Badge',
        }),
      }),
    );
    expect(prisma.badge.upsert).toHaveBeenCalledWith({
      where: {
        code: 'TIER_GOLD',
      },
      create: {
        badgeType: BadgeType.tier_badge,
        code: 'TIER_GOLD',
        name: 'Gold Badge',
        description: null,
        iconUrl: null,
      },
      update: {
        badgeType: BadgeType.tier_badge,
        name: 'Gold Badge',
      },
      select: {
        id: true,
      },
    });
    expect(prisma.userBadge.upsert).toHaveBeenCalledWith({
      where: {
        userId_badgeId_seasonId: {
          userId: 'target-user-1',
          badgeId: 'badge-gold',
          seasonId: 'season-1',
        },
      },
      create: {
        userId: 'target-user-1',
        badgeId: 'badge-gold',
        seasonId: 'season-1',
        awardedAt: expect.any(Date),
      },
      update: {
        awardedAt: expect.any(Date),
      },
      select: {
        id: true,
      },
    });
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: expect.objectContaining({
            userBadgeId: 'user-badge-gold',
          }),
        }),
      }),
    );
  });

  it('marks request failed when fulfill target user is inactive', async () => {
    const { prisma, service } = createService();
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord(),
    );
    prisma.season.findUnique.mockResolvedValueOnce({
      id: 'season-1',
      status: SeasonStatus.settled,
    });
    prisma.user.findUnique.mockResolvedValueOnce({
      id: 'target-user-1',
      status: UserStatus.deleted,
    });
    prisma.seasonParticipant.findUnique.mockResolvedValueOnce({
      id: 'participant-1',
      seasonId: 'season-1',
      userId: 'target-user-1',
    });
    prisma.seasonReward.findUnique.mockResolvedValueOnce(null);
    prisma.rewardFulfillmentRequest.update.mockResolvedValueOnce({
      id: 'fulfillment-1',
    });

    await expectHttpError(
      service.fulfill(operatorActor, 'fulfillment-1'),
      HttpStatus.CONFLICT,
      'TARGET_USER_NOT_ACTIVE',
    );

    expect(prisma.rewardFulfillmentRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'fulfillment-1',
        },
        data: expect.objectContaining({
          status: RewardFulfillmentStatus.failed,
          errorCode: 'TARGET_USER_NOT_ACTIVE',
        }),
      }),
    );
    expect(prisma.seasonReward.create).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.fulfill.failed',
          errorCode: 'TARGET_USER_NOT_ACTIVE',
        }),
      }),
    );
  });

  it('replays fulfilled fulfill, rejects canceled fulfill, and enforces cancel status rules', async () => {
    const { prisma, service } = createService();
    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({
        status: RewardFulfillmentStatus.fulfilled,
        seasonRewardId: 'season-reward-1',
      }),
    );
    const replay = await service.fulfill(operatorActor, 'fulfillment-1');
    expect(replay.data.replayed).toBe(true);

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ status: RewardFulfillmentStatus.canceled }),
    );
    await expectHttpError(
      service.fulfill(operatorActor, 'fulfillment-1'),
      HttpStatus.CONFLICT,
      'REWARD_FULFILLMENT_INVALID_STATUS',
    );

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ status: RewardFulfillmentStatus.pending }),
    );
    prisma.rewardFulfillmentRequest.update.mockResolvedValueOnce(
      fulfillmentRecord({
        status: RewardFulfillmentStatus.canceled,
        canceledAt: new Date('2026-06-09T00:02:00.000Z'),
        canceledByUserId: operatorActor.userId,
      }),
    );
    const canceled = await service.cancel(operatorActor, 'fulfillment-1', {
      reason: 'operator cancel',
    });
    expect(canceled.data.fulfillment.status).toBe(
      RewardFulfillmentStatus.canceled,
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.reward_fulfillment.cancel',
          result: OperatorAuditResult.success,
        }),
      }),
    );

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord({ status: RewardFulfillmentStatus.processing }),
    );
    await expectHttpError(
      service.cancel(operatorActor, 'fulfillment-1'),
      HttpStatus.CONFLICT,
      'REWARD_FULFILLMENT_INVALID_STATUS',
    );
  });

  it('lists and gets fulfillments for operator/admin only', async () => {
    const { prisma, service } = createService();
    prisma.rewardFulfillmentRequest.count.mockResolvedValueOnce(1);
    prisma.rewardFulfillmentRequest.findMany.mockResolvedValueOnce([
      fulfillmentRecord(),
    ]);

    const list = await service.listFulfillments(adminActor, {
      status: RewardFulfillmentStatus.pending,
      limit: '200',
      offset: '3',
    });

    expect(list.data.pagination).toMatchObject({
      limit: 100,
      offset: 3,
      total: 1,
      returned: 1,
      nextOffset: null,
    });
    expect(prisma.rewardFulfillmentRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: RewardFulfillmentStatus.pending,
        },
      }),
    );

    prisma.rewardFulfillmentRequest.findUnique.mockResolvedValueOnce(
      fulfillmentRecord(),
    );
    const get = await service.getFulfillment(operatorActor, 'fulfillment-1');
    expect(get.data.fulfillment.id).toBe('fulfillment-1');

    await expectHttpError(
      service.listFulfillments(userActor),
      HttpStatus.FORBIDDEN,
      'OPERATOR_REQUIRED',
    );
  });
});
