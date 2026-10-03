jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class {} };
});
import { Prisma } from '../generated/prisma/client';
import {
  diagnosePositionMutationFailure,
  positionAvailabilityEvidence,
} from './position-failure-diagnosis';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
} from '../common/admin-diagnostics';
import { expectSafeFinancialDiagnostic } from '../../test/support/financial-diagnostics';

const d = (s: string) => new Prisma.Decimal(s);
const base = {
  tradingAccountId: 'account-1',
  assetId: 'asset-1',
  currencyCode: 'KRW',
  quantity: d('10'),
  reservedQuantity: d('4'),
};
const input = {
  positionId: 'position-1',
  tradingAccountId: 'account-1',
  assetId: 'asset-1',
  currencyCode: 'KRW',
  quantity: d('2'),
  guard: 'available_position_quantity' as const,
  financialOperation: 'limit_sell_reservation',
  failureStage: 'position_reservation',
  mutationAffected: 0,
};

describe('read-only position failure classification', () => {
  it.each([
    [null, 'position_not_found'],
    [{ ...base, tradingAccountId: null }, 'null_scope'],
    [
      { ...base, tradingAccountId: 'foreign-account' },
      'account_scope_mismatch',
    ],
    [{ ...base, assetId: 'foreign-asset' }, 'asset_mismatch'],
    [{ ...base, currencyCode: 'USD' }, 'currency_mismatch'],
    [{ ...base, quantity: d('1') }, 'insufficient_quantity'],
    [{ ...base, reservedQuantity: d('9') }, 'insufficient_available_quantity'],
    [base, 'conflict'],
  ])('classifies %j as %s with exactly one read', async (row, reason) => {
    const client = {
      position: { findUnique: jest.fn().mockResolvedValue(row) },
    };
    let pending!: Promise<void>;
    adminDiagnosticRequestMiddleware(
      {
        method: 'POST',
        originalUrl: '/api/v1/orders',
        headers: {},
        user: { userId: 'user-1', role: 'admin' },
      } as never,
      { setHeader: jest.fn() } as never,
      () => {
        pending = diagnosePositionMutationFailure(client as never, input).then(
          (result) => {
            expect(result.failureReason).toBe(reason);
            expectSafeFinancialDiagnostic(
              buildAdminDiagnostic(
                new Error('safe guard rejection'),
                'INSUFFICIENT_QUANTITY',
                409,
              ),
            );
          },
        );
      },
    );
    await pending;
    expect(client.position.findUnique).toHaveBeenCalledTimes(1);
    expect(client.position.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'position-1' } }),
    );
  });
  it.each([
    ['1', 'insufficient_reserved_quantity', false],
    ['4', 'conflict', true],
  ])(
    'release checks reserved quantity %s',
    async (reserved, reason, sufficient) => {
      const client = {
        position: {
          findUnique: jest
            .fn()
            .mockResolvedValue({ ...base, reservedQuantity: d(reserved) }),
        },
      };
      expect(
        await diagnosePositionMutationFailure(client as never, {
          ...input,
          guard: 'reserved_position_quantity',
        }),
      ).toMatchObject({
        failureReason: reason,
        reservedSufficient: sufficient,
      });
      expect(client.position.findUnique).toHaveBeenCalledTimes(1);
    },
  );
  it('uses already-read information without I/O for previews and accepts zero legacy reservation', () => {
    expect(
      positionAvailabilityEvidence({ quantity: d('1') }, d('2')),
    ).toMatchObject({
      totalQuantitySufficient: false,
      availableQuantitySufficient: false,
      reservedQuantityPresent: false,
      failureReason: 'insufficient_quantity',
    });
    expect(
      positionAvailabilityEvidence(
        { quantity: d('10'), reservedQuantity: d('9') },
        d('2'),
      ),
    ).toMatchObject({
      totalQuantitySufficient: true,
      availableQuantitySufficient: false,
      reservedQuantityPresent: true,
      failureReason: 'insufficient_available_quantity',
    });
  });
});
