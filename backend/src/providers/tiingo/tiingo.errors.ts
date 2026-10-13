export type TiingoErrorCode =
  | 'TIINGO_DISABLED'
  | 'TIINGO_SYMBOL_NOT_ALLOWED'
  | 'TIINGO_ASSET_NOT_MAPPED'
  | 'TIINGO_ASSET_AMBIGUOUS'
  | 'TIINGO_UNAUTHORIZED'
  | 'TIINGO_FORBIDDEN'
  | 'TIINGO_NOT_FOUND'
  | 'TIINGO_RATE_LIMITED'
  | 'TIINGO_SERVER_ERROR'
  | 'TIINGO_HTTP_ERROR'
  | 'TIINGO_TIMEOUT'
  | 'TIINGO_ABORTED'
  | 'TIINGO_REQUEST_FAILED'
  | 'TIINGO_RESPONSE_TOO_LARGE'
  | 'TIINGO_INVALID_JSON'
  | 'TIINGO_INVALID_PAYLOAD'
  | 'TIINGO_EMPTY_RESPONSE'
  | 'TIINGO_SYMBOL_MISMATCH'
  | 'TIINGO_INVALID_TIMESTAMP'
  | 'TIINGO_BUDGET_EXHAUSTED'
  | 'TIINGO_CALENDAR_UNAVAILABLE';

/**
 * Fixed categories only. Provider response bodies, URLs (which never carry the
 * token, but still) and transport exception text are never wrapped, so the
 * message is the code itself.
 */
export class TiingoError extends Error {
  constructor(
    readonly code: TiingoErrorCode,
    readonly retryable = false,
    readonly httpStatus: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
    this.name = 'TiingoError';
  }
}

export function tiingoFailureCode(
  error: unknown,
): TiingoErrorCode | 'TIINGO_OPERATION_FAILED' {
  return error instanceof TiingoError ? error.code : 'TIINGO_OPERATION_FAILED';
}
