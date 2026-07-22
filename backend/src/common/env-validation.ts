import { parseLimitOrderEnabled } from '../orders/limit-order.config';
import { readLimitOrderCandleReconciliationConfig } from '../orders/limit-matching/limit-order-candle-reconciliation.config';
import { readLimitOrderMatchingConfig } from '../orders/limit-matching/limit-order-matching.config';
import { readLiveCandleConfig } from '../assets/live-candle.config';
import { OpsJobName } from '../generated/prisma/client';
import { getOpsSchedulerConfig } from '../ops/ops-config';
import { readProviderTradeReadinessConfig } from '../providers/provider-trade-readiness.config';

/**
 * Central startup validation for environment variables whose misconfiguration
 * would otherwise be silent.
 *
 * Wired into `ConfigModule.forRoot({ validate })` in app.module.ts, so a
 * rejected value aborts bootstrap instead of letting the process run with a
 * meaning the operator did not intend. Each variable keeps ONE parser, owned
 * by its feature module and reused at runtime — never a second, more
 * forgiving parser inside a service method.
 *
 * Scope note: only variables with a strict, enumerable domain belong here.
 * The many optional provider/scheduler settings keep their existing per-module
 * defaults; this is not a place to make previously optional configuration
 * mandatory.
 */
export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const errors: string[] = [];
  const env = toEnv(config);

  // LIMIT_ORDER_ENABLED: absent → false; otherwise exactly true/false/1/0
  // (trim + case-insensitive). Anything else is a boot failure, so a typo can
  // never be mistaken for a deliberate "off".
  collect(errors, () =>
    parseLimitOrderEnabled(readOptionalString(config.LIMIT_ORDER_ENABLED)),
  );

  const matching = collect(errors, () => readLimitOrderMatchingConfig(env));
  // Path B validates its own dependency on path A inside its parser.
  const reconciliation = collect(errors, () =>
    readLimitOrderCandleReconciliationConfig(env),
  );
  const sharedReadiness = collect(errors, () =>
    readProviderTradeReadinessConfig(env),
  );
  collect(errors, () => readLiveCandleConfig(env));

  // -------------------------------------------------------------------------
  // Cross-flag dependencies
  // -------------------------------------------------------------------------
  // These are the combinations that would boot "successfully" and then reserve
  // user cash against a matcher that cannot possibly fill it.
  if (matching?.enabled) {
    // Path A IS the Redis Stream consumer. Without a Redis URL it would fail
    // on its first read, after the API has already started accepting orders.
    if (!readOptionalString(config.REDIS_URL)?.trim()) {
      errors.push(
        'LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true requires REDIS_URL to be configured.',
      );
    }
    // The event boundary opens its own dedicated PostgreSQL sessions from
    // DATABASE_URL; a Prisma pool connection is deliberately never used.
    if (!readOptionalString(config.DATABASE_URL)?.trim()) {
      errors.push(
        'LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true requires DATABASE_URL to be configured for the match-boundary connection pool.',
      );
    }
  }

  if (reconciliation?.enabled) {
    // The sweep runs on the ordinary Ops tick under the shared Ops job lock.
    // Verify the RUNNER is actually wired rather than trusting the flag: an
    // enabled-but-unscheduled safety net is the worst of both states, because
    // its own health gate would then report a stale sweep and block every new
    // limit order while nothing was ever wrong with the market.
    const ops = collect(errors, () => getOpsSchedulerConfig(env));
    if (ops && !ops.enabled) {
      errors.push(
        'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=true requires the Ops scheduler to be enabled so the reconciliation job actually runs.',
      );
    }
    if (ops && !ops.jobs[OpsJobName.limit_order_candle_reconciliation]) {
      errors.push(
        'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=true requires the limit_order_candle_reconciliation Ops job to be enabled.',
      );
    }
    if (!readOptionalString(config.DATABASE_URL)?.trim()) {
      errors.push(
        'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=true requires DATABASE_URL to be configured.',
      );
    }
  }

  if (sharedReadiness?.enabled) {
    if (!readOptionalString(config.REDIS_URL)?.trim()) {
      errors.push(
        'LIMIT_ORDER_SHARED_READINESS_ENABLED=true requires REDIS_URL to be configured.',
      );
    }
    // Sharing readiness only means anything while automatic matching is the
    // thing consuming it.
    if (matching && !matching.enabled) {
      errors.push(
        'LIMIT_ORDER_SHARED_READINESS_ENABLED=true requires LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true.',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
}

function collect<T>(errors: string[], read: () => T): T | null {
  try {
    return read();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function toEnv(config: Record<string, unknown>): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      readOptionalString(value),
    ]),
  ) as NodeJS.ProcessEnv;
}

/**
 * Environment values arrive as strings, but ConfigModule types them `unknown`.
 * Anything that is not already a string is reported verbatim by the parser's
 * error message rather than being coerced through String(), which would turn
 * an object into a useless '[object Object]'.
 */
function readOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}
