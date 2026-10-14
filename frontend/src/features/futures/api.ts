import { apiClient } from "../../services/api/client";
import { assertAccountScope } from "../tradingAccount/accountScope";
import type { OffsetPagination } from "../../models/dto/common";
import type { ProtectionLeg } from '../conditional/api';

export type PriceTimes = { effectiveAt: string; capturedAt: string };
export type Direction = "long" | "short";
export type MarginMode = "isolated" | "cross";
export type Operation = "open" | "increase" | "reduce" | "close";
export type FuturesCapabilities = {
  tradingMode: "ENABLED" | "REDUCE_ONLY" | "DISABLED";
  canOpen: boolean;
  canIncrease: boolean;
  canReduce: boolean;
  canClose: boolean;
  reason: string | null;
};
export type FuturesInstrument = {
  id: string;
  isActive: boolean;
  productType: "synthetic_perpetual";
  settlementCurrency: "USD";
  underlying: {
    assetId: string;
    symbol: string;
    name: string;
    market: string;
    displayPriceDecimals: number | null;
  };
  markPrice?: string | null;
  referencePrice?: string | null;
  markState?: string;
  markCapturedAt?: string | null;
  markEvidence?: PriceTimes | null;
  referencePriceEvidence?: PriceTimes | null;
  /** Rolling 24h ticker of this USDⓈ-M contract (display only). Unavailable
   * carries no numbers; never a Spot figure or Mark − Last. */
  marketStats?: FuturesMarketStats;
};
export type FuturesMarketStats =
  | {
      state: "available";
      priceChangePercent: string;
      quoteVolume: string;
      windowOpenTime: string;
      windowCloseTime: string;
      receivedAt: string;
    }
  | {
      state: "unavailable";
      priceChangePercent: null;
      quoteVolume: null;
      windowOpenTime: null;
      windowCloseTime: null;
      receivedAt: null;
    };
