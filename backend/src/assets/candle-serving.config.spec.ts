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
    const config = readCandleServingConfig({});
    expect(config.maxManagedFiveMinuteRangeMs).toBe(35 * 24 * 60 * 60_000);
    expect(30 * 24 * 60 * 60_000 + 4 * 60 * 60_000).toBeLessThan(
      config.maxManagedFiveMinuteRangeMs,
    );
  });
});
