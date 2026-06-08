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
  return {
    enabled: parseBooleanEnv(env.SCHEDULER_ENABLED, false),
    timezone: parseTextEnv(env.SCHEDULER_TIMEZONE, DEFAULT_TIMEZONE),
    lockTtlSeconds: parsePositiveIntegerEnv(
      env.SCHEDULER_LOCK_TTL_SECONDS,
      DEFAULT_LOCK_TTL_SECONDS,
    ),
    maxAttempts: parsePositiveIntegerEnv(
      env.SCHEDULER_MAX_ATTEMPTS,
      DEFAULT_MAX_ATTEMPTS,
    ),
    tickIntervalMs: parsePositiveIntegerEnv(
      env.SCHEDULER_TICK_INTERVAL_MS,
      DEFAULT_TICK_INTERVAL_MS,
    ),
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
      [OpsJobName.season_ranking_generation]: parseBooleanEnv(
        env.SCHEDULER_RANKING_ENABLED,
        false,
      ),
      [OpsJobName.season_settlement]: parseBooleanEnv(
        env.SCHEDULER_SETTLEMENT_ENABLED,
        false,
      ),
      [OpsJobName.reward_marker]: parseBooleanEnv(
        env.SCHEDULER_REWARD_MARKER_ENABLED,
        false,
      ),
    },
  };
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
  if (value === undefined || value.trim() === '') {
    return fallback;
  }

  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}
