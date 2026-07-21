import { parseLimitOrderEnabled } from '../orders/limit-order.config';

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

  // LIMIT_ORDER_ENABLED: absent → false; otherwise exactly true/false/1/0
  // (trim + case-insensitive). Anything else is a boot failure, so a typo can
  // never be mistaken for a deliberate "off".
  try {
    parseLimitOrderEnabled(readOptionalString(config.LIMIT_ORDER_ENABLED));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${errors.join('\n- ')}`,
    );
  }

  return config;
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
