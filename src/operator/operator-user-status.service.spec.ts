jest.mock('../generated/prisma/client', () => ({
  OperatorAuditResult: {
    success: 'success',
    failure: 'failure',
  },
  PrismaClient: class PrismaClient {},
  RefreshTokenSessionStatus: {
    active: 'active',
    revoked: 'revoked',
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
  OperatorAuditResult,
  RefreshTokenSessionStatus,
  UserRole,
  UserStatus,
} from '../generated/prisma/client';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorUserStatusService } from './operator-user-status.service';

describe('OperatorUserStatusService', () => {
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
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      refreshTokenSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
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
    const service = new OperatorUserStatusService(
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

  it('allows admin to suspend an active user and revokes active refresh sessions', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(userRecord());
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 2 });
    prisma.user.update.mockResolvedValueOnce(
      userRecord({
        status: UserStatus.suspended,
        updatedAt: new Date('2026-06-09T00:01:00.000Z'),
      }),
    );

    const response = await service.updateUserStatus(
      adminActor,
      'target-1',
      {
        status: UserStatus.suspended,
        reason: 'risk review',
      },
      { requestId: 'request-1' },
    );

    expect(response).toMatchObject({
      success: true,
      data: {
        user: {
          id: 'target-1',
          status: UserStatus.suspended,
          role: UserRole.user,
        },
        statusChange: {
          beforeStatus: UserStatus.active,
          afterStatus: UserStatus.suspended,
          beforeRole: UserRole.user,
          afterRole: UserRole.user,
          reason: 'risk review',
          revokedRefreshSessionCount: 2,
        },
      },
    });
    expect(prisma.refreshTokenSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'target-1',
        status: RefreshTokenSessionStatus.active,
      },
      data: expect.objectContaining({
        status: RefreshTokenSessionStatus.revoked,
        revokedAt: expect.any(Date),
      }),
    });
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_status.update',
          result: OperatorAuditResult.success,
          metadataJson: expect.objectContaining({
            beforeStatus: UserStatus.active,
            afterStatus: UserStatus.suspended,
            revokedRefreshSessionCount: 2,
          }),
        }),
      }),
    );
    expect(JSON.stringify(response)).not.toMatch(
      /passwordHash|refreshToken|accessToken|tokenHash/i,
    );
  });

  it('allows suspended -> active without reviving refresh sessions', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ status: UserStatus.suspended }),
    );
    prisma.user.update.mockResolvedValueOnce(userRecord());

    const response = await service.updateUserStatus(adminActor, 'target-1', {
      status: UserStatus.active,
    });

    expect(response.data.statusChange.revokedRefreshSessionCount).toBe(0);
    expect(prisma.refreshTokenSession.updateMany).not.toHaveBeenCalled();
  });

  it('forces role=user and revokes refresh sessions when deleting a target user', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ role: UserRole.operator }),
    );
    prisma.refreshTokenSession.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.user.update.mockResolvedValueOnce(
      userRecord({
        status: UserStatus.deleted,
        role: UserRole.user,
      }),
    );

    const response = await service.updateUserStatus(adminActor, 'target-1', {
      status: UserStatus.deleted,
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: UserStatus.deleted,
          role: UserRole.user,
        },
      }),
    );
    expect(response.data.statusChange).toMatchObject({
      beforeRole: UserRole.operator,
      afterRole: UserRole.user,
      revokedRefreshSessionCount: 1,
    });
  });

  it('rejects non-admin, self status changes, same status, deleted patch restore, and last active admin status change', async () => {
    const { prisma, service } = createService();

    await expectHttpError(
      service.updateUserStatus(operatorActor, 'target-1', {
        status: UserStatus.suspended,
      }),
      HttpStatus.FORBIDDEN,
      'ADMIN_REQUIRED',
    );

    await expectHttpError(
      service.updateUserStatus(adminActor, adminActor.userId, {
        status: UserStatus.suspended,
      }),
      HttpStatus.CONFLICT,
      'CANNOT_CHANGE_OWN_STATUS',
    );

    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ status: UserStatus.active }),
    );
    await expectHttpError(
      service.updateUserStatus(adminActor, 'target-1', {
        status: UserStatus.active,
      }),
      HttpStatus.CONFLICT,
      'USER_STATUS_ALREADY_ASSIGNED',
    );

    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ status: UserStatus.deleted }),
    );
    await expectHttpError(
      service.updateUserStatus(adminActor, 'target-1', {
        status: UserStatus.active,
      }),
      HttpStatus.CONFLICT,
      'USE_RESTORE_ENDPOINT',
    );

    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({ id: 'admin-2', role: UserRole.admin }),
    );
    prisma.user.count.mockResolvedValueOnce(1);
    await expectHttpError(
      service.updateUserStatus(adminActor, 'admin-2', {
        status: UserStatus.deleted,
      }),
      HttpStatus.CONFLICT,
      'LAST_ADMIN_STATUS_CHANGE_FORBIDDEN',
    );
    expect(prisma.user.count).toHaveBeenCalledWith({
      where: {
        role: UserRole.admin,
        status: UserStatus.active,
      },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_status.update.failed',
          result: OperatorAuditResult.failure,
        }),
      }),
    );
  });

  it('restores deleted users as active user and does not reactivate refresh sessions', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(
      userRecord({
        status: UserStatus.deleted,
        role: UserRole.admin,
      }),
    );
    prisma.user.update.mockResolvedValueOnce(
      userRecord({
        status: UserStatus.active,
        role: UserRole.user,
      }),
    );

    const response = await service.restoreUser(adminActor, 'target-1', {
      reason: 'appeal approved',
    });

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: UserStatus.active,
          role: UserRole.user,
        },
      }),
    );
    expect(prisma.refreshTokenSession.updateMany).not.toHaveBeenCalled();
    expect(response.data.restore).toMatchObject({
      beforeStatus: UserStatus.deleted,
      afterStatus: UserStatus.active,
      beforeRole: UserRole.admin,
      afterRole: UserRole.user,
      reason: 'appeal approved',
    });
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_restore',
          result: OperatorAuditResult.success,
          metadataJson: expect.objectContaining({
            beforeRole: UserRole.admin,
            afterRole: UserRole.user,
          }),
        }),
      }),
    );
  });

  it('rejects restore for non-deleted targets and records failure audit', async () => {
    const { prisma, service } = createService();
    prisma.user.findUnique.mockResolvedValueOnce(userRecord());

    await expectHttpError(
      service.restoreUser(adminActor, 'target-1'),
      HttpStatus.CONFLICT,
      'USER_RESTORE_NOT_ALLOWED',
    );

    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'operator.user_restore.failed',
          errorCode: 'USER_RESTORE_NOT_ALLOWED',
        }),
      }),
    );
  });
});
