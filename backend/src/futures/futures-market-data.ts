import {
  isBookSequence,
  isRecord,
  parseBookLevels,
  type OrderBookLevel,
} from '../providers/order-book.types';

/**
 * USDⓈ-M display market data — order book and rolling 24h statistics.
 *
 * Both come from the contract's own Binance USDⓈ-M streams. Neither is ever an
 * execution price, executable liquidity, valuation or risk input: Futures Last
 * (executions, triggers) and Mark (valuation, risk) keep their own evidence
 * paths. Spot data is never accepted here.
 */

/** Partial book, ten levels every 500 ms; served on the `/public` route. */
export const FUTURES_DEPTH_STREAM_SUFFIX = '@depth10@500ms';
/** Rolling 24h ticker; served on the `/market` route. */
export const FUTURES_TICKER_STREAM_SUFFIX = '@ticker';
/** A ticker older than this is not displayed or sorted as current. */
export const FUTURES_MARKET_STATS_MAX_AGE_MS = 60_000;
/** Tolerated receipt-time skew between instances sharing the stats key. */
const FUTURES_MARKET_STATS_MAX_FUTURE_MS = 5_000;
export const FUTURES_MARKET_STATS_KEY = 'futures:market-stats:v1';

/** Display data only. Never an execution, valuation or persistence model. */
export type FuturesOrderBook = {
  instrumentId: string;
  symbol: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel: string;
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  /** Server receipt time. */
  capturedAt: string;
  /** Provider transaction time of the snapshot. */
  effectiveAt: string | null;
};

/** Sequence is transport-internal (provider final update id). */
export type FuturesOrderBookEvent = {
  type: 'futures_order_book';
  sequence: string;
  book: FuturesOrderBook;
};

export type FuturesMarketStats = {
  symbol: string;
  /** Provider 24h price change percent of this contract (signed). */
  priceChangePercent: string;
  /** Provider 24h quote (USDT notional) volume of this contract. */
  quoteVolume: string;
  windowOpenTime: string;
  windowCloseTime: string;
  eventTime: string;
  receivedAt: string;
};

const FUTURES_SYMBOL = /^[A-Z0-9]{1,30}USDT$/u;
const SIGNED_DECIMAL = /^-?\d{1,20}(?:\.\d{1,12})?$/u;
const DECIMAL = /^\d{1,24}(?:\.\d{1,12})?$/u;

export function futuresBaseAsset(symbol: string): string {
  return symbol.slice(0, -'USDT'.length);
}

export function futuresMarketLabel(symbol: string): string {
  return `${futuresBaseAsset(symbol)} / USDT 무기한`;
}

function epochIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    return null;
  const date = new Date(value);
  return Number.isFinite(+date) ? date.toISOString() : null;
}

function isIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function providerLevels(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const levels: unknown[] = [];
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const [price, quantity] = entry as unknown[];
    levels.push({ price, quantity });
  }
  return levels;
}

export type ParsedFuturesDepth =
  | { state: 'other' }
  | { state: 'invalid' }
  | {
      state: 'depth';
      symbol: string;
      sequence: string;
      asks: OrderBookLevel[];
      bids: OrderBookLevel[];
      effectiveAt: string;
    };

/**
 * One combined-stream partial book frame. `other` is not a depth stream (e.g. a
 * SUBSCRIBE reply); `invalid` is a depth frame whose whole snapshot is refused
 * rather than shown with gaps.
 */
export function parseBinanceFuturesDepth(frame: unknown): ParsedFuturesDepth {
  if (
    !isRecord(frame) ||
    typeof frame.stream !== 'string' ||
    !frame.stream.endsWith(FUTURES_DEPTH_STREAM_SUFFIX)
  )
    return { state: 'other' };
  const data = frame.data;
  if (
    !isRecord(data) ||
    data.e !== 'depthUpdate' ||
    typeof data.s !== 'string' ||
    !FUTURES_SYMBOL.test(data.s) ||
    frame.stream !== `${data.s.toLowerCase()}${FUTURES_DEPTH_STREAM_SUFFIX}`
  )
    return { state: 'invalid' };
  const sequence =
    typeof data.u === 'number' && Number.isSafeInteger(data.u) && data.u >= 0
      ? String(data.u)
      : null;
  const effectiveAt = epochIso(data.T) ?? epochIso(data.E);
  const asks = parseBookLevels(providerLevels(data.a), 'asks');
  const bids = parseBookLevels(providerLevels(data.b), 'bids');
  if (!sequence || !isBookSequence(sequence) || !effectiveAt || !asks || !bids)
    return { state: 'invalid' };
  return { state: 'depth', symbol: data.s, sequence, asks, bids, effectiveAt };
}

export type ParsedFuturesTicker =
  | { state: 'other' }
  | { state: 'invalid' }
  | { state: 'ticker'; stats: FuturesMarketStats };

