import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
  buildAdminPartialFailureDiagnostic,
  recordAdminDiagnosticEvent,
  setAdminDiagnosticContext,
} from './admin-diagnostics';

type Role = 'user' | 'operator' | 'admin';

function inRequest<T>(
  role: Role,
  requestId: string,
  callback: () => T,
  url = '/api/v1/trading-accounts/account-1/orders',
): T {
  const request = {
    method: 'POST',
    originalUrl: url,
    headers: { 'x-request-id': requestId },
    user: { userId: `${role}-1`, role },
  };
  const response = { setHeader: jest.fn() };
  let result: T | undefined;

  adminDiagnosticRequestMiddleware(request as never, response as never, () => {
    result = callback();
  });

  expect(response.setHeader).toHaveBeenCalledWith('x-request-id', requestId);
  return result as T;
}

describe('admin request diagnostics', () => {
  it.each(['user', 'operator'] as const)(
    'does not build a diagnostic payload for %s',
    (role) => {
      const diagnostic = inRequest(role, `req-${role}`, () =>
        buildAdminDiagnostic(new Error('private failure'), 'PRICE_STALE', 503),
      );

      expect(diagnostic).toBeUndefined();
    },
  );

  it('uses the current request role and includes actual decision evidence for admin', () => {
    const diagnostic = inRequest('admin', 'req-admin', () => {
      setAdminDiagnosticContext({
        failureStage: 'execution_price_selection',
        entities: { assetId: 'asset-1', quoteId: 'quote-1' },
        evidence: {
          provider: 'KIS',
          capturedAt: '2026-09-14T06:30:11.000Z',
          requestTime: '2026-09-14T06:30:25.000Z',
          freshnessAgeSeconds: 14,
          allowedFreshnessSeconds: 10,
          selectionResult: 'REJECTED',
          rejectedReason: 'captured_at_stale',
        },
      });
      recordAdminDiagnosticEvent(
        'warn',
        'ORDER_EXECUTION_PRICE_REJECTED',
        'Price selection rejected.',
      );
      return buildAdminDiagnostic(
        new Error('Provider asset price is stale.'),
        'PRICE_STALE',
        503,
      );
    });

    expect(diagnostic).toMatchObject({
      code: 'PRICE_STALE',
      httpStatus: 503,
      requestId: 'req-admin',
      domain: 'ORDER',
      operation: 'ORDER_CREATE',
      failureStage: 'execution_price_selection',
      entities: {
        tradingAccountId: 'account-1',
        assetId: 'asset-1',
        quoteId: 'quote-1',
      },
      evidence: {
        freshnessAgeSeconds: 14,
        allowedFreshnessSeconds: 10,
        selectionResult: 'REJECTED',
      },
    });
    expect(diagnostic?.exception.applicationStack.length).toBeGreaterThan(0);
    expect(diagnostic?.serverLogs.events.map((event) => event.event)).toEqual([
      'HTTP_REQUEST_RECEIVED',
      'ORDER_EXECUTION_PRICE_REJECTED',
      'REQUEST_FAILED',
    ]);
  });

  it('redacts secrets in evidence, messages, causes, stack, and log metadata', () => {
    const diagnostic = inRequest('admin', 'req-redaction', () => {
      setAdminDiagnosticContext({
        evidence: {
          password: 'Password123!',
          nested: { apiKey: 'provider-key-123' },
          database: 'postgresql://user:db-pass@db.example/app',
        },
      });
      recordAdminDiagnosticEvent(
        'error',
        'PROVIDER_FAILED',
        'authorization=Bearer raw-token-123',
        { refreshToken: 'refresh-token-123' },
      );
      const error = new Error('secret=raw-secret-123');
      error.cause = new Error('password=raw-password-123');
      return buildAdminDiagnostic(error, 'INTERNAL_SERVER_ERROR', 500);
    });
    const serialized = JSON.stringify(diagnostic);

    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('Password123!');
    expect(serialized).not.toContain('provider-key-123');
    expect(serialized).not.toContain('db-pass');
    expect(serialized).not.toContain('raw-token-123');
    expect(serialized).not.toContain('refresh-token-123');
    expect(serialized).not.toContain('raw-secret-123');
    expect(serialized).not.toContain('raw-password-123');
  });

  it('bounds logs and total payload and reports truncation', () => {
    const diagnostic = inRequest('admin', 'req-bounds', () => {
      setAdminDiagnosticContext({
        evidence: { oversized: 'x'.repeat(100_000) },
      });
      for (let index = 0; index < 30; index += 1) {
        recordAdminDiagnosticEvent('info', `EVENT_${index}`, 'y'.repeat(2_000));
      }
      return buildAdminDiagnostic(new Error('bounded'), 'PRICE_STALE', 503);
    });

    expect(diagnostic?.serverLogs.events.length).toBeLessThanOrEqual(20);
    expect(diagnostic?.serverLogs.truncated).toBe(true);
    expect(diagnostic?.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(diagnostic), 'utf8'),
    ).toBeLessThanOrEqual(24 * 1024);
  });

  it('keeps the hard byte bound even when many entity and evidence values are oversized', () => {
    const values = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `field${index}`,
        'z'.repeat(2_000),
      ]),
    );
    const diagnostic = inRequest('admin', 'req-hard-bound', () => {
      setAdminDiagnosticContext({ entities: values, evidence: values });
      return buildAdminDiagnostic(
        new Error('m'.repeat(10_000)),
        'INTERNAL_SERVER_ERROR',
        500,
      );
    });

    expect(diagnostic?.truncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(diagnostic), 'utf8'),
    ).toBeLessThanOrEqual(24 * 1024);
  });

  it('isolates related logs by request context', () => {
    inRequest('admin', 'req-first', () => {
      recordAdminDiagnosticEvent('warn', 'FIRST_ONLY', 'first request');
      return buildAdminDiagnostic(new Error('first'), 'FIRST', 500);
    });
    const second = inRequest('admin', 'req-second', () => {
      recordAdminDiagnosticEvent('warn', 'SECOND_ONLY', 'second request');
      return buildAdminDiagnostic(new Error('second'), 'SECOND', 500);
    });
    const serialized = JSON.stringify(second);

    expect(serialized).toContain('SECOND_ONLY');
    expect(serialized).not.toContain('FIRST_ONLY');
    expect(second?.requestId).toBe('req-second');
  });

  it('supports an admin-only HTTP 200 partial valuation failure', () => {
    const adminDiagnostic = inRequest(
      'admin',
      'req-partial',
      () =>
        buildAdminPartialFailureDiagnostic(
          new Error('No eligible valuation snapshot.'),
          'ASSET_PRICE_UNAVAILABLE',
          {
            failureStage: 'asset_valuation',
            entities: { assetId: 'asset-2' },
            evidence: {
              selectionResult: 'REJECTED',
              rejectedReason: 'captured_at_stale',
            },
          },
        ),
      '/api/v1/trading-accounts/account-1/portfolio',
    );
    const userDiagnostic = inRequest(
      'user',
      'req-partial-user',
      () =>
        buildAdminPartialFailureDiagnostic(
          new Error('No eligible valuation snapshot.'),
          'ASSET_PRICE_UNAVAILABLE',
          { failureStage: 'asset_valuation' },
        ),
      '/api/v1/trading-accounts/account-1/portfolio',
    );

    expect(adminDiagnostic).toMatchObject({
      code: 'ASSET_PRICE_UNAVAILABLE',
      httpStatus: 200,
      domain: 'PORTFOLIO',
      failureStage: 'asset_valuation',
      entities: { assetId: 'asset-2' },
    });
    expect(userDiagnostic).toBeUndefined();
  });
});
