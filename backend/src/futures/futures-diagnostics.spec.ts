import { emptyProtectionState } from '../../test/support/empty-protection-state';
jest.mock('./futures-performance.service', () => ({
  FuturesPerformanceService: class {
    async capture() {}
  },
}));
jest.mock('./futures-instrument-coverage', () => ({
  verifiedFuturesInstrument: () => true,
}));
jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
    PrismaClientKnownRequestError: class extends Error {},
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../trading-accounts/trading-account-access.service', () => ({
  TradingAccountAccessService: class {},
}));
jest.mock('../portfolio/general-account-performance.service', () => ({
  GeneralAccountPerformanceService: class {},
}));
jest.mock('./futures-last-price', () => ({
  ...jest.requireActual('./futures-last-price'),
  readFuturesLastPrice: jest.fn(),
}));
jest.mock('./futures-mark', () => ({ readFuturesMark: jest.fn() }));

import { HttpException, type ArgumentsHost } from '@nestjs/common';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';
import { GeneralAccountPerformanceService } from '../portfolio/general-account-performance.service';
import { FuturesService } from './futures.service';
import { readFuturesLastPrice } from './futures-last-price';
import { readFuturesMark } from './futures-mark';
import {
  adminDiagnosticRequestMiddleware,
  type AdminDiagnostic,
} from '../common/admin-diagnostics';
import { GlobalHttpExceptionFilter } from '../common/global-http-exception.filter';
import { safeDiagnosticMessage } from '../common/safe-diagnostic-message';
import { assertCrossSafe } from './futures-risk';
import { assertDiagnosticTriage } from '../../scripts/lib/diagnostic-quality';

const d = (value: string) => new Prisma.Decimal(value);
const now = new Date('2026-10-07T00:00:00Z');
const raw =
  'postgres://fake:fake-password@db.invalid/db https://provider.invalid/body Bearer fake-token SELECT wallet_balance FROM private_wallet 987654.12345678 76543.12345678 {"nested":{"secret":"fake-nested-secret"}}';
const forbidden =
  /db.invalid|provider.invalid|fake-token|private_wallet|987654\.12345678|76543\.12345678|fake-nested-secret/;

// Prisma returns Decimal columns even when writes used the string API contract.
function decimalRow(data: Record<string, unknown>) {
  const columns = new Set([
    'quantity',
    'averageEntryPrice',
    'entryNotional',
    'isolatedMargin',
    'realizedPnl',
    'executionPrice',
    'notional',
    'feeRate',
    'feeAmount',
    'positionQuantityAfter',
    'averageEntryPriceAfter',
    'isolatedMarginAfter',
  ]);
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      columns.has(key) && typeof value === 'string' ? d(value) : value,
    ]),
  );
}

