import {
  CandleSingleFlightConfigError,
  readCandleSingleFlightConfig,
} from './asset-candles-single-flight.config';

describe('candle single-flight config', () => {
  it('uses documented defaults', () => {
    expect(readCandleSingleFlightConfig({})).toEqual({
      lockTtlMs: 30_000,
      waitTimeoutMs: 35_000,
      pollIntervalMs: 100,
      renewIntervalMs: 10_000,
    });
  });

  it('validates positive values and renewal below TTL', () => {
    expect(() =>
      readCandleSingleFlightConfig({ CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS: '0' }),
    ).toThrow(CandleSingleFlightConfigError);
    expect(() =>
      readCandleSingleFlightConfig({
        CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS: '1000',
        CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS: '1000',
      }),
    ).toThrow(CandleSingleFlightConfigError);
  });
});
