import { OpsJobName } from '../generated/prisma/client';
import {
  readMarketCandleReconciliationConfig,
  type MarketCandleReconciliationConfig,
} from '../assets/market-candle-reconciliation.config';
import {
  readLimitOrderCandleReconciliationConfig,
  type LimitOrderCandleReconciliationConfig,
} from '../orders/limit-matching/limit-order-candle-reconciliation.config';

export type ProviderOpsJobName =
  | typeof OpsJobName.provider_fx_ingest
  | typeof OpsJobName.provider_binance_ingest
  | typeof OpsJobName.provider_kis_ingest;

export type KisPriceIngestionMode = 'websocket_trade' | 'rest_current_price';

export type OpsSchedulerConfig = {
  enabled: boolean;
  timezone: string;
  lockTtlSeconds: number;
  maxAttempts: number;
  tickIntervalMs: number;
  jobs: Record<OpsJobName, boolean>;
  providerIntervalsSeconds: Record<ProviderOpsJobName, number>;
  providerIngestionRunOnStartup: boolean;
  providerKisMaxSnapshots: number;
  providerKisPriceIngestionMode: KisPriceIngestionMode;
  marketCandleRetention: {
    enabled: boolean;
    retentionDays: number;
    batchSize: number;
    hour: number;
    minute: number;
    runOnStartup: boolean;
  };
  marketCandleReconciliation: MarketCandleReconciliationConfig;
  limitOrderCandleReconciliation: LimitOrderCandleReconciliationConfig;
};

export class OpsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsConfigError';
  }
}

const DEFAULT_LOCK_TTL_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = 'Asia/Seoul';
const DEFAULT_PROVIDER_FX_INTERVAL_SECONDS = 3600;
const DEFAULT_PROVIDER_BINANCE_INTERVAL_SECONDS = 60;
const DEFAULT_PROVIDER_KIS_INTERVAL_SECONDS = 60;
const DEFAULT_PROVIDER_KIS_MAX_SNAPSHOTS = 500;
const DEFAULT_KIS_PRICE_INGESTION_MODE: KisPriceIngestionMode =
  'websocket_trade';
const DEFAULT_RETENTION_HOUR = 4;
const DEFAULT_RETENTION_MINUTE = 0;

export function getOpsSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpsSchedulerConfig {
  const marketCandleReconciliation = readMarketCandleReconciliationConfig(env);
  const limitOrderCandleReconciliation =
    readLimitOrderCandleReconciliationConfig(env);
  const rankingEnabled = parseBooleanEnv(
    env.SCHEDULER_RANKING_ENABLED ?? env.ENABLE_RANKING_SCHEDULER,
    false,
  );
  const lifecycleEnabled = parseBooleanEnv(
    env.SCHEDULER_SEASON_LIFECYCLE_ENABLED ??
      env.ENABLE_SEASON_LIFECYCLE_SCHEDULER,
    false,
  );
  const settlementEnabled = parseBooleanEnv(
    env.SCHEDULER_SETTLEMENT_ENABLED ?? env.ENABLE_SEASON_SETTLEMENT_SCHEDULER,
    false,
  );
  const providerFxEnabled = parseBooleanEnv(
    env.SCHEDULER_PROVIDER_FX_ENABLED,
    false,
  );
  const providerBinanceEnabled = parseBooleanEnv(
    env.SCHEDULER_PROVIDER_BINANCE_ENABLED,
    false,
  );
  const providerKisEnabled = parseBooleanEnv(
    env.SCHEDULER_PROVIDER_KIS_ENABLED ?? env.ENABLE_PROVIDER_KIS_SCHEDULER,
    false,
  );
  const retentionEnabled = parseStrictBooleanEnv(
    env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED,
    false,
    'SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED',
  );
  const retentionDays = parseStrictIntegerEnv(
    env.MARKET_CANDLE_5M_RETENTION_DAYS,
    35,
    'MARKET_CANDLE_5M_RETENTION_DAYS',
    31,
  );
  const retentionBatchSize = parseStrictIntegerEnv(
    env.MARKET_CANDLE_RETENTION_BATCH_SIZE,
    5000,
    'MARKET_CANDLE_RETENTION_BATCH_SIZE',
    1,
    10_000,
  );
  const retentionHour = parseStrictIntegerEnv(
    env.SCHEDULER_MARKET_CANDLE_RETENTION_HOUR,
    DEFAULT_RETENTION_HOUR,
    'SCHEDULER_MARKET_CANDLE_RETENTION_HOUR',
    0,
    23,
  );
  const retentionMinute = parseStrictIntegerEnv(
    env.SCHEDULER_MARKET_CANDLE_RETENTION_MINUTE,
    DEFAULT_RETENTION_MINUTE,
    'SCHEDULER_MARKET_CANDLE_RETENTION_MINUTE',
    0,
    59,
  );
  const retentionRunOnStartup = parseStrictBooleanEnv(
    env.SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP,
    false,
    'SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP',
  );

  return {
    enabled:
      parseBooleanEnv(env.SCHEDULER_ENABLED, false) ||
      rankingEnabled ||
      lifecycleEnabled ||
      settlementEnabled ||
      providerFxEnabled ||
      providerBinanceEnabled ||
      providerKisEnabled ||
      retentionEnabled ||
      marketCandleReconciliation.enabled ||
      limitOrderCandleReconciliation.enabled,
    timezone: parseTextEnv(env.SCHEDULER_TIMEZONE, DEFAULT_TIMEZONE),
    lockTtlSeconds: parsePositiveIntegerEnv(
      env.SCHEDULER_LOCK_TTL_SECONDS,
      DEFAULT_LOCK_TTL_SECONDS,
    ),
    maxAttempts: parsePositiveIntegerEnv(
      env.SCHEDULER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    ),
    tickIntervalMs: resolveTickIntervalMs(env),
    jobs: {
      [OpsJobName.provider_fx_ingest]: providerFxEnabled,
      [OpsJobName.provider_binance_ingest]: providerBinanceEnabled,
      [OpsJobName.provider_kis_ingest]: providerKisEnabled,
      [OpsJobName.daily_portfolio_snapshot]: parseBooleanEnv(
        env.SCHEDULER_DAILY_SNAPSHOT_ENABLED,
        false,
      ),
      [OpsJobName.season_ranking_generation]: rankingEnabled,
      [OpsJobName.season_lifecycle_transition]: lifecycleEnabled,
      [OpsJobName.season_settlement]: settlementEnabled,
      [OpsJobName.reward_marker]: parseBooleanEnv(
        env.SCHEDULER_REWARD_MARKER_ENABLED,
        false,
      ),
      [OpsJobName.market_candle_retention]: retentionEnabled,
      // Manual/operator-triggered only in this phase; a market-close /
      // realtime sync scheduler is a unit-3 decision.
      [OpsJobName.market_candle_sync]: false,
      [OpsJobName.market_candle_reconciliation]:
        marketCandleReconciliation.enabled,
      // Dedicated long-running poller; never scheduled on the 60s Ops tick.
      [OpsJobName.limit_order_matcher]: false,
      // Path-B safety net: reuses the ordinary 60s tick, default off.
      [OpsJobName.limit_order_candle_reconciliation]:
        limitOrderCandleReconciliation.enabled,
    },
    providerIntervalsSeconds: {
      [OpsJobName.provider_fx_ingest]: parsePositiveIntegerEnv(
        env.SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS,
        DEFAULT_PROVIDER_FX_INTERVAL_SECONDS,
      ),
      [OpsJobName.provider_binance_ingest]: parsePositiveIntegerEnv(
        env.SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS,
        DEFAULT_PROVIDER_BINANCE_INTERVAL_SECONDS,
      ),
      [OpsJobName.provider_kis_ingest]: parsePositiveIntegerEnv(
        env.SCHEDULER_PROVIDER_KIS_INTERVAL_SECONDS,
        DEFAULT_PROVIDER_KIS_INTERVAL_SECONDS,
      ),
    },
    providerIngestionRunOnStartup: parseBooleanEnv(
      env.SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP,
      false,
    ),
    providerKisMaxSnapshots: resolveProviderKisMaxSnapshots(env),
    providerKisPriceIngestionMode: resolveKisPriceIngestionMode(env),
    marketCandleRetention: {
      enabled: retentionEnabled,
      retentionDays,
      batchSize: retentionBatchSize,
      hour: retentionHour,
      minute: retentionMinute,
      runOnStartup: retentionRunOnStartup,
    },
    marketCandleReconciliation,
    limitOrderCandleReconciliation,
  };
}

