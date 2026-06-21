export const fxExecuteRetryability = {
  non_retryable: 'non_retryable',
  conditionally_retryable: 'conditionally_retryable',
  retryable_only_with_idempotency_proof:
    'retryable_only_with_idempotency_proof',
} as const;

export type FxExecuteRetryability =
  (typeof fxExecuteRetryability)[keyof typeof fxExecuteRetryability];

export const fxExecuteWalletMutationPolicy = {
  no: 'no',
  no_new_mutation: 'no_new_mutation',
  rollback_only: 'rollback_only',
  rollback_or_replay_only: 'rollback_or_replay_only',
} as const;

export type FxExecuteWalletMutationPolicy =
  (typeof fxExecuteWalletMutationPolicy)[keyof typeof fxExecuteWalletMutationPolicy];

export const fxExecuteErrorCodes = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CURRENCY_PAIR: 'INVALID_CURRENCY_PAIR',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  IDEMPOTENCY_REQUIRED: 'IDEMPOTENCY_REQUIRED',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_PENDING: 'IDEMPOTENCY_PENDING',
  IDEMPOTENCY_PENDING_STALE: 'IDEMPOTENCY_PENDING_STALE',
  IDEMPOTENCY_FAILED: 'IDEMPOTENCY_FAILED',
  SEASON_NOT_FOUND: 'SEASON_NOT_FOUND',
  SEASON_NOT_ACTIVE: 'SEASON_NOT_ACTIVE',
  SEASON_NOT_STARTED: 'SEASON_NOT_STARTED',
  SEASON_ENDED: 'SEASON_ENDED',
  SEASON_NOT_JOINED: 'SEASON_NOT_JOINED',
  PARTICIPANT_EXCLUDED: 'PARTICIPANT_EXCLUDED',
  PARTICIPANT_NOT_ACTIVE: 'PARTICIPANT_NOT_ACTIVE',
  SOURCE_WALLET_NOT_FOUND: 'SOURCE_WALLET_NOT_FOUND',
  TARGET_WALLET_NOT_FOUND: 'TARGET_WALLET_NOT_FOUND',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  FX_RATE_UNAVAILABLE: 'FX_RATE_UNAVAILABLE',
  FX_RATE_STALE: 'FX_RATE_STALE',
  QUOTE_REQUIRED: 'QUOTE_REQUIRED',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  QUOTE_NOT_ACTIVE: 'QUOTE_NOT_ACTIVE',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  QUOTE_MISMATCH: 'QUOTE_MISMATCH',
  PROVIDER_RATE_UNAVAILABLE: 'PROVIDER_RATE_UNAVAILABLE',
  PROVIDER_RATE_STALE: 'PROVIDER_RATE_STALE',
  RATE_CHANGED_REQUOTE_REQUIRED: 'RATE_CHANGED_REQUOTE_REQUIRED',
  EXECUTION_SOURCE_INELIGIBLE: 'EXECUTION_SOURCE_INELIGIBLE',
  EXECUTION_PROVIDER_REQUIRED: 'EXECUTION_PROVIDER_REQUIRED',
  CONFLICT: 'CONFLICT',
  CONCURRENT_WALLET_UPDATE: 'CONCURRENT_WALLET_UPDATE',
  EXECUTE_TRANSACTION_FAILED: 'EXECUTE_TRANSACTION_FAILED',
  EXECUTE_WRITE_PATH_NOT_IMPLEMENTED: 'EXECUTE_WRITE_PATH_NOT_IMPLEMENTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type FxExecuteErrorCode =
  (typeof fxExecuteErrorCodes)[keyof typeof fxExecuteErrorCodes];

export const fxExecuteErrorCodeList = Object.values(fxExecuteErrorCodes);

export type FxExecuteErrorMetadata = {
  httpStatus: number;
  retryability: FxExecuteRetryability;
  walletMutationAllowed: FxExecuteWalletMutationPolicy;
  defaultMessage: string;
};

export const fxExecuteErrorMetadata: Record<
  FxExecuteErrorCode,
  FxExecuteErrorMetadata
