import { apiClient } from "../../services/api/client";
import { guestReadConfig } from "../auth/guestBrowsing.ts";
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
/** Device clock when a polled read was sent; its freshness is judged on the
 * server's clock from there (futuresServerNow), never on the device clock. */
type SentAt = { clientRequestedAt?: number };
export type FuturesPositions = SentAt & {
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
export type FuturesInstruments = SentAt & {
  tradingAccountId: string;
  evaluatedAt: string;
  capabilities: FuturesCapabilities;
  instruments: FuturesInstrument[];
};
/** The same contracts as market data: no account, capability or position field. */
export type FuturesMarketInstruments = SentAt & {
  evaluatedAt: string;
  instruments: FuturesInstrument[];
};
/** An account's contract list (with its capabilities), not the market-data one. */
export function isAccountFuturesInstruments(
  read: FuturesInstruments | FuturesMarketInstruments,
): read is FuturesInstruments {
  return "tradingAccountId" in read;
}
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
  /**
   * An add that changes the position's leverage to `leverage` (2026-11-06):
   * the leverage the user saw and confirmed changing. Never sent otherwise.
   */
  fromLeverage?: number;
};
/** A leverage change the server applied (from → to) and the allocation it moved. */
export type FuturesLeverageChange = {
  fromLeverage: number;
  toLeverage: number;
  isolatedMarginBefore: string;
  isolatedMarginAfter: string;
};
export type FuturesResult = {
  tradingAccountId: string;
  commandId: string;
  execution: Omit<FuturesExecution, "instrument">;
  /** Absent from an older server and from responses committed before 2026-11-06. */
  leverageChange?: FuturesLeverageChange | null;
};
/** 거래 내역 › 선물: 포지션 진입 (open/increase) or 포지션 종료 (reduce/close, liquidations, Season exit). */
export type FuturesHistoryPhase = "entry" | "exit";
/** The Season-final exit of one account: one record holding every position it closed. */
export type FuturesSeasonExit = {
  id: string;
  seasonId: string;
  endAt: string;
  realizedPnl: string;
  feeAmount: string;
  settledFee: string;
  settledCash: string;
  bankruptcyShortfall: string;
  executedAt: string;
  closes: {
    positionId: string;
    instrumentId: string;
    direction: Direction;
    marginMode: MarginMode;
    quantity: string;
    executionPrice: string;
    realizedPnl: string;
    feeAmount: string;
    priceBasis: "futures_last" | "spot_last";
    instrument: FuturesInstrument;
  }[];
};
/** One record as stored: an execution, a liquidation event or the Season exit, each with its own id. */
export type FuturesPositionRecord = { id: string; executedAt: string } & (
  | { kind: "execution"; execution: FuturesExecution }
  | { kind: "liquidation"; liquidation: FuturesLiquidation }
  | { kind: "season_settlement"; settlement: FuturesSeasonExit }
);
export type FuturesPositionHistory = {
  tradingAccountId: string;
  phase: FuturesHistoryPhase;
  pagination: OffsetPagination;
  records: FuturesPositionRecord[];
};
/** One Binance USDⓈ-M contract candle (contract trade price, not Mark). */
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
export type FuturesChartInterval = "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type FuturesChartRange = "2d" | "3d" | "14d" | "96d" | "1y";
export type FuturesChartWindow = {
  interval: FuturesChartInterval;
  range: FuturesChartRange;
  limit: number;
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
  range: FuturesChartRange;
  interval: FuturesChartInterval;
  candles: FuturesCandle[];
  source: {
    provider: "binance_usdm";
    endpoint: string;
    symbol: string;
    contractType: "PERPETUAL";
    requestedCount: number;
    returnedCount: number;
    provisionalUpdatedAt: string | null;
    /** stored = the collected 4h history; provider = native klines read on demand. */
    delivery?: "stored" | "provider";
    fetchedAt?: string | null;
    /** The server could not refresh this copy (served from its cache). */
    stale?: boolean;
  };
};
/**
 * Each 봉 시간's window, the server's own (market-candle-futures-windows.ts):
 * the general crypto chart's windows — about 2 days of 5m, 3 days of 15m, 14
 * days of 30m and 1h, 96 days of 4h, a year of 1d — each under the 1000 cap.
 */
