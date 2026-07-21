/**
 * Feature flag for the limit-buy order foundation (phase 1: reservation
 * only, no automatic matching). Default OFF — production should keep it off
 * until the phase-2 execution engine ships.
 *
 * Scope when disabled: new limit QUOTE/CREATE requests are rejected with
 * LIMIT_ORDER_DISABLED. Cancel and season-end / participant-exclusion
 * cleanup stay available regardless of the flag so already-reserved cash
 * can always be released.
 */
export function isLimitOrderEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env.LIMIT_ORDER_ENABLED?.trim().toLowerCase();
  // Fail closed: anything other than an explicit opt-in keeps the flag off.
  return value === 'true' || value === '1';
}
