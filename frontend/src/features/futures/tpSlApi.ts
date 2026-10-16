import { apiClient } from '../../services/api/client';
import { assertAccountScope } from '../tradingAccount/accountScope';
import type { OffsetPagination } from '../../models/dto/common';
import type { FuturesInstrument } from './api';

/**
 * Independent 손절가/익절가 on one open Futures position lifetime
 * (`futures/tp-sl-settings`). Each setting has its own target quantity and
 * reserves nothing; when the contract's Futures Last reaches its trigger it
 * REDUCES the position (or closes the whole remainder) through the ordinary
 * Futures execution, for min(target, the position at that moment). It never
 * opens, increases or flips a position, and one setting firing never cancels
 * another. `state: 'filled'` exists only when the reduction executed.
 */
export type FuturesTpSlKind = 'stop_loss' | 'take_profit';
export type FuturesTpSlState = 'watching' | 'triggered' | 'filled' | 'canceled' | 'failed';
export type FuturesTpSlSetting = {
  id: string;
  tradingAccountId: string;
  instrumentId: string;
  instrument: FuturesInstrument;
  positionId: string;
  direction: 'long' | 'short';
  kind: FuturesTpSlKind;
  triggerCondition: 'at_or_above' | 'at_or_below';
  triggerPrice: string;
  /** The user's target quantity (contracts of the underlying). */
  quantity: string;
  status: 'watching' | 'triggered' | 'ordered' | 'canceled' | 'failed';
  state: FuturesTpSlState;
  /** Live rows: the position now and what a trigger now would reduce. */
  position: { quantity: string; executableQuantity: string | null } | null;
  execution: {
    executionId: string; operation: string; executionPrice: string; quantity: string;
    feeAmount: string; realizedPnl: string; positionQuantityAfter: string; executedAt: string;
  } | null;
  /** The execution reduced less than the target (the position was smaller). */
  quantityLimited: boolean;
  trigger: { triggeredAt: string; snapshotId: string | null; evidence: Record<string, unknown> | null } | null;
  /** Activated from a plan on the entry that opened the lifetime. */
  entryPlanId: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  failureCode: string | null;
  terminalReason: string | null;
  createdAt: string;
  endedAt: string | null;
  updatedAt: string;
};
export type FuturesTpSlList = {
  tradingAccountId: string;
  capabilities: { enabled: boolean; canCreate: boolean; canCancel: boolean; maxLivePerAccount: number };
  settings: FuturesTpSlSetting[];
  pagination: OffsetPagination;
};
export type FuturesTpSlLeg = { triggerPrice: string; quantity: string };
export type FuturesTpSlCommand = {
  positionId: string;
  stopLoss?: FuturesTpSlLeg;
  takeProfit?: FuturesTpSlLeg;
  idempotencyKey: string;
};
export type FuturesTpSlCreateResult = { tradingAccountId: string; settings: FuturesTpSlSetting[]; duplicate: boolean };
export type FuturesTpSlResult = { tradingAccountId: string; setting: FuturesTpSlSetting; duplicate: boolean };

const path = (id: string, suffix = '') =>
  `/trading-accounts/${encodeURIComponent(id)}/futures/tp-sl-settings${suffix}`;

/** Live settings (`open`, all pages) or the newest ended page (`ended`). */
export async function getFuturesTpSlSettings(id: string, state: 'open' | 'ended', signal?: AbortSignal) {
  const url = path(id);
  if (state === 'ended') {
    const response = await apiClient.get<{ success: true; data: FuturesTpSlList }>(url, { params: { state, limit: 30, offset: 0 }, signal });
    return assertAccountScope(url, id, response.data.data);
  }
  const settings: FuturesTpSlSetting[] = [];
  let offset = 0;
  for (;;) {
    const response = await apiClient.get<{ success: true; data: FuturesTpSlList }>(url, { params: { state, limit: 100, offset }, signal });
    const page = assertAccountScope(url, id, response.data.data);
    settings.push(...page.settings);
    if (page.pagination.nextOffset === null) return { ...page, settings };
    if (!Number.isSafeInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset || page.pagination.nextOffset > 100000)
      throw new Error('FUTURES_TP_SL_PAGINATION_INVALID');
    offset = page.pagination.nextOffset;
  }
}
/** Same key + same body replays (`duplicate: true`); never a second setting. */
export async function createFuturesTpSlSettings(id: string, command: FuturesTpSlCommand) {
  const url = path(id);
  const response = await apiClient.post<{ success: true; data: FuturesTpSlCreateResult }>(url, command);
  return assertAccountScope(url, id, response.data.data);
}
/** Watching/triggered only; ended settings replay unchanged. */
export async function cancelFuturesTpSlSetting(id: string, settingId: string) {
  const url = path(id, `/${encodeURIComponent(settingId)}/cancel`);
  const response = await apiClient.post<{ success: true; data: FuturesTpSlResult }>(url, {});
  return assertAccountScope(url, id, response.data.data);
}
