import { OpsJobName } from '../generated/prisma/client';

export type OpsSchedulerConfig = {
  enabled: boolean;
  timezone: string;
  lockTtlSeconds: number;
  maxAttempts: number;
  tickIntervalMs: number;
  jobs: Record<OpsJobName, boolean>;
};

const DEFAULT_LOCK_TTL_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_TIMEZONE = 'Asia/Seoul';

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

  return {
    enabled:
      parseBooleanEnv(env.SCHEDULER_ENABLED, false) ||
      rankingEnabled ||
      lifecycleEnabled ||
      settlementEnabled,
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
      [OpsJobName.provider_fx_ingest]: parseBooleanEnv(
        env.SCHEDULER_PROVIDER_FX_ENABLED,
        false,
      ),
      [OpsJobName.provider_binance_ingest]: parseBooleanEnv(
        env.SCHEDULER_PROVIDER_BINANCE_ENABLED,
        false,
      ),
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
  };
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