export type FuturesPosition = {
  id: string;
  tradingAccountId: string;
  instrumentId: string;
  direction: Direction;
  marginMode: MarginMode;
  quantity: string;
  averageEntryPrice: string;
  leverage: number;
  isolatedMargin: string;
  realizedPnl: string;
  initialMargin: string;
  markNotional: string | null;
  roi: string | null;
  instrument: FuturesInstrument;
  markPrice: string | null;
  referencePrice: string | null;
  markUnrealizedPnl: string | null;
  markState: string;
  referencePriceEvidence: PriceTimes | null;
  markEvidence: {
    snapshotId: string;
    source: string;
    effectiveAt: string;
    capturedAt: string;
  } | null;
  risk: {
    unrealizedPnl: string;
    initialRequirement: string;
    maintenanceMargin: string;
    estimatedCloseFee: string;
    liquidationRequirement: string;
    liquidationBuffer?: string;
    liquidationPrice: string | null;
  } | null;
};
/** Minimal authorized display projection, shared with friend detail. */
export type FuturesHolding = Pick<FuturesPosition,
  'direction' | 'marginMode' | 'leverage' | 'markNotional' |
  'roi' | 'markUnrealizedPnl' | 'markState'> & {
  assetId: string; name: string; symbol: string;
  markEvidence: PriceTimes | null;
};
export type FuturesPositions = {
  tradingAccountId: string;
  evaluatedAt: string;
  capabilities: FuturesCapabilities;
  positions: FuturesPosition[];
  collateral: {
    balanceAmount: string;
    totalMarginUsed: string;
    freeCollateral: string | null;
  };
  cross: {
    positionIds: string[];
    evaluatedAt: string;
    markState: string;
    metrics: {
      crossBaseCollateral: string;
      crossUnrealizedPnl: string;
      crossEquity: string;
      crossInitialMarginRequirement: string;
      crossMaintenanceRequirement: string;
      crossFreeCollateral: string;
      liquidationBuffer: string;
    } | null;
  };
};
export type FuturesInstruments = {
  tradingAccountId: string;
  evaluatedAt: string;
  capabilities: FuturesCapabilities;
  instruments: FuturesInstrument[];
};
export type FuturesExecution = {
  positionId: string;
  leverage: number;
  positionAfter: { quantity: string; averageEntryPrice: string; isolatedMargin: string };
  id: string;
  operation: Operation;
  direction: Direction;
  quantity: string;
  executionPrice: string;
  realizedPnl: string;
  feeAmount: string;
  executedAt: string;
  instrument: FuturesInstrument;
  priceEvidence?: { priceBasis?: "futures_last" | "spot_last" };
};
export type FuturesLiquidation = {
  id: string;
  marginMode: MarginMode;
  realizedPnl: string;
  feeAmount: string;
  settledFee?: string;
  settledCash: string;
  bankruptcyShortfall: string;
  executedAt: string;
  closes: {
    positionId: string;
    instrumentId: string;
    quantity: string;
    executionPrice: string;
    direction: Direction;
    markSnapshot?: { symbol: string };
  }[];
};
export type FuturesCommand = {
  instrumentId: string;
  positionId?: string;
  operation: Operation;
  direction: Direction;
  marginMode: MarginMode;
  leverage: number;
  quantity: string;
  idempotencyKey: string;
};
export type FuturesResult = {
  tradingAccountId: string;
  commandId: string;
  execution: Omit<FuturesExecution, "instrument">;
};
export type FuturesHistory = {
  tradingAccountId: string;
  pagination: OffsetPagination;
  executions?: FuturesExecution[];
  liquidations?: FuturesLiquidation[];
};
/** One Binance USDⓈ-M contract 4h candle (contract trade price, not Mark). */
export type FuturesCandle = {
  time: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
  /** True only for the bucket containing "now" (not final yet). */
  provisional: boolean;
};
export type FuturesCandles = {
  state: "available" | "empty";
  instrument: {
    id: string;
    symbol: string;
    name: string;
    productType: string;
    settlementCurrency: string;
    isActive: boolean;
    displayPriceDecimals: number;
  };
  priceBasis: "contract_last_trade";
  range: "96d";
  interval: "4h";
  candles: FuturesCandle[];
  source: {
    provider: "binance_usdm";
    endpoint: string;
    symbol: string;
    contractType: "PERPETUAL";
    requestedCount: number;
    returnedCount: number;
    provisionalUpdatedAt: string | null;
  };
};
/** 96 days × 6 closed contract buckets + the current one, under the 1000 cap. */
export const FUTURES_CHART_WINDOW = {
  interval: "4h",
  range: "96d",
  limit: 600,
} as const;
/**
 * Contract chart of one FuturesInstrument. Market data, not account data: the
 * route is not account-scoped and the response carries no account fields, so
 * every trading account shares one cache entry per instrument.
 */
export async function getFuturesInstrumentCandles(
  instrumentId: string,
  signal?: AbortSignal,
): Promise<FuturesCandles> {
  const query = new URLSearchParams({
    interval: FUTURES_CHART_WINDOW.interval,
    range: FUTURES_CHART_WINDOW.range,
    limit: String(FUTURES_CHART_WINDOW.limit),
  });
  const response = await apiClient.get<{ success: true; data: FuturesCandles }>(
    `/futures/instruments/${encodeURIComponent(instrumentId)}/candles?${query.toString()}`,
    { signal },
  );
  const data = response.data.data;
  // Never show another contract's candles under this instrument.
  if (data.instrument.id !== instrumentId) {
    throw new Error("FUTURES_CHART_INSTRUMENT_MISMATCH");
  }
  return data;
}
const path = (id: string, suffix: string) =>
  `/trading-accounts/${encodeURIComponent(id)}/futures/${suffix}`;
