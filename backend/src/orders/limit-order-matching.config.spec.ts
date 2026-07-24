import {
  DEFAULT_LIMIT_ORDER_CANDLE_LOOKBACK_MS,
  DEFAULT_LIMIT_ORDER_MATCHING_INTERVAL_MS,
  DEFAULT_LIMIT_ORDER_MATCH_BATCH_SIZE,
  LimitOrderMatchingConfigError,
  MAX_LIMIT_ORDER_MATCHING_INTERVAL_MS,
  readLimitOrderMatchingConfig,
} from './limit-order-matching.config';

describe('readLimitOrderMatchingConfig', () => {
  it('defaults to disabled with conservative values when unset', () => {
    const config = readLimitOrderMatchingConfig({});
    expect(config).toEqual({
      matchingEnabled: false,
      intervalMs: DEFAULT_LIMIT_ORDER_MATCHING_INTERVAL_MS,
      batchSize: DEFAULT_LIMIT_ORDER_MATCH_BATCH_SIZE,
      candleLookbackMs: DEFAULT_LIMIT_ORDER_CANDLE_LOOKBACK_MS,
    });
  });

  it('parses valid overrides', () => {
    const config = readLimitOrderMatchingConfig({
      SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED: 'true',
      LIMIT_ORDER_MATCHING_INTERVAL_MS: '3000',
      LIMIT_ORDER_MATCH_BATCH_SIZE: '50',
      LIMIT_ORDER_CANDLE_LOOKBACK_MS: '600000',
    });
    expect(config).toEqual({
      matchingEnabled: true,
      intervalMs: 3000,
      batchSize: 50,
      candleLookbackMs: 600_000,
    });
  });

  it.each(['yes', 'enabled', 'tru', '', 'on'])(
    'rejects a typo in the enabled flag: %s',
    (value) => {
      expect(() =>
        readLimitOrderMatchingConfig({
          SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED: value,
        }),
      ).toThrow(LimitOrderMatchingConfigError);
    },
  );

  it('rejects an interval above half the execute-freshness window (5000ms)', () => {
    expect(MAX_LIMIT_ORDER_MATCHING_INTERVAL_MS).toBe(5000);
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_MATCHING_INTERVAL_MS: '6000' }),
    ).toThrow(LimitOrderMatchingConfigError);
    // The boundary value is accepted.
    expect(
      readLimitOrderMatchingConfig({ LIMIT_ORDER_MATCHING_INTERVAL_MS: '5000' })
        .intervalMs,
    ).toBe(5000);
  });

  it('rejects a sub-second interval, a zero batch, and a non-integer', () => {
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_MATCHING_INTERVAL_MS: '500' }),
    ).toThrow(LimitOrderMatchingConfigError);
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_MATCH_BATCH_SIZE: '0' }),
    ).toThrow(LimitOrderMatchingConfigError);
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_MATCH_BATCH_SIZE: '1.5' }),
    ).toThrow(LimitOrderMatchingConfigError);
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_CANDLE_LOOKBACK_MS: '-1' }),
    ).toThrow(LimitOrderMatchingConfigError);
  });

  it('rejects a lookback shorter than one 5m window', () => {
    expect(() =>
      readLimitOrderMatchingConfig({ LIMIT_ORDER_CANDLE_LOOKBACK_MS: '60000' }),
    ).toThrow(LimitOrderMatchingConfigError);
  });
});
