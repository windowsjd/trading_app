/**
 * Feature flag for the limit-buy order foundation (phase 1: reservation
 * only, no automatic matching). Default OFF — production should keep it off
 * unless operators intentionally expose limit-buy registration.
 *
 * Scope when disabled: new limit QUOTE/CREATE requests are rejected with
 * LIMIT_ORDER_DISABLED. Cancel and season-end / participant-exclusion
 * cleanup stay available regardless of the flag so already-reserved cash
 * can always be released.
 */

/** The only accepted spellings, compared after trim + lowercase. */
export const LIMIT_ORDER_ENABLED_TRUE_VALUES: readonly string[] = ['true', '1'];
export const LIMIT_ORDER_ENABLED_FALSE_VALUES: readonly string[] = [
  'false',
  '0',
];

export class LimitOrderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitOrderConfigError';
  }
}

/**
 * Parses LIMIT_ORDER_ENABLED strictly. A typo must never be read as "off":
 * silently disabling a flag the operator believed they had set is exactly the
 * failure this guards against, so anything outside the accepted set — `yes`,
 * `enabled`, `tru`, or an explicitly empty string — raises instead, which
 * startup validation turns into a refusal to boot.
 *
 * Only an ABSENT variable falls back to the documented default of false.
 * `TRUE` / `False` are accepted: comparison is trim + case-insensitive.
 */
export function parseLimitOrderEnabled(
  raw: string | undefined,
  variableName = 'LIMIT_ORDER_ENABLED',
): boolean {
  if (raw === undefined) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();

  if (LIMIT_ORDER_ENABLED_TRUE_VALUES.includes(normalized)) {
    return true;
  }

  if (LIMIT_ORDER_ENABLED_FALSE_VALUES.includes(normalized)) {
    return false;
  }

  throw new LimitOrderConfigError(
    `${variableName} must be one of ${[
      ...LIMIT_ORDER_ENABLED_TRUE_VALUES,
      ...LIMIT_ORDER_ENABLED_FALSE_VALUES,
    ].join(', ')} (case-insensitive), or be omitted for the default false. ` +
      `Received: ${JSON.stringify(raw)}.`,
  );
}

/**
 * Runtime read of the flag. Startup validation (src/common/env-validation.ts)
 * has already rejected any invalid value, so in a booted process this returns
 * without throwing.
 */
export function isLimitOrderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseLimitOrderEnabled(env.LIMIT_ORDER_ENABLED);
}