async function failure(action: () => Promise<unknown>, role = 'admin') {
  const request = {
    method: 'POST',
    originalUrl: '/api/v1/trading-accounts/account-1/futures/execute',
    headers: { 'x-request-id': 'futures-p0-request' },
    user: { userId: 'user-1', role },
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
  let pending!: Promise<void>;
  adminDiagnosticRequestMiddleware(request as never, response as never, () => {
    pending = action().then(
      () => {
        throw new Error('Expected rejection');
      },
      (error: unknown) => new GlobalHttpExceptionFilter().catch(error, host),
    );
  });
  await pending;
  expect(JSON.stringify(body)).not.toMatch(forbidden);
  return { body, response, diagnostic: body.error.diagnostic };
}

function expectSafe(diagnostic: AdminDiagnostic | undefined) {
  expect(diagnostic).toBeDefined();
  expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThanOrEqual(
    24 * 1024,
  );
  expect(diagnostic?.exception.stack.length).toBeLessThanOrEqual(24);
  expect(diagnostic?.exception.applicationStack.length).toBeLessThanOrEqual(12);
  expect(diagnostic?.requestId).toBe('futures-p0-request');
  expect(diagnostic?.nextInvestigation).toContain(
    'backend/src/futures/futures.service.ts',
  );
  expect(JSON.stringify(diagnostic)).not.toMatch(
    /"(?:balance|reserved|marginUsed|marginAfter|feeAmount|realizedPnl|freeAfter|quantity|price|balanceAmount|reservedAmount)":/,
  );
}

describe('Futures existing execution diagnostic boundary', () => {
  const saved = { ...process.env };
  const instrument = {
    id: 'instrument-1',
    underlyingAssetId: 'asset-1',
    isActive: true,
    productType: 'synthetic_perpetual',
    settlementCurrency: 'USD',
    underlyingAsset: {
      id: 'asset-1',
      symbol: 'BTCUSDT',
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  };
  const command = {
    instrumentId: instrument.id,
    operation: 'open',
    direction: 'long',
    quantity: '1',
    leverage: 10,
    idempotencyKey: 'command-1',
  };
  let tx: any;
  let wallet: any;
  let service: FuturesService;
  beforeEach(() => {
    process.env.FUTURES_TRADING_MODE = 'ENABLED';
    process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
    wallet = {
      id: 'wallet-1',
      tradingAccountId: 'account-1',
      walletScope: 'crypto_futures',
      currencyCode: 'USD',
      balanceAmount: d('987654.12345678'),
      reservedAmount: d('76543.12345678'),
    };
    const wallets = [
      { ...wallet, walletScope: 'securities', currencyCode: 'KRW' },
      { ...wallet, walletScope: 'securities' },
      { ...wallet, walletScope: 'crypto_spot' },
      wallet,
    ];
    tx = {
      ...emptyProtectionState(),
      futuresLimitOrder: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      $queryRaw: jest.fn().mockResolvedValue([{ now }]),
      $executeRaw: jest.fn().mockResolvedValue(1),
      futuresExecuteRequest: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      futuresInstrument: {
        findUnique: jest.fn().mockResolvedValue(instrument),
      },
      cashWallet: {
        findMany: jest.fn().mockResolvedValue(wallets),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      futuresPosition: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest
          .fn()
          .mockResolvedValue({ _sum: { isolatedMargin: d('0') } }),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 'position-1',
          ...decimalRow(data),
        })),
        update: jest.fn(),
      },
      futuresExecution: {
        create: jest.fn().mockImplementation(({ data }) => decimalRow(data)),
      },
      walletTransaction: { createMany: jest.fn() },
    };
    tx.$transaction = jest.fn((work) => work(tx));
    jest.mocked(readFuturesLastPrice).mockResolvedValue({
      id: 'last-1',
      price: d('123.45678912'),
      source: 'binance_usdm_agg_trade_ws',
      effectiveAt: now,
      capturedAt: now,
    } as never);
    jest.mocked(readFuturesMark).mockResolvedValue({
      id: 'mark-1',
      price: d('123.45678912'),
      source: 'binance_usdm_mark_ws',
      effectiveAt: now,
      capturedAt: now,
    } as never);
    const access = {
      getOwnedAccountOrThrow: jest.fn().mockResolvedValue({
        id: 'account-1',
        mode: 'general',
        status: 'active',
      }),
    };
    service = new FuturesService(
      tx as PrismaService,
      access as unknown as TradingAccountAccessService,
      {
        assertGeneralAccountReady: jest.fn(),
      } as unknown as GeneralAccountPerformanceService,
    );
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each(['admin', 'operator', 'user'])(
    'rejects exact financial/raw error copies after a satisfied guard for %s',
    async (role) => {
      tx.futuresExecution.create.mockRejectedValueOnce(
        Object.assign(new Error(raw, { cause: new Error(raw) }), {
          code: 'P2034',
        }),
      );
      const { body, diagnostic } = await failure(
        () => service.execute('user-1', 'account-1', command),
        role,
      );
      expect(body.error.code).toBe('INTERNAL_SERVER_ERROR');
      if (role !== 'admin') expect(diagnostic).toBeUndefined();
      else {
        expectSafe(diagnostic);
        assertDiagnosticTriage(
          diagnostic,
          'INTERNAL_SERVER_ERROR',
          'backend/src/futures/futures.service.ts#execute',
        );
        expect(diagnostic).toMatchObject({
          domain: 'futures',
          operation: 'market_execute',
          failureStage: 'futures_execution_evidence_write',
          evidence: {
            safeCause: { category: 'db_transaction_conflict', code: 'P2034' },
            financialGuard: {
              walletScope: 'crypto_futures',
              walletFound: true,
              scopeValid: true,
              currencyMatched: true,
              reservedCashPresent: true,
              collateralSufficient: true,
              mutationResult: 'guard_satisfied',
            },
          },
        });
        expect(diagnostic?.exception.applicationStack.length).toBeGreaterThan(
          0,
        );
      }
    },
  );

  it('keeps reduction insufficiency meaning and predicates without balance/fee/PnL', async () => {
    wallet.balanceAmount = d('30.12345678');
    wallet.reservedAmount = d('5.12345678');
    tx.futuresPosition.findFirst.mockResolvedValue({
      id: 'position-1',
      direction: 'long',
      leverage: 10,
      marginMode: 'isolated',
      quantity: d('1'),
      averageEntryPrice: d('200.12345678'),
      entryNotional: d('200.12345678'),
      isolatedMargin: d('20.01234568'),
      realizedPnl: d('12.12345678'),
    });
    tx.futuresPosition.aggregate.mockResolvedValue({
      _sum: { isolatedMargin: d('20.01234568') },
    });
    const { body, diagnostic, response } = await failure(() =>
      service.execute('user-1', 'account-1', {
        ...command,
        operation: 'close',
        positionId: 'position-1',
      }),
    );
    expect(body.error.code).toBe('FUTURES_LIQUIDATION_REQUIRED');
    assertDiagnosticTriage(
      diagnostic,
      'FUTURES_LIQUIDATION_REQUIRED',
      'backend/src/futures/futures.service.ts#execute',
    );
    expect(response.status).toHaveBeenCalledWith(409);
    expect(body.error.message).toBe(
      'Loss and fee cannot settle safely without liquidation.',
    );
    expectSafe(diagnostic);
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      guardName: 'isolated_allocation',
      crossPositionsPresent: false,
      isolatedAllocationSufficient: false,
      failureReason: 'isolated_allocation_exceeded',
      mutationResult: 'rejected',
    });
    expect(diagnostic?.exception.message).toBe(body.error.message);
    expect(diagnostic?.evidence?.safeCause).toBeUndefined();
    expect(tx.futuresPosition.update).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('preserves isolated maintenance classification without exact mark or margin', async () => {
    jest
      .mocked(readFuturesMark)
      .mockResolvedValue({ price: d('1.12345678') } as never);
    const { body, diagnostic } = await failure(() =>
      service.execute('user-1', 'account-1', command),
    );
    expect(body.error.code).toBe('FUTURES_MAINTENANCE_UNSAFE');
    assertDiagnosticTriage(
      diagnostic,
      'FUTURES_MAINTENANCE_UNSAFE',
      'backend/src/futures/futures.service.ts#execute',
    );
    expectSafe(diagnostic);
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      guardName: 'futures_maintenance',
      marginMode: 'isolated',
      maintenanceSufficient: false,
      failureReason: 'maintenance_unsafe',
    });
    expect(tx.futuresExecution.create).not.toHaveBeenCalled();
  });

  it('keeps wallet integrity meaning without copying its financial rows', async () => {
    tx.cashWallet.findMany.mockResolvedValue([wallet]);
    const { body, diagnostic, response } = await failure(() =>
      service.execute('user-1', 'account-1', command),
    );
    expect(body.error.code).toBe('FINANCIAL_SCOPE_REPAIR_REQUIRED');
    assertDiagnosticTriage(
      diagnostic,
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
      'backend/src/futures/futures.service.ts#execute',
    );
    expect(response.status).toHaveBeenCalledWith(500);
    expect(body.error.message).toBe(
      'Futures wallet information could not be verified.',
    );
    expectSafe(diagnostic);
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      guardName: 'wallet_scope',
      canonicalWalletSetValid: false,
      failureReason: 'missing',
    });
  });

  it('keeps exact money in successful execution/collateral and replay persistence', async () => {
    const result = await service.execute('user-1', 'account-1', command);
    expect(result.data.execution).toMatchObject({
      quantity: '1.00000000',
      executionPrice: '123.45678912',
      feeAmount: '0.12345679',
      realizedPnl: '0.00000000',
    });
    expect(result.data.position.isolatedMargin).toBe('12.34567892');
    expect(result.data.collateral).toMatchObject({
      balanceAmount: '987653.99999999',
      freeCollateral: '911098.53086429',
    });
    expect(
      tx.futuresExecuteRequest.create.mock.calls[0][0].data.responsePayloadJson,
    ).toEqual(result);
    expect(
      tx.walletTransaction.createMany.mock.calls[0][0].data[0].amount,
    ).toBe('0.12345679');
  });
});

