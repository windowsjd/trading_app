import {
  formatDisplayDecimal,
  formatKrw,
  formatMoney,
  formatPercent,
} from '../../utils/format.ts';
import type { PositionItemDto } from './api.ts';

export type PositionDisplay = {
  quantity: string;
  averageCost: string;
  currentPrice: string | null;
  positionValueKrw: string;
  unrealizedPnlKrw: string;
  returnRate: string;
  priceStatus: 'current' | 'stale' | 'unavailable';
  priceNotice: string | null;
};

/** Backend quantities use a fixed scale; display keeps precision but drops padding. */
export function formatPositionQuantity(quantity: string): string {
  return formatDisplayDecimal(quantity);
}

/**
 * Position existence is independent from live valuation. Internal backend
 * reasons/messages deliberately do not cross this display boundary.
 */
export function getPositionDisplay(position: PositionItemDto): PositionDisplay {
  const base = {
    quantity: formatPositionQuantity(position.quantity),
    averageCost: formatMoney(position.averageCost, position.currencyCode),
  };
  const valuation = position.valuation;

  if (valuation.state === 'unavailable') {
    return {
      ...base,
      currentPrice: null,
      positionValueKrw: '-',
      unrealizedPnlKrw: '-',
      returnRate: '-',
      priceStatus: 'unavailable',
      priceNotice: '현재 시세 조회 불가',
    };
  }

  return {
    ...base,
    currentPrice: formatMoney(valuation.currentPrice, valuation.priceCurrency),
    positionValueKrw: `${formatKrw(valuation.positionValueKrw)}원`,
    unrealizedPnlKrw: `${formatKrw(valuation.unrealizedPnlKrw)}원`,
    returnRate: `${formatPercent(valuation.returnRate)}%`,
    priceStatus:
      valuation.state === 'stale_cache' ? 'stale' : ('current' as const),
    priceNotice:
      valuation.state === 'stale_cache'
        ? '이전 시세 · 최신 시세 확인 불가'
        : null,
  };
}
