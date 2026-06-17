import { fxExecuteErrorCodes } from './fx-execute-error-policy';

export const fxExecutePendingFreshThresholdMs = 120_000;

export type FxExecuteCommandStatus = 'pending' | 'succeeded' | 'failed';

export type FxExecuteCommandCandidate = {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  status: FxExecuteCommandStatus;
  requestedAt: Date;
  completedAt: Date | null;
  responsePayloadJson: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  exchangeTransactionId: string | null;
};

export type FxExecuteIdempotencyDecision =
  | {
      action: 'create_pending';
    }
  | {
      action: 'continue_existing_pending';
      errorCode: 'IDEMPOTENCY_PENDING';
      commandId: string;
    }
  | {
      action: 'stale_pending_recovery_required';
      errorCode: 'IDEMPOTENCY_PENDING_STALE';
      commandId: string;
    }
  | {
      action: 'replay_succeeded';
      commandId: string;
      responsePayloadJson: unknown;
    }
  | {
      action: 'failed_no_retry';
      errorCode: 'IDEMPOTENCY_FAILED';
      commandId: string;
      storedErrorCode: string | null;
      storedErrorMessage: string | null;
    }
  | {
      action: 'conflict';
      errorCode: 'IDEMPOTENCY_CONFLICT';
      commandId: string;
    }
  | {
      action: 'recovery_required';
      errorCode: 'INTERNAL_ERROR';
      commandId: string;
      reason: string;
    };

export type DecideFxExecuteIdempotencyInput = {
  existingCommand: FxExecuteCommandCandidate | null;
  incomingRequestHash: string;
  now: Date;
};

export function decideFxExecuteIdempotency(
  input: DecideFxExecuteIdempotencyInput,
): FxExecuteIdempotencyDecision {
  const incomingRequestHash = normalizeIncomingRequestHash(
    input.incomingRequestHash,
  );
  assertValidDate(input.now, 'now');

  if (!input.existingCommand) {
    return { action: 'create_pending' };
  }

  const command = input.existingCommand;
  const commandRecoveryReason = getCommandRecoveryReason(command);

  if (commandRecoveryReason) {
    return buildRecoveryRequiredDecision(command, commandRecoveryReason);
  }

  if (command.requestHash !== incomingRequestHash) {
    return {
      action: 'conflict',
      errorCode: fxExecuteErrorCodes.IDEMPOTENCY_CONFLICT,
      commandId: command.id,
    };
  }

  switch (command.status) {
    case 'pending':
      return decidePendingCommand(command, input.now);
    case 'succeeded':
      return decideSucceededCommand(command);
    case 'failed':
      return {
        action: 'failed_no_retry',
        errorCode: fxExecuteErrorCodes.IDEMPOTENCY_FAILED,
        commandId: command.id,
        storedErrorCode: command.errorCode,
        storedErrorMessage: command.errorMessage,
      };
    default:
      return buildRecoveryRequiredDecision(
        command,
        `unknown command status: ${String(command.status)}`,
      );
  }
}

function decidePendingCommand(
  command: FxExecuteCommandCandidate,
  now: Date,
): FxExecuteIdempotencyDecision {
  if (isPendingCommandStale(command.requestedAt, now)) {
    return {
      action: 'stale_pending_recovery_required',
      errorCode: fxExecuteErrorCodes.IDEMPOTENCY_PENDING_STALE,
      commandId: command.id,
    };
  }

  return {
    action: 'continue_existing_pending',
    errorCode: fxExecuteErrorCodes.IDEMPOTENCY_PENDING,
    commandId: command.id,
  };
}

function decideSucceededCommand(
  command: FxExecuteCommandCandidate,
): FxExecuteIdempotencyDecision {
  if (command.responsePayloadJson == null) {
    return buildRecoveryRequiredDecision(
      command,
      'succeeded command is missing responsePayloadJson',
    );
  }

  return {
    action: 'replay_succeeded',
    commandId: command.id,
    responsePayloadJson: command.responsePayloadJson,
  };
}

function isPendingCommandStale(requestedAt: Date, now: Date): boolean {
  return (
    now.getTime() - requestedAt.getTime() > fxExecutePendingFreshThresholdMs
  );
}

function getCommandRecoveryReason(
  command: FxExecuteCommandCandidate,
): string | null {
  if (
    typeof command.requestHash !== 'string' ||
    command.requestHash.trim() === ''
  ) {
    return 'existing command requestHash is missing';
  }

  if (!isValidDate(command.requestedAt)) {
    return 'existing command requestedAt is invalid';
  }

  return null;
}

function buildRecoveryRequiredDecision(
  command: FxExecuteCommandCandidate,
  reason: string,
): FxExecuteIdempotencyDecision {
  return {
    action: 'recovery_required',
    errorCode: fxExecuteErrorCodes.INTERNAL_ERROR,
    commandId: command.id,
    reason,
  };
}

function normalizeIncomingRequestHash(value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('incomingRequestHash is required');
  }

  return value.trim();
}

function assertValidDate(value: Date, fieldName: string): void {
  if (!isValidDate(value)) {
    throw new Error(`${fieldName} must be a valid Date`);
  }
}

function isValidDate(value: Date): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