describe('Futures safe typed error vocabulary and Cross guard', () => {
  it('requires every Futures error message to be fixed, reviewed and product-safe', () => {
    let inspected = 0;
    const inspectMessage = (node: ts.Expression) => {
      if (ts.isConditionalExpression(node)) {
        inspectMessage(node.whenTrue);
        inspectMessage(node.whenFalse);
        return;
      }
      expect(ts.isStringLiteral(node)).toBe(true);
      if (!ts.isStringLiteral(node)) return;
      inspected++;
      expect(safeDiagnosticMessage(node.text)).toBe(node.text);
      expect(node.text).not.toMatch(
        /Binance|durable|canonical|Decimal|snapshot|post-mutation|positionId|idempotencyKey|DB|HTTP|env|config|console|endpoint/i,
      );
    };
    for (const name of readdirSync(__dirname).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
    )) {
      const source = ts.createSourceFile(
        name,
        readFileSync(`${__dirname}/${name}`, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          node.expression.getText(source) === 'futuresError'
        )
          inspectMessage(node.arguments[1]);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(inspected).toBeGreaterThan(30);
    expect(safeDiagnosticMessage('Futures collateral ' + raw)).toBeUndefined();
  });

  it.each([
    [
      'allocation',
      '-987654.12345678',
      '-1.12345678',
      '5.12345678',
      'isolated_allocation_underfunded',
    ],
    [
      'initial',
      '987654.12345678',
      '-76543.12345678',
      '5.12345678',
      'insufficient_free_collateral',
    ],
    [
      'maintenance',
      '987654.12345678',
      '1.12345678',
      '-76543.12345678',
      'maintenance_unsafe',
    ],
  ])(
    'keeps %s guard predicates and no exact Cross metrics',
    async (_, base, free, buffer, reason) => {
      const { diagnostic, body } = await failure(async () =>
        assertCrossSafe(
          {
            crossBaseCollateral: d(base),
            crossFreeCollateral: d(free),
            liquidationBuffer: d(buffer),
          } as ReturnType<typeof import('./futures-risk').crossRisk>,
          true,
        ),
      );
      expect(body.error.code).toBe('INSUFFICIENT_FUTURES_FREE_COLLATERAL');
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        walletScope: 'crypto_futures',
        crossPositionsPresent: true,
        failureReason: reason,
        isolatedAllocationSufficient: !base.startsWith('-'),
        collateralSufficient: !free.startsWith('-'),
        maintenanceSufficient: !buffer.startsWith('-'),
      });
      expect(diagnostic?.exception.message).toBe(body.error.message);
      expect(JSON.stringify(diagnostic)).not.toMatch(forbidden);
    },
  );
});
