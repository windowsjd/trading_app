jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('./conditional-price', () => ({
  conditionalPrice: jest.fn().mockResolvedValue(null),
}));
import { Prisma } from '../generated/prisma/client';
import { createProtectionInTransaction } from './conditional-registration';
import {
  captureFinancialFailure,
  expectSafeFinancialDiagnostic,
} from '../../test/support/financial-diagnostics';
import { assertDiagnosticTriage } from '../../scripts/lib/diagnostic-quality';
it('records the observed missing conditional reference without financial values', async () => {
  const previous = process.env.CONDITIONAL_ORDERS_ENABLED;
  process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
  try {
    const tx = {
      protectionGroup: { findFirst: jest.fn().mockResolvedValue(null) },
      asset: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'asset-1', assetType: 'crypto' }),
      },
      position: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'position-1',
          quantity: new Prisma.Decimal(1),
          reservedQuantity: new Prisma.Decimal(0),
        }),
      },
      tradingAccount: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'account-1',
          mode: 'general',
          status: 'active',
        }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: new Date() }]),
    };
    const { diagnostic } = await captureFinancialFailure(() =>
      createProtectionInTransaction(tx as never, {
        accountId: 'account-1',
        assetId: 'asset-1',
        domain: 'spot',
        positionId: 'position-1',
        legs: [
          { kind: 'stop_loss', childOrderType: 'market', triggerPrice: '90' },
        ],
        now: new Date(),
      }),
    );
    assertDiagnosticTriage(
      diagnostic,
      'CONDITIONAL_PRICE_UNAVAILABLE',
      'backend/src/conditional/conditional-registration.ts#createProtectionInTransaction',
    );
    expectSafeFinancialDiagnostic(diagnostic);
    expect(diagnostic?.failureStage).toBe(
      'conditional_registration_price_selection',
    );
  } finally {
    if (previous === undefined) delete process.env.CONDITIONAL_ORDERS_ENABLED;
    else process.env.CONDITIONAL_ORDERS_ENABLED = previous;
  }
});
