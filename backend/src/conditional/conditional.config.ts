/** Dependency-free startup/runtime capability parser. */
export function conditionalEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.CONDITIONAL_ORDERS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(value))
    // @diagnosticSurface internal: Startup rejects invalid fixed feature configuration before serving requests.
    throw new Error('CONDITIONAL_ORDERS_ENABLED must be true or false');
  return value === 'true';
}