export const FUTURES_CHART_WINDOWS: Record<FuturesChartInterval, FuturesChartWindow> = {
  "5m": { interval: "5m", range: "2d", limit: 600 },
  "15m": { interval: "15m", range: "3d", limit: 300 },
  "30m": { interval: "30m", range: "14d", limit: 700 },
  "1h": { interval: "1h", range: "14d", limit: 350 },
  "4h": { interval: "4h", range: "96d", limit: 600 },
  "1d": { interval: "1d", range: "1y", limit: 400 },
};
/** 96 days × 6 closed contract buckets + the current one, under the 1000 cap. */
export const FUTURES_CHART_WINDOW = FUTURES_CHART_WINDOWS["4h"];
/** The window of a selected 봉 시간 (the shared selector's interval). */
export function futuresChartWindow(interval: string): FuturesChartWindow {
  return FUTURES_CHART_WINDOWS[interval as FuturesChartInterval] ?? FUTURES_CHART_WINDOW;
}
/**
 * How often an open chart re-reads its window: the server's own freshness for
 * that interval (a shorter poll would only hit its cache).
 */
export const FUTURES_CHART_REFRESH_MS: Record<FuturesChartInterval, number> = {
  "5m": 15_000,
  "15m": 30_000,
  "30m": 30_000,
  "1h": 60_000,
  "4h": 60_000,
  "1d": 120_000,
};
/**
 * Contract chart of one FuturesInstrument. Market data, not account data: the
 * route is not account-scoped and the response carries no account fields, so
 * every trading account shares one cache entry per instrument and window.
 */
