/** Opt-in database storage sampler. Off unless DATABASE_STORAGE_MONITOR_ENABLED
 * is exactly "true". DATABASE_STORAGE_CAPACITY_GB is the provisioned disk in
 * decimal GB (Render "50 GB" → 50); without it only size and growth are known. */
export function readDatabaseStorageMonitorConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  const enabled = env.DATABASE_STORAGE_MONITOR_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled))
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error('DATABASE_STORAGE_MONITOR_ENABLED must be true or false');
  const capacity = env.DATABASE_STORAGE_CAPACITY_GB?.trim();
  let capacityBytes: number | null = null;
  if (capacity) {
    const gb = Number(capacity);
    if (!Number.isSafeInteger(gb) || gb < 1 || gb > 16384)
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(
        'DATABASE_STORAGE_CAPACITY_GB must be an integer from 1 to 16384',
      );
    // Decimal GB is the conservative reading: pg_database_size excludes WAL,
    // temp files and filesystem overhead that also occupy the disk.
    capacityBytes = gb * 1e9;
  }
  return {
    enabled: enabled === 'true',
    capacityBytes,
    intervalMs: 300000,
    firstSampleDelayMs: 30000,
  };
}
