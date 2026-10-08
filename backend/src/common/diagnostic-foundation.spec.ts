import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

function http(
  role: string | undefined,
  route: string,
  action: () => unknown,
  method = 'GET',
) {
  const request = {
    method,
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
  it.each([
    ['wallets', 'GET', 'WALLET_WALLETS_READ', 'wallets.service.ts'],
    [
      'wallet-transactions',
      'GET',
      'WALLET_TRANSACTIONS_READ',
      'wallets.service.ts',
    ],
    [
      'wallet-transfers',
      'POST',
      'WALLET_TRANSFER',
      'trading-account-wallet-transfer.service.ts',
    ],
    [
      'wallet-transfers/quote',
      'POST',
      'WALLET_TRANSFER_QUOTE',
      'trading-account-wallet-fx-transfer.service.ts',
    ],
    [
      'wallet-transfers/execute',
      'POST',
      'WALLET_TRANSFER_EXECUTE',
      'trading-account-wallet-fx-transfer.service.ts',
    ],
  ])(
    'resolves the responsible Wallet service for %s',
    (route, method, operation, file) => {
      for (const role of ['user', 'operator', 'admin']) {
        const body = http(
          role,
          `/api/v1/trading-accounts/account-1/${route}`,
          () =>
            createApiError('WALLET_FAILURE', 'Source wallet not found', 409),
          method,
        );
        if (role !== 'admin') {
          expect(body.error.diagnostic).toBeUndefined();
          continue;
        }
        const diagnostic = body.error.diagnostic!;
        expect(diagnostic).toMatchObject({
          domain: 'WALLET',
          operation,
          failureStage: 'request_boundary',
        });
        const path = `backend/src/wallets/${file}`;
        expect(diagnostic.nextInvestigation).toContain(path);
        expect(existsSync(resolve(__dirname, '../../..', path))).toBe(true);
      }
    },
  );

  it.each([
    ['PROTECTION_POSITION_UNAVAILABLE', 'An open position is required.', true],
    [
      'PROTECTION_POSITION_UNAVAILABLE',
      'An open Futures lifetime is required.',
      true,
    ],
    ['PROTECTION_CHILD_CHANGED', 'Protection changed before execution.', true],
    [
      'PROTECTION_CHILD_CHANGED',
      'The protected Futures lifetime changed.',
      true,
    ],
    [
      'CONDITIONAL_LIMIT_UNAVAILABLE',
      'Spot Limit registration and matching must be available.',
      false,
    ],
    [
      'FUTURES_FINAL_SETTLEMENT_REQUIRED',
      'Season final results require all Futures positions to be closed.',
      true,
    ],
    [
      'SEASON_NOT_ENDED',
      'Futures final settlement requires an ended Season.',
      true,
    ],
    [
      'OPEN_LIMIT_ORDER_RESERVATIONS',
      'Release all Season reservations before final settlement.',
      true,
    ],
    [
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'Final Futures settlement price is unavailable.',
      true,
    ],
    [
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'A fresh final execution price at Season end is required.',
      true,
    ],
    [
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'Final Futures settlement price could not be verified.',
      false,
    ],
    [
      'FUTURES_FINAL_EVIDENCE_INTEGRITY',
      'Season final settlement terms could not be verified.',
      false,
    ],
    [
      'FUTURES_FINAL_SETTLEMENT_INTEGRITY',
      'Final Futures settlement lifecycle could not be verified.',
      false,
    ],
  ] as const)(
    'preserves the public/admin boundary for %s: %s',
    (code, message, publicSafe) => {
      for (const role of ['user', 'operator', 'admin']) {
        const exception = createApiError(code, message, 409);
        expect(exception.getStatus()).toBe(409);
        const body = http(
          role,
          '/api/v1/trading-accounts/account-1/futures/execute',
          () => exception,
          'POST',
        );
        expect(body.error).toMatchObject({
          code,
          message: publicSafe ? message : 'Request could not be completed.',
        });
        if (role === 'admin')
          expect(body.error.diagnostic?.exception.message).toBe(message);
        else {
          expect(body.error.diagnostic).toBeUndefined();
          if (!publicSafe) expect(JSON.stringify(body)).not.toContain(message);
        }
      }
    },
  );

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
  it.each(['user', 'operator', 'admin', undefined])(
    'keeps diagnostic-only product factory copy out of the public response for %s',
    (role) => {
      for (const message of [
        'Limit order cancel service is not wired.',
        'Participant has no trading account link; run trading-accounts:repair-links.',
        'Trading account access service unavailable',
      ]) {
        const body = http(
          role,
          '/api/v1/trading-accounts/account-1/wallets',
          () => createApiError('NEW_DOMAIN_CODE', message, 409),
        );
        expect(body.error.message).toBe('Request could not be completed.');
        expect(Boolean(body.error.diagnostic)).toBe(role === 'admin');
      }
    },
  );
  it.each([
    ['GET', 'wallets', 'WALLET_WALLETS_READ'],
    ['POST', 'wallet-transfers', 'WALLET_TRANSFER'],
    ['POST', 'wallet-transfers/quote', 'WALLET_TRANSFER_QUOTE'],
    ['POST', 'wallet-transfers/execute', 'WALLET_TRANSFER_EXECUTE'],
    ['GET', 'wallet-transactions', 'WALLET_TRANSACTIONS_READ'],
  ])(
    'maps the real %s %s workflow without inferring a failure stage',
    (method, path, operation) => {
      const body = http(
        'admin',
        `/api/v1/trading-accounts/account-1/${path}?token=private-query`,
        () =>
          createApiError(
            'WALLET_TRANSACTION_FAILURE',
            'Request could not be completed.',
            503,
          ),
        method,
      );
      expect(body.error.diagnostic).toMatchObject({
        domain: 'WALLET',
        operation,
        failureStage: 'request_boundary',
        entities: { tradingAccountId: 'account-1' },
        nextInvestigation: [
          path === 'wallet-transfers'
            ? 'backend/src/wallets/trading-account-wallet-transfer.service.ts'
            : path.startsWith('wallet-transfers/')
              ? 'backend/src/wallets/trading-account-wallet-fx-transfer.service.ts'
              : 'backend/src/wallets/wallets.service.ts',
        ],
      });
      expect(JSON.stringify(body)).not.toContain('private-query');
    },
  );
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
  it('supplies account-scoped Conditional read/create/cancel diagnostics', () => {
    const action = () =>
      createApiError(
        'PROTECTION_CONFLICT',
        'Request could not be completed.',
        409,
      );
    const read = http(
      'admin',
      '/api/v1/trading-accounts/account-1/protections',
      action,
    );
    const create = http(
      'admin',
      '/api/v1/trading-accounts/account-1/protections',
      action,
      'POST',
    );
    const cancel = http(
      'admin',
      '/api/v1/trading-accounts/account-1/protections/group-1/cancel',
      action,
      'POST',
    );
    assertDiagnosticBaseline(
      read.error.diagnostic,
      'backend/src/conditional/conditional.controller.ts#list',
    );
    assertDiagnosticBaseline(
      create.error.diagnostic,
      'backend/src/conditional/conditional.controller.ts#create',
    );
    assertDiagnosticBaseline(
      cancel.error.diagnostic,
      'backend/src/conditional/conditional.controller.ts#cancel',
    );
    expect(read.error.diagnostic?.operation).toBe(
      'CONDITIONAL_PROTECTION_READ',
    );
    expect(create.error.diagnostic?.operation).toBe(
      'CONDITIONAL_PROTECTION_CREATE',
    );
    expect(cancel.error.diagnostic?.operation).toBe(
      'CONDITIONAL_PROTECTION_CANCEL',
    );
    expect(cancel.error.diagnostic?.entities).toMatchObject({
      tradingAccountId: 'account-1',
    });
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
  it.each([
    'instruments',
    'positions',
    'executions',
    'liquidations',
    'final-settlement',
  ])(
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
        operation: `FUTURES_${action.replace(/-/g, '_').toUpperCase()}_READ`,
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
