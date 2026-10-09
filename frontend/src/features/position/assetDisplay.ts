import type { PositionItemDto } from './api.ts';
import { formatDisplayDecimal, formatMoneyDecimal, formatSignedPercent, getAssetNameDisplay, getFinancialDirection } from '../../utils/format.ts';
import type { PositionValuationDto } from './api.ts';
import { isHeldPosition } from '../tradingAccount/holdings.ts';

export type SpotHoldingDisplay = Pick<PositionItemDto, 'name' | 'symbol' | 'assetType' | 'market' | 'quantity'> & {
  valuation: { state: 'unavailable' } | {
    state: 'available' | 'stale_cache'; priceCurrency: string;
    positionValue: string; unrealizedPnl: string; returnRate: string;
    diagnostic?: Extract<PositionValuationDto, { state: 'stale_cache' }>['diagnostic'];
  };
};

/** A holding's entire local value and unrealized return come from valuation.
 * Unit prices, quantity and KRW conversion do not determine these display values. */
export function getPositionAssetDisplay(position: SpotHoldingDisplay) {
  isHeldPosition(position);
  const name = getAssetNameDisplay(position).primary;
  const unit = position.assetType === 'crypto'
    ? position.market === 'BINANCE' ? position.symbol.replace(/USDT$/u, '') : position.symbol
    : '주';
  const quantity = `보유수량 ${formatDisplayDecimal(position.quantity)} ${unit}`;
  const valuation = position.valuation;
  if (valuation.state === 'unavailable') {
    return { name, quantity, value: '-', pnl: '-', returnRate: '-', performance: '-', direction: 'neutral' as const, notice: '현재 시세 조회 불가' };
  }
  const pnl = formatMoneyDecimal(valuation.unrealizedPnl, valuation.priceCurrency, true);
  const returnRate = formatSignedPercent(valuation.returnRate);
  return {
    name, quantity, pnl, returnRate,
    value: formatMoneyDecimal(valuation.positionValue, valuation.priceCurrency),
    performance: `${pnl} (${returnRate})`,
    direction: getFinancialDirection(valuation.unrealizedPnl),
    notice: valuation.state === 'stale_cache' ? '이전 시세 · 최신 시세 확인 불가' : null,
  };
}
