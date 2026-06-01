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
}));

import { OperatorAuditResult, UserRole } from '../generated/prisma/client';
import { OperatorAuditService } from './operator-audit.service';

describe('OperatorAuditService', () => {
  const createdAt = new Date('2026-06-01T00:00:00.000Z');

  const createService = () => {
    const prisma = {
      operatorAuditLog: {
        create: jest.fn().mockResolvedValue({
          id: 'audit-1',
          createdAt,
        }),
      },
    };
    const service = new OperatorAuditService(prisma as never);

    return { prisma, service };
  };

  it('creates a success audit log', async () => {
    const { prisma, service } = createService();

    await expect(
      service.recordSuccess({
        actorUserId: 'operator-1',
        actorRole: UserRole.operator,
        action: 'operator.me.read',
        requestId: 'request-1',
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
      }),
    ).resolves.toEqual({
      id: 'audit-1',
      createdAt,
    });

    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'operator-1',
          actorRole: UserRole.operator,
          action: 'operator.me.read',
          requestId: 'request-1',
          ipAddress: '127.0.0.1',
          userAgent: 'jest',
          result: OperatorAuditResult.success,
          errorCode: null,
        }),
      }),
    );
  });

  it('creates a failure audit log', async () => {
    const { prisma, service } = createService();

    await service.recordFailure({
      actorUserId: 'admin-1',
      actorRole: UserRole.admin,
      action: 'batch.future.run',
      targetType: 'batch_job',
      targetId: 'daily-portfolio-snapshot',
      errorCode: 'NOT_IMPLEMENTED',
    });

    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actorUserId: 'admin-1',
          actorRole: UserRole.admin,
          action: 'batch.future.run',
          targetType: 'batch_job',
          targetId: 'daily-portfolio-snapshot',
          result: OperatorAuditResult.failure,
          errorCode: 'NOT_IMPLEMENTED',
        }),
      }),
    );
  });

  it('stores non-secret metadataJson', async () => {
    const { prisma, service } = createService();

    await service.recordSuccess({
      actorUserId: 'operator-1',
      actorRole: UserRole.operator,
      action: 'operator.audit.test',
      metadataJson: {
        dryRun: true,
        idempotencyKey: 'safe-business-key',
        nested: {
          count: 3,
        },
      },
    });

    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: {
            dryRun: true,
            idempotencyKey: 'safe-business-key',
            nested: {
              count: 3,
            },
          },
        }),
      }),
    );
  });

  it('redacts secret-like metadata fields and sensitive strings', async () => {
    const { prisma, service } = createService();

    await service.recordFailure({
      actorUserId: 'operator-1',
      actorRole: UserRole.operator,
      action: 'operator.audit.secret-redaction-test',
      errorCode: 'FAILED',
      metadataJson: {
        accessToken: 'access-token-value',
        appSecret: 'app-secret-value',
        approval_key: 'approval-key-value',
        DATABASE_URL: 'postgresql://user:password@localhost:5432/db',
        idempotencyKey: 'safe-business-key',
        nested: {
          refreshToken: 'refresh-token-value',
          note: 'safe-note',
        },
        rawPayloadJson: {
          full: 'provider payload must not be stored',
        },
        values: ['Bearer secret-token', { apiKey: 'api-key-value' }],
      },
    });

    expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadataJson: {
            accessToken: '[REDACTED]',
            appSecret: '[REDACTED]',
            approval_key: '[REDACTED]',
            DATABASE_URL: '[REDACTED]',
            idempotencyKey: 'safe-business-key',
            nested: {
              refreshToken: '[REDACTED]',
              note: 'safe-note',
            },
            rawPayloadJson: '[REDACTED]',
            values: ['[REDACTED]', { apiKey: '[REDACTED]' }],
          },
        }),
      }),
    );
  });
});
