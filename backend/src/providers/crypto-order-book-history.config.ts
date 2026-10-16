/** Display-only 60 s order-book history of the Binance Spot and USDⓈ-M
 * catalogs (docs/crypto-order-book-history-contract.md). Recording is off
 * unless CRYPTO_ORDER_BOOK_HISTORY_ENABLED is exactly "true": turning it on in
 * production adds about 0.2 GB a day at 100 + 100 products, which is an
 * approved step. The 14-day retention follows recording unless
 * CRYPTO_ORDER_BOOK_RETENTION_ENABLED is set, so it can keep draining rows
 * after recording is switched off. Neither flag changes the WebSocket streams
 * or the realtime fanout. */
export function cryptoOrderBookHistoryConfig(
  env: NodeJS.ProcessEnv = process.env,
) {
  const flag = (name: string, fallback: string) => {
    const value = env[name] ?? fallback;
    if (!['true', 'false'].includes(value))
      // @diagnosticSurface internal: Startup validation collects this fixed configuration error before the server accepts requests.
      throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  const enabled = flag('CRYPTO_ORDER_BOOK_HISTORY_ENABLED', 'false');
  return {
    enabled,
    retentionEnabled: flag(
      'CRYPTO_ORDER_BOOK_RETENTION_ENABLED',
      enabled ? 'true' : 'false',
    ),
    /** One stored book per product and UTC minute at most. */
    bucketMs: 60_000,
    /** A minute's newest book is stored only if it was still current at the
     * minute's end: the app's order-book staleness (ORDER_BOOK_STALE_MS). A
     * USDⓈ-M book is also refused when its provider time is this far from
     * receipt (a delayed backlog frame, or a broken clock). */
    maxBookAgeMs: 5_000,
    /** Product policy: 14 days (336 hours). */
    retentionHours: 336,
    retentionIntervalMs: 300_000,
    retentionBatchSize: 1_000,
    /** Per run at most this many rows are deleted across both tables. */
    retentionMaxRowsPerRun: 20_000,
    /** No new batch starts after this long; each batch has a 5 s timeout. */
    retentionMaxRunMs: 60_000,
  };
}
