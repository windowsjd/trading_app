import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
  buildAdminPartialFailureDiagnostic,
  recordAdminDiagnosticEvent,
  setAdminDiagnosticContext,
  preserveAdminFailureCause,
} from './admin-diagnostics';
import {
  BadRequestException,
  ConsoleLogger,
  HttpException,
} from '@nestjs/common';
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
  it('pins the active financial failure step when preserving a generic wrapper cause', () => {
    const diagnostic = inRequest('admin', 'req-financial-cause', () => {
      setAdminDiagnosticContext({ failureStage: 'position_create' });
      const exception = preserveAdminFailureCause(
        new HttpException(
          {
            success: false,
            error: {
              code: 'ORDER_EXECUTION_TRANSACTION_FAILED',
              message: 'Order execution transaction failed.',
            },
          },
          500,
        ),
        Object.assign(new Error('private DB detail'), { code: 'P2002' }),
      );
      setAdminDiagnosticContext({ failureStage: 'later_step' });
      return buildAdminDiagnostic(
        exception,
        'ORDER_EXECUTION_TRANSACTION_FAILED',
        500,
      );
    });
    expect(diagnostic).toMatchObject({
      failureStage: 'position_create',
      evidence: {
        safeCause: { category: 'db_unique_constraint', code: 'P2002' },
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private DB detail');
  });
  it('redacts multiline private key material before splitting exception stack frames', () => {
    const error = new Error(
      '-----BEGIN PRIVATE KEY-----\nsynthetic-pem-material\n-----END PRIVATE KEY-----',
    );
    const diagnostic = inRequest('admin', 'req-pem', () =>
      buildAdminDiagnostic(error, 'INTERNAL_ERROR', 500),
    );
    expect(JSON.stringify(diagnostic)).not.toContain('synthetic-pem-material');
    expect(diagnostic?.exception.applicationStack.length).toBeGreaterThan(0);
  });
  it('redacts escaped JSON messages in errors and actual application logs', () => {
    const text = JSON.stringify({
      event: 'provider_error',
      message: JSON.stringify({ apiKey: 'synthetic-escaped-secret' }),
    });
    const diagnostic = inRequest('admin', 'req-escaped', () => {
      applicationLogger.warn(text, 'ProviderService');
      return buildAdminDiagnostic(new Error(text), 'INTERNAL_ERROR', 500);
    });
    expect(JSON.stringify(diagnostic)).not.toContain(
      'synthetic-escaped-secret',
    );
    expect(diagnostic?.exception.message).toBe('[REDACTED]');
    expect(diagnostic?.serverLogs.entries[0].message).toBe('[REDACTED]');
  });
  it('redacts normalized keys, embedded JSON and console arguments end to end', () => {
    const consoleSpy = jest
      .spyOn(ConsoleLogger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const diagnostic = inRequest('admin', 'req-expanded-redaction', () => {
        setAdminDiagnosticContext({
          evidence: {
            privateKey: 'fake-private',
            RawPayload: { data: 'fake-body' },
            'provider.payload': 'fake-provider-body',
            databaseUrl: 'fake-db-url',
            'kis app key': 'fake-app-key',
            idempotencyKey: 'safe-command',
          },
        });
        const text =
          '{"apiKey":"fake-api-key","refreshToken":"fake-refresh","authorization":"Bearer fake-auth","jwtSecret":"fake-jwt"}';
        applicationLogger.warn(
          text,
          { providerPayload: 'fake-logger-body' },
          'TestService',
        );
        recordAdminDiagnosticEvent('warn', 'TEST', text);
        return buildAdminDiagnostic(new Error(text), 'INTERNAL_ERROR', 500);
      });
      const serialized = JSON.stringify(diagnostic);
      for (const secret of [
        'fake-private',
        'fake-body',
        'fake-provider-body',
        'fake-db-url',
        'fake-app-key',
        'fake-api-key',
        'fake-refresh',
        'fake-auth',
        'fake-jwt',
        'fake-logger-body',
      ]) {
        expect(serialized).not.toContain(secret);
        expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(secret);
      }
      expect(diagnostic?.evidence?.idempotencyKey).toBe('safe-command');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it.each([
    ['Domain message', 'Domain message'],
    [{ message: 'Nest message' }, 'Nest message'],
    [
      {
        success: false,
        error: { code: 'DOMAIN', message: 'Safe domain message' },
      },
      'Safe domain message',
    ],
    [
      { message: ['First validation', 'Second validation'] },
      'First validation; Second validation',
    ],
  ])('preserves structured HTTP messages (%j)', (response, expected) => {
    const exception = new HttpException(response, 400);
    const original = exception.getResponse();
    const diagnostic = inRequest('admin', 'req-http-message', () =>
      buildAdminDiagnostic(exception, 'DOMAIN', 400),
    );
    expect(diagnostic?.exception.message).toBe(expected);
    expect(exception.getResponse()).toBe(original);
    expect(exception.getStatus()).toBe(400);
  });

  it.each([
    null,
    42,
    [],
    { message: { unexpected: true } },
    { success: false, error: null },
    { message: [1, null] },
  ])('fails safely for malformed HTTP responses (%j)', (response) => {
    const exception = new BadRequestException();
    jest.spyOn(exception, 'getResponse').mockReturnValue(response as never);
    expect(() =>
      inRequest('admin', 'req-malformed', () =>
        buildAdminDiagnostic(exception, 'INVALID', 400),
      ),
    ).not.toThrow();
  });

  it('handles an unreadable HTTP response and non-string stack', () => {
    const exception = new BadRequestException();
    jest.spyOn(exception, 'getResponse').mockImplementation(() => {
      throw new Error('malformed getter');
    });
    Object.defineProperty(exception, 'stack', { value: 123 });
    const diagnostic = inRequest('admin', 'req-unreadable', () =>
      buildAdminDiagnostic(exception, 'INVALID', 400),
    );
    expect(diagnostic?.exception.message).toBe('Bad Request');
    expect(diagnostic?.exception.stack).toEqual([]);
  });

  it('preserves only whitelisted cause classification and never the raw wrapped message', () => {
    const cause = Object.assign(
      new Error('fake-db-message with unlabeled fake-private-value'),
      { code: 'P2034' },
    );
    const wrapper = preserveAdminFailureCause(
      new HttpException(
        {
          success: false,
          error: {
            code: 'EXECUTE_TRANSACTION_FAILED',
            message: 'Transaction failed.',
          },
        },
        500,
      ),
      cause,
      'fx_execute_financial_write',
    );
    const diagnostic = inRequest('admin', 'req-wrapped', () =>
      buildAdminDiagnostic(wrapper, 'EXECUTE_TRANSACTION_FAILED', 500),
    );
    expect(diagnostic).toMatchObject({
      failureStage: 'fx_execute_financial_write',
      evidence: {
        failedStep: 'fx_execute_financial_write',
        safeCause: {
          category: 'db_transaction_conflict',
          code: 'P2034',
          errorType: 'Error',
        },
      },
      exception: {
        message: 'Transaction failed.',
        cause: 'Error: db_transaction_conflict (P2034)',
      },
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /fake-db-message|fake-private-value/,
    );
    expect(wrapper).not.toHaveProperty('cause');
  });

  it('does not retain unknown cause codes or custom error names', () => {
    const cause = Object.assign(new Error('unlabeled-secret'), {
      name: 'secret-name',
      code: 'constructor',
    });
    const wrapper = preserveAdminFailureCause(
      new Error('Internal failure'),
      cause,
      'safe_step',
    );
    const diagnostic = inRequest('admin', 'req-unknown-cause', () =>
      buildAdminDiagnostic(wrapper, 'INTERNAL_ERROR', 500),
    );
    expect(diagnostic?.evidence?.safeCause).toEqual({
      category: 'unexpected_error',
      errorType: 'Error',
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /unlabeled-secret|secret-name|constructor/,
    );
  });

  it('never infers admin access before authentication resolves the DB role', () => {
    const request = {
      method: 'GET',
      originalUrl: '/api/v1/assets?authorization=fake-secret',
      headers: {},
      user: undefined,
    };
    adminDiagnosticRequestMiddleware(
      request as never,
      { setHeader: jest.fn() } as never,
      () => {
        expect(
          buildAdminDiagnostic(new Error('failure'), 'INTERNAL_ERROR', 500),
        ).toBeUndefined();
        expect(
          buildAdminPartialFailureDiagnostic(
            new Error('failure'),
            'INTERNAL_ERROR',
            { evidence: { local: true } },
          ),
        ).toBeUndefined();
      },
    );
    expect(
      buildAdminDiagnostic(new Error('failure'), 'INTERNAL_ERROR', 500),
    ).toBeUndefined();
  });

  it('isolates two concurrent partial failures with explicit local evidence and retains bounds', async () => {
    const diagnostics = await inRequest('admin', 'req-parallel-partial', () => {
      setAdminDiagnosticContext({
        evidence: { unrelated: 'shared-request-data' },
        entities: { assetId: 'shadow' },
      });
      return Promise.all(
        ['a', 'b'].map(async (row) => {
          await Promise.resolve();
          return buildAdminPartialFailureDiagnostic(
            new Error(`row-${row}`),
            'ASSET_PRICE_UNAVAILABLE',
            {
              entities: { assetId: row },
              evidence: {
                row,
                provider: `provider-${row}`,
                privateKey: `secret-${row}`,
                nested: { a: { b: { c: { d: { e: 'deep' } } } } },
                values: Array.from({ length: 60 }, () => 'x'.repeat(100)),
              },
            },
          );
        }),
      );
    });
    for (const [index, row] of ['a', 'b'].entries()) {
      const diagnostic = diagnostics[index];
      expect(diagnostic?.evidence?.row).toBe(row);
      expect(JSON.stringify(diagnostic)).not.toMatch(
        /shared-request-data|shadow|secret-|deep/,
      );
      expect(JSON.stringify(diagnostic)).not.toContain(
        `provider-${row === 'a' ? 'b' : 'a'}`,
      );
      expect(
        Buffer.byteLength(JSON.stringify(diagnostic), 'utf8'),
      ).toBeLessThanOrEqual(24 * 1024);
      expect(diagnostic?.truncated).toBe(true);
    }
  });
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
