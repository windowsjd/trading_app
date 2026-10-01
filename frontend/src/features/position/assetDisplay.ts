import type { PositionItemDto } from './api.ts';
import { formatMoney, formatPercent, getAssetNameDisplay } from '../../utils/format.ts';

/** A holding's entire local value and unrealized return come from valuation.
 * Unit prices, quantity and KRW conversion do not determine these display values. */
export function getPositionAssetDisplay(position: PositionItemDto) {
  const name = getAssetNameDisplay(position).primary;
  const valuation = position.valuation;
  if (valuation.state === 'unavailable') {
    return { name, value: '-', returnRate: '-', direction: 'neutral' as const, notice: '현재 시세 조회 불가' };
  }
  const formattedRate = formatPercent(valuation.returnRate);
  const rate = Number(valuation.returnRate);
  const knownRate = formattedRate !== '-';
  return {
    name,
    value: formatMoney(valuation.positionValue, valuation.priceCurrency),
    returnRate: knownRate ? `${rate > 0 ? '+' : ''}${formattedRate}%` : '-',
    direction: !knownRate || rate === 0 ? 'neutral' as const : rate > 0 ? 'rise' as const : 'fall' as const,
    notice: valuation.state === 'stale_cache' ? '이전 시세 · 최신 시세 확인 불가' : null,
  };
}
