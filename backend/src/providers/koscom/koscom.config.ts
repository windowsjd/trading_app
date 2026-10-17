import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

export const KOSCOM_PRICE_SOURCE = 'koscom_krx_realtime_price';
export const KOSCOM_BOOK_SOURCE = 'koscom_krx_orderbook';
export const KOSCOM_MINUTE_SOURCE = 'koscom_intraday';
export const KOSCOM_HISTORY_SOURCE = 'koscom_history';
export const KOSCOM_MARKETS = ['kospi', 'kosdaq', 'konex'] as const;
export type KoscomMarket = (typeof KOSCOM_MARKETS)[number];

/**
 * Numeric KOSCOM settings: [env key, fallback, min, max]. An unset value uses
 * the fallback silently; a set but invalid/out-of-range value also falls back
 * (unchanged behaviour) and is reported once by `koscomConfigWarnings`.
 */
const INTEGER_SETTINGS = {
  // 5 s central price cadence (2026-10-17 product policy for the 70-stock
  // universe; 3 s would exceed the monthly budget at 70 stocks, design §10).
  pollIntervalMs: ['KOSCOM_POLL_INTERVAL_MS', 5000, 1000, 60000],
  timeoutMs: ['KOSCOM_HTTP_TIMEOUT_MS', 5000, 100, 15000],
  concurrency: ['KOSCOM_MAX_CONCURRENCY', 2, 1, 4],
  minIntervalMs: ['KOSCOM_MIN_REQUEST_INTERVAL_MS', 200, 50, 10000],
  // Stage 2c: close-recovery attempts per asset and KST day; 0 = unlimited.
  closeRecoveryMaxAttempts: ['KOSCOM_CLOSE_RECOVERY_MAX_ATTEMPTS', 0, 0, 20],
  // Stage 3c: the shared provider pool the budget governor admits against
  // (design v2.1 §7.1: 50,000 per quota day, 1,000,000 per month).
  budgetDailyLimit: ['KOSCOM_BUDGET_DAILY_LIMIT', 50000, 1000, 10000000],
  budgetMonthlyLimit: [
    'KOSCOM_BUDGET_MONTHLY_LIMIT',
    1000000,
    10000,
    1000000000,
  ],
} as const;

/**
 * Collection switches. Every default keeps the behaviour production runs
 * today; turning a collection policy change on is an explicit, separately
 * approved env change (design v2.1 §10, §13).
 */
const FLAG_SETTINGS = {
  // Stage 1: the unused KOSCOM order-book poll/storage. Off by default since
  // the 2026-10-17 product policy (no domestic order-book calls; production
  // already ran with it off). `true` restores the poll.
  orderbookCollectionEnabled: ['KOSCOM_ORDERBOOK_COLLECTION_ENABLED', false],
  // Stage 1 observation (never blocks a call): per-category attempt counters
  // and the provider daily-quota headers, in Redis.
  callMetricsEnabled: ['KOSCOM_CALL_METRICS_ENABLED', true],
  // Stage 1 observation: one structured price-cycle summary per minute.
  cycleMetricsEnabled: ['KOSCOM_CYCLE_METRICS_ENABLED', true],
  // Stage 1 diagnostic (Q2‴): one structured line per price batch request.
  pollLogEnabled: ['KOSCOM_POLL_LOG_ENABLED', false],
  // Stage 2a: store only the audited price fields in NEW rows' raw payload.
  // Irreversible per row: switching it off does not restore slimmed rows.
  priceRawSlimEnabled: ['KOSCOM_PRICE_RAW_SLIM_ENABLED', false],
  // Stage 2b/2d: one price cycle per fixed slot across the cluster (Redis
  // slot key + 3T cycle lock), owned by the Ops scheduler whatever the live
  // candle flag says.
  priceSlotEnabled: ['KOSCOM_PRICE_SLOT_ENABLED', false],
  // Stage 2c: no in-cycle price retry (the next cycle is the retry) and a
  // cluster-wide 15/30/60 s pause after 3 consecutive fully failed cycles.
  priceRetryCapsEnabled: ['KOSCOM_PRICE_RETRY_CAPS_ENABLED', false],
  // Stage 2c: exponential market-list backoff (≤ 30 min) + Redis single flight.
  listBackoffEnabled: ['KOSCOM_LIST_BACKOFF_ENABLED', false],
  // Stage 3c: admit every attempt by priority against the daily and monthly
  // budget (§7.3). Off, the same decisions are only counted ("shadow").
  budgetEnforcementEnabled: ['KOSCOM_BUDGET_ENFORCEMENT_ENABLED', false],
  // Stage 3c: background KOSCOM calls wait while a price cycle's batches run.
  priceLaneEnabled: ['KOSCOM_PRICE_PRIORITY_LANE_ENABLED', false],
} as const;

