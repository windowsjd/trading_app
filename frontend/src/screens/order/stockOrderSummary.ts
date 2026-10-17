/**
 * Pure rules of the stock order card (A-2). Display only: nothing here takes
 * part in a quote, a create or any amount sent to the server.
 */

export type SummaryTone = 'warning' | 'info' | 'error';
export type OrderSummaryBadge = { label: string; tone: SummaryTone };

/**
 * A decimal exactly as entered or computed, never rounded (a limit price shows
 * what will be sent): thousands separators, trailing fraction zeros dropped,
 * and the money unit when a currency is given.
 */
export function formatEnteredAmount(value: string, currency: string | null) {
  const match = /^(\d*)(?:\.(\d*))?$/u.exec(value.trim());
  if (!match) return value;
  const integer = (match[1].replace(/^0+(?=\d)/u, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  const fraction = (match[2] ?? '').replace(/0+$/u, '');
  const text = fraction ? `${integer}.${fraction}` : integer;
  return currency === 'USD' ? `$${text}` : currency === 'KRW' ? `${text}원` : text;
}

/** Estimated width of a figure in ems: digits and punctuation are narrow. */
function figureEms(text: string) {
  return [...text].reduce((sum, char) => sum + (char === ' ' ? 0.3 : /[0-9.,$₩+%-]/u.test(char) ? 0.6 : 1), 0);
}

/**
 * The largest font size (≤ max, ≥ min, before the user's font scale) at which
 * a figure fits `width` on one line: a long amount shrinks instead of breaking
 * between its digits. Unmeasured (width 0) keeps `max`.
 */
export function fitFontSize(text: string, width: number, fontScale = 1, min = 10, max = 13) {
  if (width <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor(width / (Math.max(figureEms(text), 1) * Math.max(fontScale, 1)))));
}

/**
 * The 시세 price in a narrow column: as large as the column allows (16–24,
 * before the user's font scale), so long KRW figures stay on one line where
 * they can; at extreme sizes the text wraps instead of being cut.
 */
export function fitPriceFontSize(text: string, width: number, fontScale = 1) {
  return width <= 0 ? 22 : fitFontSize(text, width, fontScale, 16, 24);
}

/**
 * How the order would be handled under the session the screen knows, before
 * it is sent (the server still decides at quote and create time):
 * - market closed: a limit order waits for the next regular session; market
 *   and LOC orders are not accepted then;
 * - market open: market fills now, a limit waits for its price, LOC for the
 *   close;
 * - unknown market status: no badge (only the server can tell).
 */
export function getOrderSummaryBadge(marketStatus: string | null | undefined, method: 'market' | 'limit' | 'loc' | 'conditional'): OrderSummaryBadge | null {
  if (method === 'conditional') return null;
  if (marketStatus === 'closed') {
    return method === 'limit' ? { label: '정규장 대기', tone: 'warning' } : { label: '주문 불가', tone: 'error' };
  }
  if (marketStatus !== 'open') return null;
  if (method === 'loc') return { label: '종가 대기', tone: 'warning' };
  if (method === 'limit') return { label: '체결 대기', tone: 'warning' };
  return { label: '즉시 체결', tone: 'info' };
}
