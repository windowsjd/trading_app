import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
  buildAdminPartialFailureDiagnostic,
  recordAdminDiagnosticEvent,
  setAdminDiagnosticContext,
} from './admin-diagnostics';
import { AdminDiagnosticLogger } from './admin-diagnostic.logger';

type Role = 'user' | 'operator' | 'admin';

class SilentAdminDiagnosticLogger extends AdminDiagnosticLogger {
  protected override printMessages(): void {}
}

const applicationLogger = new SilentAdminDiagnosticLogger();

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
    expect(
      diagnostic?.diagnosticEvents.events.map((event) => event.event),
    ).toEqual([
      'HTTP_REQUEST_RECEIVED',
      'ORDER_EXECUTION_PRICE_REJECTED',
      'REQUEST_FAILED',
    ]);
    expect(diagnostic?.serverLogs.entries).toEqual([]);
  });

  it('separates actual application logs from diagnostic events and redacts both', () => {
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
      applicationLogger.warn(
        'provider failed authorization=Bearer logger-token-123',
        { password: 'logger-password-123' },
        'ProviderService',
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
    expect(serialized).not.toContain('logger-token-123');
    expect(serialized).not.toContain('logger-password-123');
    expect(serialized).not.toContain('refresh-token-123');
    expect(serialized).not.toContain('raw-secret-123');
    expect(serialized).not.toContain('raw-password-123');
    expect(diagnostic?.diagnosticEvents.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'PROVIDER_FAILED' }),
      ]),
    );
    expect(diagnostic?.serverLogs.entries).toEqual([
      expect.objectContaining({
        level: 'warn',
        context: 'ProviderService',
      }),
    ]);
  });

  it('bounds logs and total payload and reports truncation', () => {
    const diagnostic = inRequest('admin', 'req-bounds', () => {
      setAdminDiagnosticContext({
        evidence: { oversized: 'x'.repeat(100_000) },
      });
      for (let index = 0; index < 30; index += 1) {
        recordAdminDiagnosticEvent('info', `EVENT_${index}`, 'y'.repeat(2_000));
        applicationLogger.warn(
          `application log ${index} ${'q'.repeat(2_000)}`,
          'BoundedLogger',
        );
      }
      return buildAdminDiagnostic(new Error('bounded'), 'PRICE_STALE', 503);
    });

    expect(diagnostic?.diagnosticEvents.events.length).toBeLessThanOrEqual(20);
    expect(diagnostic?.diagnosticEvents.truncated).toBe(true);
    expect(diagnostic?.serverLogs.entries.length).toBeLessThanOrEqual(20);
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
      applicationLogger.error('FIRST_APPLICATION_LOG', 'FirstService');
      return buildAdminDiagnostic(new Error('first'), 'FIRST', 500);
    });
    const second = inRequest('admin', 'req-second', () => {
      recordAdminDiagnosticEvent('warn', 'SECOND_ONLY', 'second request');
      applicationLogger.error('SECOND_APPLICATION_LOG', 'SecondService');
      return buildAdminDiagnostic(new Error('second'), 'SECOND', 500);
    });
    const serialized = JSON.stringify(second);

    expect(serialized).toContain('SECOND_ONLY');
    expect(serialized).not.toContain('FIRST_ONLY');
    expect(serialized).not.toContain('FIRST_APPLICATION_LOG');
    expect(serialized).toContain('SECOND_APPLICATION_LOG');
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
    const operatorDiagnostic = inRequest(
      'operator',
      'req-partial-operator',
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
    expect(
      adminDiagnostic?.diagnosticEvents.events.map((event) => event.event),
    ).toEqual(['HTTP_REQUEST_RECEIVED', 'PARTIAL_FAILURE_RECORDED']);
    expect(userDiagnostic).toBeUndefined();
    expect(operatorDiagnostic).toBeUndefined();
  });

  it('builds a partial failure only from its failure-local snapshot', () => {
    const diagnostic = inRequest(
      'admin',
      'req-isolated-partial',
      () => {
        setAdminDiagnosticContext({
          failureStage: 'asset_price_selection',
          entities: {
            assetId: 'asset-a-shadow',
            snapshotId: 'snapshot-a-shadow',
          },
          evidence: { provider: 'provider-shadow', rejectedReason: 'b-reason' },
        });
        recordAdminDiagnosticEvent(
          'warn',
          'ASSET_B_REJECTED',
          'parallel asset B failed',
        );
        applicationLogger.warn(
          JSON.stringify({
            assetId: 'asset-a-shadow',
            snapshotId: 'snapshot-a-shadow',
          }),
          'PortfolioValuationService',
        );
        applicationLogger.warn(
          JSON.stringify({ assetId: 'asset-a', snapshotId: 'snapshot-a' }),
          'PortfolioService',
        );
        return buildAdminPartialFailureDiagnostic(
          new Error('asset A failed'),
          'ASSET_PRICE_UNAVAILABLE',
          {
            failureStage: 'asset_price_selection',
            entities: { assetId: 'asset-a', snapshotId: 'snapshot-a' },
            evidence: {
              provider: 'provider-a',
              rejectedReason: 'a-reason',
            },
          },
        );
      },
      '/api/v1/trading-accounts/account-1/portfolio',
    );
    const serialized = JSON.stringify(diagnostic);

    expect(diagnostic).toMatchObject({
      entities: {
        tradingAccountId: 'account-1',
        assetId: 'asset-a',
        snapshotId: 'snapshot-a',
      },
      evidence: {
        provider: 'provider-a',
        rejectedReason: 'a-reason',
      },
    });
    expect(serialized).not.toContain('asset-a-shadow');
    expect(serialized).not.toContain('snapshot-a-shadow');
    expect(serialized).not.toContain('provider-shadow');
    expect(serialized).not.toContain('ASSET_B_REJECTED');
    expect(diagnostic?.serverLogs.entries).toEqual([
      expect.objectContaining({
        context: 'PortfolioService',
        message: expect.stringContaining('asset-a'),
      }),
    ]);
  });
});
