import { Prisma } from '../../generated/prisma/client';
import { fromTiingoTicker } from './tiingo.config';
import { TiingoError } from './tiingo.errors';

/**
 * Pure Tiingo payload validation. Nothing here keeps raw provider objects:
 * every accepted value is copied into a normalized decimal string, and every
 * field Tiingo leaves null (or sends malformed) stays null. A missing price or
 * size is never replaced by another field.
 */

export type TiingoTimestamp = {
  epochMs: number;
  /** Sub-millisecond part (0–999999 ns) so ordering keeps Tiingo's precision. */
  nanos: number;
  /** Millisecond-precision UTC ISO string. */
  iso: string;
};

export type TiingoLiquidityFields = {
  /** Relative spread as a decimal fraction (0.0011 = 0.11%). */
  spread: string | null;
  bidPrice: string | null;
  /** Shares. */
  bidSize: string | null;
  askPrice: string | null;
  /** Shares. */
  askSize: string | null;
  referencePrice: string | null;
};

export type TiingoSnapshot = {
  symbol: string;
  timestamp: TiingoTimestamp;
  referencePrice: string | null;
  prevClose: string | null;
  prevDate: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: string | null;
  liquidity: TiingoLiquidityFields;
  invalidFieldCount: number;
};

export type TiingoIntradayBar = {
  /** Bar start (Tiingo `date`). */
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
};

export type TiingoDailyBar = {
  /** Trading date, YYYY-MM-DD. */
  date: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string | null;
  /** Split- and dividend-adjusted values; null when Tiingo omits/invalidates them. */
  adjOpen: string | null;
  adjHigh: string | null;
  adjLow: string | null;
  adjClose: string | null;
  adjVolume: string | null;
  divCash: string | null;
  splitFactor: string | null;
};

export type TiingoMeta = {
  symbol: string;
  name: string | null;
  exchangeCode: string | null;
  startDate: string | null;
  endDate: string | null;
};

export type TiingoBarParseResult<T> = {
  bars: T[];
  invalid: number;
  duplicates: number;
};

export type TiingoWsChannelKind = 'reference' | 'liquidity';

export type TiingoWsMessage =
  | {
      kind: 'subscribed';
      subscriptionId: number | null;
      tickers: string[] | null;
      thresholdLevel: string | null;
    }
  | { kind: 'heartbeat' }
  | { kind: 'error'; responseCode: number | null }
  | {
      kind: 'reference';
      symbol: string;
      timestamp: TiingoTimestamp;
      price: string;
    }
  | {
      kind: 'liquidity';
      symbol: string;
      timestamp: TiingoTimestamp;
      liquidity: TiingoLiquidityFields;
      invalidFieldCount: number;
    }
  | {
      kind: 'ignored';
      reason: 'unknown_message_type' | 'unexpected_service';
    }
  | {
      kind: 'invalid';
      reason:
        | 'oversized'
        | 'not_json'
        | 'not_object'
        | 'bad_data'
        | 'channel_mismatch'
        | 'bad_timestamp'
        | 'bad_ticker'
        | 'bad_price';
    };

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/u;
const MAX_WS_FRAME_CHARS = 65_536;
const PRICE_DECIMALS = 8;

