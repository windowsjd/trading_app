import { apiClient } from '../../services/api/client';
import { assertAccountScope } from '../tradingAccount/accountScope';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';

/**
 * 손절가/익절가 plans on a PENDING entry (`/trading-accounts/:accountId/entry-tp-sl-plans`):
 * a Spot BUY Limit, a Spot conditional BUY, a Futures limit entry or a Futures
 * conditional entry. A plan is a share (whole percent) of whatever the entry
 * ACTUALLY fills: it reserves nothing and never triggers. The entry's own
 * fill turns it into an independent stop-loss/take-profit for that share
 * (`activated`), or records why it could not (`failed`); an entry that ends
 * unfilled ends its plans (`canceled`). A conditional entry and the order it
 * created share ONE plan set (the server resolves the order to its entry).
 */
export type EntryTpSlEntryType =
  | 'spot_limit_order'
  | 'spot_conditional_buy'
  | 'futures_limit_order'
  | 'futures_conditional_entry';
export type EntryTpSlKind = 'stop_loss' | 'take_profit';
export type EntryTpSlPlanStatus = 'pending' | 'activated' | 'failed' | 'canceled';

export interface EntryTpSlPlanDto {
  id: string;
  /** The entry the plan belongs to (a conditional entry, never its order). */
  entryType: EntryTpSlEntryType;
  entryId: string;
  /** The order that entry created, if any (its plans follow that order). */
  childOrderId: string | null;
  domain: 'spot' | 'futures';
  assetId: string;
  direction: 'long' | 'short';
  kind: EntryTpSlKind;
  triggerCondition: 'at_or_above' | 'at_or_below';
  triggerPrice: string;
  /** Whole percent of the quantity the entry actually fills. */
  ratioPercent: number;
  status: EntryTpSlPlanStatus;
  /** Activation evidence: the executed quantity and the resulting target. */
  basisQuantity: string | null;
  activatedQuantity: string | null;
  fillOrderId: string | null;
  fillExecutionId: string | null;
  /** The setting an activated plan became. */
  settingId: string | null;
  failureCode: string | null;
  terminalReason: string | null;
  createdAt: string;
  endedAt: string | null;
  updatedAt: string;
}

/** The entry facts the sheet shows; they describe the entry, never a fill. */
export interface EntryTpSlEntryDto {
  entryType: EntryTpSlEntryType;
  entryId: string;
  domain: 'spot' | 'futures';
  state: 'open' | 'filled' | 'ended';
  supported: boolean;
  assetId: string;
  asset: { id: string; symbol: string; name: string; market: string; assetType: string };
  instrumentId: string | null;
  direction: 'long' | 'short';
  executionType: 'market' | 'limit';
  /** What plan triggers are checked against (limit, or market trigger). */
  entryPrice: string | null;
  triggerPrice: string | null;
  limitPrice: string | null;
  /** If the entry filled completely; null when decided at execution. */
  expectedQuantity: string | null;
  amount: string | null;
  currencyCode: string;
  leverage: number | null;
  legacyProtection: boolean;
  childOrderId: string | null;
}

export interface EntryTpSlCapabilitiesDto {
  /** `markets` (additive, 2026-10-17): KRX, CRYPTO_SPOT and, when supported, US. */
  spot: { enabled: boolean; canCreate: boolean; markets?: string[] };
  futures: { enabled: boolean; canCreate: boolean };
  canCancel: boolean;
  maxPendingPerAccount: number;
  maxPerEntry: number;
}

export interface EntryTpSlListDto {
  tradingAccountId: string;
  capabilities: EntryTpSlCapabilitiesDto;
  entry: EntryTpSlEntryDto | null;
  plans: EntryTpSlPlanDto[];
  pagination: OffsetPagination;
}

export interface EntryTpSlCreateResultDto {
  tradingAccountId: string;
  entry: EntryTpSlEntryDto | null;
  plans: EntryTpSlPlanDto[];
  duplicate: boolean;
}

export interface EntryTpSlPlanResultDto {
  tradingAccountId: string;
  plan: EntryTpSlPlanDto;
  duplicate: boolean;
}

export type EntryTpSlLegDto = { triggerPrice: string; ratio: number };
export type EntryTpSlCreateDto = {
  entryType: EntryTpSlEntryType;
  entryId: string;
  stopLoss?: EntryTpSlLegDto;
  takeProfit?: EntryTpSlLegDto;
  idempotencyKey: string;
};
/** One plan sent with a Spot BUY Limit or Futures limit entry create. */
export type EntryTpSlDraftDto = { kind: EntryTpSlKind; triggerPrice: string; ratio: number };

const path = (accountId: string, suffix = '') =>
  `/trading-accounts/${encodeURIComponent(accountId)}/entry-tp-sl-plans${suffix}`;

/** Every plan of one entry (any status), with that entry's facts. */
export async function getEntryTpSlPlans(
  accountId: string,
  entry: { entryType: EntryTpSlEntryType; entryId: string },
  signal?: AbortSignal,
) {
  const response = await apiClient.get<ApiSuccessResponse<EntryTpSlListDto>>(path(accountId), {
    params: { entryType: entry.entryType, entryId: entry.entryId, limit: 100 },
    signal,
  });
  return assertAccountScope('GET /trading-accounts/:accountId/entry-tp-sl-plans', accountId, response.data.data);
}

/** The account's pending plans (`open`) or the newest ended ones (`ended`). */
export async function getAccountEntryTpSlPlans(accountId: string, state: 'open' | 'ended', signal?: AbortSignal) {
  const response = await apiClient.get<ApiSuccessResponse<EntryTpSlListDto>>(path(accountId), {
    params: { state, limit: state === 'open' ? 100 : 30 },
    signal,
  });
  return assertAccountScope('GET /trading-accounts/:accountId/entry-tp-sl-plans', accountId, response.data.data);
}

/** Same key + same body replays (`duplicate: true`); never a second plan. */
export async function createEntryTpSlPlans(accountId: string, body: EntryTpSlCreateDto) {
  const response = await apiClient.post<ApiSuccessResponse<EntryTpSlCreateResultDto>>(path(accountId), body);
  return assertAccountScope('POST /trading-accounts/:accountId/entry-tp-sl-plans', accountId, response.data.data);
}

/** Pending plans only; activated/failed/canceled replay (`duplicate: true`). */
export async function cancelEntryTpSlPlan(accountId: string, planId: string) {
  const response = await apiClient.post<ApiSuccessResponse<EntryTpSlPlanResultDto>>(
    path(accountId, `/${encodeURIComponent(planId)}/cancel`),
  );
  return assertAccountScope('POST /trading-accounts/:accountId/entry-tp-sl-plans/:id/cancel', accountId, response.data.data);
}
