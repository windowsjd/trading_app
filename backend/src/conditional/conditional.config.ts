/** Dependency-free startup/runtime capability parser. */
export function conditionalEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.CONDITIONAL_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('CONDITIONAL_ORDERS_ENABLED must be true or false');
  return value === 'true';
}

/**
 * New whole-position OCO groups (POST /protections, a Spot BUY Limit
 * `attachedProtection`, a Futures limit entry `attachedProtection`) are
 * retired (2026-10-16): new stop-loss/take-profit registrations are the
 * independent settings and entry plans. This is separate from
 * CONDITIONAL_ORDERS_ENABLED on purpose: existing groups keep triggering,
 * filling, canceling and listing under that flag whatever this one says.
 * Strict true/false, omitted is false; true exists only for legacy
 * compatibility tests and must stay false in production.
 */
export function legacyOcoRegistrationEnabled(
  env: NodeJS.ProcessEnv = process.env,
) {
  const value = env.LEGACY_OCO_REGISTRATION_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('LEGACY_OCO_REGISTRATION_ENABLED must be true or false');
  return value === 'true';
}
