import { apiClient } from "../../services/api/client";
import { assertAccountScope } from "../tradingAccount/accountScope";
import type { OffsetPagination } from "../../models/dto/common";
export type ProtectionLeg = {
  kind: "stop_loss" | "take_profit";
  triggerPrice: string;
  childOrderType: "market" | "limit";
  childLimitPrice?: string;
};
export type ProtectionGroup = {
  id: string;
  domain: "spot" | "futures";
  assetId: string;
  currencyCode: string;
  positionId: string | null;
  parentOrderId: string | null;
  direction: "long" | "short";
  status: "holding" | "active" | "completed" | "canceled";
  remainingQuantity: string | null;
  terminalReason: string | null;
  createdAt: string;
  endedAt: string | null;
  legs: (Omit<ProtectionLeg, "childLimitPrice"> & {
    id: string;
    childLimitPrice: string | null;
    state: "holding" | "armed" | "triggered" | "completed" | "canceled";
  })[];
  children: {
    id: string;
    legId: string;
    status: "pending" | "filled" | "canceled";
    quantity: string;
    orderId: string | null;
    futuresExecutionId: string | null;
    triggeredAt: string;
    terminalReason: string | null;
    triggerEvidence: {
      price: string;
      sourceName: string;
      effectiveAt: string;
      capturedAt: string;
    };
  }[];
};
export type Protections = {
  tradingAccountId: string;
  capabilities: {
    enabled: boolean;
    canCreateSpot: boolean;
    canCreateFutures: boolean;
    canCancel: boolean;
    canUseSpotLimit: boolean;
  };
  groups: ProtectionGroup[];
  pagination: OffsetPagination;
};
const path = (id: string) =>
  `/trading-accounts/${encodeURIComponent(id)}/protections`;
export async function getProtections(
  id: string,
  domain: "spot" | "futures",
  assetId: string,
  history = false,
  signal?: AbortSignal,
) {
  const url = path(id);
  const response = await apiClient.get<{ data: Protections }>(url, {
    params: { domain, assetId, history: String(history), limit: 30 },
    signal,
  });
  return assertAccountScope(url, id, response.data.data);
}
export type ProtectionCreate = {
  domain: "spot" | "futures";
  assetId: string;
  positionId: string;
  legs: ProtectionLeg[];
  idempotencyKey: string;
};
type Result = {
  tradingAccountId: string;
  groupId: string;
  status: ProtectionGroup["status"];
};
export async function createProtection(id: string, body: ProtectionCreate) {
  const url = path(id),
    response = await apiClient.post<{ data: Result }>(url, body);
  return assertAccountScope(url, id, response.data.data);
}
export async function cancelProtection(
  id: string,
  groupId: string,
  idempotencyKey: string,
) {
  const url = `${path(id)}/${encodeURIComponent(groupId)}/cancel`;
  const response = await apiClient.post<{ data: Result }>(url, {
    idempotencyKey,
  });
  return assertAccountScope(url, id, response.data.data);
}
