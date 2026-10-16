import { readUsStockPriceProvider } from '../providers/us-stock-price-provider.config';

/**
 * Dependency-free Limit-on-Close configuration. LOC_ORDERS_ENABLED (BUY) and
 * LOC_SELL_ORDERS_ENABLED (SELL, 2026-10-13) gate only NEW registrations of
 * their side; settlement/expiry of already accepted orders always runs so a
 * day-bound reservation can never strand. Evidence timing values are seconds
 * and are strictly bounded at startup.
 *
 * US stocks (2026-10-17) have their own registration flags and their own
 * close-evidence timing, as America/New_York wall-clock times of the session
 * date: Tiingo publishes the end-of-day close around 17:30 EST and applies
 * exchange corrections until 20:00 EST, so an offset from the close (which is
 * 13:00 on early-close days) would not express the policy. The KRX flags and
 * KRX timing above are unchanged and never enable US, and vice versa. A US
 * flag requires US_STOCK_PRICE_PROVIDER=tiingo (whose startup validation in
 * turn requires Tiingo's official mode): without the Tiingo close source a
 * US LOC could only ever expire.
 */
export type LimitOnCloseConfig = {
  /** KRX BUY registrations (LOC_ORDERS_ENABLED). */
  enabled: boolean;
  /** KRX SELL registrations (LOC_SELL_ORDERS_ENABLED); independent of BUY. */
  sellEnabled: boolean;
  /** KRX: first close observation no earlier than session close + this delay. */
  evidenceMinDelayMs: number;
  /** KRX: an identical observation at least this long after the first is final. */
  evidenceConfirmMs: number;
  /** KRX: no final evidence by session close + this deadline → expire/release. */
  evidenceDeadlineMs: number;
  us: LimitOnCloseUsConfig;
};

export type LimitOnCloseUsConfig = {
  /** US BUY registrations (LOC_US_ORDERS_ENABLED). */
  enabled: boolean;
  /** US SELL registrations (LOC_US_SELL_ORDERS_ENABLED). */
  sellEnabled: boolean;
  /** First close observation no earlier than this New York time (minutes of the day). */
  evidenceEarliestMinute: number;
  /** An identical observation at least this long after the first is final. */
  evidenceConfirmMs: number;
  /** No final evidence by this New York time (minutes of the day) → expire/release. */
  evidenceDeadlineMinute: number;
};

export const LOC_US_TIME_ZONE = 'America/New_York';

export function readLimitOnCloseConfig(
  env: NodeJS.ProcessEnv = process.env,
): LimitOnCloseConfig {
  const enabled = flag(env, 'LOC_ORDERS_ENABLED');
  const sellEnabled = flag(env, 'LOC_SELL_ORDERS_ENABLED');
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
  // US: never before 21:10 New York, the product policy (Tiingo corrections
  // until 20:00 EST, read as EDT too, plus a margin). Earlier needs real EOD
  // evidence and approval, not a config change.
  const usEarliest = wallClock(
    env,
    'LOC_US_CLOSE_EVIDENCE_EARLIEST_ET',
    '21:10',
    [21 * 60 + 10, 22 * 60 + 50],
  );
  const usConfirm = seconds(
    env,
    'LOC_US_CLOSE_EVIDENCE_CONFIRM_SECONDS',
    300,
    [300, 3600],
  );
  const usDeadline = wallClock(
    env,
    'LOC_US_CLOSE_EVIDENCE_DEADLINE_ET',
    '23:00',
    [21 * 60 + 10, 23 * 60 + 59],
  );
  if ((usDeadline - usEarliest) * 60 < 2 * usConfirm)
    // @diagnosticSurface internal: Startup rejects a US evidence window that cannot fit two confirmations.
    throw new Error(
      'LOC_US_CLOSE_EVIDENCE_DEADLINE_ET must leave two confirmation intervals after LOC_US_CLOSE_EVIDENCE_EARLIEST_ET',
    );
  const usEnabled = flag(env, 'LOC_US_ORDERS_ENABLED');
  const usSellEnabled = flag(env, 'LOC_US_SELL_ORDERS_ENABLED');
  if (
    (usEnabled || usSellEnabled) &&
    readUsStockPriceProvider(env) !== 'tiingo'
  )
    // @diagnosticSurface internal: Startup rejects US LOC without the Tiingo close-evidence provider.
    throw new Error(
      'LOC_US_ORDERS_ENABLED and LOC_US_SELL_ORDERS_ENABLED require US_STOCK_PRICE_PROVIDER=tiingo',
    );
  return {
    enabled,
    sellEnabled,
    evidenceMinDelayMs: minDelay * 1000,
    evidenceConfirmMs: confirm * 1000,
    evidenceDeadlineMs: deadline * 1000,
    us: {
      enabled: usEnabled,
      sellEnabled: usSellEnabled,
      evidenceEarliestMinute: usEarliest,
      evidenceConfirmMs: usConfirm * 1000,
      evidenceDeadlineMinute: usDeadline,
    },
  };
}

/** KRX BUY flag (the original LOC flag). */
export function limitOnCloseEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readLimitOnCloseConfig(env).enabled;
}

/** KRX SELL flag. */
export function limitOnCloseSellEnabled(env: NodeJS.ProcessEnv = process.env) {
  return readLimitOnCloseConfig(env).sellEnabled;
}

/** Markets whose registration flag for `side` is on (KRX first). */
export function limitOnCloseMarkets(
  config: LimitOnCloseConfig,
  side: 'buy' | 'sell',
): Array<'KRX' | 'US'> {
  const krx = side === 'buy' ? config.enabled : config.sellEnabled;
  const us = side === 'buy' ? config.us.enabled : config.us.sellEnabled;
  return [...(krx ? (['KRX'] as const) : []), ...(us ? (['US'] as const) : [])];
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name] ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error(`${name} must be true or false`);
  return value === 'true';
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

/** `HH:MM` (24h) → minutes of the day, bounded. */
function wallClock(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
  [min, max]: [number, number],
) {
  const text = (env[name] ?? fallback).trim();
  const match = /^(\d{2}):(\d{2})$/u.exec(text);
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  if (
    !match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    minutes < min ||
    minutes > max
  )
    // @diagnosticSurface internal: Startup rejects invalid fixed LOC timing configuration before serving requests.
    throw new Error(
      `${name} must be HH:MM from ${clockText(min)} through ${clockText(max)}`,
    );
  return minutes;
}

function clockText(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
