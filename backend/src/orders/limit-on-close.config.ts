/**
 * Dependency-free Limit-on-Close configuration. LOC_ORDERS_ENABLED (BUY) and
 * LOC_SELL_ORDERS_ENABLED (SELL, 2026-10-13) gate only NEW registrations of
 * their side; settlement/expiry of already accepted orders always runs so a
 * day-bound reservation can never strand. Evidence timing values are seconds
 * and are strictly bounded at startup.
 */
export type LimitOnCloseConfig = {
  /** BUY registrations (LOC_ORDERS_ENABLED). */
  enabled: boolean;
  /** SELL registrations (LOC_SELL_ORDERS_ENABLED); independent of BUY. */
  sellEnabled: boolean;
  /** First close observation no earlier than session close + this delay. */
  evidenceMinDelayMs: number;
  /** An identical observation at least this long after the first is final. */
  evidenceConfirmMs: number;
  /** No final evidence by session close + this deadline → expire/release. */
  evidenceDeadlineMs: number;
};

export function readLimitOnCloseConfig(
  env: NodeJS.ProcessEnv = process.env,
): LimitOnCloseConfig {
  const value = env.LOC_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('LOC_ORDERS_ENABLED must be true or false');
  const sellValue = env.LOC_SELL_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(sellValue))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('LOC_SELL_ORDERS_ENABLED must be true or false');
  const minDelay = seconds(
    env,
    'LOC_CLOSE_EVIDENCE_MIN_DELAY_SECONDS',
    1200,
    [300, 7200],
  );
  const confirm = seconds(
    env,
    'LOC_CLOSE_EVIDENCE_CONFIRM_SECONDS',
    300,
    [60, 3600],
  );
  const deadline = seconds(
    env,
    'LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS',
    10800,
    [1800, 43200],
  );
  if (deadline < minDelay + 2 * confirm)
    // @diagnosticSurface internal: Startup rejects an evidence deadline that cannot fit two confirmations.
    throw new Error(
      'LOC_CLOSE_EVIDENCE_DEADLINE_SECONDS must cover the minimum delay plus two confirmation intervals',
    );
  return {
    enabled: value === 'true',
    sellEnabled: sellValue === 'true',
    evidenceMinDelayMs: minDelay * 1000,
    evidenceConfirmMs: confirm * 1000,
    evidenceDeadlineMs: deadline * 1000,
  };
}

export function limitOnCloseEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readLimitOnCloseConfig(env).enabled;
}

export function limitOnCloseSellEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readLimitOnCloseConfig(env).sellEnabled;
}

function seconds(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  [min, max]: [number, number],
) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const parsed = /^\d{1,6}$/u.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    // @diagnosticSurface internal: Startup rejects invalid fixed LOC timing configuration before serving requests.
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return parsed;
}
