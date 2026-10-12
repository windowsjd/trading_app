import { apiClient } from '../../services/api/client';
import { assertAccountScope } from '../tradingAccount/accountScope';
import type { ApiSuccessResponse, OffsetPagination } from '../../models/dto/common';

/**
 * Conditional BUY watches (`/trading-accounts/:accountId/conditional-buy-orders`).
 * A watch reserves nothing; when its condition is met the server submits ONE
 * ordinary market or limit BUY, and that Order is the financial record. `state`
 * is derived from `status` and the linked order: `filled` exists only when the
 * linked order executed, never because the condition was met.
 */
export type ConditionalBuyTriggerCondition = 'at_or_above' | 'at_or_below';
export type ConditionalBuyExecutionType = 'market' | 'limit';
export type ConditionalBuyStatus = 'watching' | 'triggered' | 'ordered' | 'canceled' | 'failed';
export type ConditionalBuyState =
  | 'watching'
  | 'triggered'
  | 'order_pending'
  | 'filled'
  | 'order_canceled'
  | 'order_rejected'
  | 'canceled'
  | 'failed';

export interface ConditionalBuyLinkedOrderDto {
  orderId: string;
  orderType: string;
  status: string;
  quantity: string | null;
  executedQuantity: string | null;
  limitPrice: string | null;
  executedPrice: string | null;
  grossAmount: string | null;
  feeAmount: string | null;
  netAmount: string | null;
  reservedAmount: string | null;
  cancelReason: string | null;
  submittedAt: string | null;
  executedAt: string | null;
  canceledAt: string | null;
}

export interface ConditionalBuyOrderDto {
  id: string;
  assetId: string;
  asset: { id: string; symbol: string; name: string; market: string | null; assetType: string } | null;
  side: 'buy';
  triggerCondition: ConditionalBuyTriggerCondition;
  triggerPrice: string;
  executionType: ConditionalBuyExecutionType;
  limitPrice: string | null;
  quantity: string | null;
  amount: string | null;
  currencyCode: string;
  status: ConditionalBuyStatus;
  state: ConditionalBuyState;
  trigger: { triggeredAt: string; snapshotId: string | null; evidence: Record<string, unknown> | null } | null;
  order: ConditionalBuyLinkedOrderDto | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  failureCode: string | null;
  terminalReason: string | null;
  createdAt: string;
  endedAt: string | null;
  updatedAt: string;
}

export interface ConditionalBuyCapabilitiesDto {
  enabled: boolean;
  canCreate: boolean;
  canCancel: boolean;
  canUseLimit: boolean;
  markets: string[];
  maxLivePerAccount: number;
}

export interface ConditionalBuyListDto {
  tradingAccountId: string;
  capabilities: ConditionalBuyCapabilitiesDto;
  conditionalOrders: ConditionalBuyOrderDto[];
  pagination: OffsetPagination;
}

export interface ConditionalBuyResultDto {
  tradingAccountId: string;
  conditionalOrder: ConditionalBuyOrderDto;
  duplicate: boolean;
}

export type ConditionalBuyCreateDto = {
  assetId: string;
  triggerCondition: ConditionalBuyTriggerCondition;
  triggerPrice: string;
  executionType: ConditionalBuyExecutionType;
  limitPrice?: string;
  idempotencyKey: string;
} & ({ quantity: string; amount?: never } | { amount: string; quantity?: never });

const path = (accountId: string, suffix = '') =>
  `/trading-accounts/${encodeURIComponent(accountId)}/conditional-buy-orders${suffix}`;

/** Without `history`, the server returns only live rows (watching/triggered). */
export async function getConditionalBuyOrders(
  accountId: string,
  params: { history?: boolean; assetId?: string; limit?: number; offset?: number } = {},
  signal?: AbortSignal,
) {
  const url = path(accountId);
  const response = await apiClient.get<ApiSuccessResponse<ConditionalBuyListDto>>(url, {
    params: {
      ...(params.history ? { history: 'true' } : {}),
      ...(params.assetId ? { assetId: params.assetId } : {}),
      limit: params.limit ?? 30,
      offset: params.offset ?? 0,
    },
    signal,
  });
  return assertAccountScope('GET /trading-accounts/:accountId/conditional-buy-orders', accountId, response.data.data);
}

export async function getConditionalBuyOrder(accountId: string, conditionalOrderId: string) {
  const response = await apiClient.get<ApiSuccessResponse<ConditionalBuyResultDto>>(
    path(accountId, `/${encodeURIComponent(conditionalOrderId)}`),
  );
  return assertAccountScope('GET /trading-accounts/:accountId/conditional-buy-orders/:id', accountId, response.data.data);
}

/** Same key + same body replays (`duplicate: true`); never a second watch. */
export async function createConditionalBuyOrder(accountId: string, body: ConditionalBuyCreateDto) {
  const response = await apiClient.post<ApiSuccessResponse<ConditionalBuyResultDto>>(path(accountId), body);
  return assertAccountScope('POST /trading-accounts/:accountId/conditional-buy-orders', accountId, response.data.data);
}

/** Only watching/triggered rows; an ordered row is canceled through its order. */
export async function cancelConditionalBuyOrder(accountId: string, conditionalOrderId: string) {
  const response = await apiClient.post<ApiSuccessResponse<ConditionalBuyResultDto>>(
    path(accountId, `/${encodeURIComponent(conditionalOrderId)}/cancel`),
  );
  return assertAccountScope('POST /trading-accounts/:accountId/conditional-buy-orders/:id/cancel', accountId, response.data.data);
}