export function parseTiingoTimestamp(value: unknown): TiingoTimestamp | null {
  if (typeof value !== 'string' || value.length > 48) return null;
  const match = TIMESTAMP_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const digits = fraction.padEnd(9, '0');
  const offset =
    zone === 'Z'
      ? 'Z'
      : zone.length === 5
        ? `${zone.slice(0, 3)}:${zone.slice(3)}`
        : zone;
  const epochMs = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${digits.slice(0, 3)}${offset}`,
  );
  if (!Number.isFinite(epochMs)) return null;
  // Date.parse rolls some impossible values over; require a round trip of the
  // calendar fields in the given offset.
  const offsetMinutes =
    offset === 'Z'
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const local = new Date(epochMs + offsetMinutes * 60_000);
  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute)
  )
    return null;
  return {
    epochMs,
    nanos: Number(digits.slice(3, 9)),
    iso: new Date(epochMs).toISOString(),
  };
}

/** Negative = a before b, 0 = same instant (to the nanosecond). */
export function compareTiingoTimestamps(
  a: Pick<TiingoTimestamp, 'epochMs' | 'nanos'>,
  b: Pick<TiingoTimestamp, 'epochMs' | 'nanos'>,
): number {
  return a.epochMs !== b.epochMs ? a.epochMs - b.epochMs : a.nanos - b.nanos;
}

export function parseTiingoSnapshotResponse(
  json: unknown,
  expectedSymbol: string,
): TiingoSnapshot {
  const rows = Array.isArray(json) ? json : isRecord(json) ? [json] : null;
  if (!rows)
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_INVALID_PAYLOAD',
    );
  if (rows.length === 0)
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_EMPTY_RESPONSE',
    );
  const expected = expectedSymbol.trim().toUpperCase();
  const matches = rows.filter(
    (row): row is Record<string, unknown> =>
      isRecord(row) &&
      typeof row.ticker === 'string' &&
      fromTiingoTicker(row.ticker) === expected,
  );
  // Another ticker (or two rows for the same one) is never adopted.
  if (matches.length !== 1)
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_SYMBOL_MISMATCH',
    );
  const row = matches[0];
  const timestamp = parseTiingoTimestamp(row.timestamp);
  if (!timestamp)
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_INVALID_TIMESTAMP',
    );
  const counter = { invalid: 0 };
  const referencePrice = readPrice(row.tngoLast, counter);
  const liquidity = normalizeLiquidity(
    {
      spread: row.lqSpread,
      bidPrice: row.lqBidPrice,
      bidSize: row.lqBidSize,
      askPrice: row.lqAskPrice,
      askSize: row.lqAskSize,
      referencePrice: row.lqRefPrice ?? row.tngoLast,
    },
    counter,
  );
  const prevDate =
    typeof row.prevDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/u.test(row.prevDate)
      ? row.prevDate
      : null;
  return {
    symbol: expected,
    timestamp,
    referencePrice,
    prevClose: readPrice(row.prevClose, counter),
    prevDate,
    open: readPrice(row.open, counter),
    high: readPrice(row.high, counter),
    low: readPrice(row.low, counter),
    volume: readQuantity(row.volume, counter),
    liquidity,
    invalidFieldCount: counter.invalid,
  };
}

export function parseTiingoIntradayBars(
  json: unknown,
): TiingoBarParseResult<TiingoIntradayBar> {
  if (!Array.isArray(json))
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_INVALID_PAYLOAD',
    );
  const byOpenTime = new Map<number, TiingoIntradayBar>();
  let invalid = 0;
  let duplicates = 0;
  for (const row of json) {
    if (!isRecord(row)) {
      invalid += 1;
      continue;
    }
    const timestamp = parseTiingoTimestamp(row.date);
    const ohlc = readOhlc(row.open, row.high, row.low, row.close);
    const counter = { invalid: 0 };
    const volume =
      row.volume === undefined ? null : readQuantity(row.volume, counter);
    if (!timestamp || !ohlc || counter.invalid > 0) {
      invalid += 1;
      continue;
    }
    if (byOpenTime.has(timestamp.epochMs)) {
      duplicates += 1;
      continue;
    }
    byOpenTime.set(timestamp.epochMs, {
      openTime: new Date(timestamp.epochMs),
      ...ohlc,
      volume,
    });
  }
  return {
    bars: [...byOpenTime.values()].sort(
      (a, b) => a.openTime.getTime() - b.openTime.getTime(),
    ),
    invalid,
    duplicates,
  };
}

export function parseTiingoDailyBars(
  json: unknown,
): TiingoBarParseResult<TiingoDailyBar> {
  if (!Array.isArray(json))
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_INVALID_PAYLOAD',
    );
  const byDate = new Map<string, TiingoDailyBar>();
  let invalid = 0;
  let duplicates = 0;
  for (const row of json) {
    if (!isRecord(row) || typeof row.date !== 'string') {
      invalid += 1;
      continue;
    }
    const date = /^(\d{4}-\d{2}-\d{2})(?:T|$)/u.exec(row.date)?.[1] ?? null;
    const raw = readOhlc(row.open, row.high, row.low, row.close);
    const counter = { invalid: 0 };
    const volume =
      row.volume === undefined ? null : readQuantity(row.volume, counter);
    if (!date || !raw || counter.invalid > 0) {
      invalid += 1;
      continue;
    }
    if (byDate.has(date)) {
      duplicates += 1;
      continue;
    }
    // Adjusted values are validated as a set: a partial adjusted bar is not
    // mixed with raw values.
    const adjusted = readOhlc(
      row.adjOpen,
      row.adjHigh,
      row.adjLow,
      row.adjClose,
    );
    const adjCounter = { invalid: 0 };
    const adjVolume =
      row.adjVolume === undefined || row.adjVolume === null
        ? null
        : readQuantity(row.adjVolume, adjCounter);
    byDate.set(date, {
      date,
      ...raw,
      volume,
      adjOpen: adjusted?.open ?? null,
      adjHigh: adjusted?.high ?? null,
      adjLow: adjusted?.low ?? null,
      adjClose: adjusted?.close ?? null,
      adjVolume: adjCounter.invalid > 0 ? null : adjVolume,
      divCash: readNonNegative(row.divCash),
      splitFactor: readPositive(row.splitFactor),
    });
  }
  return {
    bars: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    invalid,
    duplicates,
  };
}

export function parseTiingoMeta(
  json: unknown,
  expectedSymbol: string,
): TiingoMeta {
  if (!isRecord(json) || typeof json.ticker !== 'string')
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_INVALID_PAYLOAD',
    );
  const expected = expectedSymbol.trim().toUpperCase();
  if (fromTiingoTicker(json.ticker) !== expected)
    throw /* @diagnosticSurface internal: Fixed Tiingo parse category for REST callers and diagnostics. */ new TiingoError(
      'TIINGO_SYMBOL_MISMATCH',
    );
  const text = (value: unknown, max: number) =>
    typeof value === 'string' && value.trim() && value.length <= max
      ? value.trim()
      : null;
  const date = (value: unknown) =>
    typeof value === 'string'
      ? (/^(\d{4}-\d{2}-\d{2})/u.exec(value)?.[1] ?? null)
      : null;
  return {
    symbol: expected,
    name: text(json.name, 200),
    exchangeCode: text(json.exchangeCode, 32),
    startDate: date(json.startDate),
    endDate: date(json.endDate),
  };
}

export function parseTiingoWsMessage(
  text: string,
  channel: TiingoWsChannelKind,
): TiingoWsMessage {
  if (text.length > MAX_WS_FRAME_CHARS)
    return { kind: 'invalid', reason: 'oversized' };
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: 'not_json' };
  }
  if (!isRecord(message)) return { kind: 'invalid', reason: 'not_object' };
  const response = isRecord(message.response) ? message.response : null;
  const responseCode =
    typeof response?.code === 'number' && Number.isFinite(response.code)
      ? response.code
      : null;
  const messageType = message.messageType;
  if (messageType === 'E' || (responseCode !== null && responseCode >= 400))
    return { kind: 'error', responseCode };
  if (messageType === 'H') return { kind: 'heartbeat' };
  if (messageType === 'I') {
    const data = isRecord(message.data) ? message.data : {};
    const rawId = data.subscriptionId;
    const subscriptionId =
      typeof rawId === 'number' && Number.isSafeInteger(rawId)
        ? rawId
        : typeof rawId === 'string' && /^\d{1,15}$/u.test(rawId)
          ? Number(rawId)
          : null;
    const tickers =
      Array.isArray(data.tickers) &&
      data.tickers.every((value) => typeof value === 'string')
        ? data.tickers.map((value) => value.toUpperCase())
        : null;
    const level = data.thresholdLevel;
    return {
      kind: 'subscribed',
      subscriptionId,
      tickers,
      thresholdLevel:
        typeof level === 'string' || typeof level === 'number'
          ? String(level)
          : null,
    };
  }
  if (messageType !== 'A')
    return { kind: 'ignored', reason: 'unknown_message_type' };
  if (message.service !== 'cons')
    return { kind: 'ignored', reason: 'unexpected_service' };
  const data = message.data;
  if (!Array.isArray(data)) return { kind: 'invalid', reason: 'bad_data' };
  const expectedLength = channel === 'reference' ? 3 : 8;
  if (data.length !== expectedLength)
    return {
      kind: 'invalid',
      reason:
        data.length === 3 || data.length === 8
          ? 'channel_mismatch'
          : 'bad_data',
    };
  const timestamp = parseTiingoTimestamp(data[0]);
  if (!timestamp) return { kind: 'invalid', reason: 'bad_timestamp' };
  if (
    typeof data[1] !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9.-]{0,9}$/u.test(data[1])
  )
    return { kind: 'invalid', reason: 'bad_ticker' };
  const symbol = fromTiingoTicker(data[1]);
  if (channel === 'reference') {
    const counter = { invalid: 0 };
    const price = readPrice(data[2], counter);
    if (!price) return { kind: 'invalid', reason: 'bad_price' };
    return { kind: 'reference', symbol, timestamp, price };
  }
  const counter = { invalid: 0 };
  const liquidity = normalizeLiquidity(
    {
      spread: data[2],
      bidSize: data[3],
      bidPrice: data[4],
      referencePrice: data[5],
      askPrice: data[6],
      askSize: data[7],
    },
    counter,
  );
  return {
    kind: 'liquidity',
    symbol,
    timestamp,
    liquidity,
    invalidFieldCount: counter.invalid,
  };
}

/** Shared by REST `lq*` fields and WebSocket thresholdLevel 4 arrays. */
export function normalizeLiquidity(
  raw: Record<keyof TiingoLiquidityFields, unknown>,
  counter: { invalid: number },
): TiingoLiquidityFields {
  let bidPrice = readPrice(raw.bidPrice, counter);
  let askPrice = readPrice(raw.askPrice, counter);
  let bidSize = readQuantity(raw.bidSize, counter);
  let askSize = readQuantity(raw.askSize, counter);
  // A crossed estimate is not shown as a market; both sides become unknown.
  if (
    bidPrice &&
    askPrice &&
    new Prisma.Decimal(bidPrice).gt(new Prisma.Decimal(askPrice))
  ) {
    counter.invalid += 2;
    bidPrice = null;
    askPrice = null;
    bidSize = null;
    askSize = null;
  }
  // A size without its price has nothing to attach to.
  if (!bidPrice) bidSize = null;
  if (!askPrice) askSize = null;
  return {
    spread: readNonNegative(raw.spread, counter),
    bidPrice,
    bidSize,
    askPrice,
    askSize,
    referencePrice: readPrice(raw.referencePrice, counter),
  };
}

function readOhlc(
  openRaw: unknown,
  highRaw: unknown,
  lowRaw: unknown,
  closeRaw: unknown,
): { open: string; high: string; low: string; close: string } | null {
  const values = [openRaw, highRaw, lowRaw, closeRaw].map((value) =>
    toDecimal(value)?.toDecimalPlaces(PRICE_DECIMALS),
  );
  if (values.some((value) => !value || value.lte(0))) return null;
  const [open, high, low, close] = values as Prisma.Decimal[];
  if (
    high.lt(low) ||
    high.lt(open) ||
    high.lt(close) ||
    low.gt(open) ||
    low.gt(close)
  )
    return null;
  return {
    open: formatPrice(open),
    high: formatPrice(high),
    low: formatPrice(low),
    close: formatPrice(close),
  };
}

function readPrice(value: unknown, counter?: { invalid: number }) {
  if (value === null || value === undefined) return null;
  const decimal = toDecimal(value)?.toDecimalPlaces(PRICE_DECIMALS);
  if (!decimal || decimal.lte(0)) {
    if (counter) counter.invalid += 1;
    return null;
  }
  return decimal.toFixed();
}

function readQuantity(value: unknown, counter?: { invalid: number }) {
  if (value === null || value === undefined) return null;
  const decimal = toDecimal(value);
  if (!decimal || decimal.lt(0)) {
    if (counter) counter.invalid += 1;
    return null;
  }
  return decimal.toFixed();
}

function readNonNegative(value: unknown, counter?: { invalid: number }) {
  return readQuantity(value, counter);
}

function readPositive(value: unknown) {
  return readPrice(value);
}

function toDecimal(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Prisma.Decimal(value) : null;
  }
  if (
    typeof value === 'string' &&
    value.length <= 64 &&
    /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/u.test(value.trim())
  ) {
    const decimal = new Prisma.Decimal(value.trim());
    return decimal.isFinite() ? decimal : null;
  }
  return null;
}

function formatPrice(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(PRICE_DECIMALS).toFixed();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