async function read<T>(
  id: string,
  suffix: string,
  signal?: AbortSignal,
): Promise<T> {
  const url = path(id, suffix);
  const response = await apiClient.get<{ success: true; data: T }>(url, {
    signal,
  });
  return assertAccountScope(url, id, response.data.data);
}
export const getFuturesInstruments = (id: string, signal?: AbortSignal) =>
  read<FuturesInstruments>(id, "instruments", signal);
export const getFuturesPositions = (id: string, signal?: AbortSignal) =>
  read<FuturesPositions>(id, "positions", signal);
export const getFuturesHistory = (
  id: string,
  kind: "executions" | "liquidations",
  offset: number,
  signal?: AbortSignal,
) => read<FuturesHistory>(id, `${kind}?limit=20&offset=${offset}`, signal);
export const getFuturesFinalSettlement = (id: string, signal?: AbortSignal) =>
  read<{
    tradingAccountId: string;
    settlement: {
      endAt: string;
      realizedPnl: string;
      feeAmount: string;
      settledCash: string;
      bankruptcyShortfall: string;
      closes?: { price?: { lastPriceSnapshot?: unknown } }[];
    } | null;
  }>(id, "final-settlement", signal);
export async function executeFutures(id: string, command: FuturesCommand) {
  const url = path(id, "execute");
  const response = await apiClient.post<{ success: true; data: FuturesResult }>(
    url,
    command,
  );
  return assertAccountScope(url, id, response.data.data);
}

export type FuturesLimitCommand = Omit<FuturesCommand, 'operation' | 'positionId'> & { limitPrice: string; attachedProtection?: ProtectionLeg[] };
export type FuturesLimitOrder = {
  id: string; tradingAccountId: string; instrumentId: string; direction: Direction;
  marginMode: MarginMode; leverage: number; quantity: string; limitPrice: string;
  reservedAmount: string; status: 'submitted' | 'executed' | 'canceled';
  executionId: string | null; terminalReason: string | null;
  createdAt: string; endedAt: string | null;
  instrument: FuturesInstrument;
};
export type FuturesLimitResult = { tradingAccountId: string; order: Omit<FuturesLimitOrder, 'instrument'> };
export async function getFuturesLimitOrders(id: string, signal?: AbortSignal) {
  const orders: FuturesLimitOrder[] = [];
  let offset = 0;
  for (;;) {
    const page = await read<{ tradingAccountId: string; orders: FuturesLimitOrder[]; pagination: OffsetPagination }>(id, `limit-orders?limit=100&offset=${offset}`, signal);
    orders.push(...page.orders);
    if (page.pagination.nextOffset === null) return { ...page, orders };
    if (!Number.isSafeInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset || page.pagination.nextOffset > 100000) throw new Error('대기 주문을 다시 조회해주세요.');
    offset = page.pagination.nextOffset;
  }
}
export async function createFuturesLimitOrder(id: string, command: FuturesLimitCommand) {
  const url = path(id, 'limit-orders');
  const response = await apiClient.post<{ success: true; data: FuturesLimitResult }>(url, command);
  return assertAccountScope(url, id, response.data.data);
}
export async function cancelFuturesLimitOrder(id: string, orderId: string) {
  const url = path(id, `limit-orders/${encodeURIComponent(orderId)}/cancel`);
  const response = await apiClient.post<{ success: true; data: FuturesLimitResult }>(url, {});
  return assertAccountScope(url, id, response.data.data);
}

/**
 * Futures conditional entries (`futures/conditional-entries`): a watch on the
 * contract's Futures Last that opens ONE new position — a market open or a
 * Futures limit entry — when it triggers. Registering reserves nothing;
 * `state` follows the created execution or limit entry, so a met condition is
 * never reported as filled. Separate from position TP/SL (protections).
 */
export type FuturesConditionalTrigger = 'at_or_above' | 'at_or_below';
export type FuturesConditionalExecution = 'market' | 'limit';
export type FuturesConditionalEntryState =
  | 'watching' | 'triggered' | 'filled' | 'order_pending' | 'order_canceled'
  | 'order_rejected' | 'failed' | 'canceled';
