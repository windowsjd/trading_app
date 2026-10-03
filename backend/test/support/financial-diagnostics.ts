import { HttpException } from '@nestjs/common';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
} from '../../src/common/admin-diagnostics';

/** Exercise the real request context and admin projection, never mock them. */
export function captureFinancialFailure(
  action: () => Promise<unknown>,
  role = 'admin',
) {
  let pending!: Promise<{
    error: HttpException;
    diagnostic: ReturnType<typeof buildAdminDiagnostic>;
  }>;
  adminDiagnosticRequestMiddleware(
    {
      method: 'POST',
      originalUrl: '/api/v1/trading-accounts/account-1/orders',
      headers: {},
      user: { userId: 'user-1', role },
    } as never,
    { setHeader: jest.fn() } as never,
    () => {
      pending = action().then(
        () => {
          throw new Error('Expected financial guard failure');
        },
        (error: HttpException) => {
          expect(error).toBeInstanceOf(HttpException);
          const code = (error.getResponse() as { error: { code: string } })
            .error.code;
          expect(error.getResponse()).toEqual({
            success: false,
            error: { code, message: expect.any(String) },
          });
          return {
            error,
            diagnostic: buildAdminDiagnostic(error, code, error.getStatus()),
          };
        },
      );
    },
  );
  return pending;
}

export function expectSafeFinancialDiagnostic(
  diagnostic: ReturnType<typeof buildAdminDiagnostic>,
) {
  const serialized = JSON.stringify(diagnostic);
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(24 * 1024);
  for (const key of [
    'balanceAmount',
    'reservedAmount',
    'reservedQuantity',
    'averageCost',
    'realizedPnl',
    'netAmount',
    'grossAmount',
    'feeAmount',
    'providerPayload',
  ]) {
    expect(serialized).not.toContain(`"${key}":`);
  }
  expect(JSON.stringify(diagnostic?.evidence)).not.toMatch(
    /"(?:quantity|amount|balance|pnl)":/i,
  );
  for (const sentinel of [
    'foreign-account',
    'foreign-asset',
    'foreign-wallet',
    'foreign-position',
    '987654.12345678',
  ])
    expect(serialized).not.toContain(sentinel);
}
