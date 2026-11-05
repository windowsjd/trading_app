import type { Protections } from '../conditional/api';
import type { ConditionalBuyOrderDto } from '../conditional/conditionalBuyApi';
import type { ConditionalSellOrderDto } from '../conditional/conditionalSellApi';
import type { PositionItemDto } from '../position/api';
import type { RecordOrderItemDto } from '../record/api';
import { isOpenLimitOrder } from '../record/openOrder.ts';
import {
  chartPrice,
  mergeChartPriceLines,
  type ChartPriceLine,
} from '../../components/charts/chartPriceLines.ts';
import { formatSignedPercent } from '../../utils/format.ts';

const SIDE = { buy: '매수', sell: '매도' } as const;
// A SELL condition's trigger is its 매도 기준가 (the card's and the form's word).
const SELL_TRIGGER_TITLE = {
  condition: '조건 매도 기준가',
  stop_loss: '손절가',
  take_profit: '익절가',
} as const;

/**
 * One asset's lines on its spot chart, from the account reads the order screen
 * already makes: the holding's average price with the server's own return
 * rate (current valuations only), each open limit order at its limit price,
 * and every trigger price still being watched — a conditional BUY/SELL, an
 * independent 손절가/익절가, an armed leg of an old OCO group. A triggered
 * condition's order shows as that order's limit line; a finished row shows
 * nothing. A price in another currency than the candles' is never drawn.
 */
export function buildSpotChartPriceLines(input: {
  assetId: string;
  /** The candles' own currency (never the won view's). */
  currencyCode: string | null | undefined;
  position: PositionItemDto | null | undefined;
  pendingOrders: RecordOrderItemDto[];
  conditionalBuys: ConditionalBuyOrderDto[];
  conditionalSells: ConditionalSellOrderDto[];
  protections: Protections | null | undefined;
}): ChartPriceLine[] {
  const { assetId, currencyCode } = input;
  if (!currencyCode) return [];
  const lines: ChartPriceLine[] = [];
  const add = (line: Omit<ChartPriceLine, 'price'>, value: string | null | undefined) => {
    const price = chartPrice(value);
    if (price !== null) lines.push({ ...line, price });
  };

  const position = input.position;
  // A malformed quantity draws nothing (the holdings list reports it).
  if (position && position.assetId === assetId && position.currencyCode === currencyCode && chartPrice(position.quantity) !== null) {
    const valuation = position.valuation;
    add({
      key: `average:${position.positionId}`,
      kind: 'average',
      title: '평단가',
      note: valuation.state === 'available' ? formatSignedPercent(valuation.returnRate) : null,
    }, position.averageCost);
  }

  for (const order of input.pendingOrders) {
    if (order.assetId !== assetId || order.currencyCode !== currencyCode || !isOpenLimitOrder(order)) continue;
    add({
      key: `limit:${order.orderId ?? order.id}`,
      kind: 'limit',
      title: `${order.limitOnClose ? 'LOC' : '지정가'} ${SIDE[order.side]}`,
    }, order.limitPrice);
  }

  for (const row of input.conditionalBuys) {
    if (row.assetId !== assetId || row.currencyCode !== currencyCode || row.state !== 'watching') continue;
    add({ key: `conditional-buy:${row.id}`, kind: 'trigger', title: '조건 매수 감시가' }, row.triggerPrice);
  }

  for (const row of input.conditionalSells) {
    if (row.assetId !== assetId || row.currencyCode !== currencyCode || row.state !== 'watching') continue;
    add({ key: `conditional-sell:${row.id}`, kind: 'trigger', title: SELL_TRIGGER_TITLE[row.kind] }, row.triggerPrice);
  }

  // Old OCO groups: no new ones, but armed legs are still watched while the
  // server says so (the pending list's own rule).
  const protections = input.protections;
  const monitored = !!protections?.capabilities.enabled &&
    (protections.capabilities.canMonitorSpot ?? protections.capabilities.canCreateSpot);
  for (const group of monitored ? protections.groups : []) {
    if (group.domain !== 'spot' || group.assetId !== assetId || group.currencyCode !== currencyCode || group.status !== 'active') continue;
    for (const leg of group.legs) {
      if (leg.state !== 'armed') continue;
      add({ key: `oco:${group.id}:${leg.id}`, kind: 'trigger', title: leg.kind === 'stop_loss' ? '손절가' : '익절가' }, leg.triggerPrice);
    }
  }

  return mergeChartPriceLines(lines);
}