/** One combined-stream 24h ticker frame of a USDⓈ-M contract. */
export function parseBinanceFuturesTicker(
  frame: unknown,
  receivedAt: Date,
): ParsedFuturesTicker {
  if (
    !isRecord(frame) ||
    typeof frame.stream !== 'string' ||
    !frame.stream.endsWith(FUTURES_TICKER_STREAM_SUFFIX)
  )
    return { state: 'other' };
  const data = frame.data;
  if (
    !isRecord(data) ||
    data.e !== '24hrTicker' ||
    typeof data.s !== 'string' ||
    !FUTURES_SYMBOL.test(data.s) ||
    frame.stream !== `${data.s.toLowerCase()}${FUTURES_TICKER_STREAM_SUFFIX}`
  )
    return { state: 'invalid' };
  const eventTime = epochIso(data.E);
  const windowOpenTime = epochIso(data.O);
  const windowCloseTime = epochIso(data.C);
  if (
    typeof data.P !== 'string' ||
    !SIGNED_DECIMAL.test(data.P) ||
    typeof data.q !== 'string' ||
    !DECIMAL.test(data.q) ||
    !eventTime ||
    !windowOpenTime ||
    !windowCloseTime ||
    Date.parse(windowOpenTime) >= Date.parse(windowCloseTime)
  )
    return { state: 'invalid' };
  return {
    state: 'ticker',
    stats: {
      symbol: data.s,
      priceChangePercent: data.P,
      quoteVolume: data.q,
      windowOpenTime,
      windowCloseTime,
      eventTime,
      receivedAt: receivedAt.toISOString(),
    },
  };
}

function validStats(value: unknown): value is FuturesMarketStats {
  return (
    isRecord(value) &&
    typeof value.symbol === 'string' &&
    FUTURES_SYMBOL.test(value.symbol) &&
    typeof value.priceChangePercent === 'string' &&
    SIGNED_DECIMAL.test(value.priceChangePercent) &&
    typeof value.quoteVolume === 'string' &&
    DECIMAL.test(value.quoteVolume) &&
    isIso(value.windowOpenTime) &&
    isIso(value.windowCloseTime) &&
    isIso(value.eventTime) &&
    isIso(value.receivedAt)
  );
}

export function serializeFuturesMarketStats(
  stats: Iterable<FuturesMarketStats>,
): string {
  return JSON.stringify({ version: 1, stats: [...stats] });
}

/** Shared-cache read boundary: malformed entries are dropped, never repaired. */
export function parseFuturesMarketStats(
  raw: string | null,
): Map<string, FuturesMarketStats> {
  const result = new Map<string, FuturesMarketStats>();
  if (!raw) return result;
  try {
    const blob: unknown = JSON.parse(raw);
    if (!isRecord(blob) || blob.version !== 1 || !Array.isArray(blob.stats))
      return result;
    for (const entry of blob.stats as unknown[])
      if (validStats(entry))
        result.set(entry.symbol, {
          symbol: entry.symbol,
          priceChangePercent: entry.priceChangePercent,
          quoteVolume: entry.quoteVolume,
          windowOpenTime: entry.windowOpenTime,
          windowCloseTime: entry.windowCloseTime,
          eventTime: entry.eventTime,
          receivedAt: entry.receivedAt,
        });
  } catch {
    return new Map();
  }
  return result;
}

/** Current = received within the freshness window of the reading clock. */
export function currentFuturesMarketStats(
  stats: FuturesMarketStats | undefined,
  now: Date,
): FuturesMarketStats | null {
  if (!stats) return null;
  const age = +now - Date.parse(stats.receivedAt);
  return age <= FUTURES_MARKET_STATS_MAX_AGE_MS &&
    age >= -FUTURES_MARKET_STATS_MAX_FUTURE_MS
    ? stats
    : null;
}

/** API projection; `unavailable` never carries a number. */
export function presentFuturesMarketStats(stats: FuturesMarketStats | null) {
  return stats
    ? {
        state: 'available' as const,
        priceChangePercent: stats.priceChangePercent,
        quoteVolume: stats.quoteVolume,
        windowOpenTime: stats.windowOpenTime,
        windowCloseTime: stats.windowCloseTime,
        receivedAt: stats.receivedAt,
      }
    : {
        state: 'unavailable' as const,
        priceChangePercent: null,
        quoteVolume: null,
        windowOpenTime: null,
        windowCloseTime: null,
        receivedAt: null,
      };
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 80
  );
}

/** Cross-instance pub/sub boundary: re-validate everything that is relayed. */
export function parseFuturesOrderBookEvent(
  message: string,
): FuturesOrderBookEvent | null {
  try {
    const event: unknown = JSON.parse(message);
    if (
      !isRecord(event) ||
      event.type !== 'futures_order_book' ||
      !isBookSequence(event.sequence) ||
      !isRecord(event.book)
    )
      return null;
    const book = event.book;
    if (
      !isLabel(book.instrumentId) ||
      typeof book.symbol !== 'string' ||
      !FUTURES_SYMBOL.test(book.symbol) ||
      !isLabel(book.priceUnit) ||
      !isLabel(book.quantityUnit) ||
      !isLabel(book.marketLabel) ||
      !isIso(book.capturedAt) ||
      (book.effectiveAt !== null && !isIso(book.effectiveAt))
    )
      return null;
    const asks = parseBookLevels(book.asks, 'asks');
    const bids = parseBookLevels(book.bids, 'bids');
    if (!asks || !bids) return null;
    return {
      type: 'futures_order_book',
      sequence: event.sequence,
      book: {
        instrumentId: book.instrumentId,
        symbol: book.symbol,
        priceUnit: book.priceUnit,
        quantityUnit: book.quantityUnit,
        marketLabel: book.marketLabel,
        asks,
        bids,
        capturedAt: book.capturedAt,
        effectiveAt: book.effectiveAt,
      },
    };
  } catch {
    return null;
  }
}
