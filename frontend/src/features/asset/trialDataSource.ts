// Tiingo US-equity TRIAL data is display-only and never stored by the server.
// These helpers make that source visible, so an evaluator can never mistake a
// stored/KIS price for Tiingo data (or the reverse). Pure module: unit-tested
// under `node --test`.

export const TIINGO_TRIAL_PRICE_SOURCE = 'tiingo_equity_reference_price';

export const TRIAL_PRICE_NOTICE =
  'Tiingo 참조가 · 체험 데이터 (실제 체결가와 다를 수 있음)';
export const TRIAL_ORDER_NOTICE =
  '표시 시세는 Tiingo 체험 데이터이며 주문 견적·체결은 기존 시세로 처리됩니다.';

type CandleSourceLike = {
  provider?: string;
  coverage?: string;
  requestedSessions?: number;
  coveredSessions?: number;
  currentCandleTime?: string | null;
} | null | undefined;

export function isTrialPriceSource(priceSource: unknown): boolean {
  if (typeof priceSource === 'string')
    return priceSource === TIINGO_TRIAL_PRICE_SOURCE;
  return (
    priceSource !== null &&
    typeof priceSource === 'object' &&
    (priceSource as { sourceName?: unknown }).sourceName ===
      TIINGO_TRIAL_PRICE_SOURCE
  );
}

/** One line for a Tiingo chart: coverage and the in-progress last candle. */
export function trialCandleNotice(source: CandleSourceLike): string | null {
  if (source?.provider !== 'tiingo') return null;
  const parts = ['Tiingo 체험 차트'];
  if (source.coverage === 'empty') parts.push('표시할 실제 데이터가 아직 없습니다');
  else if (
    source.coverage === 'partial' &&
    typeof source.coveredSessions === 'number' &&
    typeof source.requestedSessions === 'number'
  )
    parts.push(
      `받은 ${source.coveredSessions}/${source.requestedSessions}거래일 구간만 표시`,
    );
  else parts.push('서버에 저장하지 않는 임시 데이터');
  // No live-candle stream exists for trial data and the chart does not poll:
  // the forming candle is as of this read (pull to refresh re-reads it).
  if (source.currentCandleTime) parts.push('마지막 봉은 조회 시점의 진행 중 봉');
  return parts.join(' · ');
}
