/** Fixed operational categories for PostgreSQL failures seen by background
 * collectors and workers. Only the category is ever logged or recorded; driver
 * messages, SQL and parameters never leave this module. */
export type DatabaseFailureKind =
  | 'disk_full'
  | 'statement_timeout'
  | 'lock_timeout'
  | 'connection'
  | 'data_rejected'
  | 'database_error'
  | 'unknown';

type DriverCause = {
  kind?: unknown;
  originalCode?: unknown;
  originalMessage?: unknown;
};

// @prisma/adapter-pg socket/TLS/session mappings that carry no SQLSTATE.
const CONNECTION_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'SocketTimeout',
  'TooManyConnections',
  'TlsConnectionError',
  'DatabaseDoesNotExist',
  'DatabaseAccessDenied',
  'AuthenticationFailed',
]);

function driverCause(value: unknown): DriverCause | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as {
    cause?: unknown;
    meta?: { driverAdapterError?: { cause?: unknown } };
  };
  // Prisma 7 model calls throw DriverAdapterError { cause }; raw queries throw
  // P2010 with meta.driverAdapterError.cause. Both carry the SQLSTATE.
  const cause = record.meta?.driverAdapterError?.cause ?? record.cause;
  return typeof cause === 'object' && cause !== null
    ? (cause as DriverCause)
    : undefined;
}

function topLevelCode(value: unknown) {
  const code =
    typeof value === 'object' && value !== null
      ? (value as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** SQLSTATE when the error carries one, else null. Prisma's own P1xxx–P6xxx
 * request codes are not SQLSTATEs. */
export function postgresErrorCode(value: unknown): string | null {
  const original = driverCause(value)?.originalCode;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/u.test(original))
    return original;
  const code = topLevelCode(value);
  return code && /^[0-9A-Z]{5}$/u.test(code) && !/^P[1-9]\d{3}$/u.test(code)
    ? code
    : null;
}

export function databaseFailureKind(value: unknown): DatabaseFailureKind {
  const sqlState = postgresErrorCode(value);
  const cause = driverCause(value);
  // ENOSPC surfaces as 53100 ("could not extend file ...: No space left on device").
  if (
    sqlState === '53100' ||
    (typeof cause?.originalMessage === 'string' &&
      /No space left on device/u.test(cause.originalMessage))
  )
    return 'disk_full';
  if (sqlState === '57014') return 'statement_timeout';
  if (sqlState === '55P03') return 'lock_timeout';
  const code = topLevelCode(value);
  if (
    sqlState?.startsWith('08') ||
    sqlState?.startsWith('57P') ||
    sqlState === '53300' ||
    (typeof cause?.kind === 'string' && CONNECTION_KINDS.has(cause.kind)) ||
    (code !== undefined &&
      ['P1001', 'P1002', 'P1017', 'ECONNREFUSED', 'ECONNRESET'].includes(code))
  )
    return 'connection';
  if (sqlState?.startsWith('22') || sqlState?.startsWith('23'))
    return 'data_rejected';
  if (sqlState) return 'database_error';
  return 'unknown';
}
