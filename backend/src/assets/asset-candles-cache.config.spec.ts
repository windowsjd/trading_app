import {
  CandleCacheConfigError,
  DEFAULT_CANDLE_CACHE_MAX_PAYLOAD_BYTES,
  readCandleCacheConfig,
} from './asset-candles-cache.config';

describe('readCandleCacheConfig', () => {
  it('defaults to disabled with the 2 MiB payload limit', () => {
    expect(readCandleCacheConfig({})).toEqual({
      enabled: false,
      maxPayloadBytes: DEFAULT_CANDLE_CACHE_MAX_PAYLOAD_BYTES,
    });
  });

  it('parses boolean flags in true/false/1/0 forms case-insensitively', () => {
    expect(
      readCandleCacheConfig({ CANDLE_CACHE_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(
      readCandleCacheConfig({ CANDLE_CACHE_ENABLED: 'TRUE' }).enabled,
    ).toBe(true);
    expect(readCandleCacheConfig({ CANDLE_CACHE_ENABLED: '1' }).enabled).toBe(
      true,
    );
    expect(
      readCandleCacheConfig({ CANDLE_CACHE_ENABLED: 'false' }).enabled,
    ).toBe(false);
    expect(readCandleCacheConfig({ CANDLE_CACHE_ENABLED: '0' }).enabled).toBe(
      false,
    );
  });

  it('reads a custom payload limit', () => {
    expect(
      readCandleCacheConfig({ CANDLE_CACHE_MAX_PAYLOAD_BYTES: '1048576' })
        .maxPayloadBytes,
    ).toBe(1048576);
  });

  it('rejects an invalid boolean flag', () => {
    expect(() =>
      readCandleCacheConfig({ CANDLE_CACHE_ENABLED: 'yes' }),
    ).toThrow(CandleCacheConfigError);
  });

  it('rejects a non-integer payload limit', () => {
    expect(() =>
      readCandleCacheConfig({ CANDLE_CACHE_MAX_PAYLOAD_BYTES: 'big' }),
    ).toThrow(CandleCacheConfigError);
  });

  it('rejects a non-positive payload limit', () => {
    expect(() =>
      readCandleCacheConfig({ CANDLE_CACHE_MAX_PAYLOAD_BYTES: '0' }),
    ).toThrow(CandleCacheConfigError);
  });
});
