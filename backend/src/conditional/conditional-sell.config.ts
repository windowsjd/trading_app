/**
 * Dependency-free startup/runtime capability parsers for SELL intents. Each
 * is independent of every existing flag: CONDITIONAL_ORDERS_ENABLED (whole
 * position OCO protection) and CONDITIONAL_BUY_ORDERS_ENABLED never expose a
 * new SELL feature, and the two SELL kinds are gated separately.
 */
export function conditionalSellEnabled(env: NodeJS.ProcessEnv = process.env) {
  return strictFlag(env, 'CONDITIONAL_SELL_ORDERS_ENABLED');
}

/** Independent stop-loss / take-profit intents (not the OCO protection). */
export function independentTpSlEnabled(env: NodeJS.ProcessEnv = process.env) {
  return strictFlag(env, 'INDEPENDENT_TP_SL_ORDERS_ENABLED');
}

function strictFlag(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name] ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error(`${name} must be true or false`);
  return value === 'true';
}
