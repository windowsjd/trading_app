import type { FriendCompletedTrade } from '../ranking/api';
import { formatMoneyDecimal, formatSignedPercent, getAssetNameDisplay, getAssetNameSubline, getFinancialDirection } from '../../utils/format.ts';

/**
 * A 거래 완료 종목 row: the same name rules as holdings (a KRX listing reads
 * its Korean name over its code), the trade's own currency, and the server's
 * confirmed figures only — nothing recomputed from a current price.
 */
export function getCompletedTradeDisplay(item: FriendCompletedTrade) {
  const name = getAssetNameDisplay(item);
  const spot = item.kind === 'spot';
  return {
    name: name.primary,
    subline: getAssetNameSubline(name),
    kind: spot ? '현물' : '선물',
    // A futures lifetime's side: the L / S box beside the kind (FuturesDirectionBadge).
    direction: spot ? null : item.direction,
    basisLabel: spot ? '매수 금액' : '진입 증거금',
    basis: formatMoneyDecimal(spot ? item.buyAmount : item.entryMargin, item.currencyCode),
    pnl: formatMoneyDecimal(item.realizedPnl, item.currencyCode, true),
    returnRate: formatSignedPercent(item.returnRate),
    pnlDirection: getFinancialDirection(item.realizedPnl),
  };
}
