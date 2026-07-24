import { parseLimitOrderEnabled } from '../orders/limit-order.config';
import { readLimitOrderMatchingConfig } from '../orders/limit-order-matching.config';
import { readLiveCandleConfig } from '../assets/live-candle.config';

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
  const limitOrderEnabled = collect(errors, () =>
    parseLimitOrderEnabled(readOptionalString(config.LIMIT_ORDER_ENABLED)),
  );

  // SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED + the matching interval / batch /
  // lookback are strictly validated by their own parser. The parser also caps
  // the interval at half the 10s execute-freshness window, so a snapshot the
  // matcher accepts can never age past freshness before the fill commits.
  const matching = collect(errors, () => readLimitOrderMatchingConfig(env));

  collect(errors, () => readLiveCandleConfig(env));

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  // Questionable-but-valid operational combo, surfaced as a warning (never a
  // boot failure): matching is ON while new limit registration is OFF. New
  // orders are blocked but any ALREADY-submitted limit orders keep filling — a
  // legitimate "drain" state, so it is allowed and merely flagged.
  if (matching?.matchingEnabled && limitOrderEnabled === false) {
    console.warn(
      JSON.stringify({
        event: 'limit_order_matching_without_registration',
        message:
          'SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED=true while LIMIT_ORDER_ENABLED=false: no new limit orders can be registered, but existing submitted orders will still be auto-filled.',
      }),
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
