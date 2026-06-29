import { OpsJobName } from '../generated/prisma/client';

export type ProviderOpsJobName =
  | typeof OpsJobName.provider_fx_ingest
  | typeof OpsJobName.provider_binance_ingest
  | typeof OpsJobName.provider_kis_ingest;

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
};

const DEFAULT_LOCK_TTL_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = 'Asia/Seoul';
const DEFAULT_PROVIDER_FX_INTERVAL_SECONDS = 3600;
const DEFAULT_PROVIDER_BINANCE_INTERVAL_SECONDS = 60;
const DEFAULT_PROVIDER_KIS_INTERVAL_SECONDS = 60;
const DEFAULT_PROVIDER_KIS_MAX_SNAPSHOTS = 500;

export function getOpsSchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpsSchedulerConfig {
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

  return {
    enabled:
      parseBooleanEnv(env.SCHEDULER_ENABLED, false) ||
      rankingEnabled ||
      lifecycleEnabled ||
      settlementEnabled ||
      providerFxEnabled ||
      providerBinanceEnabled ||
      providerKisEnabled,
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
  };
}

function resolveProviderKisMaxSnapshots(env: NodeJS.ProcessEnv) {
  return (
    parseOptionalPositiveIntegerEnv(env.SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS) ??
    parseOptionalPositiveIntegerEnv(env.PROVIDER_INGESTION_MAX_SNAPSHOTS) ??
    DEFAULT_PROVIDER_KIS_MAX_SNAPSHOTS
  );
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
  if (timezone === DEFAULT_TIMEZONE) {
    return new Date(now.getTime() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
  }

  return now.toISOString().slice(0, 10);
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
