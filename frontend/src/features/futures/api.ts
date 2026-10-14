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