> = {
  UNAUTHORIZED: {
    httpStatus: 401,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Unauthorized',
  },
  INVALID_CURRENCY_PAIR: {
    httpStatus: 400,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Invalid currency pair',
  },
  INVALID_AMOUNT: {
    httpStatus: 400,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Invalid amount',
  },
  IDEMPOTENCY_REQUIRED: {
    httpStatus: 400,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Idempotency key is required',
  },
  IDEMPOTENCY_CONFLICT: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Idempotency key conflicts with a different request',
  },
  IDEMPOTENCY_PENDING: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no_new_mutation,
    defaultMessage: 'Idempotent request is still pending',
  },
  IDEMPOTENCY_PENDING_STALE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no_new_mutation,
    defaultMessage: 'Idempotent request is stale and requires recovery',
  },
  IDEMPOTENCY_FAILED: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no_new_mutation,
    defaultMessage: 'Idempotent request has failed',
  },
  SEASON_NOT_FOUND: {
    httpStatus: 404,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season not found',
  },
  SEASON_NOT_ACTIVE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season is not active',
  },
  SEASON_NOT_STARTED: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season has not started',
  },
  SEASON_ENDED: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season has ended',
  },
  SEASON_NOT_JOINED: {
    httpStatus: 403,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season is not joined',
  },
  PARTICIPANT_EXCLUDED: {
    httpStatus: 403,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season participant is excluded',
  },
  PARTICIPANT_NOT_ACTIVE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Season participant is not active',
  },
  SOURCE_WALLET_NOT_FOUND: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Source wallet not found',
  },
  TARGET_WALLET_NOT_FOUND: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Target wallet not found',
  },
  INSUFFICIENT_BALANCE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Insufficient balance',
  },
  FX_RATE_UNAVAILABLE: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'FX rate is unavailable',
  },
  FX_RATE_STALE: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'FX rate is stale',
  },
  QUOTE_REQUIRED: {
    httpStatus: 400,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'quoteId is required',
  },
  QUOTE_NOT_FOUND: {
    httpStatus: 404,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Quote not found',
  },
  QUOTE_NOT_ACTIVE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Quote is not active',
  },
  QUOTE_EXPIRED: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Quote has expired',
  },
  QUOTE_MISMATCH: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Quote does not match the execute request',
  },
  PROVIDER_RATE_UNAVAILABLE: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Provider FX rate is unavailable',
  },
  PROVIDER_RATE_STALE: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Provider FX rate is stale',
  },
  RATE_CHANGED_REQUOTE_REQUIRED: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'FX rate changed; requote is required',
  },
  EXECUTION_SOURCE_INELIGIBLE: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Execution source is ineligible',
  },
  EXECUTION_PROVIDER_REQUIRED: {
    httpStatus: 503,
    retryability: fxExecuteRetryability.conditionally_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: 'Provider execution source is required',
  },
  CONFLICT: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.retryable_only_with_idempotency_proof,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no_new_mutation,
    defaultMessage: 'Conflict',
  },
  CONCURRENT_WALLET_UPDATE: {
    httpStatus: 409,
    retryability: fxExecuteRetryability.retryable_only_with_idempotency_proof,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no_new_mutation,
    defaultMessage: 'Concurrent wallet update rejected',
  },
  EXECUTE_TRANSACTION_FAILED: {
    httpStatus: 500,
    retryability: fxExecuteRetryability.retryable_only_with_idempotency_proof,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.rollback_only,
    defaultMessage: 'Execute transaction failed',
  },
  EXECUTE_WRITE_PATH_NOT_IMPLEMENTED: {
    httpStatus: 501,
    retryability: fxExecuteRetryability.non_retryable,
    walletMutationAllowed: fxExecuteWalletMutationPolicy.no,
    defaultMessage: '/fx execute write path is not implemented yet.',
  },
  INTERNAL_ERROR: {
    httpStatus: 500,
    retryability: fxExecuteRetryability.retryable_only_with_idempotency_proof,
    walletMutationAllowed:
      fxExecuteWalletMutationPolicy.rollback_or_replay_only,
    defaultMessage: 'Internal server error',
  },
};

export type FxExecuteErrorEnvelope = {
  success: false;
  error: {
    code: FxExecuteErrorCode;
    message: string;
  };
};

export function getFxExecuteErrorMetadata(
  code: FxExecuteErrorCode,
): FxExecuteErrorMetadata {
  return fxExecuteErrorMetadata[code];
}

export function buildFxExecuteErrorEnvelope(
  code: FxExecuteErrorCode,
  message?: string,
): FxExecuteErrorEnvelope {
  const publicCode = mapFxExecutePublicErrorCode(code);

  return {
    success: false,
    error: {
      code: publicCode,
      message: message ?? fxExecuteErrorMetadata[publicCode].defaultMessage,
    },
  };
}

export function mapFxExecutePublicErrorCode(
  code: FxExecuteErrorCode,
): FxExecuteErrorCode {
  switch (code) {
    case fxExecuteErrorCodes.SOURCE_WALLET_NOT_FOUND:
    case fxExecuteErrorCodes.TARGET_WALLET_NOT_FOUND:
      return fxExecuteErrorCodes.INSUFFICIENT_BALANCE;
    case fxExecuteErrorCodes.EXECUTION_SOURCE_INELIGIBLE:
    case fxExecuteErrorCodes.EXECUTION_PROVIDER_REQUIRED:
      return fxExecuteErrorCodes.PROVIDER_RATE_UNAVAILABLE;
    case fxExecuteErrorCodes.CONCURRENT_WALLET_UPDATE:
      return fxExecuteErrorCodes.CONFLICT;
    default:
      return code;
  }
}
