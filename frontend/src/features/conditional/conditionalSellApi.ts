import { apiClient } from '../../services/api/client';
import { assertAccountScope } from '../tradingAccount/accountScope';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';

/**
 * SELL intents on an open Spot holding (`/trading-accounts/:accountId/conditional-sell-orders`):
 * a user condition, an independent stop-loss and an independent take-profit.
 * None reserves quantity, so several may target more than the holding in
 * total. When one fires the server submits ONE ordinary market or limit SELL
 * sized to min(target, holding − other orders' reservations) at that moment;
 * that Order is the financial record. `state` follows the linked order:
 * `filled` exists only when it executed, never because a price was reached.
 */
export type ConditionalSellKind = 'condition' | 'stop_loss' | 'take_profit';
export type ConditionalSellTriggerCondition = 'at_or_above' | 'at_or_below';
export type ConditionalSellExecutionType = 'market' | 'limit';
export type ConditionalSellStatus = 'watching' | 'triggered' | 'ordered' | 'canceled' | 'failed';
export type ConditionalSellState =
  | 'watching'
  | 'triggered'
  | 'order_pending'
  | 'filled'
  | 'order_canceled'
  | 'order_rejected'
  | 'canceled'
  | 'failed';

export interface ConditionalSellLinkedOrderDto {
  orderId: string;
  orderType: string;
  status: string;
  /** What was really submitted (may be less than the target). */
  quantity: string | null;
  executedQuantity: string | null;
  canceledQuantity: string | null;
  limitPrice: string | null;
  executedPrice: string | null;
  grossAmount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  reservedQuantity: string | null;
  cancelReason: string | null;
  submittedAt: string | null;
  executedAt: string | null;
  canceledAt: string | null;
}

/** Live rows only: today's holding facts and what a trigger now would sell. */
export interface ConditionalSellPositionDto {
  holdingQuantity: string | null;
  reservedQuantity: string | null;
  availableQuantity: string | null;
  /** Null: nothing could be sold right now. */
  executableQuantity: string | null;
}

export interface ConditionalSellOrderDto {
  id: string;
  assetId: string;
  asset: { id: string; symbol: string; name: string; market: string | null; assetType: string } | null;
  side: 'sell';
  kind: ConditionalSellKind;
  positionId: string;
  triggerCondition: ConditionalSellTriggerCondition;
  triggerPrice: string;
  executionType: ConditionalSellExecutionType;
  limitPrice: string | null;
  /** The user's target quantity. */
  quantity: string;
  currencyCode: string;
  status: ConditionalSellStatus;
  state: ConditionalSellState;
  position: ConditionalSellPositionDto | null;
  /** Unreserved holding when the order was sized (evidence for a smaller order). */
  executionAvailableQuantity: string | null;
  /** The linked order is smaller than the target. */
  quantityLimited: boolean;
  trigger: { triggeredAt: string; snapshotId: string | null; evidence: Record<string, unknown> | null } | null;
  order: ConditionalSellLinkedOrderDto | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  failureCode: string | null;
  terminalReason: string | null;
  createdAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface ConditionalSellKindCapabilitiesDto {
  enabled: boolean;
  canCreate: boolean;
  canUseLimit: boolean;
}

export interface ConditionalSellCapabilitiesDto {
  enabled: boolean;
  condition: ConditionalSellKindCapabilitiesDto;
  protection: ConditionalSellKindCapabilitiesDto;
  canCancel: boolean;
  markets: string[];
  maxLivePerAccount: number;
}

export interface ConditionalSellListDto {
  tradingAccountId: string;
  capabilities: ConditionalSellCapabilitiesDto;
  conditionalOrders: ConditionalSellOrderDto[];
  pagination: OffsetPagination;
}

export interface ConditionalSellCreateResultDto {
  tradingAccountId: string;
  conditionalOrders: ConditionalSellOrderDto[];
  duplicate: boolean;
}

export interface ConditionalSellResultDto {
  tradingAccountId: string;
  conditionalOrder: ConditionalSellOrderDto;
  duplicate: boolean;
}

export type ConditionalSellLegDto = {
  triggerPrice: string;
  executionType: ConditionalSellExecutionType;
  limitPrice?: string;
  quantity: string;
};

export type ConditionalSellCreateDto =
  | ({
      kind: 'condition';
      assetId: string;
      triggerCondition: ConditionalSellTriggerCondition;
      idempotencyKey: string;
    } & ConditionalSellLegDto)
  | {
      kind: 'protection';
      assetId: string;
      stopLoss?: ConditionalSellLegDto;
      takeProfit?: ConditionalSellLegDto;
      idempotencyKey: string;
    };

const path = (accountId: string, suffix = '') =>
  `/trading-accounts/${encodeURIComponent(accountId)}/conditional-sell-orders${suffix}`;

/** `open`: every row the owner can still cancel; `ended`: the rest. */
export type ConditionalSellListState = 'open' | 'ended';
/** `protection` = stop-loss and take-profit rows. */
export type ConditionalSellListKind = 'condition' | 'protection';

/**
 * Without `history` or `state`, the server returns only live rows
 * (watching/triggered). `state` replaces `history` (never both).
 */
export async function getConditionalSellOrders(
  accountId: string,
  params: {
    history?: boolean;
    state?: ConditionalSellListState;
    kind?: ConditionalSellListKind;
    assetId?: string;
    limit?: number;
    offset?: number;
  } = {},
  signal?: AbortSignal,
) {
  const response = await apiClient.get<ApiSuccessResponse<ConditionalSellListDto>>(path(accountId), {
    params: {
      ...(params.state ? { state: params.state } : params.history ? { history: 'true' } : {}),
      ...(params.kind ? { kind: params.kind } : {}),
      ...(params.assetId ? { assetId: params.assetId } : {}),
      limit: params.limit ?? 30,
      offset: params.offset ?? 0,
    },
    signal,
  });
  return assertAccountScope('GET /trading-accounts/:accountId/conditional-sell-orders', accountId, response.data.data);
}

export async function getConditionalSellOrder(accountId: string, conditionalOrderId: string) {
  const response = await apiClient.get<ApiSuccessResponse<ConditionalSellResultDto>>(
    path(accountId, `/${encodeURIComponent(conditionalOrderId)}`),
  );
  return assertAccountScope('GET /trading-accounts/:accountId/conditional-sell-orders/:id', accountId, response.data.data);
}

/** Same key + same body replays (`duplicate: true`); never a second intent. */
export async function createConditionalSellOrder(accountId: string, body: ConditionalSellCreateDto) {
  const response = await apiClient.post<ApiSuccessResponse<ConditionalSellCreateResultDto>>(path(accountId), body);
  return assertAccountScope('POST /trading-accounts/:accountId/conditional-sell-orders', accountId, response.data.data);
}

/** Only watching/triggered rows; an ordered row is canceled through its order. */
export async function cancelConditionalSellOrder(accountId: string, conditionalOrderId: string) {
  const response = await apiClient.post<ApiSuccessResponse<ConditionalSellResultDto>>(
    path(accountId, `/${encodeURIComponent(conditionalOrderId)}/cancel`),
  );
  return assertAccountScope('POST /trading-accounts/:accountId/conditional-sell-orders/:id/cancel', accountId, response.data.data);
}
