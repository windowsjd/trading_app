import type { PositionItemDto } from './api.ts';
import Decimal from 'decimal.js';
import { formatDisplayDecimal, formatMoney, formatPercent, getAssetNameDisplay } from '../../utils/format.ts';
import { isHeldPosition } from '../tradingAccount/holdings.ts';

/** Home/Wallet display only: never change the raw quantity or order precision. */
function formatHoldingQuantity(position: PositionItemDto) {
  // Reuse the holdings contract guard, including when valuation is unavailable.
  isHeldPosition(position);
  const quantity = formatDisplayDecimal(new Decimal(position.quantity).toFixed(6, Decimal.ROUND_HALF_UP));
  if (position.assetType !== 'crypto') return `${quantity}주`;
  // The existing Binance contract uses <BASE>USDT; other symbols stay intact.
  const symbol = position.market === 'BINANCE' ? position.symbol.replace(/USDT$/u, '') : position.symbol;
  return `${quantity} ${symbol}`;
}

/** A holding's entire local value and unrealized return come from valuation.
 * Unit prices, quantity and KRW conversion do not determine these display values. */
export function getPositionAssetDisplay(position: PositionItemDto) {
  const name = getAssetNameDisplay(position).primary;
  const quantity = formatHoldingQuantity(position);
  const valuation = position.valuation;
  if (valuation.state === 'unavailable') {
    return { name, quantity, value: '-', returnRate: '-', direction: 'neutral' as const, notice: '현재 시세 조회 불가' };
  }
  const formattedRate = formatPercent(valuation.returnRate);
  const rate = Number(valuation.returnRate);
  const knownRate = formattedRate !== '-';
  return {
    name,
    quantity,
    value: formatMoney(valuation.positionValue, valuation.priceCurrency),
    returnRate: knownRate ? `${rate > 0 ? '+' : ''}${formattedRate}%` : '-',
    direction: !knownRate || rate === 0 ? 'neutral' as const : rate > 0 ? 'rise' as const : 'fall' as const,
    notice: valuation.state === 'stale_cache' ? '이전 시세 · 최신 시세 확인 불가' : null,
  };
}
