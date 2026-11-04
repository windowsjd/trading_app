import type { Protections } from '../conditional/api';
import type {
  FuturesConditionalEntry,
  FuturesLimitOrder,
  FuturesPosition,
} from './api';
import type { FuturesTpSlSetting } from './tpSlApi';
import { futuresHolding, getFuturesPositionDisplay } from './positionDisplay.ts';
import {
  chartPrice,
  mergeChartPriceLines,
  type ChartPriceLine,
} from '../../components/charts/chartPriceLines.ts';

const DIRECTION = { long: '롱', short: '숏' } as const;

/**
 * One contract's lines on its chart (Futures Last candles, USD): the open
 * position's average entry price with the position's own ROI (the card's
 * leverage/margin figure, shown only while its Mark evaluation is fresh),
 * each submitted limit entry, and every trigger still being watched — a
 * conditional entry, an independent 손절가/익절가 of this position, an armed
 * leg of an old OCO group on it. All of them trigger on Futures Last, the
 * candles' own price. A triggered entry's order shows as that order's line.
 */
export function buildFuturesChartPriceLines(input: {
  instrumentId: string;
  positions: FuturesPosition[];
  /** The positions read's evaluation time and the server clock now. */
  evaluatedAt: string | undefined;
  now: number;
  limitOrders: FuturesLimitOrder[];
  conditionalEntries: FuturesConditionalEntry[];
  tpSl: FuturesTpSlSetting[];
  protections: Protections | null | undefined;
}): ChartPriceLine[] {
  const { instrumentId } = input;
  const lines: ChartPriceLine[] = [];
  const add = (line: Omit<ChartPriceLine, 'price'>, value: string | null | undefined) => {
    const price = chartPrice(value);
    if (price !== null) lines.push({ ...line, price });
  };

  const held = input.positions.filter((position) =>
    position.instrumentId === instrumentId && chartPrice(position.quantity) !== null);
  for (const position of held) {
    const display = getFuturesPositionDisplay(futuresHolding(position), input.evaluatedAt, input.now);
    add({
      key: `average:${position.id}`,
      kind: 'average',
      title: `${DIRECTION[position.direction]} 진입가`,
      note: display.fresh ? display.roi : null,
    }, position.averageEntryPrice);
  }

  for (const order of input.limitOrders) {
    if (order.instrumentId !== instrumentId || order.status !== 'submitted') continue;
    add({ key: `limit:${order.id}`, kind: 'limit', title: `지정가 ${DIRECTION[order.direction]}` }, order.limitPrice);
  }

  for (const entry of input.conditionalEntries) {
    if (entry.instrumentId !== instrumentId || entry.state !== 'watching') continue;
    add({ key: `conditional-entry:${entry.id}`, kind: 'trigger', title: `조건 ${DIRECTION[entry.direction]} 감시가` }, entry.triggerPrice);
  }

  const positionIds = new Set(held.map((position) => position.id));
  for (const setting of input.tpSl) {
    if (setting.instrumentId !== instrumentId || setting.state !== 'watching' || !positionIds.has(setting.positionId)) continue;
    add({ key: `tp-sl:${setting.id}`, kind: 'trigger', title: setting.kind === 'stop_loss' ? '손절가' : '익절가' }, setting.triggerPrice);
  }

  // Old OCO groups on this position: armed legs while the server watches them.
  const protections = input.protections;
  const monitored = !!protections?.capabilities.enabled &&
    (protections.capabilities.canMonitorFutures ?? protections.capabilities.canCreateFutures);
  for (const group of monitored ? protections.groups : []) {
    if (group.domain !== 'futures' || group.status !== 'active' || !group.positionId || !positionIds.has(group.positionId)) continue;
    for (const leg of group.legs) {
      if (leg.state !== 'armed') continue;
      add({ key: `oco:${group.id}:${leg.id}`, kind: 'trigger', title: leg.kind === 'stop_loss' ? '손절가' : '익절가' }, leg.triggerPrice);
    }
  }

  return mergeChartPriceLines(lines);
}
