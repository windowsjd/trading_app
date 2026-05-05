jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import type { FxExecuteCommandCandidate } from './fx-execute-idempotency-decision-policy';
import type {
  FxExecuteSnapshotWithId,
  FxExecuteWalletCandidate,
} from './fx-execute-plan-policy';
import {
  preflightFxExecuteRequest,
  type FxExecuteRequestBodyLike,
} from './fx-execute-request-policy';
import { orchestrateFxExecutePreMutation } from './fx-execute-orchestration-policy';

describe('fx execute pre-mutation orchestration policy', () => {
  const executeNow = new Date('2026-05-01T00:01:00.000Z');
  const context = {
    userId: 'user-1',
    seasonParticipantId: 'participant-1',
  };
  const validBody: FxExecuteRequestBodyLike = {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '135000',
    idempotencyKey: 'idempotency-key-1',
  };

  const getRequestHash = (body = validBody) => {
    const preflight = preflightFxExecuteRequest(body, context);

    if (!preflight.ok) {
      throw new Error('test setup produced invalid preflight request');
    }

    return preflight.value.requestHash;
  };

  const wallet = (
    id: string,
    currencyCode: 'KRW' | 'USD',
    balanceAmount: string | Prisma.Decimal,
    seasonParticipantId = 'participant-1',
  ): FxExecuteWalletCandidate => ({
    id,
    seasonParticipantId,
    currencyCode,
    balanceAmount,
  });

  const snapshot = (
    id: string,
    overrides: Partial<FxExecuteSnapshotWithId> = {},
  ): FxExecuteSnapshotWithId => ({
    id,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    sourceType: FxRateSourceType.admin_manual,
    rate: '1350.00000000',
    effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
    capturedAt: new Date('2026-05-01T00:00:31.000Z'),
    createdAt: new Date('2026-05-01T00:00:32.000Z'),
    ...overrides,
  });

  const command = (
    overrides: Partial<FxExecuteCommandCandidate> = {},
  ): FxExecuteCommandCandidate => ({
    id: 'command-1',
    idempotencyKey: 'idempotency-key-1',
    requestHash: getRequestHash(),
    status: 'pending',
    requestedAt: new Date('2026-05-01T00:00:30.000Z'),
    completedAt: null,
    responsePayloadJson: null,
    errorCode: null,
    errorMessage: null,
    exchangeTransactionId: null,
    ...overrides,
  });

  const baseInput = () => ({
    body: validBody,
    context,
    existingCommand: null,
    sourceWallet: wallet('krw-wallet-1', 'KRW', '200000.00000000'),
    targetWallet: wallet('usd-wallet-1', 'USD', '10.00000000'),
    snapshots: [snapshot('snapshot-1')],
    fxFeeRate: '0.001000',
    executeNow,
  });

  const orchestrate = (overrides: Partial<ReturnType<typeof baseInput>> = {}) =>
    orchestrateFxExecutePreMutation({
      ...baseInput(),
      ...overrides,
    });

  it('returns request_preflight IDEMPOTENCY_REQUIRED for missing idempotencyKey', () => {
    const decision = orchestrate({
      body: {
        ...validBody,
        idempotencyKey: undefined,
      },
      existingCommand: command(),
      sourceWallet: null,
      snapshots: [],
    });

    expect(decision).toEqual({
      action: 'return_error',
      source: 'request_preflight',
      errorCode: 'IDEMPOTENCY_REQUIRED',
    });
    expect(decision).not.toHaveProperty('normalizedRequest');
    expect(decision).not.toHaveProperty('plan');
    expect(decision).not.toHaveProperty('commandId');
  });

  it('returns request_preflight INVALID_CURRENCY_PAIR for invalid pair', () => {
    expect(
      orchestrate({
        body: {
          ...validBody,
          toCurrency: 'KRW',
        },
      }),
    ).toEqual({
      action: 'return_error',
      source: 'request_preflight',
      errorCode: 'INVALID_CURRENCY_PAIR',
    });
  });

  it('returns request_preflight INVALID_AMOUNT for invalid amount', () => {
    expect(
      orchestrate({
        body: {
          ...validBody,
          sourceAmount: '0',
        },
      }),
    ).toEqual({
      action: 'return_error',
      source: 'request_preflight',
      errorCode: 'INVALID_AMOUNT',
    });
  });

  it('returns create_pending_and_execute for no existing command and valid plan', () => {
    expect(orchestrate()).toMatchObject({
      action: 'create_pending_and_execute',
      normalizedRequest: {
        userId: 'user-1',
        seasonParticipantId: 'participant-1',
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '135000.00000000',
        idempotencyKey: 'idempotency-key-1',
        requestHash: expect.any(String),
      },
      plan: {
        sourceWalletId: 'krw-wallet-1',
        targetWalletId: 'usd-wallet-1',
        sourceAmount: '135000.00000000',
        grossTargetAmount: '100.00000000',
        feeRate: '0.001000',
        feeAmount: '0.10000000',
        feeCurrency: 'USD',
        appliedRate: '1350.00000000',
        netTargetAmount: '99.90000000',
        targetCreditAmount: '99.90000000',
        sourceDebitAmount: '135000.00000000',
        fxRateSnapshotId: 'snapshot-1',
      },
    });
  });

  it('returns IDEMPOTENCY_PENDING for pending fresh same-hash command', () => {
    expect(
      orchestrate({
        existingCommand: command({
          status: 'pending',
          requestedAt: new Date('2026-05-01T00:00:30.000Z'),
        }),
      }),
    ).toEqual({
      action: 'return_error',
      source: 'idempotency',
      errorCode: 'IDEMPOTENCY_PENDING',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_PENDING_STALE for pending stale same-hash command', () => {
    expect(
      orchestrate({
        existingCommand: command({
          status: 'pending',
          requestedAt: new Date('2026-04-30T23:58:59.999Z'),
        }),
      }),
    ).toEqual({
      action: 'return_error',
      source: 'idempotency',
      errorCode: 'IDEMPOTENCY_PENDING_STALE',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_CONFLICT for same key different hash', () => {
    expect(
      orchestrate({
        existingCommand: command({
          requestHash: 'different-request-hash',
        }),
      }),
    ).toEqual({
      action: 'return_error',
      source: 'idempotency',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_FAILED for failed same-hash command', () => {
    expect(
      orchestrate({
        existingCommand: command({
          status: 'failed',
          errorCode: 'INSUFFICIENT_BALANCE',
          errorMessage: 'Insufficient balance',
        }),
      }),
    ).toEqual({
      action: 'return_error',
      source: 'idempotency',
      errorCode: 'IDEMPOTENCY_FAILED',
      commandId: 'command-1',
    });
  });

  it('returns replay_succeeded with exact stored responsePayloadJson', () => {
    const responsePayloadJson = {
      success: true,
      data: {
        exchangeId: 'exchange-1',
        rate: 'stored-rate',
      },
    };
    const decision = orchestrate({
      existingCommand: command({
        status: 'succeeded',
        responsePayloadJson,
        exchangeTransactionId: 'exchange-1',
      }),
    });

    expect(decision).toEqual({
      action: 'replay_succeeded',
      commandId: 'command-1',
      responsePayloadJson,
    });

    if (decision.action === 'replay_succeeded') {
      expect(decision.responsePayloadJson).toBe(responsePayloadJson);
    }
    expect(decision).not.toHaveProperty('plan');
  });

  it('returns idempotency_recovery INTERNAL_ERROR when succeeded command is missing responsePayloadJson', () => {
    expect(
      orchestrate({
        existingCommand: command({
          status: 'succeeded',
          responsePayloadJson: null,
          exchangeTransactionId: 'exchange-1',
        }),
      }),
    ).toEqual({
      action: 'return_error',
      source: 'idempotency_recovery',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'succeeded command is missing responsePayloadJson',
    });
  });

  it.each([
    [
      'source wallet',
      {
        sourceWallet: null,
      },
      'SOURCE_WALLET_NOT_FOUND',
    ],
    [
      'target wallet',
      {
        targetWallet: null,
      },
      'TARGET_WALLET_NOT_FOUND',
    ],
    [
      'eligible snapshot',
      {
        snapshots: [],
      },
      'FX_RATE_UNAVAILABLE',
    ],
    [
      'fresh snapshot',
      {
        snapshots: [
          snapshot('stale', {
            effectiveAt: new Date('2026-04-30T23:59:59.999Z'),
          }),
        ],
      },
      'FX_RATE_STALE',
    ],
    [
      'sufficient balance',
      {
        sourceWallet: wallet('krw-wallet-1', 'KRW', '134999.99999999'),
      },
      'INSUFFICIENT_BALANCE',
    ],
  ])(
    'returns plan error for missing/invalid %s',
    (_label, overrides, errorCode) => {
      expect(orchestrate(overrides)).toEqual({
        action: 'return_error',
        source: 'plan',
        errorCode,
      });
    },
  );

  it('creates a KRW to USD pending-and-execute decision with normalizedRequest and plan aligned', () => {
    const decision = orchestrate({
      snapshots: [
        snapshot('older-snapshot', {
          effectiveAt: new Date('2026-05-01T00:00:10.000Z'),
        }),
        snapshot('selected-snapshot', {
          effectiveAt: new Date('2026-05-01T00:00:50.000Z'),
        }),
      ],
    });

    expect(decision.action).toBe('create_pending_and_execute');

    if (decision.action === 'create_pending_and_execute') {
      expect(decision.normalizedRequest.requestHash).toBe(
        decision.plan.requestHash,
      );
      expect(decision.normalizedRequest.idempotencyKey).toBe(
        decision.plan.idempotencyKey,
      );
      expect(decision.plan.sourceDebitAmount).toBe(
        decision.normalizedRequest.sourceAmount,
      );
      expect(decision.plan.targetCreditAmount).toBe(
        decision.plan.netTargetAmount,
      );
      expect(decision.plan.fxRateSnapshotId).toBe('selected-snapshot');
      expect(decision.plan).not.toHaveProperty('balanceAfter');
      expect(decision).not.toHaveProperty('exchangeId');
    }
  });

  it('replay_succeeded path does not require valid wallets, snapshots, or fee rate', () => {
    const responsePayloadJson = {
      success: true,
      data: { exchangeId: 'stored' },
    };

    expect(
      orchestrate({
        existingCommand: command({
          status: 'succeeded',
          responsePayloadJson,
          exchangeTransactionId: 'exchange-1',
        }),
        sourceWallet: null,
        targetWallet: null,
        snapshots: [],
        fxFeeRate: 'not-a-fee-rate',
      }),
    ).toEqual({
      action: 'replay_succeeded',
      commandId: 'command-1',
      responsePayloadJson,
    });
  });

  it.each([
    [
      'pending',
      command({
        status: 'pending',
      }),
      'IDEMPOTENCY_PENDING',
    ],
    [
      'conflict',
      command({
        requestHash: 'different-request-hash',
      }),
      'IDEMPOTENCY_CONFLICT',
    ],
    [
      'failed',
      command({
        status: 'failed',
      }),
      'IDEMPOTENCY_FAILED',
    ],
  ])(
    '%s idempotency path does not require valid wallets or snapshots',
    (_label, existingCommand, errorCode) => {
      const decision = orchestrate({
        existingCommand,
        sourceWallet: null,
        targetWallet: null,
        snapshots: [],
        fxFeeRate: 'not-a-fee-rate',
      });

      expect(decision).toEqual({
        action: 'return_error',
        source: 'idempotency',
        errorCode,
        commandId: 'command-1',
      });
      expect(decision).not.toHaveProperty('plan');
    },
  );

  it('idempotency recovery path does not include plan', () => {
    const decision = orchestrate({
      existingCommand: command({
        requestHash: '',
      }),
      sourceWallet: null,
      targetWallet: null,
      snapshots: [],
    });

    expect(decision).toEqual({
      action: 'return_error',
      source: 'idempotency_recovery',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'existing command requestHash is missing',
    });
    expect(decision).not.toHaveProperty('plan');
  });

  it('create_pending path requires plan inputs and can fail from plan', () => {
    expect(
      orchestrate({
        existingCommand: null,
        sourceWallet: null,
      }),
    ).toEqual({
      action: 'return_error',
      source: 'plan',
      errorCode: 'SOURCE_WALLET_NOT_FOUND',
    });
  });

  it('does not mutate input body, command, wallets, or snapshots', () => {
    const body = { ...validBody };
    const existingCommand = command();
    const sourceWallet = wallet('krw-wallet-1', 'KRW', '200000.00000000');
    const targetWallet = wallet('usd-wallet-1', 'USD', '10.00000000');
    const snapshots = [snapshot('snapshot-1')];
    const originalBody = { ...body };
    const originalCommand = { ...existingCommand };
    const originalSourceWallet = { ...sourceWallet };
    const originalTargetWallet = { ...targetWallet };
    const originalSnapshots = snapshots.slice();

    orchestrate({
      body,
      existingCommand,
      sourceWallet,
      targetWallet,
      snapshots,
    });

    expect(body).toEqual(originalBody);
    expect(existingCommand).toEqual(originalCommand);
    expect(sourceWallet).toEqual(originalSourceWallet);
    expect(targetWallet).toEqual(originalTargetWallet);
    expect(snapshots).toEqual(originalSnapshots);
  });

  it('keeps orchestration scoped away from services, controllers, DB writes, and Nest exceptions', () => {
    const source = readFileSync(
      join(__dirname, 'fx-execute-orchestration-policy.ts'),
      'utf8',
    );

    expect(source).not.toContain('PrismaService');
    expect(source).not.toContain('fx.service');
    expect(source).not.toContain('fx.controller');
    expect(source).not.toContain('HttpException');
    expect(source).not.toMatch(/\.create|\.update|\.upsert|\.delete/);
    expect(source).not.toContain('exchangeId');
    expect(source).not.toContain('wallets');
  });
});