export function readKoscomConfig(env = process.env) {
  const apiKey = env.KOSCOM_API_KEY?.trim() ?? '';
  const baseUrl = env.KOSCOM_BASE_URL?.trim() || 'https://oap.k-mydata.org';
  const validOrigin = [
    'https://oap.k-mydata.org',
    'https://testoap.k-mydata.org',
  ].includes(baseUrl);
  return {
    apiKey,
    baseUrl,
    enabled:
      Boolean(apiKey) &&
      validOrigin &&
      !['false', '0'].includes(env.KOSCOM_MARKET_DATA_ENABLED?.trim() ?? '') &&
      ['true', '1'].includes(env.PROVIDER_INGESTION_ENABLED?.trim() ?? ''),
    pollingEnabled: ['true', '1'].includes(
      env.KOSCOM_POLLING_ENABLED?.trim() ?? '',
    ),
    pollIntervalMs: integer(env, INTEGER_SETTINGS.pollIntervalMs),
    timeoutMs: integer(env, INTEGER_SETTINGS.timeoutMs),
    concurrency: integer(env, INTEGER_SETTINGS.concurrency),
    minIntervalMs: integer(env, INTEGER_SETTINGS.minIntervalMs),
    closeRecoveryMaxAttempts: integer(
      env,
      INTEGER_SETTINGS.closeRecoveryMaxAttempts,
    ),
    budgetDailyLimit: integer(env, INTEGER_SETTINGS.budgetDailyLimit),
    budgetMonthlyLimit: integer(env, INTEGER_SETTINGS.budgetMonthlyLimit),
    orderbookCollectionEnabled: flag(
      env,
      FLAG_SETTINGS.orderbookCollectionEnabled,
    ),
    callMetricsEnabled: flag(env, FLAG_SETTINGS.callMetricsEnabled),
    cycleMetricsEnabled: flag(env, FLAG_SETTINGS.cycleMetricsEnabled),
    pollLogEnabled: flag(env, FLAG_SETTINGS.pollLogEnabled),
    priceRawSlimEnabled: flag(env, FLAG_SETTINGS.priceRawSlimEnabled),
    priceSlotEnabled: flag(env, FLAG_SETTINGS.priceSlotEnabled),
    priceRetryCapsEnabled: flag(env, FLAG_SETTINGS.priceRetryCapsEnabled),
    listBackoffEnabled: flag(env, FLAG_SETTINGS.listBackoffEnabled),
    budgetEnforcementEnabled: flag(env, FLAG_SETTINGS.budgetEnforcementEnabled),
    priceLaneEnabled: flag(env, FLAG_SETTINGS.priceLaneEnabled),
    namespace: createHash('sha256')
      .update(`${baseUrl}:${apiKey}`)
      .digest('hex')
      .slice(0, 16),
  };
}

export type KoscomConfig = ReturnType<typeof readKoscomConfig>;

/**
 * Whether the live candle supervisor polls KOSCOM prices (legacy live mode).
 * In slot mode (2d) the Ops scheduler owns the price loop in every mode, so
 * the live flag no longer changes how KOSCOM prices are collected.
 */
export function isKoscomPollingOwnedByLiveSupervisor(
  config: Pick<KoscomConfig, 'enabled' | 'pollingEnabled' | 'priceSlotEnabled'>,
): boolean {
  return config.enabled && config.pollingEnabled && !config.priceSlotEnabled;
}

export type KoscomConfigWarning = {
  setting: string;
  reason: 'out_of_range' | 'invalid';
  fallback: number | boolean;
};

/**
 * Set-but-ignored KOSCOM settings (F16). Values silently fell back before;
 * the fallback is unchanged, the misconfiguration is now observable. Only
 * the env key and the fallback are reported, never the raw value.
 */
export function koscomConfigWarnings(env = process.env): KoscomConfigWarning[] {
  const warnings: KoscomConfigWarning[] = [];
  for (const [key, fallback, min, max] of Object.values(INTEGER_SETTINGS)) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isSafeInteger(n))
      warnings.push({ setting: key, reason: 'invalid', fallback });
    else if (n < min || n > max)
      warnings.push({ setting: key, reason: 'out_of_range', fallback });
  }
  for (const [key, fallback] of Object.values(FLAG_SETTINGS)) {
    const raw = env[key]?.trim().toLowerCase();
    if (raw && !['true', 'false', '1', '0'].includes(raw))
      warnings.push({ setting: key, reason: 'invalid', fallback });
  }
  return warnings;
}

function integer(
  env: NodeJS.ProcessEnv,
  [key, fallback, min, max]: readonly [string, number, number, number],
) {
  const n = Number(env[key]);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

function flag(
  env: NodeJS.ProcessEnv,
  [key, fallback]: readonly [string, boolean],
) {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

@Injectable()
export class KoscomConfigService {
  getConfig() {
    return readKoscomConfig();
  }
}

/** Fixed categories only: never wrap provider/transport exception messages. */
export class KoscomError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'KoscomError';
  }
}

export function koscomFailure(error: unknown): string {
  return error instanceof KoscomError ? error.code : 'KOSCOM_OPERATION_FAILED';
}
