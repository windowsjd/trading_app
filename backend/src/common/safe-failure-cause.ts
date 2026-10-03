export type SafeFailureCause = {
  category: string;
  errorType: string;
  code?: string;
};

/** Request-neutral allowlist; never retains messages, stacks or payloads. */
export function classifyFailureCause(cause: unknown): SafeFailureCause {
  const categories: Record<string, string> = {
    P2002: 'db_unique_constraint',
    P2003: 'db_foreign_key_constraint',
    P2025: 'db_record_not_found',
    P2034: 'db_transaction_conflict',
    P1001: 'db_connection_failed',
    P1002: 'db_timeout',
    '23505': 'db_unique_constraint',
    '23503': 'db_foreign_key_constraint',
    '40001': 'db_transaction_conflict',
    '40P01': 'db_deadlock',
    PROVIDER_HTTP_ERROR: 'provider_http_error',
    PROVIDER_TIMEOUT: 'provider_timeout',
    PROVIDER_REQUEST_FAILED: 'provider_request_failed',
    PROVIDER_JSON_PARSE_ERROR: 'provider_parse_error',
  };
  const code =
    cause &&
    typeof cause === 'object' &&
    'code' in cause &&
    typeof cause.code === 'string'
      ? cause.code
      : undefined;
  const knownType =
    cause instanceof Error &&
    [
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'PrismaClientKnownRequestError',
      'PrismaClientUnknownRequestError',
      'PrismaClientInitializationError',
      'PrismaClientValidationError',
    ].includes(cause.name)
      ? cause.name
      : cause instanceof Error
        ? 'Error'
        : 'NonError';
  return {
    category:
      code && Object.hasOwn(categories, code)
        ? categories[code]
        : 'unexpected_error',
    errorType: knownType,
    ...(code && Object.hasOwn(categories, code) ? { code } : {}),
  };
}
