/** Scheduled asset price snapshot retention (P1, 2026-10-16). Off unless
 * ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED is exactly "true": turning it on in
 * production starts deleting the existing backlog, which is an approved step.
 * The retention is the product policy, 14 days; the job never keeps less. */
export function assetPriceSnapshotRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  const enabled = env.ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled))
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error(
      'ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED must be true or false',
    );
  const integer = (
    name: string,
    fallback: number,
    min: number,
    max: number,
  ) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return value;
  };
  return {
    enabled: enabled === 'true',
    retentionDays: integer('ASSET_PRICE_SNAPSHOT_RETENTION_DAYS', 14, 14, 3650),
    batchSize: integer(
      'ASSET_PRICE_SNAPSHOT_RETENTION_BATCH_SIZE',
      1000,
      1,
      10000,
    ),
    /** Per run at most maxBatches × batchSize rows are examined (and so at
     * most that many deleted) across all assets. */
    maxBatches: integer(
      'ASSET_PRICE_SNAPSHOT_RETENTION_MAX_BATCHES',
      20,
      1,
      1000,
    ),
    intervalMs: 300000,
    /** No new batch starts after this long; each batch has a 5 s timeout. */
    maxRunMs: 60000,
  };
}
