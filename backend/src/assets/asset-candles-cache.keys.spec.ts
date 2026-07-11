import {
  buildCandleDataKey,
  buildCandleGenerationKey,
  CandleCacheKeyError,
  CandleCacheKeyInput,
  CANDLE_CACHE_DATA_NAMESPACE,
  CANDLE_CACHE_GENERATION_NAMESPACE,
} from './asset-candles-cache.keys';

const baseInput: CandleCacheKeyInput & { generation: number } = {
  assetId: 'asset-1',
  range: '1d',
  interval: '5m',
  limit: 100,
  requestedDate: '2026-07-10',
  generation: 0,
};

describe('candle cache keys', () => {
  describe('buildCandleDataKey', () => {
    it('is deterministic for the same input', () => {
      expect(buildCandleDataKey(baseInput)).toBe(
        buildCandleDataKey({ ...baseInput }),
      );
    });

    it('uses the versioned data namespace and recommended field order', () => {
      expect(buildCandleDataKey(baseInput)).toBe(
        `${CANDLE_CACHE_DATA_NAMESPACE}:asset-1:g0:2026-07-10:1d:5m:100`,
      );
    });

    it('differs when assetId differs', () => {
      expect(buildCandleDataKey({ ...baseInput, assetId: 'asset-2' })).not.toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('differs when range differs', () => {
      expect(buildCandleDataKey({ ...baseInput, range: '7d' })).not.toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('differs when interval differs', () => {
      expect(buildCandleDataKey({ ...baseInput, interval: '1d' })).not.toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('differs when limit differs', () => {
      expect(buildCandleDataKey({ ...baseInput, limit: 50 })).not.toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('differs when requestedDate differs', () => {
      expect(
        buildCandleDataKey({ ...baseInput, requestedDate: '2026-07-11' }),
      ).not.toBe(buildCandleDataKey(baseInput));
    });

    it('differs when generation differs', () => {
      expect(buildCandleDataKey({ ...baseInput, generation: 1 })).not.toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('appends optional to/includePrevious discriminators without collision', () => {
      const base = buildCandleDataKey(baseInput);
      const withTo = buildCandleDataKey({ ...baseInput, to: '093000' });
      const withPrev = buildCandleDataKey({
        ...baseInput,
        includePrevious: true,
      });
      const withPrevFalse = buildCandleDataKey({
        ...baseInput,
        includePrevious: false,
      });
      const withBoth = buildCandleDataKey({
        ...baseInput,
        to: '093000',
        includePrevious: true,
      });

      const keys = [base, withTo, withPrev, withPrevFalse, withBoth];
      expect(new Set(keys).size).toBe(keys.length);
      expect(withTo).toBe(`${base}:t093000`);
      expect(withPrev).toBe(`${base}:p1`);
      expect(withPrevFalse).toBe(`${base}:p0`);
      expect(withBoth).toBe(`${base}:t093000:p1`);
    });

    it('treats null/empty to as absent', () => {
      expect(buildCandleDataKey({ ...baseInput, to: null })).toBe(
        buildCandleDataKey(baseInput),
      );
      expect(buildCandleDataKey({ ...baseInput, to: '' })).toBe(
        buildCandleDataKey(baseInput),
      );
    });

    it('encodes special characters so they cannot break the key structure', () => {
      const key = buildCandleDataKey({
        ...baseInput,
        assetId: 'a:b:c evil',
      });
      // The raw delimiter-bearing value must not appear unescaped.
      expect(key).not.toContain('a:b:c');
      expect(key).toContain(encodeURIComponent('a:b:c evil'));
      // Structure is still exactly 7 base segments plus namespace colons.
      expect(key.startsWith(`${CANDLE_CACHE_DATA_NAMESPACE}:`)).toBe(true);
    });

    it('does not collide when a delimiter-bearing assetId mimics another key', () => {
      const injected = buildCandleDataKey({
        ...baseInput,
        assetId: 'asset-1:g9:2000-01-01:1d:5m:1',
      });
      const real = buildCandleDataKey({
        ...baseInput,
        assetId: 'asset-1',
        generation: 9,
      });
      expect(injected).not.toBe(real);
    });

    it('rejects an oversized segment', () => {
      expect(() =>
        buildCandleDataKey({ ...baseInput, assetId: 'x'.repeat(300) }),
      ).toThrow(CandleCacheKeyError);
    });

    it('rejects a negative or non-integer generation', () => {
      expect(() =>
        buildCandleDataKey({ ...baseInput, generation: -1 }),
      ).toThrow(CandleCacheKeyError);
      expect(() =>
        buildCandleDataKey({ ...baseInput, generation: 1.5 }),
      ).toThrow(CandleCacheKeyError);
    });
  });

  describe('buildCandleGenerationKey', () => {
    it('uses the versioned generation namespace', () => {
      expect(buildCandleGenerationKey('asset-1')).toBe(
        `${CANDLE_CACHE_GENERATION_NAMESPACE}:asset-1`,
      );
    });

    it('encodes the assetId', () => {
      expect(buildCandleGenerationKey('a b')).toBe(
        `${CANDLE_CACHE_GENERATION_NAMESPACE}:${encodeURIComponent('a b')}`,
      );
    });

    it('rejects an empty assetId', () => {
      expect(() => buildCandleGenerationKey('')).toThrow(CandleCacheKeyError);
    });
  });
});