export async function getFuturesInstrumentCandles(
  instrumentId: string,
  window: FuturesChartWindow = FUTURES_CHART_WINDOW,
  signal?: AbortSignal,
): Promise<FuturesCandles> {
  const query = new URLSearchParams({
    interval: window.interval,
    range: window.range,
    limit: String(window.limit),
  });
  // Guest browsing reads it as a public request (no credentials).
  const response = await apiClient.get<{ success: true; data: FuturesCandles }>(
    `/futures/instruments/${encodeURIComponent(instrumentId)}/candles?${query.toString()}`,
    { signal, ...guestReadConfig() },
  );
  const data = response.data.data;
  // Never show another contract's, or another interval's, candles here.
  if (data.instrument.id !== instrumentId || data.interval !== window.interval) {
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
async function sentRead<T extends SentAt>(
  id: string,
  suffix: string,
  signal?: AbortSignal,
): Promise<T> {
  const clientRequestedAt = Date.now();
  return { ...(await read<T>(id, suffix, signal)), clientRequestedAt };
}
export const getFuturesInstruments = (id: string, signal?: AbortSignal) =>
  sentRead<FuturesInstruments>(id, "instruments", signal);
/**
 * The contract list as market data (guest browsing, 2026-10-30): the
 * account route's contracts, Last/Mark and 24h statistics without an account.
 * Members keep the account route, whose capabilities decide trading.
 */
export async function getFuturesMarketInstruments(signal?: AbortSignal): Promise<FuturesMarketInstruments> {
  const clientRequestedAt = Date.now();
  const response = await apiClient.get<{ success: true; data: FuturesMarketInstruments }>(
    "/futures/instruments",
    { signal, ...guestReadConfig() },
  );
  return { ...response.data.data, clientRequestedAt };
}
export const getFuturesPositions = (id: string, signal?: AbortSignal) =>
  sentRead<FuturesPositions>(id, "positions", signal);
/** One page of the server's union for the phase (never a filter of another page; 2026-11-06). */
export const getFuturesPositionHistory = (
  id: string,
  phase: FuturesHistoryPhase,
  offset: number,
  signal?: AbortSignal,
) => read<FuturesPositionHistory>(id, `position-history?phase=${phase}&limit=20&offset=${offset}`, signal);
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

export type FuturesLimitCommand = Omit<FuturesCommand, 'operation' | 'positionId'> & {
  limitPrice: string;
  attachedProtection?: ProtectionLeg[];
  /** 손절가/익절가 plans registered with the entry (activate on its fill). */
  entryTpSl?: import('../conditional/entryTpSlApi').EntryTpSlDraftDto[];
};
export type FuturesLimitOrder = {
  id: string; tradingAccountId: string; instrumentId: string; direction: Direction;
  marginMode: MarginMode; leverage: number; quantity: string; limitPrice: string;
  reservedAmount: string; status: 'submitted' | 'executed' | 'canceled';
  executionId: string | null; terminalReason: string | null;
  createdAt: string; endedAt: string | null;
  instrument: FuturesInstrument;
  /** 설정 변경 (2026-11-05): absent on an older server (0). */
  revision?: number; revisedAt?: string | null;
  /** The confirmed change of the open same-direction position's leverage at the fill. */
  leverageChange?: { positionId: string; fromLeverage: number } | null;
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
 * contract's Futures Last that makes ONE entry in its direction — a market
 * entry or a Futures limit entry — when it triggers; the fill opens that
 * direction's position or adds to the open one. Registering reserves nothing;
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
  /** 설정 변경 (2026-11-05): absent on an older server (0). */
  revision?: number; revisedAt?: string | null;
  /** The confirmed change of the open same-direction position's leverage at the fill. */
  leverageChange?: { positionId: string; fromLeverage: number } | null;
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
  /** The open same-direction position's leverage the user confirmed changing. */
  fromLeverage?: number;
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

/**
 * Leverage change of an open position (2026-11-06): the user confirms it
 * naming the leverage the position has now (`fromLeverage`). Quantity, entry
 * price, history and TP/SL stay; the margin is re-derived. Same key + same
 * body replays the first answer.
 */
export type FuturesLeverageChangeResult = {
  tradingAccountId: string;
  changeId: string;
  position: Pick<FuturesPosition, 'id' | 'instrumentId' | 'direction' | 'marginMode' | 'quantity' | 'averageEntryPrice' | 'leverage' | 'isolatedMargin' | 'initialMargin'>;
  leverageChange: FuturesLeverageChange;
  collateral: { balanceAmount: string; totalMarginUsed: string; freeCollateral: string };
  changedAt: string;
};
export async function changeFuturesLeverage(
  id: string,
  positionId: string,
  command: { leverage: number; fromLeverage: number; idempotencyKey: string },
) {
  const url = path(id, `positions/${encodeURIComponent(positionId)}/leverage`);
  const response = await apiClient.post<{ success: true; data: FuturesLeverageChangeResult }>(url, command);
  return assertAccountScope(url, id, response.data.data);
}

/** One side of a preview: the position's terms and Mark risk (null when unknown). */
export type FuturesLeverageSide = {
  leverage: number;
  quantity: string;
  averageEntryPrice: string;
  isolatedMargin: string;
  initialMargin: string;
  initialRequirement: string | null;
  liquidationPrice: string | null;
  liquidationBuffer: string | null;
};
/**
 * The server's estimate of a leverage change, alone or with an add of
 * `quantity` at `price` (the current Futures Last when omitted), from the
 * same plan and checks as the commands. Values it cannot evaluate are null
 * (never guessed); `refusal` names the check that would refuse it now.
 */
export type FuturesLeveragePreview = {
  tradingAccountId: string;
  positionId: string;
  evaluatedAt: string;
  markState: string;
  basisPrice: string | null;
  before: FuturesLeverageSide;
  after: FuturesLeverageSide | null;
  collateral: {
    freeCollateralBefore: string | null;
    freeCollateralAfter: string;
    isolatedMarginDelta: string;
    initialRequirementDelta: string;
    estimatedFee: string;
    crossLiquidationBufferBefore: string | null;
    crossLiquidationBufferAfter: string | null;
  } | null;
  refusal: string | null;
};
export function getFuturesLeveragePreview(
  id: string,
  positionId: string,
  query: { leverage: number; quantity?: string | null; price?: string | null },
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ leverage: String(query.leverage) });
  if (query.quantity) params.set('quantity', query.quantity);
  if (query.quantity && query.price) params.set('price', query.price);
  return read<FuturesLeveragePreview>(id, `positions/${encodeURIComponent(positionId)}/leverage-preview?${params.toString()}`, signal);
}