export type FuturesConditionalEntry = {
  id: string; tradingAccountId: string; instrumentId: string; instrument: FuturesInstrument;
  direction: Direction; marginMode: MarginMode; leverage: number; quantity: string;
  triggerCondition: FuturesConditionalTrigger; triggerPrice: string;
  executionType: FuturesConditionalExecution; limitPrice: string | null;
  status: 'watching' | 'triggered' | 'ordered' | 'canceled' | 'failed';
  state: FuturesConditionalEntryState;
  trigger: { triggeredAt: string; snapshotId: string | null; evidence: Record<string, unknown> | null } | null;
  execution: { executionId: string; positionId: string; executionPrice: string; quantity: string; feeAmount: string; executedAt: string } | null;
  limitOrder: { orderId: string; status: 'submitted' | 'executed' | 'canceled' | 'rejected'; limitPrice: string; reservedAmount: string;
    executionId: string | null; terminalReason: string | null; createdAt: string; endedAt: string | null } | null;
  attemptCount: number; lastAttemptAt: string | null; failureCode: string | null; terminalReason: string | null;
  createdAt: string; endedAt: string | null; updatedAt: string;
};
export type FuturesConditionalEntries = {
  tradingAccountId: string;
  capabilities: { enabled: boolean; canCreate: boolean; maxLivePerAccount: number };
  entries: FuturesConditionalEntry[];
  pagination: OffsetPagination;
};
export type FuturesConditionalEntryCommand = {
  instrumentId: string; direction: Direction; marginMode: MarginMode; leverage: number; quantity: string;
  triggerCondition: FuturesConditionalTrigger; triggerPrice: string;
  executionType: FuturesConditionalExecution; limitPrice?: string; idempotencyKey: string;
};
export type FuturesConditionalEntryResult = { tradingAccountId: string; entry: FuturesConditionalEntry; duplicate: boolean };
/** Ended rows: the newest page only (state history, not a ledger). */
export const FUTURES_CONDITIONAL_ENDED_PAGE = 20;
/** `open`: every row the owner can still cancel, read completely; `ended`: newest page. */
export async function getFuturesConditionalEntries(id: string, state: 'open' | 'ended', signal?: AbortSignal) {
  if (state === 'ended')
    return read<FuturesConditionalEntries>(id, `conditional-entries?state=ended&limit=${FUTURES_CONDITIONAL_ENDED_PAGE}&offset=0`, signal);
  const entries: FuturesConditionalEntry[] = [];
  let offset = 0;
  for (;;) {
    const page = await read<FuturesConditionalEntries>(id, `conditional-entries?state=open&limit=100&offset=${offset}`, signal);
    entries.push(...page.entries);
    if (page.pagination.nextOffset === null) return { ...page, entries };
    if (!Number.isSafeInteger(page.pagination.nextOffset) || page.pagination.nextOffset <= offset || page.pagination.nextOffset > 100000)
      throw new Error('FUTURES_CONDITIONAL_PAGINATION_INVALID');
    offset = page.pagination.nextOffset;
  }
}
/** Same key + same body replays (`duplicate: true`); never a second watch. */
export async function createFuturesConditionalEntry(id: string, command: FuturesConditionalEntryCommand) {
  const url = path(id, 'conditional-entries');
  const response = await apiClient.post<{ success: true; data: FuturesConditionalEntryResult }>(url, command);
  return assertAccountScope(url, id, response.data.data);
}
/** Watching/triggered only; a created limit entry is canceled as a limit entry. */
export async function cancelFuturesConditionalEntry(id: string, entryId: string) {
  const url = path(id, `conditional-entries/${encodeURIComponent(entryId)}/cancel`);
  const response = await apiClient.post<{ success: true; data: FuturesConditionalEntryResult }>(url, {});
  return assertAccountScope(url, id, response.data.data);
}
