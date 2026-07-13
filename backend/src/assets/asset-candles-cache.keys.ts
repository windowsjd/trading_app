import type { CandleInterval, CandleRange } from './asset-candles.service';

// Redis-internal cache schema version. This is NOT the public `/api/v1` URL
// version; bumping it only rotates the cache namespace so an incompatible
// envelope/key change cannot read stale entries. The HTTP contract is unchanged.
export const CANDLE_CACHE_KEY_VERSION = 'v2';

export const CANDLE_CACHE_DATA_NAMESPACE = `candles:data:${CANDLE_CACHE_KEY_VERSION}`;
export const CANDLE_CACHE_GENERATION_NAMESPACE = `candles:gen:${CANDLE_CACHE_KEY_VERSION}`;

// Guard against unbounded keys from hostile/oversized query input. Real
// assetIds are UUIDs and dates are `YYYY-MM-DD`, so these limits are generous.
const MAX_KEY_SEGMENT_LENGTH = 256;

// Every response-affecting input. assetId/range/interval/limit/requestedDate are
// the required discriminators. `to` and `includePrevious` also change the
// provider window/result, so they are included as optional discriminators; when
// the cache is wired into the serving path they must be passed through so two
// requests that differ only by `to`/`includePrevious` never collide. Omitting
// them (the range-based path fully determines the window via range +
// requestedDate) yields the compact base key.
export type CandleCacheKeyInput = {
  assetId: string;
  range: CandleRange;
  interval: CandleInterval;
  limit: number;
  requestedDate: string;
  to?: string | null;
  includePrevious?: boolean;
  normalizedFrom?: string;
  normalizedTo?: string;
  latest?: boolean;
  explicitTo?: boolean;
};

export class CandleCacheKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleCacheKeyError';
  }
}

export function buildCandleGenerationKey(assetId: string): string {
  return `${CANDLE_CACHE_GENERATION_NAMESPACE}:${encodeSegment(
    assetId,
    'assetId',
  )}`;
}

/**
 * Deterministic per-query data key. Same input (including generation) always
 * yields the same key; any difference in assetId, generation, requestedDate,
 * range, interval, limit, to, or includePrevious yields a different key.
 *
 * Structure:
 *   candles:data:v1:{assetId}:g{generation}:{requestedDate}:{range}:{interval}:{limit}
 * with optional trailing discriminators appended only when provided:
 *   :t{to}   (present-`to` segments are prefixed `t`)
 *   :p{0|1}  (includePrevious)
 * The `t`/`p` prefixes and fixed positions make the absent case collision-free
 * against any present value.
 */
export function buildCandleDataKey(
  input: CandleCacheKeyInput & { generation: number },
): string {
  const generation = input.generation;
  if (!Number.isInteger(generation) || generation < 0) {
    throw new CandleCacheKeyError('generation must be a non-negative integer.');
  }

  if (!Number.isInteger(input.limit) || input.limit < 0) {
    throw new CandleCacheKeyError('limit must be a non-negative integer.');
  }

  const segments = [
    CANDLE_CACHE_DATA_NAMESPACE,
    encodeSegment(input.assetId, 'assetId'),
    `g${generation}`,
    encodeSegment(input.requestedDate, 'requestedDate'),
    encodeSegment(input.range, 'range'),
    encodeSegment(input.interval, 'interval'),
    String(input.limit),
  ];

  if (input.to !== undefined && input.to !== null && input.to !== '') {
    segments.push(`t${encodeSegment(input.to, 'to')}`);
  }

  if (input.includePrevious !== undefined) {
    segments.push(`p${input.includePrevious ? 1 : 0}`);
  }

  if (input.latest === true) {
    segments.push('wlatest');
  } else if (input.normalizedFrom || input.normalizedTo) {
    if (!input.normalizedFrom || !input.normalizedTo) {
      throw new CandleCacheKeyError(
        'normalizedFrom and normalizedTo must be provided together.',
      );
    }
    segments.push(
      `f${encodeSegment(input.normalizedFrom, 'normalizedFrom')}`,
      `u${encodeSegment(input.normalizedTo, 'normalizedTo')}`,
    );
  }

  if (input.explicitTo !== undefined) {
    segments.push(`e${input.explicitTo ? 1 : 0}`);
  }

  return segments.join(':');
}

// encodeURIComponent guarantees no `:` (or other delimiter) leaks into a
// segment and breaks the key structure. Length is validated first so a hostile
// oversized value fails loudly (programmer/validation error) instead of
// producing a giant key.
function encodeSegment(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CandleCacheKeyError(`${field} must be a non-empty string.`);
  }

  if (value.length > MAX_KEY_SEGMENT_LENGTH) {
    throw new CandleCacheKeyError(
      `${field} exceeds the maximum cache key segment length.`,
    );
  }

  return encodeURIComponent(value);
}
