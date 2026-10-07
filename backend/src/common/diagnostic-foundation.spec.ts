import { Logger, type ArgumentsHost } from '@nestjs/common';
import { createApiError } from './api-error';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminDiagnostic,
  setAdminDiagnosticContext,
  type AdminDiagnostic,
} from './admin-diagnostics';
import { GlobalHttpExceptionFilter } from './global-http-exception.filter';
import {
  assertDiagnosticBaseline,
  assertPreAuthFailure,
  diagnosticQualityGaps,
} from '../../scripts/lib/diagnostic-quality';
import { projectOpsFailure } from '../ops/ops-failure';
import { sanitizeOpsJson } from '../ops/ops-redaction';

const raw =
  'Authorization Bearer fake-token postgres://fake:fake@db.invalid/db https://provider.invalid/body SELECT private_wallet 987654.12345678 {"nested":{"secret":"fake-nested"}}';

function http(role: string | undefined, route: string, action: () => unknown) {
  const request = {
    method: 'GET',
    originalUrl: route,
    headers: { 'x-request-id': 'foundation-request' },
    ...(role ? { user: { userId: 'user-1', role } } : {}),
  };
  let body!: {
    error: { code: string; message: string; diagnostic?: AdminDiagnostic };
  };
  const response = {
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: (value: typeof body) => {
      body = value;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ArgumentsHost;
  adminDiagnosticRequestMiddleware(request as never, response as never, () => {
    new GlobalHttpExceptionFilter().catch(action(), host);
  });
  return body;
}

describe('Diagnostic Enforcement Foundation', () => {
  it('does not promote admin-reviewed Provider details into public copy or accept private code text', () => {
    const message = http(
      'admin',
      '/api/v1/trading-accounts/account-1/futures/positions',
      () =>
        createApiError(
          'NEW_SYNTHETIC_ERROR',
          'binance HTTP 503 (PROVIDER_HTTP_ERROR).',
          503,
        ),
    ).error.message;
    expect(message).toBe('Request could not be completed.');
    const body = http(
      'admin',
      '/api/v1/trading-accounts/account-1/futures/positions',
      () => createApiError(raw, raw, 500),
    );
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(body)).not.toMatch(
      /fake-token|db.invalid|provider.invalid|987654|fake-nested/,
    );
  });
  it('logs unexpected pre-auth failures safely without exposing an admin bypass', () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    try {
      const body = http(undefined, '/api/v1/auth/login', () => new Error(raw));
      expect(body.error.diagnostic).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('pre_auth_http'),
      );
      assertPreAuthFailure(
        body,
        'backend/src/auth/auth.controller.ts#login',
        log.mock.calls.map((call) => String(call[0])),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /fake-token|db.invalid|provider.invalid|private_wallet|987654|fake-nested/,
      );
    } finally {
      log.mockRestore();
    }
  });
  it('route contracts reject generic workflow context and accept observed Futures context', () => {
    const generic = http('admin', '/api/v1/new-feature', () =>
      createApiError(
        'NEW_SYNTHETIC_ERROR',
        'Request could not be completed.',
        409,
      ),
    );
    expect(() =>
      assertDiagnosticBaseline(
        generic.error.diagnostic,
        'backend/src/feature/feature.controller.ts#read',
      ),
    ).toThrow('route domain');
    const routed = http(
      'admin',
      '/api/v1/trading-accounts/account-1/futures/instruments',
      () =>
        createApiError(
          'NEW_SYNTHETIC_ERROR',
          'Request could not be completed.',
          409,
        ),
    );
    assertDiagnosticBaseline(
      routed.error.diagnostic,
      'backend/src/futures/futures.controller.ts#instruments',
    );
    expect(() =>
      assertDiagnosticBaseline(
        { ...routed.error.diagnostic!, operation: 'FUTURES_REQUEST_READ' },
        'backend/src/feature/feature.controller.ts#read',
      ),
    ).toThrow('workflow operation');
  });
  it.each(['instruments', 'positions', 'executions', 'liquidations'])(
    'automatically supplies the %s route baseline for an unregistered code',
    (action) => {
      const body = http(
        'admin',
        `/api/v1/trading-accounts/account-1/futures/${action}?token=private-query`,
        () => createApiError('NEW_SYNTHETIC_ERROR', raw, 409),
      );
      expect(body.error.diagnostic).toMatchObject({
        code: 'NEW_SYNTHETIC_ERROR',
        httpStatus: 409,
        requestId: 'foundation-request',
        domain: 'FUTURES',
        operation: `FUTURES_${action.toUpperCase()}_READ`,
        failureStage: 'request_boundary',
        nextInvestigation: ['backend/src/futures/futures.service.ts'],
      });
      expect(diagnosticQualityGaps(body.error.diagnostic, 'baseline')).toEqual(
        [],
      );
      expect(JSON.stringify(body)).not.toMatch(
        /fake-token|db.invalid|provider.invalid|private_wallet|987654|fake-nested|private-query/,
      );
    },
  );
  it.each(['user', 'operator', undefined])(
    'keeps automatic diagnostics away from role=%s',
    (role) => {
      const body = http(
        role,
        '/api/v1/trading-accounts/account-1/futures/positions',
        () => createApiError('NEW_SYNTHETIC_ERROR', raw, 503),
      );
      expect(body.error.diagnostic).toBeUndefined();
      expect(body.error.code).toBe('NEW_SYNTHETIC_ERROR');
      expect(body.error.message).toBe('Request could not be completed.');
    },
  );
  it('preserves reviewed domain copy independently of the code', () => {
    expect(
      http('admin', '/api/v1/trading-accounts/account-1/futures/execute', () =>
        createApiError(
          'NEW_SYNTHETIC_ERROR',
          'Futures trading is disabled.',
          409,
        ),
      ).error.message,
    ).toBe('Futures trading is disabled.');
  });
  it('detects a present but insufficient diagnostic without guessing a cause', () => {
    const diagnostic = http(
      'admin',
      '/api/v1/new-feature',
      () => new Error(raw),
    ).error.diagnostic;
    expect(diagnosticQualityGaps(diagnostic, 'triage')).toEqual(
      expect.arrayContaining([
        'domain',
        'meaningful failureStage',
        'observed evidence',
        'nextInvestigation',
      ]),
    );
    expect(diagnostic?.failureStage).toBe('request_boundary');
    expect(JSON.stringify(diagnostic)).not.toMatch(
      /fake-token|db.invalid|987654|fake-nested/,
    );
  });
  it('accepts an observed transaction step/classification while rejecting missing enrichment', () => {
    const error = Object.assign(new Error(raw), { code: 'P2034' });
    const diagnostic = http(
      'admin',
      '/api/v1/trading-accounts/account-1/futures/execute',
      () => {
        setAdminDiagnosticContext({
          failureStage: 'futures_execution_evidence_write',
        });
        return error;
      },
    ).error.diagnostic;
    expect(diagnosticQualityGaps(diagnostic, 'triage')).toEqual([]);
    expect(diagnostic?.evidence?.safeCause).toMatchObject({
      category: 'db_transaction_conflict',
    });
  });
  it('does not store arbitrary SDK exception codes as an Ops diagnostic', () => {
    const failure = projectOpsFailure(
      Object.assign(new Error(raw), { code: 'FAKE_PRIVATE_TOKEN' }),
    );
    expect(JSON.stringify(failure)).not.toMatch(
      /FAKE_PRIVATE_TOKEN|db.invalid|987654/,
    );
    expect(failure.code).toBe('OPS_JOB_FAILED');
  });
  it('projects a synthetic background code only to bounded Ops, keeping numeric Ops facts', () => {
    const failure = projectOpsFailure(
      Object.assign(new Error(raw), { code: 'NEW_SYNTHETIC_BACKGROUND_ERROR' }),
      'NEW_SYNTHETIC_BACKGROUND_ERROR',
    );
    expect(failure).toMatchObject({
      code: 'NEW_SYNTHETIC_BACKGROUND_ERROR',
      message: 'Background operation failed.',
    });
    expect(buildAdminDiagnostic(failure, failure.code, 500)).toBeUndefined();
    const projected = sanitizeOpsJson({
      failure,
      accountId: 'account-1',
      count: 42,
      settlementTotal: '123.45678900',
      errors: Array(1500).fill(new Error(raw)),
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /fake-token|db.invalid|provider.invalid|private_wallet|987654|fake-nested/,
    );
    expect(projected).toMatchObject({
      accountId: 'account-1',
      count: 42,
      settlementTotal: '123.45678900',
    });
    expect((projected as { errors: unknown[] }).errors).toHaveLength(1000);
  });
});
