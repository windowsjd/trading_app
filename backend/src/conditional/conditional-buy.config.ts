/**
 * Dependency-free startup/runtime capability parser for conditional BUY
 * watches. Independent of CONDITIONAL_ORDERS_ENABLED (Spot/Futures
 * protection): enabling protection never exposes this feature.
 */
export function conditionalBuyEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.CONDITIONAL_BUY_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('CONDITIONAL_BUY_ORDERS_ENABLED must be true or false');
  return value === 'true';
}
