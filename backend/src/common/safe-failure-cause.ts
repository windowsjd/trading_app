export type SafeFailureCause = {
  category: string;
  errorType: string;
  code?: string;
};

/** Request-neutral allowlist; never retains messages, stacks or payloads. */
export function classifyFailureCause(
  cause: unknown,
  depth = 0,
): SafeFailureCause {
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
      'HttpException',
      'BadRequestException',
      'UnauthorizedException',
      'ForbiddenException',
      'NotFoundException',
      'ConflictException',
      'InternalServerErrorException',
      'ServiceUnavailableException',
      'PortfolioValuationError',
      'PrismaClientKnownRequestError',
      'PrismaClientUnknownRequestError',
      'PrismaClientInitializationError',
      'PrismaClientValidationError',
    ].includes(cause.name)
      ? cause.name
      : cause instanceof Error
        ? 'Error'
        : 'NonError';
  const result: SafeFailureCause = {
    category:
      code && Object.hasOwn(categories, code)
        ? categories[code]
        : knownType.startsWith('PrismaClient')
          ? 'database_failure'
          : 'unexpected_error',
    errorType: knownType,
    ...(code && Object.hasOwn(categories, code) ? { code } : {}),
  };
  // A cause may supply an observed allowlisted code. Strings/payloads and
  // unknown names are never retained, and cycles cannot recurse indefinitely.
  if (
    result.category === 'unexpected_error' &&
    cause instanceof Error &&
    depth < 3 &&
    cause.cause
  ) {
    const nested = classifyFailureCause(cause.cause, depth + 1);
    if (nested.category !== 'unexpected_error') return nested;
  }
  return result;
}
