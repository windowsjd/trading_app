import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  Prisma,
  RefreshTokenSessionStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuditService } from './operator-audit.service';
import type { OperatorRequestContext } from './operator-account-management.service';

export type UserStatusChangeBody = {
  status?: unknown;
  reason?: unknown;
};

export type UserRestoreBody = {
  reason?: unknown;
};

const USER_SAFE_SELECT = {
  id: true,
  email: true,
  nickname: true,
  status: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type ManagedUserRecord = Prisma.UserGetPayload<{
  select: typeof USER_SAFE_SELECT;
}>;

type StatusAuditFailureInput = {
  actor: AuthenticatedUser;
  action: 'operator.user_status.update.failed' | 'operator.user_restore.failed';
  targetUserId: string;
  requestedStatus?: UserStatus | string | null;
  reason: string | null;
  failureCode: string;
  context: OperatorRequestContext;
};

@Injectable()
export class OperatorUserStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OperatorAuditService,
  ) {}

  async updateUserStatus(
    actor: AuthenticatedUser | undefined,
    userId: string,
    body: UserStatusChangeBody = {},
    context: OperatorRequestContext = {},
  ) {
    const targetUserId = this.parseTargetUserId(userId);
    const reason = this.parseReason(body.reason);

    if (!actor) {
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    const requestedStatus = this.parseStatus(body.status);
    if (actor.role !== UserRole.admin) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.user_status.update.failed',
        targetUserId,
        requestedStatus,
        reason,
        failureCode: 'ADMIN_REQUIRED',
        context,
      });
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    if (!requestedStatus) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.user_status.update.failed',
        targetUserId,
        requestedStatus: this.safeRequestedStatus(body.status),
        reason,
        failureCode: 'INVALID_USER_STATUS',
        context,
      });
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_USER_STATUS',
        'Invalid user status.',
      );
    }

    if (actor.userId === targetUserId) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.user_status.update.failed',
        targetUserId,
        requestedStatus,
        reason,
        failureCode: 'CANNOT_CHANGE_OWN_STATUS',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'CANNOT_CHANGE_OWN_STATUS',
        'Admin cannot change their own status.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: {
            id: targetUserId,
          },
          select: USER_SAFE_SELECT,
        });

        if (!target) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'TARGET_USER_NOT_FOUND',
            'Target user not found.',
          );
        }

        this.validateStatusChangeTarget(target, requestedStatus);

        if (this.isLastActiveAdminStatusChange(target, requestedStatus)) {
          const activeAdminCount = await tx.user.count({
            where: {
              role: UserRole.admin,
              status: UserStatus.active,
            },
          });

          if (activeAdminCount <= 1) {
            this.throwApiError(
              HttpStatus.CONFLICT,
              'LAST_ADMIN_STATUS_CHANGE_FORBIDDEN',
              'Cannot suspend or delete the last active admin.',
            );
          }
        }

        const revokeResult = await this.revokeRefreshSessionsIfNeeded(
          tx as Pick<PrismaService, 'refreshTokenSession'>,
          target.id,
          requestedStatus,
        );
        const updated = await tx.user.update({
          where: {
            id: target.id,
          },
          data: {
            status: requestedStatus,
            ...(requestedStatus === UserStatus.deleted
              ? { role: UserRole.user }
              : {}),
          },
          select: USER_SAFE_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.user_status.update',
            targetType: 'user',
            targetId: target.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              targetUserId: target.id,
              beforeStatus: target.status,
              afterStatus: updated.status,
              beforeRole: target.role,
              afterRole: updated.role,
              reason,
              requestId: context.requestId ?? null,
              revokedRefreshSessionCount: revokeResult.count,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            user: this.serializeUser(updated),
            statusChange: {
              beforeStatus: target.status,
              afterStatus: updated.status,
              beforeRole: target.role,
              afterRole: updated.role,
              reason,
              revokedRefreshSessionCount: revokeResult.count,
            },
          },
        };
      });
    } catch (error) {
      if (error instanceof HttpException) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.user_status.update.failed',
          targetUserId,
          requestedStatus,
          reason,
          failureCode: this.extractErrorCode(error),
          context,
        });
        throw error;
      }

      await this.tryRecordFailure({
        actor,
        action: 'operator.user_status.update.failed',
        targetUserId,
        requestedStatus,
        reason,
        failureCode: 'USER_STATUS_CHANGE_FAILED',
        context,
      });
      throw new InternalServerErrorException(
        this.errorBody(
          'USER_STATUS_CHANGE_FAILED',
          'User status change failed.',
        ),
      );
    }
  }

  async restoreUser(
    actor: AuthenticatedUser | undefined,
    userId: string,
    body: UserRestoreBody = {},
    context: OperatorRequestContext = {},
  ) {
    const targetUserId = this.parseTargetUserId(userId);
    const reason = this.parseReason(body.reason);

    if (!actor) {
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    if (actor.role !== UserRole.admin) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.user_restore.failed',
        targetUserId,
        requestedStatus: UserStatus.active,
        reason,
        failureCode: 'ADMIN_REQUIRED',
        context,
      });
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    if (actor.userId === targetUserId) {
      await this.tryRecordFailure({
        actor,
        action: 'operator.user_restore.failed',
        targetUserId,
        requestedStatus: UserStatus.active,
        reason,
        failureCode: 'CANNOT_CHANGE_OWN_STATUS',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'CANNOT_CHANGE_OWN_STATUS',
        'Admin cannot change their own status.',
      );
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const target = await tx.user.findUnique({
          where: {
            id: targetUserId,
          },
          select: USER_SAFE_SELECT,
        });

        if (!target) {
          this.throwApiError(
            HttpStatus.NOT_FOUND,
            'TARGET_USER_NOT_FOUND',
            'Target user not found.',
          );
        }

        if (target.status !== UserStatus.deleted) {
          this.throwApiError(
            HttpStatus.CONFLICT,
            'USER_RESTORE_NOT_ALLOWED',
            'Only deleted users can be restored.',
          );
        }

        const updated = await tx.user.update({
          where: {
            id: target.id,
          },
          data: {
            status: UserStatus.active,
            role: UserRole.user,
          },
          select: USER_SAFE_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.user_restore',
            targetType: 'user',
            targetId: target.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              targetUserId: target.id,
              beforeStatus: target.status,
              afterStatus: updated.status,
              beforeRole: target.role,
              afterRole: updated.role,
              reason,
              requestId: context.requestId ?? null,
              revokedRefreshSessionCount: 0,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            user: this.serializeUser(updated),
            restore: {
              beforeStatus: target.status,
              afterStatus: updated.status,
              beforeRole: target.role,
              afterRole: updated.role,
              reason,
            },
          },
        };
      });
    } catch (error) {
      if (error instanceof HttpException) {
        await this.tryRecordFailure({
          actor,
          action: 'operator.user_restore.failed',
          targetUserId,
          requestedStatus: UserStatus.active,
          reason,
          failureCode: this.extractErrorCode(error),
          context,
        });
        throw error;
      }

      await this.tryRecordFailure({
        actor,
        action: 'operator.user_restore.failed',
        targetUserId,
        requestedStatus: UserStatus.active,
        reason,
        failureCode: 'USER_RESTORE_FAILED',
        context,
      });
      throw new InternalServerErrorException(
        this.errorBody('USER_RESTORE_FAILED', 'User restore failed.'),
      );
    }
  }

  private validateStatusChangeTarget(
    target: ManagedUserRecord,
    requestedStatus: UserStatus,
  ) {
    if (target.status === requestedStatus) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'USER_STATUS_ALREADY_ASSIGNED',
        'Target user already has the requested status.',
      );
    }

    if (target.status === UserStatus.deleted) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'USE_RESTORE_ENDPOINT',
        'Deleted users must be restored through the restore endpoint.',
      );
    }
  }

  private isLastActiveAdminStatusChange(
    target: ManagedUserRecord,
    requestedStatus: UserStatus,
  ) {
    return (
      target.status === UserStatus.active &&
      target.role === UserRole.admin &&
      (requestedStatus === UserStatus.suspended ||
        requestedStatus === UserStatus.deleted)
    );
  }

  private async revokeRefreshSessionsIfNeeded(
    client: Pick<PrismaService, 'refreshTokenSession'>,
    userId: string,
    requestedStatus: UserStatus,
  ) {
    if (
      requestedStatus !== UserStatus.suspended &&
      requestedStatus !== UserStatus.deleted
    ) {
      return { count: 0 };
    }

    return client.refreshTokenSession.updateMany({
      where: {
        userId,
        status: RefreshTokenSessionStatus.active,
      },
      data: {
        status: RefreshTokenSessionStatus.revoked,
        revokedAt: new Date(),
      },
    });
  }

  private parseStatus(value: unknown): UserStatus | null {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    if (
      text === UserStatus.active ||
      text === UserStatus.suspended ||
      text === UserStatus.deleted
    ) {
      return text;
    }

    return null;
  }

  private parseReason(value: unknown) {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    return text === '' ? null : text.slice(0, 500);
  }

  private parseTargetUserId(value: string) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'TARGET_USER_NOT_FOUND',
        'Target user not found.',
      );
    }

    return text;
  }

  private serializeUser(user: ManagedUserRecord) {
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      status: user.status,
      role: user.role,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    };
  }

  private async tryRecordFailure(input: StatusAuditFailureInput) {
    try {
      await this.auditService.recordFailure({
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: input.action,
        targetType: 'user',
        targetId: input.targetUserId,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadataJson: {
          actorUserId: input.actor.userId,
          targetUserId: input.targetUserId,
          requestedStatus: input.requestedStatus,
          reason: input.reason,
          requestId: input.context.requestId ?? null,
          failureCode: input.failureCode,
          revokedRefreshSessionCount: 0,
        },
        errorCode: input.failureCode,
      });
    } catch {
      return;
    }
  }

  private safeRequestedStatus(value: unknown) {
    return typeof value === 'string' ? value.trim().slice(0, 100) : null;
  }

  private extractErrorCode(error: HttpException) {
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

    return 'USER_STATUS_CHANGE_FAILED';
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
