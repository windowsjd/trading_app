import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  Prisma,
  RewardFulfillmentStatus,
  SeasonRewardType,
  SeasonStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { buildPagination } from '../common/pagination';
import { OperatorAuditService } from '../operator/operator-audit.service';
import type { OperatorRequestContext } from '../operator/operator-account-management.service';
import { hasOperatorRole } from '../operator/operator.guard';
import { PrismaService } from '../prisma/prisma.service';

export type RewardFulfillmentQuery = {
  status?: string;
  seasonId?: string;
  userId?: string;
  seasonParticipantId?: string;
  rewardCode?: string;
  limit?: string;
  offset?: string;
};

export type RewardFulfillmentCreateBody = {
  seasonId?: unknown;
  seasonParticipantId?: unknown;
  rewardType?: unknown;
  rewardCode?: unknown;
  rewardName?: unknown;
  rewardValueJson?: unknown;
  idempotencyKey?: unknown;
  reason?: unknown;
};

export type RewardFulfillmentActionBody = {
  reason?: unknown;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const REDACTED = '[REDACTED]';
const UNSUPPORTED_JSON_VALUE = '[UNSUPPORTED_JSON_VALUE]';
const SENSITIVE_KEY_PATTERNS = [
  'access_token',
  'accesstoken',
  'api_key',
  'apikey',
  'app_key',
  'appkey',
  'app_secret',
  'appsecret',
  'approval_key',
  'approvalkey',
  'authorization',
  'database_url',
  'databaseurl',
  'password',
  'private_key',
  'privatekey',
  'provider_payload',
  'providerpayload',
  'raw_payload',
  'rawpayload',
  'refresh_token',
  'refreshtoken',
  'secret',
  'token',
];

const REWARD_FULFILLMENT_SELECT = {
  id: true,
  seasonId: true,
  seasonParticipantId: true,
  userId: true,
  rewardType: true,
  rewardCode: true,
  rewardName: true,
  rewardValueJson: true,
  status: true,
  seasonRewardId: true,
  idempotencyKey: true,
  requestHash: true,
  requestedByUserId: true,
  processedByUserId: true,
  canceledByUserId: true,
  requestedAt: true,
  processingStartedAt: true,
  fulfilledAt: true,
  failedAt: true,
  canceledAt: true,
  errorCode: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RewardFulfillmentRequestSelect;

type RewardFulfillmentRecord = Prisma.RewardFulfillmentRequestGetPayload<{
  select: typeof REWARD_FULFILLMENT_SELECT;
}>;

type ParsedCreateRequest = {
  seasonId: string;
  seasonParticipantId: string;
  rewardType: SeasonRewardType;
  rewardCode: string;
  rewardName: string;
  rewardValueJson: Prisma.InputJsonValue | null;
  idempotencyKey: string;
  reason: string | null;
  requestHash: string;
};

type RewardFailureAuditInput = {
  actor: AuthenticatedUser;
  action:
    | 'operator.reward_fulfillment.create.failed'
    | 'operator.reward_fulfillment.fulfill.failed'
    | 'operator.reward_fulfillment.cancel.failed';
  fulfillmentId?: string | null;
  seasonId?: string | null;
  seasonParticipantId?: string | null;
  userId?: string | null;
  rewardCode?: string | null;
  reason?: string | null;
  failureCode: string;
  context: OperatorRequestContext;
};

@Injectable()
export class RewardFulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OperatorAuditService,
  ) {}

  async listFulfillments(
    actor: AuthenticatedUser | undefined,
    query: RewardFulfillmentQuery = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const parsed = this.parseListQuery(query);
    const where: Prisma.RewardFulfillmentRequestWhereInput = {
      ...(parsed.status ? { status: parsed.status } : {}),
      ...(parsed.seasonId ? { seasonId: parsed.seasonId } : {}),
      ...(parsed.userId ? { userId: parsed.userId } : {}),
      ...(parsed.seasonParticipantId
        ? { seasonParticipantId: parsed.seasonParticipantId }
        : {}),
      ...(parsed.rewardCode ? { rewardCode: parsed.rewardCode } : {}),
    };
    const total = await this.prisma.rewardFulfillmentRequest.count({ where });
    const items = await this.prisma.rewardFulfillmentRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: parsed.limit,
      skip: parsed.offset,
      select: REWARD_FULFILLMENT_SELECT,
    });

    await this.tryRecordReadSuccess(actor, 'operator.reward_fulfillment.list', {
      ...context,
      metadataJson: {
        filters: {
          status: parsed.status ?? null,
          seasonId: parsed.seasonId ?? null,
          userId: parsed.userId ?? null,
          seasonParticipantId: parsed.seasonParticipantId ?? null,
          rewardCode: parsed.rewardCode ?? null,
          limit: parsed.limit,
          offset: parsed.offset,
        },
        resultCount: items.length,
      },
    });

    return {
      success: true,
      data: {
        items: items.map((item) => this.serializeFulfillment(item)),
        pagination: buildPagination({
          limit: parsed.limit,
          offset: parsed.offset,
          total,
          returned: items.length,
        }),
      },
    };
  }

  async getFulfillment(
    actor: AuthenticatedUser | undefined,
    fulfillmentId: string,
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const id = this.parseRequiredText(
      fulfillmentId,
      'REWARD_FULFILLMENT_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'Reward fulfillment not found.',
    );
    const fulfillment = await this.prisma.rewardFulfillmentRequest.findUnique({
      where: { id },
      select: REWARD_FULFILLMENT_SELECT,
    });

    if (!fulfillment) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'REWARD_FULFILLMENT_NOT_FOUND',
        'Reward fulfillment not found.',
      );
    }

    await this.tryRecordReadSuccess(actor, 'operator.reward_fulfillment.get', {
      ...context,
      targetId: fulfillment.id,
      metadataJson: {
        fulfillmentId: fulfillment.id,
        status: fulfillment.status,
      },
    });

    return {
      success: true,
      data: {
        fulfillment: this.serializeFulfillment(fulfillment),
      },
    };
  }

  async createFulfillment(
    actor: AuthenticatedUser | undefined,
    body: RewardFulfillmentCreateBody = {},
    context: OperatorRequestContext = {},
  ) {
    if (!actor || !hasOperatorRole(actor.role)) {
      if (actor) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.reward_fulfillment.create.failed',
          failureCode: 'OPERATOR_REQUIRED',
          reason: this.parseReason(body.reason),
          context,
        });
      }
      throw new ForbiddenException(
        this.errorBody('OPERATOR_REQUIRED', 'Operator role is required.'),
      );
    }

    let parsed: ParsedCreateRequest;
    try {
      parsed = this.parseCreateRequest(body);
    } catch (error) {
      if (error instanceof HttpException) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.reward_fulfillment.create.failed',
          seasonId: this.safeText(body.seasonId),
          seasonParticipantId: this.safeText(body.seasonParticipantId),
          rewardCode: this.safeText(body.rewardCode),
          reason: this.parseReason(body.reason),
          failureCode: this.extractErrorCode(
            error,
            'REWARD_FULFILLMENT_FAILED',
          ),
          context,
        });
      }

      throw error;
    }
    const existingByKey =
      await this.prisma.rewardFulfillmentRequest.findUnique({
        where: {
          requestedByUserId_idempotencyKey: {
            requestedByUserId: actor.userId,
            idempotencyKey: parsed.idempotencyKey,
          },
        },
        select: REWARD_FULFILLMENT_SELECT,
      });

    if (existingByKey) {
      if (existingByKey.requestHash === parsed.requestHash) {
        return {
          success: true,
          data: {
            fulfillment: this.serializeFulfillment(existingByKey),
            replayed: true,
          },
        };
      }

      await this.tryRecordFailure({
        actor,
        action: 'operator.reward_fulfillment.create.failed',
        seasonId: parsed.seasonId,
        seasonParticipantId: parsed.seasonParticipantId,
        rewardCode: parsed.rewardCode,
        reason: parsed.reason,
        failureCode: 'REWARD_FULFILLMENT_IDEMPOTENCY_CONFLICT',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'REWARD_FULFILLMENT_IDEMPOTENCY_CONFLICT',
        'Reward fulfillment idempotency key conflicts with a different request.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const season = await tx.season.findUnique({
          where: {
            id: parsed.seasonId,
          },
          select: {
            id: true,
            status: true,
          },
        });

        if (!season) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'SEASON_NOT_FOUND',
            'Season not found.',
          );
        }

        if (season.status !== SeasonStatus.settled) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'SEASON_NOT_SETTLED',
            'Reward fulfillment requires a settled season.',
          );
        }

        const participant = await tx.seasonParticipant.findUnique({
          where: {
            id: parsed.seasonParticipantId,
          },
          select: {
            id: true,
            seasonId: true,
            userId: true,
            user: {
              select: {
                id: true,
                status: true,
              },
            },
          },
        });

        if (!participant) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'SEASON_PARTICIPANT_NOT_FOUND',
            'Season participant not found.',
          );
        }

        if (participant.seasonId !== parsed.seasonId) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'SEASON_PARTICIPANT_MISMATCH',
            'Season participant does not belong to the requested season.',
          );
        }

        if (participant.user.status !== UserStatus.active) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'TARGET_USER_NOT_ACTIVE',
            'Reward target user must be active.',
          );
        }

        await this.assertNoDuplicateReward(
          tx as Pick<
            PrismaService,
            'rewardFulfillmentRequest' | 'seasonReward'
          >,
          parsed.seasonParticipantId,
          parsed.rewardCode,
        );

        const fulfillment = await tx.rewardFulfillmentRequest.create({
          data: {
            seasonId: parsed.seasonId,
            seasonParticipantId: parsed.seasonParticipantId,
            userId: participant.userId,
            rewardType: parsed.rewardType,
            rewardCode: parsed.rewardCode,
            rewardName: parsed.rewardName,
            ...(parsed.rewardValueJson === null
              ? {}
              : { rewardValueJson: parsed.rewardValueJson }),
            status: RewardFulfillmentStatus.pending,
            idempotencyKey: parsed.idempotencyKey,
            requestHash: parsed.requestHash,
            requestedByUserId: actor.userId,
            requestedAt: new Date(),
          },
          select: REWARD_FULFILLMENT_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.reward_fulfillment.create',
            targetType: 'reward_fulfillment',
            targetId: fulfillment.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              fulfillmentId: fulfillment.id,
              seasonId: fulfillment.seasonId,
              seasonParticipantId: fulfillment.seasonParticipantId,
              targetUserId: fulfillment.userId,
              rewardType: fulfillment.rewardType,
              rewardCode: fulfillment.rewardCode,
              rewardName: fulfillment.rewardName,
              rewardValueJson: fulfillment.rewardValueJson ?? null,
              idempotencyKey: fulfillment.idempotencyKey,
              status: fulfillment.status,
              reason: parsed.reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            fulfillment: this.serializeFulfillment(fulfillment),
            replayed: false,
          },
        };
      });
    } catch (error) {
      if (error instanceof HttpException) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.reward_fulfillment.create.failed',
          seasonId: parsed.seasonId,
          seasonParticipantId: parsed.seasonParticipantId,
          rewardCode: parsed.rewardCode,
          reason: parsed.reason,
          failureCode: this.extractErrorCode(
            error,
            'REWARD_FULFILLMENT_FAILED',
          ),
          context,
        });
        throw error;
      }

      if (this.isUniqueConstraintError(error)) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.reward_fulfillment.create.failed',
          seasonId: parsed.seasonId,
          seasonParticipantId: parsed.seasonParticipantId,
          rewardCode: parsed.rewardCode,
          reason: parsed.reason,
          failureCode: 'REWARD_FULFILLMENT_DUPLICATE',
          context,
        });
        this.throwApiError(
          HttpStatus.CONFLICT,
          'REWARD_FULFILLMENT_DUPLICATE',
          'Reward fulfillment already exists for this target and reward code.',
        );
      }

      await this.tryRecordFailure({
        actor,
        action: 'operator.reward_fulfillment.create.failed',
        seasonId: parsed.seasonId,
        seasonParticipantId: parsed.seasonParticipantId,
        rewardCode: parsed.rewardCode,
        reason: parsed.reason,
        failureCode: 'REWARD_FULFILLMENT_FAILED',
        context,
      });
      throw new InternalServerErrorException(
        this.errorBody(
          'REWARD_FULFILLMENT_FAILED',
          'Reward fulfillment creation failed.',
        ),
      );
    }
  }

  async fulfill(
    actor: AuthenticatedUser | undefined,
    fulfillmentId: string,
    body: RewardFulfillmentActionBody = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const id = this.parseRequiredText(
      fulfillmentId,
      'REWARD_FULFILLMENT_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'Reward fulfillment not found.',
    );
    const reason = this.parseReason(body.reason);
    const request = await this.findFulfillmentOrThrow(id);

    if (request.status === RewardFulfillmentStatus.fulfilled) {
      return {
        success: true,
        data: {
          fulfillment: this.serializeFulfillment(request),
          replayed: true,
        },
      };
    }

    if (
      request.status !== RewardFulfillmentStatus.pending &&
      request.status !== RewardFulfillmentStatus.failed
    ) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.reward_fulfillment.fulfill.failed',
        fulfillmentId: request.id,
        seasonId: request.seasonId,
        seasonParticipantId: request.seasonParticipantId,
        userId: request.userId,
        rewardCode: request.rewardCode,
        reason,
        failureCode: 'REWARD_FULFILLMENT_INVALID_STATUS',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'REWARD_FULFILLMENT_INVALID_STATUS',
        'Reward fulfillment cannot be fulfilled from its current status.',
      );
    }

    const preflightFailure = await this.validateFulfillmentPreflight(request);
    if (preflightFailure) {
      await this.markFulfillmentFailed({
        actor,
        request,
        errorCode: preflightFailure.code,
        errorMessage: preflightFailure.message,
        reason,
        context,
      });
      this.throwApiError(
        preflightFailure.status,
        preflightFailure.code,
        preflightFailure.message,
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const transitioned = await tx.rewardFulfillmentRequest.updateMany({
          where: {
            id: request.id,
            status: {
              in: [
                RewardFulfillmentStatus.pending,
                RewardFulfillmentStatus.failed,
              ],
            },
          },
          data: {
            status: RewardFulfillmentStatus.processing,
            processingStartedAt: now,
            processedByUserId: actor.userId,
            failedAt: null,
            errorCode: null,
            errorMessage: null,
          },
        });

        if (transitioned.count !== 1) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'REWARD_FULFILLMENT_INVALID_STATUS',
            'Reward fulfillment cannot be fulfilled from its current status.',
          );
        }

        const existingReward = await tx.seasonReward.findUnique({
          where: {
            seasonParticipantId_rewardCode: {
              seasonParticipantId: request.seasonParticipantId,
              rewardCode: request.rewardCode,
            },
          },
          select: {
            id: true,
          },
        });

        if (existingReward) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'REWARD_ALREADY_FULFILLED',
            'Reward has already been fulfilled for this participant.',
          );
        }

        const seasonReward = await tx.seasonReward.create({
          data: {
            seasonId: request.seasonId,
            seasonParticipantId: request.seasonParticipantId,
            userId: request.userId,
            rewardType: request.rewardType,
            rewardCode: request.rewardCode,
            rewardName: request.rewardName,
            ...(request.rewardValueJson === null
              ? {}
              : {
                  rewardValueJson:
                    request.rewardValueJson as Prisma.InputJsonValue,
                }),
            fulfillmentRequestId: request.id,
            grantedAt: now,
          },
          select: {
            id: true,
          },
        });

        await tx.seasonParticipant.updateMany({
          where: {
            id: request.seasonParticipantId,
            rewardGrantedAt: null,
          },
          data: {
            rewardGrantedAt: now,
          },
        });

        const fulfilled = await tx.rewardFulfillmentRequest.update({
          where: {
            id: request.id,
          },
          data: {
            status: RewardFulfillmentStatus.fulfilled,
            seasonRewardId: seasonReward.id,
            fulfilledAt: now,
            processedByUserId: actor.userId,
            errorCode: null,
            errorMessage: null,
          },
          select: REWARD_FULFILLMENT_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.reward_fulfillment.fulfill',
            targetType: 'reward_fulfillment',
            targetId: request.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              fulfillmentId: request.id,
              seasonId: request.seasonId,
              seasonParticipantId: request.seasonParticipantId,
              targetUserId: request.userId,
              rewardType: request.rewardType,
              rewardCode: request.rewardCode,
              beforeStatus: request.status,
              afterStatus: fulfilled.status,
              seasonRewardId: seasonReward.id,
              reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            fulfillment: this.serializeFulfillment(fulfilled),
            replayed: false,
          },
        };
      });
    } catch (error) {
      const code =
        error instanceof HttpException
          ? this.extractErrorCode(error, 'REWARD_FULFILLMENT_FAILED')
          : this.isUniqueConstraintError(error)
            ? 'REWARD_ALREADY_FULFILLED'
            : 'REWARD_FULFILLMENT_FAILED';
      const message =
        error instanceof HttpException
          ? this.extractErrorMessage(error, 'Reward fulfillment failed.')
          : 'Reward fulfillment failed.';

      await this.markFulfillmentFailed({
        actor,
        request,
        errorCode: code,
        errorMessage: message,
        reason,
        context,
      });

      if (error instanceof HttpException) {
        throw error;
      }

      if (code === 'REWARD_ALREADY_FULFILLED') {
        this.throwApiError(
          HttpStatus.CONFLICT,
          'REWARD_ALREADY_FULFILLED',
          'Reward has already been fulfilled for this participant.',
        );
      }

      throw new InternalServerErrorException(
        this.errorBody(
          'REWARD_FULFILLMENT_FAILED',
          'Reward fulfillment failed.',
        ),
      );
    }
  }

  async cancel(
    actor: AuthenticatedUser | undefined,
    fulfillmentId: string,
    body: RewardFulfillmentActionBody = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertOperator(actor);
    const id = this.parseRequiredText(
      fulfillmentId,
      'REWARD_FULFILLMENT_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'Reward fulfillment not found.',
    );
    const reason = this.parseReason(body.reason);
    const request = await this.findFulfillmentOrThrow(id);

    if (
      request.status !== RewardFulfillmentStatus.pending &&
      request.status !== RewardFulfillmentStatus.failed
    ) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.reward_fulfillment.cancel.failed',
        fulfillmentId: request.id,
        seasonId: request.seasonId,
        seasonParticipantId: request.seasonParticipantId,
        userId: request.userId,
        rewardCode: request.rewardCode,
        reason,
        failureCode: 'REWARD_FULFILLMENT_INVALID_STATUS',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'REWARD_FULFILLMENT_INVALID_STATUS',
        'Reward fulfillment cannot be canceled from its current status.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        const canceled = await tx.rewardFulfillmentRequest.update({
          where: {
            id: request.id,
          },
          data: {
            status: RewardFulfillmentStatus.canceled,
            canceledAt: now,
            canceledByUserId: actor.userId,
          },
          select: REWARD_FULFILLMENT_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.reward_fulfillment.cancel',
            targetType: 'reward_fulfillment',
            targetId: request.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              fulfillmentId: request.id,
              seasonId: request.seasonId,
              seasonParticipantId: request.seasonParticipantId,
              targetUserId: request.userId,
              rewardCode: request.rewardCode,
              beforeStatus: request.status,
              afterStatus: canceled.status,
              reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            fulfillment: this.serializeFulfillment(canceled),
          },
        };
      });
    } catch (error) {
      const code =
        error instanceof HttpException
          ? this.extractErrorCode(error, 'REWARD_FULFILLMENT_CANCEL_FAILED')
          : 'REWARD_FULFILLMENT_CANCEL_FAILED';
      await this.tryRecordFailure({
        actor,
        action: 'operator.reward_fulfillment.cancel.failed',
        fulfillmentId: request.id,
        seasonId: request.seasonId,
        seasonParticipantId: request.seasonParticipantId,
        userId: request.userId,
        rewardCode: request.rewardCode,
        reason,
        failureCode: code,
        context,
      });

      if (error instanceof HttpException) {
        throw error;
      }

      throw new InternalServerErrorException(
        this.errorBody(
          'REWARD_FULFILLMENT_CANCEL_FAILED',
          'Reward fulfillment cancel failed.',
        ),
      );
    }
  }

  private async findFulfillmentOrThrow(id: string) {
    const request = await this.prisma.rewardFulfillmentRequest.findUnique({
      where: { id },
      select: REWARD_FULFILLMENT_SELECT,
    });

    if (!request) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'REWARD_FULFILLMENT_NOT_FOUND',
        'Reward fulfillment not found.',
      );
    }

    return request;
  }

  private async validateFulfillmentPreflight(
    request: RewardFulfillmentRecord,
  ): Promise<{
    status: HttpStatus;
    code: string;
    message: string;
  } | null> {
    const [season, targetUser, participant, existingReward] =
      await Promise.all([
        this.prisma.season.findUnique({
          where: { id: request.seasonId },
          select: { id: true, status: true },
        }),
        this.prisma.user.findUnique({
          where: { id: request.userId },
          select: { id: true, status: true },
        }),
        this.prisma.seasonParticipant.findUnique({
          where: { id: request.seasonParticipantId },
          select: { id: true, seasonId: true, userId: true },
        }),
        this.prisma.seasonReward.findUnique({
          where: {
            seasonParticipantId_rewardCode: {
              seasonParticipantId: request.seasonParticipantId,
              rewardCode: request.rewardCode,
            },
          },
          select: { id: true },
        }),
      ]);

    if (!season) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'SEASON_NOT_FOUND',
        message: 'Season not found.',
      };
    }

    if (season.status !== SeasonStatus.settled) {
      return {
        status: HttpStatus.CONFLICT,
        code: 'SEASON_NOT_SETTLED',
        message: 'Reward fulfillment requires a settled season.',
      };
    }

    if (!participant) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'SEASON_PARTICIPANT_NOT_FOUND',
        message: 'Season participant not found.',
      };
    }

    if (
      participant.seasonId !== request.seasonId ||
      participant.userId !== request.userId
    ) {
      return {
        status: HttpStatus.CONFLICT,
        code: 'SEASON_PARTICIPANT_MISMATCH',
        message: 'Season participant does not match the fulfillment request.',
      };
    }

    if (!targetUser) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: 'TARGET_USER_NOT_FOUND',
        message: 'Target user not found.',
      };
    }

    if (targetUser.status !== UserStatus.active) {
      return {
        status: HttpStatus.CONFLICT,
        code: 'TARGET_USER_NOT_ACTIVE',
        message: 'Reward target user must be active.',
      };
    }

    if (existingReward) {
      return {
        status: HttpStatus.CONFLICT,
        code: 'REWARD_ALREADY_FULFILLED',
        message: 'Reward has already been fulfilled for this participant.',
      };
    }

    return null;
  }

  private async assertNoDuplicateReward(
    client: Pick<PrismaService, 'rewardFulfillmentRequest' | 'seasonReward'>,
    seasonParticipantId: string,
    rewardCode: string,
  ) {
    const [existingRequest, existingReward] = await Promise.all([
      client.rewardFulfillmentRequest.findUnique({
        where: {
          seasonParticipantId_rewardCode: {
            seasonParticipantId,
            rewardCode,
          },
        },
        select: {
          id: true,
        },
      }),
      client.seasonReward.findUnique({
        where: {
          seasonParticipantId_rewardCode: {
            seasonParticipantId,
            rewardCode,
          },
        },
        select: {
          id: true,
        },
      }),
    ]);

    if (existingRequest || existingReward) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'REWARD_FULFILLMENT_DUPLICATE',
        'Reward fulfillment already exists for this target and reward code.',
      );
    }
  }

  private async markFulfillmentFailed(input: {
    actor: AuthenticatedUser;
    request: RewardFulfillmentRecord;
    errorCode: string;
    errorMessage: string;
    reason: string | null;
    context: OperatorRequestContext;
  }) {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.rewardFulfillmentRequest.update({
          where: {
            id: input.request.id,
          },
          data: {
            status: RewardFulfillmentStatus.failed,
            failedAt: new Date(),
            errorCode: input.errorCode,
            errorMessage: input.errorMessage.slice(0, 500),
          },
          select: {
            id: true,
          },
        });

        await this.auditService.recordFailure(
          {
            actorUserId: input.actor.userId,
            actorRole: input.actor.role,
            action: 'operator.reward_fulfillment.fulfill.failed',
            targetType: 'reward_fulfillment',
            targetId: input.request.id,
            requestId: input.context.requestId,
            ipAddress: input.context.ipAddress,
            userAgent: input.context.userAgent,
            metadataJson: {
              actorUserId: input.actor.userId,
              fulfillmentId: input.request.id,
              seasonId: input.request.seasonId,
              seasonParticipantId: input.request.seasonParticipantId,
              targetUserId: input.request.userId,
              rewardCode: input.request.rewardCode,
              beforeStatus: input.request.status,
              afterStatus: RewardFulfillmentStatus.failed,
              reason: input.reason,
              requestId: input.context.requestId ?? null,
              failureCode: input.errorCode,
            },
            errorCode: input.errorCode,
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );
      });
    } catch {
      return;
    }
  }

  private parseCreateRequest(
    body: RewardFulfillmentCreateBody,
  ): ParsedCreateRequest {
    const seasonId = this.parseRequiredText(
      body.seasonId,
      'SEASON_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'Season not found.',
    );
    const seasonParticipantId = this.parseRequiredText(
      body.seasonParticipantId,
      'SEASON_PARTICIPANT_NOT_FOUND',
      HttpStatus.NOT_FOUND,
      'Season participant not found.',
    );
    const rewardType = this.parseRewardType(body.rewardType);
    const rewardCode = this.parseRewardCode(body.rewardCode);
    const rewardName = this.parseRewardName(body.rewardName);
    const rewardValueJson = this.parseRewardValueJson(body.rewardValueJson);
    const idempotencyKey = this.parseIdempotencyKey(body.idempotencyKey);
    const reason = this.parseReason(body.reason);
    const requestHash = this.hashRequest({
      seasonId,
      seasonParticipantId,
      rewardType,
      rewardCode,
      rewardName,
      rewardValueJson,
    });

    return {
      seasonId,
      seasonParticipantId,
      rewardType,
      rewardCode,
      rewardName,
      rewardValueJson,
      idempotencyKey,
      reason,
      requestHash,
    };
  }

  private parseListQuery(query: RewardFulfillmentQuery) {
    return {
      status: this.parseOptionalStatus(query.status),
      seasonId: this.parseOptionalText(query.seasonId),
      userId: this.parseOptionalText(query.userId),
      seasonParticipantId: this.parseOptionalText(query.seasonParticipantId),
      rewardCode: this.parseOptionalText(query.rewardCode),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseOptionalStatus(value: string | undefined) {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === RewardFulfillmentStatus.pending ||
      text === RewardFulfillmentStatus.processing ||
      text === RewardFulfillmentStatus.fulfilled ||
      text === RewardFulfillmentStatus.failed ||
      text === RewardFulfillmentStatus.canceled
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'REWARD_FULFILLMENT_INVALID_STATUS',
      'Invalid reward fulfillment status.',
    );
  }

  private parseRewardType(value: unknown): SeasonRewardType {
    if (typeof value !== 'string') {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REWARD_TYPE',
        'Invalid reward type.',
      );
    }

    const text = value.trim();
    if (
      text === SeasonRewardType.internal ||
      text === SeasonRewardType.badge ||
      text === SeasonRewardType.trophy
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_REWARD_TYPE',
      'Invalid reward type.',
    );
  }

  private parseRewardCode(value: unknown) {
    const text = this.parseRequiredText(
      value,
      'INVALID_REWARD_CODE',
      HttpStatus.BAD_REQUEST,
      'Reward code is required.',
    );
    if (text.length > 100) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REWARD_CODE',
        'Reward code is too long.',
      );
    }

    return text;
  }

  private parseRewardName(value: unknown) {
    const text = this.parseRequiredText(
      value,
      'INVALID_REWARD_NAME',
      HttpStatus.BAD_REQUEST,
      'Reward name is required.',
    );
    if (text.length > 200) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_REWARD_NAME',
        'Reward name is too long.',
      );
    }

    return text;
  }

  private parseIdempotencyKey(value: unknown) {
    const text = this.parseRequiredText(
      value,
      'INVALID_IDEMPOTENCY_KEY',
      HttpStatus.BAD_REQUEST,
      'Idempotency key is required.',
    );
    if (text.length > 200) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency key is too long.',
      );
    }

    return text;
  }

  private parseRewardValueJson(value: unknown): Prisma.InputJsonValue | null {
    if (value === undefined || value === null) {
      return null;
    }

    return this.sanitizeRewardJson(value) as Prisma.InputJsonValue;
  }

  private sanitizeRewardJson(value: unknown): unknown {
    if (value === null) {
      return null;
    }

    if (typeof value === 'string') {
      return this.isSensitiveString(value) ? REDACTED : value;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : UNSUPPORTED_JSON_VALUE;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeRewardJson(item));
    }

    if (typeof value === 'object') {
      if (!this.isPlainObject(value)) {
        return UNSUPPORTED_JSON_VALUE;
      }

      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .map(([key, item]) => [
            key,
            this.isSensitiveKey(key) ? REDACTED : this.sanitizeRewardJson(item),
          ]),
      );
    }

    return UNSUPPORTED_JSON_VALUE;
  }

  private parseReason(value: unknown) {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    return text === '' ? null : text.slice(0, 500);
  }

  private parseLimit(value: string | undefined): number {
    if (value === undefined) {
      return DEFAULT_LIMIT;
    }

    const limit = this.parseNonNegativeInteger(value, 'INVALID_LIMIT', 'limit');
    if (limit < 1) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_LIMIT',
        'limit must be greater than 0.',
      );
    }

    return Math.min(limit, MAX_LIMIT);
  }

  private parseOffset(value: string | undefined): number {
    if (value === undefined) {
      return 0;
    }

    return this.parseNonNegativeInteger(value, 'INVALID_OFFSET', 'offset');
  }

  private parseNonNegativeInteger(
    value: string,
    code: string,
    fieldName: string,
  ): number {
    if (!/^\d+$/.test(value.trim())) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a non-negative integer.`,
      );
    }

    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        code,
        `${fieldName} must be a safe integer.`,
      );
    }

    return parsed;
  }

  private parseRequiredText(
    value: unknown,
    code: string,
    status: HttpStatus,
    message: string,
  ) {
    if (typeof value !== 'string') {
      this.throwApiError(status, code, message);
    }

    const text = value.trim();
    if (!text) {
      this.throwApiError(status, code, message);
    }

    return text;
  }

  private parseOptionalText(value: string | undefined) {
    if (typeof value !== 'string') {
      return undefined;
    }

    const text = value.trim();
    return text === '' ? undefined : text;
  }

  private safeText(value: unknown) {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    return text === '' ? null : text.slice(0, 200);
  }

  private hashRequest(value: unknown) {
    return createHash('sha256')
      .update(JSON.stringify(this.canonicalize(value)))
      .digest('hex');
  }

  private canonicalize(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalize(item));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, this.canonicalize(item)]),
    );
  }

  private serializeFulfillment(fulfillment: RewardFulfillmentRecord) {
    return {
      id: fulfillment.id,
      seasonId: fulfillment.seasonId,
      seasonParticipantId: fulfillment.seasonParticipantId,
      userId: fulfillment.userId,
      rewardType: fulfillment.rewardType,
      rewardCode: fulfillment.rewardCode,
      rewardName: fulfillment.rewardName,
      rewardValueJson: fulfillment.rewardValueJson ?? null,
      status: fulfillment.status,
      seasonRewardId: fulfillment.seasonRewardId,
      requestedAt: fulfillment.requestedAt.toISOString(),
      processingStartedAt:
        fulfillment.processingStartedAt?.toISOString() ?? null,
      fulfilledAt: fulfillment.fulfilledAt?.toISOString() ?? null,
      failedAt: fulfillment.failedAt?.toISOString() ?? null,
      canceledAt: fulfillment.canceledAt?.toISOString() ?? null,
      errorCode: fulfillment.errorCode,
      errorMessage: fulfillment.errorMessage,
      createdAt: fulfillment.createdAt.toISOString(),
      updatedAt: fulfillment.updatedAt.toISOString(),
    };
  }

  private assertOperator(
    actor: AuthenticatedUser | undefined,
  ): asserts actor is AuthenticatedUser {
    if (!actor || !hasOperatorRole(actor.role)) {
      throw new ForbiddenException(
        this.errorBody('OPERATOR_REQUIRED', 'Operator role is required.'),
      );
    }
  }

  private async tryRecordReadSuccess(
    actor: AuthenticatedUser,
    action: 'operator.reward_fulfillment.list' | 'operator.reward_fulfillment.get',
    input: OperatorRequestContext & {
      targetId?: string | null;
      metadataJson?: unknown;
    },
  ) {
    try {
      await this.auditService.recordSuccess({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: input.targetId ? 'reward_fulfillment' : null,
        targetId: input.targetId,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadataJson: input.metadataJson,
      });
    } catch {
      return;
    }
  }

  private async tryRecordFailure(input: RewardFailureAuditInput) {
    try {
      await this.auditService.recordFailure({
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: input.action,
        targetType: input.fulfillmentId ? 'reward_fulfillment' : null,
        targetId: input.fulfillmentId,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadataJson: {
          actorUserId: input.actor.userId,
          fulfillmentId: input.fulfillmentId ?? null,
          seasonId: input.seasonId ?? null,
          seasonParticipantId: input.seasonParticipantId ?? null,
          targetUserId: input.userId ?? null,
          rewardCode: input.rewardCode ?? null,
          reason: input.reason ?? null,
          requestId: input.context.requestId ?? null,
          failureCode: input.failureCode,
        },
        errorCode: input.failureCode,
      });
    } catch {
      return;
    }
  }

  private isSensitiveKey(key: string) {
    const normalized = key.replace(/[\s.-]/g, '_').toLowerCase();
    return SENSITIVE_KEY_PATTERNS.some((pattern) =>
      normalized.includes(pattern),
    );
  }

  private isSensitiveString(value: string) {
    return (
      /^bearer\s+/i.test(value.trim()) ||
      /postgres(?:ql)?:\/\//i.test(value) ||
      /mysql:\/\//i.test(value) ||
      /mongodb(?:\+srv)?:\/\//i.test(value)
    );
  }

  private isPlainObject(value: object) {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  private extractErrorCode(error: HttpException, fallback: string) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      typeof response.error === 'object' &&
      response.error !== null &&
      'code' in response.error &&
      typeof response.error.code === 'string'
    ) {
      return response.error.code;
    }

    return fallback;
  }

  private extractErrorMessage(error: HttpException, fallback: string) {
    const response = error.getResponse();
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      typeof response.error === 'object' &&
      response.error !== null &&
      'message' in response.error &&
      typeof response.error.message === 'string'
    ) {
      return response.error.message;
    }

    return fallback;
  }

  private isUniqueConstraintError(error: unknown) {
    return (error as { code?: unknown }).code === 'P2002';
  }

  private throwApiError(
    status: HttpStatus,
    code: string,
    message: string,
  ): never {
    throw new HttpException(this.errorBody(code, message), status);
  }

  private errorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}
