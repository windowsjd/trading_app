import type { FxExecuteErrorCode } from './fx-execute-error-policy';
import {
  decideFxExecuteIdempotency,
  type FxExecuteCommandCandidate,
} from './fx-execute-idempotency-decision-policy';
import {
  buildFxExecutePlan,
  type FxExecutePlan,
  type FxExecuteSnapshotWithId,
  type FxExecuteWalletCandidate,
} from './fx-execute-plan-policy';
import {
  preflightFxExecuteRequest,
  type FxExecuteRequestBodyLike,
  type FxExecuteRequestContextLike,
  type NormalizedFxExecuteRequest,
} from './fx-execute-request-policy';

export type FxExecuteOrchestrationInput = {
  body: FxExecuteRequestBodyLike;
  context: FxExecuteRequestContextLike;
  existingCommand: FxExecuteCommandCandidate | null;
  sourceWallet: FxExecuteWalletCandidate | null;
  targetWallet: FxExecuteWalletCandidate | null;
  snapshots: readonly FxExecuteSnapshotWithId[];
  fxFeeRate: string;
  executeNow: Date;
};

export type FxExecuteOrchestrationDecision =
  | {
      action: 'return_error';
      errorCode: FxExecuteErrorCode;
      source:
        | 'request_preflight'
        | 'idempotency'
        | 'plan'
        | 'idempotency_recovery';
      commandId?: string;
      reason?: string;
    }
  | {
      action: 'replay_succeeded';
      commandId: string;
      responsePayloadJson: unknown;
    }
  | {
      action: 'create_pending_and_execute';
      normalizedRequest: NormalizedFxExecuteRequest;
      plan: FxExecutePlan;
    };

export function orchestrateFxExecutePreMutation(
  input: FxExecuteOrchestrationInput,
): FxExecuteOrchestrationDecision {
  const preflightResult = preflightFxExecuteRequest(input.body, input.context);

  if (!preflightResult.ok) {
    return {
      action: 'return_error',
      source: 'request_preflight',
      errorCode: preflightResult.errorCode,
    };
  }

  const normalizedRequest = preflightResult.value;
  const idempotencyDecision = decideFxExecuteIdempotency({
    existingCommand: input.existingCommand,
    incomingRequestHash: normalizedRequest.requestHash,
    now: input.executeNow,
  });

  switch (idempotencyDecision.action) {
    case 'create_pending':
      break;
    case 'continue_existing_pending':
    case 'stale_pending_recovery_required':
    case 'failed_no_retry':
    case 'conflict':
      return {
        action: 'return_error',
        source: 'idempotency',
        errorCode: idempotencyDecision.errorCode,
        commandId: idempotencyDecision.commandId,
      };
    case 'recovery_required':
      return {
        action: 'return_error',
        source: 'idempotency_recovery',
        errorCode: idempotencyDecision.errorCode,
        commandId: idempotencyDecision.commandId,
        reason: idempotencyDecision.reason,
      };
    case 'replay_succeeded':
      return {
        action: 'replay_succeeded',
        commandId: idempotencyDecision.commandId,
        responsePayloadJson: idempotencyDecision.responsePayloadJson,
      };
  }

  const planResult = buildFxExecutePlan({
    request: normalizedRequest,
    sourceWallet: input.sourceWallet,
    targetWallet: input.targetWallet,
    snapshots: input.snapshots,
    fxFeeRate: input.fxFeeRate,
    executeNow: input.executeNow,
  });

  if (!planResult.ok) {
    return {
      action: 'return_error',
      source: 'plan',
      errorCode: planResult.errorCode,
    };
  }

  return {
    action: 'create_pending_and_execute',
    normalizedRequest,
    plan: planResult.value,
  };
}
