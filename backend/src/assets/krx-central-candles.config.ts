import { readMarketCandleRetentionConfig } from './market-candle-retention.config';
import { MANAGED_FIVE_MINUTE_RANGE_DAYS } from './candle-serving.config';

/**
 * Central KRX candle collection (design v2.1 §3, §4.2, §5.6; stage 3b).
 *
 * One switch turns on, together, the central intraday/post-close writers and
 * the KRX DB-only read path (holiday bridge, obligation filter, no provider
 * call from any chart request). Off (default) keeps every existing path.
 * Production activation needs the product approvals P1–P3 (design §13).
 */
export const KRX_CENTRAL_CANDLES_CONFIG = Symbol('KRX_CENTRAL_CANDLES_CONFIG');

/**
 * A collection cohort: the domestic symbols whose intraday 5m candles the
 * central collector must prove from `obligationStart` (A) on. Slots closed
 * before A carry no obligation (initial history, `pre_obligation`); every
 * required slot after A does (`post_obligation` when unproven).
 *
 * A is RECORDED here before the cohort's symbols are activated — never
 * derived from data (assets carry no activation time; the first checkpoint
 * of a failed collector would move A and hide the defect). A deployed
 * cohort's A must never change: the config test pins past values.
 */
export type KrxCollectionCohort = {
  id: string;
  /** ISO instant at 00:00 KST of the cohort's first obligated session date. */
  obligationStart: string;
  symbols: readonly string[];
};

/**
 * Versioned cohort registry. The first cohort (the domestic universe live at
 * activation) is added with A = the activation date's 00:00 KST in the same
 * change that is deployed before `KOSCOM_CENTRAL_CANDLES_ENABLED` is set;
 * each expansion step (25 → 50 → 100) appends a cohort before its symbols
 * are activated (design v2.1 §5.6, §10.5). Empty until then.
 */
export const KRX_COLLECTION_COHORTS: readonly KrxCollectionCohort[] = [];

export type KrxCentralCandlesConfig = {
  enabled: boolean;
  /** Intraday tick = 5m bucket end + this delay (KOSCOM 1m publication, Q13). */
  tickDelayMs: number;
  /** 1w upkeep once per week until apps without the weekly tab are gone. */
  weeklySyncEnabled: boolean;
  cohorts: readonly KrxCollectionCohort[];
};

export class KrxCentralCandlesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KrxCentralCandlesConfigError';
  }
}

const KST_MIDNIGHT_UTC_HOUR = 15; // 00:00 KST = 15:00 UTC of the previous day

export function readKrxCentralCandlesConfig(
  env: NodeJS.ProcessEnv = process.env,
  cohorts: readonly KrxCollectionCohort[] = KRX_COLLECTION_COHORTS,
): KrxCentralCandlesConfig {
  const enabled = readFlag(env, 'KOSCOM_CENTRAL_CANDLES_ENABLED', false);
  const config: KrxCentralCandlesConfig = {
    enabled,
    tickDelayMs: readInteger(
      env,
      'KOSCOM_CENTRAL_CANDLE_TICK_DELAY_MS',
      70_000,
      30_000,
      240_000,
    ),
    weeklySyncEnabled: readFlag(
      env,
      'KOSCOM_CENTRAL_WEEKLY_SYNC_ENABLED',
      true,
    ),
    cohorts,
  };
  validateCohorts(cohorts);
  if (!enabled) return config;
  // Fail closed at start-up instead of collecting without an obligation.
  if (cohorts.length === 0)
    // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
    throw new KrxCentralCandlesConfigError(
      'KOSCOM_CENTRAL_CANDLES_ENABLED requires at least one KRX collection cohort with its obligation start.',
    );
  const retentionDays = readMarketCandleRetentionConfig(env).retentionDays;
  if (retentionDays < MANAGED_FIVE_MINUTE_RANGE_DAYS)
    // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
    throw new KrxCentralCandlesConfigError(
      `KOSCOM_CENTRAL_CANDLES_ENABLED requires MARKET_CANDLE_5M_RETENTION_DAYS >= ${MANAGED_FIVE_MINUTE_RANGE_DAYS} (the 1h 24-session window).`,
    );
  return config;
}

function validateCohorts(cohorts: readonly KrxCollectionCohort[]): void {
  const seenIds = new Set<string>();
  let previousStart = -Infinity;
  for (const cohort of cohorts) {
    const start = Date.parse(cohort.obligationStart);
    const instant = new Date(start);
    if (
      !cohort.id ||
      seenIds.has(cohort.id) ||
      !Number.isFinite(start) ||
      instant.getUTCHours() !== KST_MIDNIGHT_UTC_HOUR ||
      instant.getUTCMinutes() !== 0 ||
      instant.getUTCSeconds() !== 0 ||
      instant.getUTCMilliseconds() !== 0 ||
      start < previousStart
    )
      // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
      throw new KrxCentralCandlesConfigError(
        'Each KRX collection cohort needs a unique id and an obligation start at 00:00 KST, in chronological order.',
      );
    // A symbol may reappear in a later cohort (re-activation, design §5.6).
    if (
      cohort.symbols.some((symbol) => !/^\d{6}$/u.test(symbol)) ||
      new Set(cohort.symbols).size !== cohort.symbols.length
    )
      // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
      throw new KrxCentralCandlesConfigError(
        'KRX collection cohort symbols must be distinct six-digit codes.',
      );
    seenIds.add(cohort.id);
    previousStart = start;
  }
}

/**
 * Obligation start A of a symbol: the LATEST cohort that lists it (a
 * re-activated symbol is re-registered, and its inactive period carries no
 * obligation), else the FIRST cohort's A — fail-closed: an unregistered
 * active symbol is held to the earliest obligation, so a missed registration
 * shows more defects, never fewer.
 */
export function resolveKrxObligationStart(
  config: Pick<KrxCentralCandlesConfig, 'cohorts'>,
  symbol: string,
): Date | null {
  if (config.cohorts.length === 0) return null;
  const listed = config.cohorts.filter((entry) =>
    entry.symbols.includes(symbol),
  );
  const cohort = listed.at(-1) ?? config.cohorts[0];
  return new Date(cohort.obligationStart);
}

function readFlag(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
  throw new KrxCentralCandlesConfigError(
    `${name} must be true, false, 1, or 0.`,
  );
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!/^\d+$/u.test(value) || parsed < min || parsed > max)
    // @diagnosticSurface internal: Start-up configuration guard; the message names only public env keys and the cohort registry rule.
    throw new KrxCentralCandlesConfigError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  return parsed;
}
