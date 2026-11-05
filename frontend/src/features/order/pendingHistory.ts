import { formatDisplayDecimal, formatKstDateTime, getAssetNameDisplay } from '../../utils/format.ts';
import { getConditionalBuyEndReason, getConditionalBuyStateLabel } from '../conditional/conditionalBuyDisplay.ts';
import { getConditionalSellEndReason, getConditionalSellStateLabel } from '../conditional/conditionalSellDisplay.ts';
import { getFuturesConditionalEndReason, getFuturesConditionalStateLabel } from '../futures/conditionalEntryDisplay.ts';
import { getEntryPlanFailureText, getEntryPlanStateLabel, getFuturesTpSlStateLabel } from '../conditional/tpSlModel.ts';
import type { ConditionalBuyOrderDto } from '../conditional/conditionalBuyApi';
import type { ConditionalSellOrderDto } from '../conditional/conditionalSellApi';
import type { EntryTpSlPlanDto } from '../conditional/entryTpSlApi';
import type { ProtectionGroup } from '../conditional/api';
import type { FuturesConditionalEntry } from '../futures/api';
import type { FuturesTpSlSetting } from '../futures/tpSlApi';

/**
 * 종료 이력 of the unified pending list (2026-11-05): the newest ended rows
 * of every kind, newest end first, each with its real end (체결, 취소, 실패,
 * 만료) and reason. Limit orders' own fills and cancels stay in 거래 내역.
 * Pure: runs under `node --test`.
 */
export type PendingHistoryItem = {
  key: string;
  assetName: string;
  typeLabel: string;
  stateLabel: string;
  endedAt: string;
  reason: string | null;
};

export type PendingHistorySources = {
  conditionalBuys?: readonly ConditionalBuyOrderDto[];
  conditionalSells?: readonly ConditionalSellOrderDto[];
  futuresConditionals?: readonly FuturesConditionalEntry[];
  futuresTpSl?: readonly FuturesTpSlSetting[];
  entryPlans?: readonly EntryTpSlPlanDto[];
  protections?: readonly ProtectionGroup[];
};

const ended = (at: string | null | undefined, fallback: string) => at ?? fallback;

const LIVE = new Set(['watching', 'triggered', 'order_pending']);

export function buildPendingHistory(sources: PendingHistorySources): PendingHistoryItem[] {
  // Only ended rows: a row still live belongs to the pending list, whatever a read returned.
  const items: PendingHistoryItem[] = [
    ...(sources.conditionalBuys ?? []).filter((row) => !LIVE.has(row.state)).map((row) => ({
      key: `conditional_buy:${row.id}`,
      assetName: getAssetNameDisplay(row.asset).primary,
      typeLabel: '조건부 매수',
      stateLabel: getConditionalBuyStateLabel(row.state),
      endedAt: ended(row.endedAt ?? row.order?.executedAt ?? row.order?.canceledAt, row.updatedAt),
      reason: getConditionalBuyEndReason(row),
    })),
    ...(sources.conditionalSells ?? []).filter((row) => !LIVE.has(row.state)).map((row) => ({
      key: `conditional_sell:${row.id}`,
      assetName: getAssetNameDisplay(row.asset).primary,
      typeLabel: row.kind === 'stop_loss' ? '손절가' : row.kind === 'take_profit' ? '익절가' : '조건부 매도',
      stateLabel: getConditionalSellStateLabel(row.state),
      endedAt: ended(row.endedAt ?? row.order?.executedAt, row.updatedAt),
      reason: getConditionalSellEndReason(row),
    })),
    ...(sources.futuresConditionals ?? []).filter((row) => !LIVE.has(row.state)).map((row) => ({
      key: `futures_conditional:${row.id}`,
      assetName: row.instrument.underlying.name,
      typeLabel: `선물 조건주문 · ${row.direction === 'long' ? '롱' : '숏'}`,
      stateLabel: getFuturesConditionalStateLabel(row),
      endedAt: ended(row.endedAt ?? row.execution?.executedAt, row.updatedAt),
      reason: getFuturesConditionalEndReason(row),
    })),
    ...(sources.futuresTpSl ?? []).filter((row) => !LIVE.has(row.state)).map((row) => ({
      key: `futures_tp_sl:${row.id}`,
      assetName: row.instrument.underlying.name,
      typeLabel: `선물 ${row.kind === 'stop_loss' ? '손절가' : '익절가'}`,
      stateLabel: getFuturesTpSlStateLabel(row),
      endedAt: ended(row.endedAt ?? row.execution?.executedAt, row.updatedAt),
      reason: null,
    })),
    ...(sources.entryPlans ?? []).filter((plan) => plan.status !== 'pending').map((plan) => ({
      key: `entry_plan:${plan.id}`,
      assetName: getAssetNameDisplay(plan.asset).primary,
      typeLabel: `체결 후 ${plan.kind === 'stop_loss' ? '손절가' : '익절가'}`,
      stateLabel: getEntryPlanStateLabel(plan),
      endedAt: ended(plan.endedAt, plan.updatedAt),
      reason: getEntryPlanFailureText(plan),
    })),
    ...(sources.protections ?? [])
      .filter((group) => group.status === 'completed' || group.status === 'canceled')
      .map((group) => ({
        key: `protection:${group.id}`,
        assetName: group.asset?.name ?? '보호 종목',
        typeLabel: `기존 손절가/익절가(OCO)${group.domain === 'futures' ? ' · 선물' : ''}`,
        stateLabel: group.status === 'completed' ? '보호 완료' : '보호 취소',
        endedAt: ended(group.endedAt, group.createdAt),
        // What each leg did, as the OCO list always showed it.
        reason: group.children.map((child) => `조건 충족 ${formatDisplayDecimal(child.triggerEvidence.price)} · ${
          child.status === 'filled' ? '실행됨' : child.status === 'canceled' ? '취소/교체됨' : '체결 대기'}`).join(' / ') || null,
      })),
  ];
  return items.sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt) || a.key.localeCompare(b.key));
}

export function historyTime(item: Pick<PendingHistoryItem, 'endedAt'>) {
  return formatKstDateTime(item.endedAt);
}
