import {
  CandleServingConfigError,
  readCandleServingConfig,
} from './candle-serving.config';

describe('readCandleServingConfig', () => {
  it('defaults to database serving', () => {
    // 15m/30m/1h/4h only exist as read-time aggregates of the stored 5m feed,
    // so database serving is the normal mode; `legacy` is the explicit
    // emergency rollback and must be opted into.
    expect(readCandleServingConfig({}).mode).toBe('database');
    expect(readCandleServingConfig({ CANDLE_SERVING_MODE: '' }).mode).toBe(
      'database',
    );
  });

  it('accepts an explicit legacy rollback and rejects unknown modes', () => {
    expect(
      readCandleServingConfig({ CANDLE_SERVING_MODE: 'legacy' }).mode,
    ).toBe('legacy');
    expect(
      readCandleServingConfig({ CANDLE_SERVING_MODE: ' LEGACY ' }).mode,
    ).toBe('legacy');
    expect(
      readCandleServingConfig({ CANDLE_SERVING_MODE: 'database' }).mode,
    ).toBe('database');
    expect(() =>
      readCandleServingConfig({ CANDLE_SERVING_MODE: 'typo' }),
    ).toThrow(CandleServingConfigError);
  });

  it('keeps the 5m retention window as the managed range ceiling', () => {
    // 30d 4h + 4h source padding must stay inside it, or the request would be
    // routed out of the managed path.
    const DAY_MS = 24 * 60 * 60_000;
    const config = readCandleServingConfig({});
    expect(config.maxManagedFiveMinuteRangeMs).toBe(45 * DAY_MS);
    expect(30 * DAY_MS + 4 * 60 * 60_000).toBeLessThan(
      config.maxManagedFiveMinuteRangeMs,
    );
    // Never beyond the configured retention (no window over deleted rows)…
    expect(
      readCandleServingConfig({ MARKET_CANDLE_5M_RETENTION_DAYS: '35' })
        .maxManagedFiveMinuteRangeMs,
    ).toBe(35 * DAY_MS);
    // …and never beyond the 45-day policy when retention is longer.
    expect(
      readCandleServingConfig({ MARKET_CANDLE_5M_RETENTION_DAYS: '60' })
        .maxManagedFiveMinuteRangeMs,
    ).toBe(45 * DAY_MS);
    // KRX 1d 576 sessions (≤ 867.6 days, design v2.1 §5.4).
    expect(config.maxManagedKrxDailyRangeMs).toBe(875 * DAY_MS);
    expect(config.maxManagedPeriodRangeMs).toBe(365 * DAY_MS);
  });

  it('lets the 15m/3d chart self-heal inside the on-demand repair budget', () => {
    const config = readCandleServingConfig({});
    const DAY_MS = 24 * 60 * 60_000;
    // The 15m tab requests range=3d; its aggregated read plan spans 3d + 4h
    // of source padding. The repair bound must exceed that or a cold asset
    // answers 503/short-partial forever instead of repairing on demand.
    expect(config.maxOnDemandRepairRangeMs).toBe(4 * DAY_MS);
    expect(3 * DAY_MS + 4 * 60 * 60_000).toBeLessThan(
      config.maxOnDemandRepairRangeMs,
    );
    // ... and 14d/30d windows must stay ABOVE it: those are baseline-seeded,
    // never request-time repaired.
    expect(14 * DAY_MS).toBeGreaterThan(config.maxOnDemandRepairRangeMs);

    // One repair sweep must be able to cover the whole 3d + 4h window. The
    // sweep pages backward from the newest edge, so a smaller budget leaves
    // the oldest chunk permanently unfetched: a 3d + 4h window can span 4
    // KRX sessions ≈ ~1,530 domestic 1m rows ≈ 13 pages at 120 rows/page.
    expect(config.onDemandRefreshMaxPages).toBe(15);
    expect(config.onDemandRefreshMaxPages).toBeGreaterThanOrEqual(13);
  });
});
