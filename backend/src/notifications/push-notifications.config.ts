/** Push notification worker (docs/push-notifications-contract.md).
 *
 * The worker is off unless PUSH_NOTIFICATIONS_ENABLED is exactly "true". With
 * PUSH_NOTIFICATIONS_DRY_RUN=true it still derives notifications from
 * committed rows but marks them `skipped` (`dry_run`) instead of calling Expo,
 * so event detection can be verified on a real database without sending.
 * EXPO_ACCESS_TOKEN is only required when Expo "enhanced push security" is on
 * for the project; it is sent as a bearer token and never logged. Device and
 * preference APIs work regardless of these flags. */
export function pushNotificationsConfig(env: NodeJS.ProcessEnv = process.env) {
  const flag = (name: string, fallback: string) => {
    const value = env[name] ?? fallback;
    if (!['true', 'false'].includes(value))
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  const intervalText = env.PUSH_NOTIFICATIONS_INTERVAL_MS ?? '10000';
  const intervalMs = Number(intervalText);
  if (
    !/^\d+$/.test(intervalText) ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 2_000 ||
    intervalMs > 300_000
  )
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error(
      'PUSH_NOTIFICATIONS_INTERVAL_MS must be an integer from 2000 to 300000',
    );
  const rawToken = env.EXPO_ACCESS_TOKEN;
  // The value itself never appears in an error, a log or an Ops row.
  if (rawToken !== undefined && rawToken !== '' && /\s/.test(rawToken))
    // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
    throw new Error('EXPO_ACCESS_TOKEN must not contain whitespace');
  return {
    enabled: flag('PUSH_NOTIFICATIONS_ENABLED', 'false'),
    dryRun: flag('PUSH_NOTIFICATIONS_DRY_RUN', 'false'),
    intervalMs,
    accessToken: rawToken ? rawToken : null,
    sendUrl: 'https://exp.host/--/api/v2/push/send',
    receiptsUrl: 'https://exp.host/--/api/v2/push/getReceipts',
    /** Expo: at most 100 messages per send request. */
    sendChunkSize: 100,
    /** Expo: at most 1000 ids per receipt request. */
    receiptChunkSize: 1_000,
    /** HTTP timeout of one Expo request. */
    requestTimeoutMs: 15_000,
    /** Each scan re-reads this much before the previous high-water mark, so a
     * transaction that committed after a later one was scanned is not missed
     * (the unique outbox key absorbs the overlap). */
    scanLookbackMs: 120_000,
    /** Notifications claimed per tick (trading outcomes first, then
     * important-notice fan-out with the remaining room). */
    dispatchBatchSize: 1_000,
    /** A row stamped at least this long before a scan has committed (the
     * longest financial transaction is 15 s): a scan that stops on a full
     * page resumes after the newest such row, never after a younger one. */
    commitSafetyMs: 30_000,
    /** A claimed row is reclaimable after this lease (a crashed send). */
    claimLeaseMs: 120_000,
    /** Attempts per notification for retryable Expo/transport failures. */
    maxAttempts: 4,
    /** Delay before attempt n+1 (index = attempts made - 1). */
    retryDelaysMs: [30_000, 120_000, 600_000] as readonly number[],
    /** Expo receipts become available after ~15 minutes and are kept 24 h. */
    receiptDelayMs: 15 * 60_000,
    receiptMaxAgeMs: 24 * 3_600_000,
    /** Outbox rows (and their deliveries) are kept this long. */
    retentionMs: 30 * 24 * 3_600_000,
    retentionBatchSize: 1_000,
    /** Registered devices kept per user; the oldest beyond this are released. */
    maxDevicesPerUser: 10,
    /** Users read per important-notice fan-out page. */
    fanoutPageSize: 500,
  };
}

export type PushNotificationsConfig = ReturnType<
  typeof pushNotificationsConfig
>;
