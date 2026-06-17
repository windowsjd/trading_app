import {
  buildFxExecuteErrorEnvelope,
  fxExecuteErrorCodeList,
  fxExecuteErrorMetadata,
  fxExecuteRetryability,
  fxExecuteWalletMutationPolicy,
} from './fx-execute-error-policy';

describe('fx execute error policy', () => {
  const expectedHttpStatuses = {
    UNAUTHORIZED: 401,
    INVALID_CURRENCY_PAIR: 400,
    INVALID_AMOUNT: 400,
    IDEMPOTENCY_REQUIRED: 400,
    IDEMPOTENCY_CONFLICT: 409,
    IDEMPOTENCY_PENDING: 409,
    IDEMPOTENCY_PENDING_STALE: 409,
    IDEMPOTENCY_FAILED: 409,
    SEASON_NOT_FOUND: 404,
    SEASON_NOT_ACTIVE: 409,
    SEASON_NOT_JOINED: 403,
    SOURCE_WALLET_NOT_FOUND: 409,
    TARGET_WALLET_NOT_FOUND: 409,
    INSUFFICIENT_BALANCE: 409,
    FX_RATE_UNAVAILABLE: 503,
    FX_RATE_STALE: 503,
    QUOTE_REQUIRED: 400,
    QUOTE_NOT_FOUND: 404,
    QUOTE_NOT_ACTIVE: 409,
    QUOTE_EXPIRED: 409,
    QUOTE_MISMATCH: 409,
    PROVIDER_RATE_UNAVAILABLE: 503,
    PROVIDER_RATE_STALE: 503,
    RATE_CHANGED_REQUOTE_REQUIRED: 409,
    EXECUTION_SOURCE_INELIGIBLE: 503,
    EXECUTION_PROVIDER_REQUIRED: 503,
    CONCURRENT_WALLET_UPDATE: 409,
    EXECUTE_TRANSACTION_FAILED: 500,
    EXECUTE_WRITE_PATH_NOT_IMPLEMENTED: 501,
    INTERNAL_ERROR: 500,
  } as const;

  it('provides metadata for every accepted error code', () => {
    expect(fxExecuteErrorCodeList).toHaveLength(
      Object.keys(expectedHttpStatuses).length,
    );

    for (const code of fxExecuteErrorCodeList) {
      expect(fxExecuteErrorMetadata[code]).toEqual({
        httpStatus: expect.any(Number),
        retryability: expect.any(String),
        walletMutationAllowed: expect.any(String),
        defaultMessage: expect.any(String),
      });
    }
  });

  it('matches the accepted HTTP status table', () => {
    for (const [code, httpStatus] of Object.entries(expectedHttpStatuses)) {
      expect(fxExecuteErrorMetadata[code].httpStatus).toBe(httpStatus);
    }
  });

  it('blocks wallet mutation for validation, conflict, rate, wallet, and balance errors', () => {
    const noMutationCodes = [
      'INVALID_CURRENCY_PAIR',
      'INVALID_AMOUNT',
      'IDEMPOTENCY_REQUIRED',
      'IDEMPOTENCY_CONFLICT',
      'FX_RATE_UNAVAILABLE',
      'FX_RATE_STALE',
      'QUOTE_REQUIRED',
      'QUOTE_NOT_FOUND',
      'QUOTE_NOT_ACTIVE',
      'QUOTE_EXPIRED',
      'QUOTE_MISMATCH',
      'PROVIDER_RATE_UNAVAILABLE',
      'PROVIDER_RATE_STALE',
      'RATE_CHANGED_REQUOTE_REQUIRED',
      'EXECUTION_SOURCE_INELIGIBLE',
      'EXECUTION_PROVIDER_REQUIRED',
      'SOURCE_WALLET_NOT_FOUND',
      'TARGET_WALLET_NOT_FOUND',
      'INSUFFICIENT_BALANCE',
      'EXECUTE_WRITE_PATH_NOT_IMPLEMENTED',
    ] as const;

    for (const code of noMutationCodes) {
      expect([
        fxExecuteWalletMutationPolicy.no,
        fxExecuteWalletMutationPolicy.no_new_mutation,
      ]).toContain(fxExecuteErrorMetadata[code].walletMutationAllowed);
    }
  });

  it('does not mark internal transaction failures as generally retryable', () => {
    expect(fxExecuteErrorMetadata.INTERNAL_ERROR.retryability).toBe(
      fxExecuteRetryability.retryable_only_with_idempotency_proof,
    );
    expect(fxExecuteErrorMetadata.EXECUTE_TRANSACTION_FAILED.retryability).toBe(
      fxExecuteRetryability.retryable_only_with_idempotency_proof,
    );
  });

  it('builds the accepted error envelope only', () => {
    expect(buildFxExecuteErrorEnvelope('INVALID_AMOUNT')).toEqual({
      success: false,
      error: {
        code: 'INVALID_AMOUNT',
        message: fxExecuteErrorMetadata.INVALID_AMOUNT.defaultMessage,
      },
    });
    expect(
      buildFxExecuteErrorEnvelope('FX_RATE_STALE', 'Custom stale message'),
    ).toEqual({
      success: false,
      error: {
        code: 'FX_RATE_STALE',
        message: 'Custom stale message',
      },
    });
  });
});
