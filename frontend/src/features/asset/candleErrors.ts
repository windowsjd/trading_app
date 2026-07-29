// Candle request error classification. Pure module (no React/RN/axios imports)
// so `node --test` covers it.
//
// The chart has one error state that is NOT a failure: the backend aggregates
// 15m/30m/1h/4h from the stored 5m feed, and until that feed's baseline has
// been seeded for the requested window it answers
// ASSET_CANDLES_BASELINE_NOT_READY instead of serving a truncated
// provider-direct answer. The user is told the data is being prepared and can
// retry; everything else stays the generic chart error.

/** Backend error code for "the 5m baseline for this window is still syncing". */
export const CANDLE_BASELINE_NOT_READY_CODE = 'ASSET_CANDLES_BASELINE_NOT_READY';

export const CANDLE_BASELINE_NOT_READY_MESSAGE =
  '차트 데이터를 준비 중입니다.';
export const CANDLE_BASELINE_NOT_READY_HELPER =
  '잠시 후 다시 시도해주세요. 저장된 5분봉을 모으는 중입니다.';

/** Reads the API error code out of an axios-style error, safely. */
export function getApiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: unknown }).response;
  if (!response || typeof response !== 'object') return null;
  const data = (response as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const inner = (data as { error?: unknown }).error;
  if (!inner || typeof inner !== 'object') return null;
  const code = (inner as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

export function isCandleBaselineNotReadyError(error: unknown): boolean {
  return getApiErrorCode(error) === CANDLE_BASELINE_NOT_READY_CODE;
}
