import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decideFxExecuteIdempotency,
  fxExecutePendingFreshThresholdMs,
  type FxExecuteCommandCandidate,
} from './fx-execute-idempotency-decision-policy';

describe('fx execute idempotency decision policy', () => {
  const now = new Date('2026-05-01T00:02:00.000Z');
  const incomingRequestHash = 'request-hash-1';

  const command = (
    overrides: Partial<FxExecuteCommandCandidate> = {},
  ): FxExecuteCommandCandidate => ({
    id: 'command-1',
    idempotencyKey: 'idempotency-key-1',
    requestHash: incomingRequestHash,
    status: 'pending',
    requestedAt: new Date('2026-05-01T00:01:00.000Z'),
    completedAt: null,
    responsePayloadJson: null,
    errorCode: null,
    errorMessage: null,
    exchangeTransactionId: null,
    ...overrides,
  });

  const decide = (
    existingCommand: FxExecuteCommandCandidate | null,
    requestHash = incomingRequestHash,
    decisionNow = now,
  ) =>
    decideFxExecuteIdempotency({
      existingCommand,
      incomingRequestHash: requestHash,
      now: decisionNow,
    });

  it('returns create_pending when there is no existing command', () => {
    expect(decide(null)).toEqual({
      action: 'create_pending',
    });
  });

  it('returns IDEMPOTENCY_PENDING for pending same-hash fresh command', () => {
    expect(decide(command())).toEqual({
      action: 'continue_existing_pending',
      errorCode: 'IDEMPOTENCY_PENDING',
      commandId: 'command-1',
    });
  });

  it('treats exactly 120_000ms old pending command as fresh', () => {
    const requestedAt = new Date(
      now.getTime() - fxExecutePendingFreshThresholdMs,
    );

    expect(decide(command({ requestedAt }))).toEqual({
      action: 'continue_existing_pending',
      errorCode: 'IDEMPOTENCY_PENDING',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_PENDING_STALE for pending same-hash command older than 120_000ms', () => {
    const requestedAt = new Date(
      now.getTime() - fxExecutePendingFreshThresholdMs - 1,
    );

    expect(decide(command({ requestedAt }))).toEqual({
      action: 'stale_pending_recovery_required',
      errorCode: 'IDEMPOTENCY_PENDING_STALE',
      commandId: 'command-1',
    });
  });

  it('treats future requestedAt pending command as fresh', () => {
    expect(
      decide(
        command({
          requestedAt: new Date('2026-05-01T00:02:00.001Z'),
        }),
      ),
    ).toEqual({
      action: 'continue_existing_pending',
      errorCode: 'IDEMPOTENCY_PENDING',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_CONFLICT for pending different-hash command', () => {
    expect(decide(command(), 'different-request-hash')).toEqual({
      action: 'conflict',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      commandId: 'command-1',
    });
  });

  it('does not turn stale pending into create_pending or replay_succeeded', () => {
    const decision = decide(
      command({
        requestedAt: new Date(
          now.getTime() - fxExecutePendingFreshThresholdMs - 1,
        ),
      }),
    );

    expect(decision.action).toBe('stale_pending_recovery_required');
    expect(decision.action).not.toBe('create_pending');
    expect(decision.action).not.toBe('replay_succeeded');
  });

  it('replays succeeded same-hash command with stored responsePayloadJson', () => {
    const responsePayloadJson = {
      success: true,
      data: {
        exchangeId: 'exchange-1',
        rate: '1350.00000000',
        netTargetAmount: '99.90000000',
      },
    };
    const decision = decide(
      command({
        status: 'succeeded',
        completedAt: new Date('2026-05-01T00:01:30.000Z'),
        responsePayloadJson,
        exchangeTransactionId: 'exchange-1',
      }),
    );

    expect(decision).toEqual({
      action: 'replay_succeeded',
      commandId: 'command-1',
      responsePayloadJson,
    });

    if (decision.action === 'replay_succeeded') {
      expect(decision.responsePayloadJson).toBe(responsePayloadJson);
    }
  });

  it('does not recompute succeeded replay response fields', () => {
    const responsePayloadJson = {
      success: true,
      data: {
        rate: 'stored-rate',
        feeAmount: 'stored-fee',
        wallets: {
          KRW: 'stored-krw-balance',
          USD: 'stored-usd-balance',
        },
      },
    };

    expect(
      decide(
        command({
          status: 'succeeded',
          responsePayloadJson,
          exchangeTransactionId: 'exchange-1',
        }),
      ),
    ).toEqual({
      action: 'replay_succeeded',
      commandId: 'command-1',
      responsePayloadJson,
    });
  });

  it('returns recovery_required when succeeded same-hash command is missing responsePayloadJson', () => {
    expect(
      decide(
        command({
          status: 'succeeded',
          responsePayloadJson: null,
          exchangeTransactionId: 'exchange-1',
        }),
      ),
    ).toEqual({
      action: 'recovery_required',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'succeeded command is missing responsePayloadJson',
    });
  });

  it('returns IDEMPOTENCY_CONFLICT for succeeded different-hash command', () => {
    expect(
      decide(
        command({
          status: 'succeeded',
          responsePayloadJson: { success: true },
          exchangeTransactionId: 'exchange-1',
        }),
        'different-request-hash',
      ),
    ).toEqual({
      action: 'conflict',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      commandId: 'command-1',
    });
  });

  it('returns IDEMPOTENCY_FAILED for failed same-hash command', () => {
    expect(
      decide(
        command({
          status: 'failed',
          completedAt: new Date('2026-05-01T00:01:30.000Z'),
          errorCode: 'INSUFFICIENT_BALANCE',
          errorMessage: 'Insufficient balance',
        }),
      ),
    ).toEqual({
      action: 'failed_no_retry',
      errorCode: 'IDEMPOTENCY_FAILED',
      commandId: 'command-1',
      storedErrorCode: 'INSUFFICIENT_BALANCE',
      storedErrorMessage: 'Insufficient balance',
    });
  });

  it('never returns create_pending or replay_succeeded for failed same-hash command', () => {
    const decision = decide(command({ status: 'failed' }));

    expect(decision.action).toBe('failed_no_retry');
    expect(decision.action).not.toBe('create_pending');
    expect(decision.action).not.toBe('replay_succeeded');
  });

  it('returns IDEMPOTENCY_CONFLICT for failed different-hash command', () => {
    expect(
      decide(command({ status: 'failed' }), 'different-request-hash'),
    ).toEqual({
      action: 'conflict',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      commandId: 'command-1',
    });
  });

  it.each(['pending', 'succeeded', 'failed'] as const)(
    'returns IDEMPOTENCY_CONFLICT for %s different-hash command',
    (status) => {
      const responsePayloadJson = status === 'succeeded' ? { ok: true } : null;

      expect(
        decide(
          command({
            status,
            responsePayloadJson,
          }),
          'different-request-hash',
        ),
      ).toEqual({
        action: 'conflict',
        errorCode: 'IDEMPOTENCY_CONFLICT',
        commandId: 'command-1',
      });
    },
  );

  it('does not include responsePayloadJson in conflict decision', () => {
    const decision = decide(
      command({
        status: 'succeeded',
        responsePayloadJson: { success: true },
      }),
      'different-request-hash',
    );

    expect(decision).toEqual({
      action: 'conflict',
      errorCode: 'IDEMPOTENCY_CONFLICT',
      commandId: 'command-1',
    });
    expect(decision).not.toHaveProperty('responsePayloadJson');
  });

  it('throws when incomingRequestHash is empty', () => {
    expect(() => decide(null, '')).toThrow('incomingRequestHash is required');
    expect(() => decide(null, '   ')).toThrow(
      'incomingRequestHash is required',
    );
  });

  it('throws when now is invalid', () => {
    expect(() =>
      decide(null, incomingRequestHash, new Date('invalid')),
    ).toThrow('now must be a valid Date');
  });

  it('returns recovery_required when existing command requestHash is empty', () => {
    expect(decide(command({ requestHash: ' ' }))).toEqual({
      action: 'recovery_required',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'existing command requestHash is missing',
    });
  });

  it('returns recovery_required when existing command requestedAt is invalid', () => {
    expect(decide(command({ requestedAt: new Date('invalid') }))).toEqual({
      action: 'recovery_required',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'existing command requestedAt is invalid',
    });
  });

  it('returns recovery_required for unknown runtime status', () => {
    expect(
      decide(
        command({
          status: 'unknown' as never,
        }),
      ),
    ).toEqual({
      action: 'recovery_required',
      errorCode: 'INTERNAL_ERROR',
      commandId: 'command-1',
      reason: 'unknown command status: unknown',
    });
  });

  it('does not mutate existingCommand', () => {
    const existingCommand = command({
      status: 'succeeded',
      responsePayloadJson: Object.freeze({ success: true }),
      exchangeTransactionId: 'exchange-1',
    });
    const originalCommand = { ...existingCommand };

    Object.freeze(existingCommand);

    decide(existingCommand);

    expect(existingCommand).toEqual(originalCommand);
  });

  it('keeps the utility independent from service, plan, wallet, snapshot, and envelopes', () => {
    const source = readFileSync(
      join(__dirname, 'fx-execute-idempotency-decision-policy.ts'),
      'utf8',
    );

    expect(source).not.toContain('PrismaService');
    expect(source).not.toContain('fx-execute-plan-policy');
    expect(source).not.toContain('fx-execute-snapshot-policy');
    expect(source).not.toContain('wallet');
    expect(source).not.toContain('buildFxExecuteErrorEnvelope');
    expect(source).not.toMatch(/\.create|\.update|\.upsert|\.delete/);
  });
});
