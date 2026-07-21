jest.mock('../generated/prisma/client', () => ({
  MarketCalendarMarket: {
    KRX: 'KRX',
    US: 'US',
  },
  MarketSessionOverrideType: {
    regular: 'regular',
    closed: 'closed',
    custom: 'custom',
  },
  OperatorAuditResult: {
    success: 'success',
    failure: 'failure',
  },
  Prisma: {},
  PrismaClient: class PrismaClient {},
  UserRole: {
    user: 'user',
    operator: 'operator',
    admin: 'admin',
  },
}));

import { ForbiddenException, HttpException } from '@nestjs/common';
import { OperatorAuditResult, UserRole } from '../generated/prisma/client';
import { OperatorAuditService } from './operator-audit.service';
import { OperatorMarketSessionOverrideService } from './operator-market-session-override.service';

describe('OperatorMarketSessionOverrideService', () => {
  const operator = { userId: 'operator-1', role: UserRole.operator };
  const admin = { userId: 'admin-1', role: UserRole.admin };
  const regularUser = { userId: 'user-1', role: UserRole.user };
  const now = new Date('2026-07-20T05:00:00.000Z');

  const baseRecord = (
    overrides: Partial<{
      id: string;
      market: string;
      localDate: string;
      overrideType: string;
      openTime: string | null;
      closeTime: string | null;
      reason: string;
      source: string | null;
      isActive: boolean;
    }> = {},
  ) => ({
    id: 'override-1',
    market: 'KRX',
    localDate: '2026-07-21',
    overrideType: 'closed',
    openTime: null,
    closeTime: null,
    reason: 'emergency closure',
    source: null,
    isActive: true,
    createdByUserId: operator.userId,
    updatedByUserId: operator.userId,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  const createPrisma = () => {
    const prisma = {
      $transaction: jest.fn(),
      operatorAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: now }),
      },
      marketSessionOverride: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    return prisma;
  };

  const createService = () => {
    const prisma = createPrisma();
    const auditService = new OperatorAuditService(prisma as never);
    const loader = { refreshNow: jest.fn().mockResolvedValue(true) };
    const service = new OperatorMarketSessionOverrideService(
      prisma as never,
      auditService,
      loader as never,
    );
    return { loader, prisma, service };
  };

  const getErrorCode = (error: unknown) => {
    const response = (error as HttpException).getResponse() as {
      error: { code: string };
    };
    return response.error.code;
  };

  const expectErrorCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(HttpException);
    try {
      await promise;
    } catch (error) {
      expect(getErrorCode(error)).toBe(code);
    }
  };

  // Typed wrapper so nested matcher values are not `any` assignments.
  const containing = (
    value: Record<string, unknown>,
  ): Record<string, unknown> =>
    expect.objectContaining(value) as Record<string, unknown>;

  describe('upsert validation', () => {
    it.each([
      [{ market: 'JPX' }, 'INVALID_MARKET'],
      [{ localDate: '2026/07/21' }, 'INVALID_LOCAL_DATE'],
      [{ localDate: '2026-02-30' }, 'INVALID_LOCAL_DATE'],
      [{ localDate: '1999-01-04' }, 'INVALID_LOCAL_DATE'],
      [{ overrideType: 'half_day' }, 'INVALID_OVERRIDE_TYPE'],
      [
        { overrideType: 'custom', openTime: '25:00', closeTime: '15:30' },
        'INVALID_OVERRIDE_TIME',
      ],
      [
        { overrideType: 'custom', openTime: '9:00', closeTime: '15:30' },
        'INVALID_OVERRIDE_TIME',
      ],
      [
        { overrideType: 'custom', openTime: '10:00:61', closeTime: '15:30' },
        'INVALID_OVERRIDE_TIME',
      ],
      [
        { overrideType: 'custom', openTime: '15:30', closeTime: '10:00' },
        'OVERRIDE_TIME_ORDER_INVALID',
      ],
      [
        { overrideType: 'custom', openTime: '10:00', closeTime: '10:00' },
        'OVERRIDE_TIME_ORDER_INVALID',
      ],
      [{ overrideType: 'custom', openTime: '10:00' }, 'OVERRIDE_TIME_REQUIRED'],
      [{ overrideType: 'custom' }, 'OVERRIDE_TIME_REQUIRED'],
      [
        { overrideType: 'closed', openTime: '10:00', closeTime: '15:30' },
        'OVERRIDE_TIME_NOT_ALLOWED',
      ],
      [
        { overrideType: 'regular', closeTime: '15:30' },
        'OVERRIDE_TIME_NOT_ALLOWED',
      ],
      [{ reason: '' }, 'INVALID_OVERRIDE_REASON'],
      [{ reason: undefined }, 'INVALID_OVERRIDE_REASON'],
      // 2026-07-18 is a Saturday: a regular/custom override would be
      // silently ineffective (sessions never open on weekends).
      [
        { localDate: '2026-07-18', overrideType: 'regular' },
        'MARKET_SESSION_OVERRIDE_WEEKEND_UNSUPPORTED',
      ],
      [
        {
          localDate: '2026-07-18',
          overrideType: 'custom',
          openTime: '10:00',
          closeTime: '15:30',
        },
        'MARKET_SESSION_OVERRIDE_WEEKEND_UNSUPPORTED',
      ],
    ])('rejects %j with %s', async (patch, code) => {
      const { prisma, service } = createService();
      await expectErrorCode(
        service.upsertOverride(operator, {
          market: 'KRX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'emergency closure',
          ...patch,
        }),
        code,
      );
      expect(prisma.marketSessionOverride.create).not.toHaveBeenCalled();
      expect(prisma.marketSessionOverride.update).not.toHaveBeenCalled();
    });

    it('allows a closed override on a weekend (harmless no-op)', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(
        baseRecord({ localDate: '2026-07-18' }),
      );
      await expect(
        service.upsertOverride(operator, {
          market: 'KRX',
          localDate: '2026-07-18',
          overrideType: 'closed',
          reason: 'weekend annotation',
        }),
      ).resolves.toMatchObject({ success: true });
    });
  });

  describe('upsert', () => {
    it('creates a KRX closed override, audits it, and refreshes the runtime store', async () => {
      const { loader, prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(baseRecord());

      const response = await service.upsertOverride(
        operator,
        {
          market: 'KRX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'emergency closure',
        },
        { requestId: 'req-1' },
      );

      expect(response).toMatchObject({
        success: true,
        data: {
          created: true,
          runtimeApplied: true,
          override: {
            id: 'override-1',
            market: 'KRX',
            localDate: '2026-07-21',
            overrideType: 'closed',
            openTime: null,
            closeTime: null,
            isActive: true,
            calendarYearCovered: true,
          },
        },
      });
      expect(prisma.marketSessionOverride.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            market: 'KRX',
            localDate: '2026-07-21',
            overrideType: 'closed',
            openTime: null,
            closeTime: null,
            isActive: true,
            createdByUserId: operator.userId,
            updatedByUserId: operator.userId,
          }),
        }),
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.upsert',
            result: OperatorAuditResult.success,
            targetType: 'market_session_override',
            metadataJson: containing({
              market: 'KRX',
              localDate: '2026-07-21',
              created: true,
              before: null,
              after: containing({ overrideType: 'closed' }),
              reason: 'emergency closure',
            }),
          }),
        }),
      );
      expect(loader.refreshNow).toHaveBeenCalledWith('operator_mutation');
    });

    it('creates a US custom override with times normalized to canonical HHmmss', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(
        baseRecord({
          id: 'override-2',
          market: 'US',
          localDate: '2026-07-22',
          overrideType: 'custom',
          openTime: '103000',
          closeTime: '140000',
        }),
      );

      const response = await service.upsertOverride(admin, {
        market: 'US',
        localDate: '2026-07-22',
        overrideType: 'custom',
        openTime: '10:30',
        closeTime: '14:00:00',
        reason: 'delayed open',
        source: 'exchange notice',
      });

      expect(prisma.marketSessionOverride.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            openTime: '103000',
            closeTime: '140000',
            source: 'exchange notice',
          }),
        }),
      );
      expect(response.data.override).toMatchObject({
        openTime: '10:30:00',
        closeTime: '14:00:00',
      });
    });

    it('updates the existing row on upsert of a duplicate market+date and reactivates it', async () => {
      const { prisma, service } = createService();
      const existing = baseRecord({ isActive: false });
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(existing);
      prisma.marketSessionOverride.update.mockResolvedValueOnce(
        baseRecord({
          overrideType: 'custom',
          openTime: '100000',
          closeTime: '153000',
        }),
      );

      const response = await service.upsertOverride(operator, {
        market: 'KRX',
        localDate: '2026-07-21',
        overrideType: 'custom',
        openTime: '10:00',
        closeTime: '15:30',
        reason: 'switch to delayed open',
      });

      expect(response.data.created).toBe(false);
      expect(prisma.marketSessionOverride.update).toHaveBeenCalledWith(
        containing({
          where: { id: existing.id },
          data: containing({ isActive: true }),
        }),
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            metadataJson: containing({
              before: containing({
                overrideType: 'closed',
                isActive: false,
              }),
              after: containing({
                overrideType: 'custom',
                isActive: true,
              }),
            }),
          }),
        }),
      );
    });

    it('maps a unique-constraint race to CONFLICT and records a failure audit', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockRejectedValueOnce({
        code: 'P2002',
      });

      await expectErrorCode(
        service.upsertOverride(operator, {
          market: 'KRX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'emergency closure',
        }),
        'MARKET_SESSION_OVERRIDE_CONFLICT',
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.upsert.failed',
            result: OperatorAuditResult.failure,
            errorCode: 'MARKET_SESSION_OVERRIDE_CONFLICT',
          }),
        }),
      );
    });

    it('does not report runtimeApplied when the post-commit refresh fails', async () => {
      const { loader, prisma, service } = createService();
      loader.refreshNow.mockRejectedValueOnce(new Error('refresh failed'));
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(baseRecord());

      const response = await service.upsertOverride(operator, {
        market: 'KRX',
        localDate: '2026-07-21',
        overrideType: 'closed',
        reason: 'emergency closure',
      });

      expect(response.data.runtimeApplied).toBe(false);
    });

    it('flags overrides in uncovered years so operators see coverage is still missing', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(
        baseRecord({ localDate: '2028-03-02' }),
      );

      const response = await service.upsertOverride(operator, {
        market: 'KRX',
        localDate: '2028-03-02',
        overrideType: 'closed',
        reason: 'closure in uncovered year',
      });

      expect(response.data.override.calendarYearCovered).toBe(false);
    });
  });

  describe('update', () => {
    it('re-validates the merged state: switching custom → regular clears times', async () => {
      const { prisma, service } = createService();
      const existing = baseRecord({
        overrideType: 'custom',
        openTime: '100000',
        closeTime: '153000',
      });
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(existing);
      prisma.marketSessionOverride.update.mockResolvedValueOnce(
        baseRecord({ overrideType: 'regular' }),
      );

      await service.updateOverride(operator, 'override-1', {
        overrideType: 'regular',
      });

      expect(prisma.marketSessionOverride.update).toHaveBeenCalledWith(
        containing({
          data: containing({
            overrideType: 'regular',
            openTime: null,
            closeTime: null,
          }),
        }),
      );
    });

    it('rejects an update that leaves custom without a close time', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord({
          overrideType: 'custom',
          openTime: '100000',
          closeTime: '153000',
        }),
      );

      await expectErrorCode(
        service.updateOverride(operator, 'override-1', { closeTime: null }),
        'OVERRIDE_TIME_REQUIRED',
      );
    });

    it('returns NOT_FOUND for an unknown override id', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      await expectErrorCode(
        service.updateOverride(operator, 'missing-id', { reason: 'x' }),
        'MARKET_SESSION_OVERRIDE_NOT_FOUND',
      );
    });
  });

  describe('deactivate / reactivate', () => {
    it('deactivates an active override with an audit trail', async () => {
      const { loader, prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord(),
      );
      prisma.marketSessionOverride.update.mockResolvedValueOnce(
        baseRecord({ isActive: false }),
      );

      const response = await service.deactivateOverride(
        operator,
        'override-1',
        { note: 'closure cancelled' },
      );

      expect(response.data.override.isActive).toBe(false);
      expect(prisma.marketSessionOverride.update).toHaveBeenCalledWith(
        containing({
          data: containing({ isActive: false }),
        }),
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.deactivate',
            result: OperatorAuditResult.success,
            metadataJson: containing({
              note: 'closure cancelled',
            }),
          }),
        }),
      );
      expect(loader.refreshNow).toHaveBeenCalledWith('operator_mutation');
    });

    it('rejects deactivating an already-inactive override', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord({ isActive: false }),
      );
      await expectErrorCode(
        service.deactivateOverride(operator, 'override-1'),
        'MARKET_SESSION_OVERRIDE_ALREADY_INACTIVE',
      );
    });

    it('reactivates an inactive override', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord({ isActive: false }),
      );
      prisma.marketSessionOverride.update.mockResolvedValueOnce(baseRecord());

      const response = await service.reactivateOverride(admin, 'override-1');

      expect(response.data.override.isActive).toBe(true);
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.reactivate',
          }),
        }),
      );
    });

    it('rejects reactivating an already-active override', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord(),
      );
      await expectErrorCode(
        service.reactivateOverride(operator, 'override-1'),
        'MARKET_SESSION_OVERRIDE_ALREADY_ACTIVE',
      );
    });
  });

  describe('authorization', () => {
    it('allows operator and admin roles', async () => {
      for (const actor of [operator, admin]) {
        const { prisma, service } = createService();
        prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
        await expect(service.listOverrides(actor)).resolves.toMatchObject({
          success: true,
        });
      }
    });

    it('rejects regular users and anonymous callers on reads and mutations', async () => {
      const { prisma, service } = createService();
      await expect(service.listOverrides(regularUser)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        service.upsertOverride(regularUser, {
          market: 'KRX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'x',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.deactivateOverride(undefined, 'override-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.marketSessionOverride.findMany).not.toHaveBeenCalled();
      expect(prisma.marketSessionOverride.create).not.toHaveBeenCalled();
    });
  });

  describe('validation failure auditing', () => {
    it.each([
      ['invalid market', { market: 'JPX' }, 'INVALID_MARKET'],
      [
        'nonexistent calendar date',
        { localDate: '2026-02-30' },
        'INVALID_LOCAL_DATE',
      ],
      [
        'invalid open time',
        { overrideType: 'custom', openTime: '25:00', closeTime: '15:30' },
        'INVALID_OVERRIDE_TIME',
      ],
      [
        'custom time range order',
        { overrideType: 'custom', openTime: '15:30', closeTime: '10:00' },
        'OVERRIDE_TIME_ORDER_INVALID',
      ],
    ])(
      'audits an upsert validation failure: %s',
      async (_label, patch, code) => {
        const { prisma, service } = createService();
        await expectErrorCode(
          service.upsertOverride(
            operator,
            {
              market: 'KRX',
              localDate: '2026-07-21',
              overrideType: 'closed',
              reason: 'emergency closure',
              ...patch,
            },
            { requestId: 'req-validation' },
          ),
          code,
        );
        // The attempt itself must land in the audit trail with the actor,
        // the action, and the sanitized failure code.
        expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
          containing({
            data: containing({
              actorUserId: operator.userId,
              action: 'operator.market_session_override.upsert.failed',
              result: OperatorAuditResult.failure,
              targetType: 'market_session_override',
              errorCode: code,
            }),
          }),
        );
      },
    );

    it('keeps raw bodies and long values out of validation-failure metadata', async () => {
      const { prisma, service } = createService();
      const oversized = 'x'.repeat(500);
      await expectErrorCode(
        service.upsertOverride(operator, {
          market: 'KRX',
          localDate: oversized,
          overrideType: 'closed',
          reason: 'secret-adjacent free text',
        }),
        'INVALID_LOCAL_DATE',
      );
      const createCalls = prisma.operatorAuditLog.create.mock
        .calls as unknown[][];
      const auditData = (
        createCalls[0][0] as {
          data: { metadataJson: Record<string, unknown> };
        }
      ).data;
      // Only short identifying scalars are echoed; the oversized value and
      // the free-form reason of the unparsed body are dropped entirely.
      expect(auditData.metadataJson).toMatchObject({
        market: 'KRX',
        localDate: null,
        overrideType: 'closed',
      });
      expect(JSON.stringify(auditData)).not.toContain(oversized);
      expect(JSON.stringify(auditData)).not.toContain('secret-adjacent');
    });

    it('audits an invalid override id on update and status changes', async () => {
      const { prisma, service } = createService();
      await expectErrorCode(
        service.updateOverride(operator, '   ', { reason: 'x' }),
        'INVALID_OVERRIDE_ID',
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.update.failed',
            result: OperatorAuditResult.failure,
            errorCode: 'INVALID_OVERRIDE_ID',
          }),
        }),
      );

      prisma.operatorAuditLog.create.mockClear();
      await expectErrorCode(
        service.deactivateOverride(operator, '   '),
        'INVALID_OVERRIDE_ID',
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.deactivate.failed',
            errorCode: 'INVALID_OVERRIDE_ID',
          }),
        }),
      );
    });

    it('audits an invalid note on a status change', async () => {
      const { prisma, service } = createService();
      await expectErrorCode(
        service.reactivateOverride(operator, 'override-1', {
          note: 'n'.repeat(1_001),
        }),
        'INVALID_OVERRIDE_TEXT',
      );
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.reactivate.failed',
            result: OperatorAuditResult.failure,
            errorCode: 'INVALID_OVERRIDE_TEXT',
          }),
        }),
      );
    });

    it('preserves the original validation error when the failure audit itself fails', async () => {
      const { prisma, service } = createService();
      prisma.operatorAuditLog.create.mockRejectedValueOnce(
        new Error('audit insert down'),
      );
      await expectErrorCode(
        service.upsertOverride(operator, {
          market: 'JPX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'emergency closure',
        }),
        'INVALID_MARKET',
      );
    });

    it('records a runtime_refresh_failed audit when the post-commit refresh does not apply', async () => {
      const { loader, prisma, service } = createService();
      loader.refreshNow.mockResolvedValueOnce(false);
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(baseRecord());

      const response = await service.upsertOverride(operator, {
        market: 'KRX',
        localDate: '2026-07-21',
        overrideType: 'closed',
        reason: 'emergency closure',
      });

      expect(response.data.runtimeApplied).toBe(false);
      expect(prisma.operatorAuditLog.create).toHaveBeenLastCalledWith(
        containing({
          data: containing({
            action:
              'operator.market_session_override.upsert.runtime_refresh_failed',
            result: OperatorAuditResult.failure,
            errorCode: 'MARKET_SESSION_OVERRIDE_RUNTIME_REFRESH_FAILED',
            metadataJson: containing({ mutationCommitted: true }),
          }),
        }),
      );
    });

    it('does not write a runtime_refresh_failed audit when the refresh applies', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(baseRecord());

      const response = await service.upsertOverride(operator, {
        market: 'KRX',
        localDate: '2026-07-21',
        overrideType: 'closed',
        reason: 'emergency closure',
      });

      expect(response.data.runtimeApplied).toBe(true);
      // Exactly one audit row: the in-transaction success entry.
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('transaction consistency', () => {
    it('fails the whole mutation when the success-audit write fails inside the transaction', async () => {
      const { loader, prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      prisma.marketSessionOverride.create.mockResolvedValueOnce(baseRecord());
      prisma.operatorAuditLog.create
        .mockRejectedValueOnce(new Error('audit insert failed'))
        .mockResolvedValueOnce({ id: 'audit-2', createdAt: now });

      await expectErrorCode(
        service.upsertOverride(operator, {
          market: 'KRX',
          localDate: '2026-07-21',
          overrideType: 'closed',
          reason: 'emergency closure',
        }),
        'MARKET_SESSION_OVERRIDE_UPSERT_FAILED',
      );

      // The mutation and its success audit share one transaction; after the
      // rollback path only the failure audit (outside the transaction) runs,
      // and the runtime store is never refreshed with uncommitted data.
      expect(prisma.operatorAuditLog.create).toHaveBeenCalledTimes(2);
      expect(prisma.operatorAuditLog.create).toHaveBeenLastCalledWith(
        containing({
          data: containing({
            action: 'operator.market_session_override.upsert.failed',
            result: OperatorAuditResult.failure,
          }),
        }),
      );
      expect(loader.refreshNow).not.toHaveBeenCalled();
    });
  });

  describe('list / get', () => {
    it('filters by market and date range and hides inactive rows by default', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
        baseRecord(),
      ]);

      await service.listOverrides(operator, {
        market: 'KRX',
        from: '2026-07-01',
        to: '2026-07-31',
      });

      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledWith(
        containing({
          where: {
            market: 'KRX',
            localDate: { gte: '2026-07-01', lte: '2026-07-31' },
            isActive: true,
          },
        }),
      );
    });

    it('includes inactive rows only when requested', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
      await service.listOverrides(operator, { includeInactive: 'true' });
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledWith(
        containing({ where: {} }),
      );
    });

    it('rejects an inverted date range', async () => {
      const { service } = createService();
      await expectErrorCode(
        service.listOverrides(operator, {
          from: '2026-08-01',
          to: '2026-07-01',
        }),
        'INVALID_OVERRIDE_QUERY',
      );
    });

    it.each([['2026-99-99'], ['2026-02-30'], ['2026-13-01'], ['2026-04-31']])(
      'rejects the nonexistent query date %s',
      async (badDate) => {
        const { prisma, service } = createService();
        await expectErrorCode(
          service.listOverrides(operator, { from: badDate }),
          'INVALID_OVERRIDE_QUERY',
        );
        await expectErrorCode(
          service.listOverrides(operator, { to: badDate }),
          'INVALID_OVERRIDE_QUERY',
        );
        expect(prisma.marketSessionOverride.findMany).not.toHaveBeenCalled();
      },
    );

    it('returns a single override by id', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(
        baseRecord(),
      );
      const response = await service.getOverride(operator, 'override-1');
      expect(response.data.override).toMatchObject({ id: 'override-1' });
    });

    it('returns NOT_FOUND for an unknown id', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findUnique.mockResolvedValueOnce(null);
      await expectErrorCode(
        service.getOverride(operator, 'missing'),
        'MARKET_SESSION_OVERRIDE_NOT_FOUND',
      );
    });
  });
});
