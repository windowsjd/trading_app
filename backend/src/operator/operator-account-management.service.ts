import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma, UserRole, UserStatus } from '../generated/prisma/client';
import type { AuthenticatedUser } from '../auth/auth.types';
import { buildPagination } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { OperatorAuditService } from './operator-audit.service';

export type OperatorRequestContext = {
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
};

export type UserManagementQuery = {
  role?: string;
  status?: string;
  search?: string;
  limit?: string;
  offset?: string;
};

export type RoleChangeBody = {
  role?: unknown;
  reason?: unknown;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
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

@Injectable()
export class OperatorAccountManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: OperatorAuditService,
  ) {}

  async listUsers(
    actor: AuthenticatedUser | undefined,
    query: UserManagementQuery = {},
    context: OperatorRequestContext = {},
  ) {
    this.assertAdmin(actor);
    const parsed = this.parseListQuery(query);
    const where = this.buildUserWhere(parsed);
    const total = await this.prisma.user.count({ where });
    const users = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: parsed.limit,
      skip: parsed.offset,
      select: USER_SAFE_SELECT,
    });

    await this.tryRecordReadSuccess(actor, 'operator.users.list', null, {
      ...context,
      metadataJson: {
        filters: {
          role: parsed.role ?? null,
          status: parsed.status ?? null,
          search: parsed.search ?? null,
          limit: parsed.limit,
          offset: parsed.offset,
        },
        resultCount: users.length,
      },
    });

    return {
      success: true,
      data: {
        users: users.map((user) => this.serializeUser(user)),
        pagination: buildPagination({
          limit: parsed.limit,
          offset: parsed.offset,
          total,
          returned: users.length,
        }),
      },
    };
  }

  async getUser(
    actor: AuthenticatedUser | undefined,
    userId: string,
    context: OperatorRequestContext = {},
  ) {
    this.assertAdmin(actor);
    const targetUserId = this.parseTargetUserId(userId);
    const user = await this.prisma.user.findUnique({
      where: {
        id: targetUserId,
      },
      select: USER_SAFE_SELECT,
    });

    if (!user) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'TARGET_USER_NOT_FOUND',
        'Target user not found.',
      );
    }

    await this.tryRecordReadSuccess(actor, 'operator.users.get', targetUserId, {
      ...context,
      metadataJson: {
        targetUserId,
      },
    });

    return {
      success: true,
      data: {
        user: this.serializeUser(user),
      },
    };
  }

  async updateUserRole(
    actor: AuthenticatedUser | undefined,
    userId: string,
    body: RoleChangeBody = {},
    context: OperatorRequestContext = {},
  ) {
    const targetUserId = this.parseTargetUserId(userId);
    const reason = this.parseReason(body.reason);

    if (!actor) {
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    const requestedRole = this.parseRole(body.role);
    if (actor.role !== UserRole.admin) {
      await this.tryRecordRoleChangeFailure({
        actor,
        targetUserId,
        requestedRole,
        reason,
        failureCode: 'ADMIN_REQUIRED',
        context,
      });
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }

    if (!requestedRole) {
      await this.tryRecordRoleChangeFailure({
        actor,
        targetUserId,
        requestedRole: this.safeRequestedRole(body.role),
        reason,
        failureCode: 'INVALID_USER_ROLE',
        context,
      });
      this.throwApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_USER_ROLE',
        'Invalid user role.',
      );
    }

    if (actor.userId === targetUserId) {
      await this.tryRecordRoleChangeFailure({
        actor,
        targetUserId,
        requestedRole,
        reason,
        failureCode: 'CANNOT_CHANGE_OWN_ROLE',
        context,
      });
      this.throwApiError(
        HttpStatus.CONFLICT,
        'CANNOT_CHANGE_OWN_ROLE',
        'Admin cannot change their own role.',
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

        this.validateRoleChangeTarget(target, requestedRole);

        if (this.isActiveAdminDemotion(target, requestedRole)) {
          const activeAdminCount = await tx.user.count({
            where: {
              role: UserRole.admin,
              status: UserStatus.active,
            },
          });

          if (activeAdminCount <= 1) {
            this.throwApiError(
              HttpStatus.CONFLICT,
              'LAST_ADMIN_ROLE_CHANGE_FORBIDDEN',
              'Cannot demote the last active admin.',
            );
          }
        }

        const updated = await tx.user.update({
          where: {
            id: target.id,
          },
          data: {
            role: requestedRole,
          },
          select: USER_SAFE_SELECT,
        });

        await this.auditService.recordSuccess(
          {
            actorUserId: actor.userId,
            actorRole: actor.role,
            action: 'operator.user_role.update',
            targetType: 'user',
            targetId: target.id,
            requestId: context.requestId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            metadataJson: {
              actorUserId: actor.userId,
              targetUserId: target.id,
              beforeRole: target.role,
              afterRole: requestedRole,
              reason,
              requestId: context.requestId ?? null,
            },
          },
          tx as Pick<PrismaService, 'operatorAuditLog'>,
        );

        return {
          success: true,
          data: {
            user: this.serializeUser(updated),
            roleChange: {
              beforeRole: target.role,
              afterRole: requestedRole,
              reason,
            },
          },
        };
      });
    } catch (error) {
      if (error instanceof HttpException) {
        await this.tryRecordRoleChangeFailure({
          actor,
          targetUserId,
          requestedRole,
          reason,
          failureCode: this.extractErrorCode(error),
          context,
        });
        throw error;
      }

      await this.tryRecordRoleChangeFailure({
        actor,
        targetUserId,
        requestedRole,
        reason,
        failureCode: 'OPERATOR_ROLE_CHANGE_FAILED',
        context,
      });
      throw new InternalServerErrorException(
        this.errorBody(
          'OPERATOR_ROLE_CHANGE_FAILED',
          'Operator role change failed.',
        ),
      );
    }
  }

  private validateRoleChangeTarget(
    target: ManagedUserRecord,
    requestedRole: UserRole,
  ) {
    if (target.role === requestedRole) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'ROLE_ALREADY_ASSIGNED',
        'Target user already has the requested role.',
      );
    }

    if (target.status === UserStatus.deleted) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TARGET_USER_DELETED',
        'Deleted user role changes are forbidden.',
      );
    }

    if (
      target.status === UserStatus.suspended &&
      requestedRole !== UserRole.user
    ) {
      this.throwApiError(
        HttpStatus.CONFLICT,
        'TARGET_USER_SUSPENDED_PROMOTION_FORBIDDEN',
        'Suspended users cannot be promoted to operator or admin.',
      );
    }
  }

  private isActiveAdminDemotion(
    target: ManagedUserRecord,
    requestedRole: UserRole,
  ) {
    return (
      target.status === UserStatus.active &&
      target.role === UserRole.admin &&
      requestedRole !== UserRole.admin
    );
  }

  private assertAdmin(
    actor: AuthenticatedUser | undefined,
  ): asserts actor is AuthenticatedUser {
    if (!actor || actor.role !== UserRole.admin) {
      throw new ForbiddenException(
        this.errorBody('ADMIN_REQUIRED', 'Admin role is required.'),
      );
    }
  }

  private buildUserWhere(
    query: ReturnType<OperatorAccountManagementService['parseListQuery']>,
  ): Prisma.UserWhereInput {
    return {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              {
                email: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
              {
                nickname: {
                  contains: query.search,
                  mode: 'insensitive',
                },
              },
            ],
          }
        : {}),
    };
  }

  private parseListQuery(query: UserManagementQuery) {
    return {
      role: this.parseOptionalRole(query.role),
      status: this.parseOptionalStatus(query.status),
      search: this.parseOptionalText(query.search),
      limit: this.parseLimit(query.limit),
      offset: this.parseOffset(query.offset),
    };
  }

  private parseOptionalRole(value: string | undefined) {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    const role = this.parseRole(text);
    if (role) {
      return role;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_USER_ROLE',
      'Invalid user role.',
    );
  }

  private parseOptionalStatus(value: string | undefined) {
    const text = this.parseOptionalText(value);
    if (!text) {
      return undefined;
    }

    if (
      text === UserStatus.active ||
      text === UserStatus.suspended ||
      text === UserStatus.deleted
    ) {
      return text;
    }

    this.throwApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_USER_STATUS',
      'Invalid user status.',
    );
  }

  private parseRole(value: unknown): UserRole | null {
    if (typeof value !== 'string') {
      return null;
    }

    const text = value.trim();
    if (
      text === UserRole.user ||
      text === UserRole.operator ||
      text === UserRole.admin
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

  private parseTargetUserId(value: string) {
    const text = this.parseOptionalText(value);
    if (!text) {
      this.throwApiError(
        HttpStatus.NOT_FOUND,
        'TARGET_USER_NOT_FOUND',
        'Target user not found.',
      );
    }

    return text;
  }

  private parseOptionalText(value: string | undefined) {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
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

  private async tryRecordReadSuccess(
    actor: AuthenticatedUser,
    action: string,
    targetId: string | null,
    input: OperatorRequestContext & { metadataJson?: unknown },
  ) {
    try {
      await this.auditService.recordSuccess({
        actorUserId: actor.userId,
        actorRole: actor.role,
        action,
        targetType: targetId ? 'user' : null,
        targetId,
        requestId: input.requestId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
        metadataJson: input.metadataJson,
      });
    } catch {
      return;
    }
  }

  private async tryRecordRoleChangeFailure(input: {
    actor: AuthenticatedUser;
    targetUserId: string;
    requestedRole: UserRole | string | null;
    reason: string | null;
    failureCode: string;
    context: OperatorRequestContext;
  }) {
    try {
      await this.auditService.recordFailure({
        actorUserId: input.actor.userId,
        actorRole: input.actor.role,
        action: 'operator.user_role.update.failed',
        targetType: 'user',
        targetId: input.targetUserId,
        requestId: input.context.requestId,
        ipAddress: input.context.ipAddress,
        userAgent: input.context.userAgent,
        metadataJson: {
          actorUserId: input.actor.userId,
          targetUserId: input.targetUserId,
          requestedRole: input.requestedRole,
          reason: input.reason,
          requestId: input.context.requestId ?? null,
          failureCode: input.failureCode,
        },
        errorCode: input.failureCode,
      });
    } catch {
      return;
    }
  }

  private safeRequestedRole(value: unknown) {
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

    return 'OPERATOR_ROLE_CHANGE_FAILED';
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