function resolveProviderKisMaxSnapshots(env: NodeJS.ProcessEnv) {
  return (
    parseOptionalPositiveIntegerEnv(env.SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS) ??
    parseOptionalPositiveIntegerEnv(env.PROVIDER_INGESTION_MAX_SNAPSHOTS) ??
    DEFAULT_PROVIDER_KIS_MAX_SNAPSHOTS
  );
}

function resolveKisPriceIngestionMode(
  env: NodeJS.ProcessEnv,
): KisPriceIngestionMode {
  const value = parseTextEnv(
    env.KIS_PRICE_INGESTION_MODE,
    DEFAULT_KIS_PRICE_INGESTION_MODE,
  )
    .trim()
    .toLowerCase();

  return value === 'rest_current_price' || value === 'websocket_trade'
    ? value
    : DEFAULT_KIS_PRICE_INGESTION_MODE;
}

function resolveTickIntervalMs(env: NodeJS.ProcessEnv) {
  const explicitMs = parseOptionalPositiveIntegerEnv(
    env.SCHEDULER_TICK_INTERVAL_MS,
  );
  if (explicitMs) {
    return explicitMs;
  }

  const intervalSeconds = parseOptionalPositiveIntegerEnv(
    env.RANKING_REFRESH_INTERVAL_SECONDS ??
      env.SEASON_SETTLEMENT_INTERVAL_SECONDS,
  );

  return intervalSeconds ? intervalSeconds * 1000 : DEFAULT_TICK_INTERVAL_MS;
}

export function getSchedulerBusinessDate(now: Date, timezone: string): string {
  const parts = getSchedulerLocalDateTime(now, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function getSchedulerLocalDateTime(now: Date, timezone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    throw new OpsConfigError(
      'SCHEDULER_TIMEZONE must be a valid IANA timezone.',
    );
  }
  const values = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function parseStrictBooleanEnv(
  value: string | undefined,
  fallback: boolean,
  name: string,
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new OpsConfigError(`${name} must be true, false, 1, or 0.`);
}

function parseStrictIntegerEnv(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    throw new OpsConfigError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new OpsConfigError(
      `${name} must be an integer between ${min} and ${max}.`,
    );
  }
  return parsed;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }

  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return fallback;
}

function parseTextEnv(value: string | undefined, fallback: string) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number) {
  return parseOptionalPositiveIntegerEnv(value) ?? fallback;
}

function parseOptionalPositiveIntegerEnv(value: string | undefined) {
  if (value === undefined || value.trim() === '') {
    return undefined;
  }

  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return undefined;
  }

  return parsed;
}
