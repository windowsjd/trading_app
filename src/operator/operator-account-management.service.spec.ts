jest.mock('../generated/prisma/client', () => ({
  OperatorAuditResult: {
    success: 'success',
    failure: 'failure',
  },
  PrismaClient: class PrismaClient {},
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
  OperatorAuditResult,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorAccountManagementService } from './operator-account-management.service';

describe('OperatorAccountManagementService', () => {
  const now = new Date('2026-06-09T00:00:00.000Z');
  const adminActor = {
    userId: 'admin-1',
    role: UserRole.admin,
  };
  const operatorActor = {
    userId: 'operator-1',
    role: UserRole.operator,
  };

  const userRecord = (
    overrides: Partial<{
      id: string;
      email: string;
      nickname: string;
      status: UserStatus;
      role: UserRole;
      createdAt: Date;
      updatedAt: Date;
    }> = {},
  ) => ({
    id: overrides.id ?? 'target-1',
    email: overrides.email ?? 'target@example.com',
    nickname: overrides.nickname ?? 'target',
    status: overrides.status ?? UserStatus.active,
    role: overrides.role ?? UserRole.user,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
  });

  const createService = () => {
    const prisma = {
      user: {
        count: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
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
    const service = new OperatorAccountManagementService(
      prisma as never,
      auditService,
    );

    return { prisma, service };
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

  it('allows only admin to list users and clamps max limit', async () => {
    const { prisma, service } = createService();
    prisma.user.count.mockResolvedValueOnce(1);
    prisma.user.findMany.mockResolvedValueOnce([userRecord()]);

    const response = await service.listUsers(
      adminActor,
      {
        role: UserRole.operator,
        status: UserStatus.active,
        search: 'target',
        limit: '500',
        offset: '2',
      },
      { requestId: 'request-1' },
    );

    expect(response).toEqual({
      success: true,
      data: {
        users: [
          {
            id: 'target-1',
            email: 'target@example.com',
            nickname: 'target',
            status: UserStatus.active,
            role: UserRole.user,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ],
        pagination: {
          limit: 100,
          offset: 2,
          total: 1,
          returned: 1,
          nextOffset: null,
        },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /passwordHash|refreshToken|accessToken/i,
    );
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          role: UserRole.operator,
          status: UserStatus.active,
          OR: [
            {
              email: {
                contains: 'target',
                mode: 'insensitive',
              },
            },
            {
              nickname: {
                contains: 'target',
                mode: 'insensitive',
              },
            },
          ],
        },
        take: 100,
        skip: 2,
        select: expect.not.objectContaining({
          passwordHash: true,
        }),
      }),
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.users.list',
          result: OperatorAuditResult.success,
        }),
      }),
    );

    await expectHttpError(
      service.listUsers(operatorActor),
      HttpStatus.FORBIDDEN,
      'ADMIN_REQUIRED',
    );
  });

  it('gets one user for admin without exposing secret fields', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(userRecord());

    const response = await service.getUser(adminActor, 'target-1');

    expect(response).toMatchObject({
      success: true,
      data: {
        user: {
          id: 'target-1',
          email: 'target@example.com',
          role: UserRole.user,
          status: UserStatus.active,
        },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /passwordHash|refreshToken|accessToken/i,
    );
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.users.get',
          targetId: 'target-1',
          result: OperatorAuditResult.success,
        }),
      }),
    );
  });

  it('returns TARGET_USER_NOT_FOUND for missing user detail', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(null);

    await expectHttpError(
      service.getUser(adminActor, 'missing-user'),
      HttpStatus.NOT_FOUND,
      'TARGET_USER_NOT_FOUND',
    );
  });

  it('changes a user role as admin and records success audit in the transaction', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ role: UserRole.user }),
    );
    prisma.user.update.mockResolvedValueOnce(
      userRecord({
        role: UserRole.operator,
        updatedAt: new Date('2026-06-09T00:01:00.000Z'),
      }),
    );

    const response = await service.updateUserRole(
      adminActor,
      'target-1',
      {
        role: UserRole.operator,
        reason: 'grant support access',
      },
      {
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      },
    );

    expect(response).toMatchObject({
      success: true,
      data: {
        user: {
          id: 'target-1',
          role: UserRole.operator,
        },
        roleChange: {
          beforeRole: UserRole.user,
          afterRole: UserRole.operator,
          reason: 'grant support access',
        },
      },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: {
        id: 'target-1',
      },
      data: {
        role: UserRole.operator,
      },
      select: expect.any(Object),
    });
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: adminActor.userId,
          actorRole: UserRole.admin,
          action: 'operator.user_role.update',
          targetType: 'user',
          targetId: 'target-1',
          requestId: 'request-1',
          result: OperatorAuditResult.success,
          errorCode: null,
          metadataJson: {
            actorUserId: adminActor.userId,
            targetUserId: 'target-1',
            beforeRole: UserRole.user,
            afterRole: UserRole.operator,
            reason: 'grant support access',
            requestId: 'request-1',
          },
        }),
      }),
    );
    expect(
      JSON.stringify(prisma.operatorAuditLog.create.mock.calls),
    ).not.toMatch(
      /passwordHash|refreshToken|accessToken|rawPayload|DATABASE_URL/i,
    );
  });

  it('records failure audit when a non-admin attempts role change', async () => {
    const { prisma, service } = createService();

    await expectHttpError(
      service.updateUserRole(operatorActor, 'target-1', {
        role: UserRole.admin,
        reason: 'should fail',
      }),
      HttpStatus.FORBIDDEN,
      'ADMIN_REQUIRED',
    );

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_role.update.failed',
          actorRole: UserRole.operator,
          result: OperatorAuditResult.failure,
          errorCode: 'ADMIN_REQUIRED',
          metadataJson: expect.objectContaining({
            targetUserId: 'target-1',
            requestedRole: UserRole.admin,
            failureCode: 'ADMIN_REQUIRED',
          }),
        }),
      }),
    );
  });

  it.each([
    ['invalid role', { role: 'owner' }, 'INVALID_USER_ROLE'],
    [
      'self role change',
      { role: UserRole.user, targetUserId: adminActor.userId },
      'CANNOT_CHANGE_OWN_ROLE',
    ],
  ])('rejects %s before updating', async (_label, input, code) => {
    const { prisma, service } = createService();
    const targetUserId =
      'targetUserId' in input ? input.targetUserId : 'target-1';

    await expectHttpError(
      service.updateUserRole(adminActor, targetUserId, {
        role: input.role,
      }),
      code === 'INVALID_USER_ROLE'
        ? HttpStatus.BAD_REQUEST
        : HttpStatus.CONFLICT,
      code,
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_role.update.failed',
          errorCode: code,
        }),
      }),
    );
  });

  it.each([
    [
      'same role',
      userRecord({ role: UserRole.operator }),
      UserRole.operator,
      'ROLE_ALREADY_ASSIGNED',
    ],
    [
      'deleted target',
      userRecord({ role: UserRole.user, status: UserStatus.deleted }),
      UserRole.operator,
      'TARGET_USER_DELETED',
    ],
    [
      'suspended promotion',
      userRecord({ role: UserRole.user, status: UserStatus.suspended }),
      UserRole.operator,
      'TARGET_USER_SUSPENDED_PROMOTION_FORBIDDEN',
    ],
  ])('rejects %s with failure audit', async (_label, target, role, code) => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(target);

    await expectHttpError(
      service.updateUserRole(adminActor, target.id, { role }),
      HttpStatus.CONFLICT,
      code,
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_role.update.failed',
          errorCode: code,
        }),
      }),
    );
  });

  it('forbids demoting the last active admin and counts only active admins', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ id: 'admin-2', role: UserRole.admin }),
    );
    prisma.user.count.mockResolvedValueOnce(1);

    await expectHttpError(
      service.updateUserRole(adminActor, 'admin-2', { role: UserRole.user }),
      HttpStatus.CONFLICT,
      'LAST_ADMIN_ROLE_CHANGE_FORBIDDEN',
    );

    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        role: UserRole.admin,
        status: UserStatus.active,
      },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('allows suspended operator/admin demotion to user without active-admin protection', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({
        id: 'suspended-admin-1',
        role: UserRole.admin,
        status: UserStatus.suspended,
      }),
    );
    prisma.user.update.mockResolvedValueOnce(
      userRecord({
        id: 'suspended-admin-1',
        role: UserRole.user,
        status: UserStatus.suspended,
      }),
    );

    const response = await service.updateUserRole(
      adminActor,
      'suspended-admin-1',
      { role: UserRole.user },
    );

    expect(response.success).toBe(true);
    expect(response.data.user.role).toBe(UserRole.user);
    expect(prisma.user.count).not.toHaveBeenCalledWith({
      where: {
        role: UserRole.admin,
        status: UserStatus.active,
      },
    });
  });
});
