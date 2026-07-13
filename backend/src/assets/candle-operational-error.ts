/**
 * Classification of errors that may be absorbed by the stale-Redis fallback
 * on the candle serving path.
 *
 * Only transient infrastructure failures qualify: database connectivity,
 * timeouts, pool exhaustion, Redis coordination timeouts, and operational
 * provider-refresh failures. Validation errors, configuration errors, schema
 * invariant violations, and other programmer errors must surface to the
 * caller — hiding them behind stale data would mask real defects.
 *
 * The check is an allowlist: anything not positively identified as
 * operational is NOT eligible for the stale fallback.
 */

// Prisma driver/client failures that indicate the database (not the query)
// is unhealthy. P1xxx are connection/environment errors; P2024 is
// connection-pool checkout timeout; P2028 is a transaction API failure
// (typically a dropped connection mid-transaction).
const PRISMA_OPERATIONAL_CODE_PATTERN = /^P1\d{3}$/u;
const PRISMA_OPERATIONAL_CODES = new Set(['P2024', 'P2028', 'P2034']);

const PRISMA_OPERATIONAL_ERROR_NAMES = new Set([
  'PrismaClientInitializationError',
  'PrismaClientRustPanicError',
  'PrismaClientUnknownRequestError',
]);

// Node/driver-level connectivity failures (surfaced via error.code or the
// message, depending on the driver adapter).
const CONNECTIVITY_CODE_PATTERN =
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b/u;
// PostgreSQL server-side shutdown/connection failure SQLSTATEs.
const POSTGRES_OPERATIONAL_SQLSTATE = /\b(57P0[123]|08\d{3}|53300)\b/u;
const CONNECTIVITY_MESSAGE_PATTERN =
  /(connection (refused|reset|closed|terminated|lost)|connect(ion)? timeout|timed? ?out|pool.*(exhaust|timeout)|server has closed the connection|can't reach database server|database server.*(unavailable|not running))/iu;

export function isDatabaseOperationalError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && PRISMA_OPERATIONAL_ERROR_NAMES.has(name)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (
      PRISMA_OPERATIONAL_CODE_PATTERN.test(code) ||
      PRISMA_OPERATIONAL_CODES.has(code) ||
      CONNECTIVITY_CODE_PATTERN.test(code) ||
      POSTGRES_OPERATIONAL_SQLSTATE.test(code)
    ) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string') {
    if (
      CONNECTIVITY_CODE_PATTERN.test(message) ||
      POSTGRES_OPERATIONAL_SQLSTATE.test(message) ||
      CONNECTIVITY_MESSAGE_PATTERN.test(message)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Errors the candle serving path may hide behind a stale cached response.
 * Callers pass the names of their own operational error classes (e.g.
 * CandleOperationalRefreshError) via `extraOperationalNames` to avoid import
 * cycles.
 */
export function isCandleOperationalFallbackError(
  error: unknown,
  extraOperationalNames: readonly string[] = [],
): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string') {
    if (extraOperationalNames.includes(name)) return true;
    if (
      name === 'CandleSingleFlightWaitTimeoutError' ||
      name === 'RedisUnavailableError'
    ) {
      return true;
    }
  }
  return isDatabaseOperationalError(error);
}
