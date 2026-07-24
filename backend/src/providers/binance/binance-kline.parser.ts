import { Prisma } from '../../generated/prisma/client';

export type BinanceFiveMinuteKline = {
  symbol: string;
  eventTime: Date;
  openTime: Date;
  closeTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  final: boolean;
  firstTradeId: number;
  lastTradeId: number;
  tradeCount: number;
  eventId: string;
  sequence: string;
};

export type BinanceKlineParseResult =
  | { state: 'kline'; kline: BinanceFiveMinuteKline }
  | { state: 'ack' }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string; message: string };

const FIVE_MINUTES_MS = 5 * 60_000;

export function parseBinanceFiveMinuteKline(
  frame: string,
): BinanceKlineParseResult {
  let payload: unknown;
  try {
    payload = JSON.parse(frame) as unknown;
  } catch {
    return failed('INVALID_JSON', 'Binance kline frame is invalid JSON.');
  }
  if (!payload || typeof payload !== 'object') {
    return failed(
      'INVALID_PAYLOAD',
      'Binance kline payload must be an object.',
    );
  }
  const envelope = payload as Record<string, unknown>;
  const raw =
    envelope.data && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>)
      : envelope;
  if (
    typeof raw.code === 'number' &&
    typeof raw.msg === 'string' &&
    'id' in raw
  ) {
    return failed(
      'BINANCE_SUBSCRIPTION_FAILED',
      'Binance rejected the kline subscription request.',
    );
  }
  if ('result' in raw && 'id' in raw) return { state: 'ack' };
  if (raw.e !== 'kline') {
    return { state: 'skipped', reason: 'UNSUPPORTED_EVENT_TYPE' };
  }
  if (!raw.k || typeof raw.k !== 'object') {
    return failed('INVALID_KLINE', 'Binance kline body is missing.');
  }

  try {
    const kline = raw.k as Record<string, unknown>;
    const symbol = requiredString(kline.s ?? raw.s, 's').toUpperCase();
    const interval = requiredString(kline.i, 'i');
    if (interval !== '5m') throw new Error('i must be 5m.');
    const eventTimeMs = integer(raw.E, 'E');
    const openTimeMs = integer(kline.t, 'k.t');
    const inclusiveCloseMs = integer(kline.T, 'k.T');
    if (
      openTimeMs % FIVE_MINUTES_MS !== 0 ||
      inclusiveCloseMs + 1 - openTimeMs !== FIVE_MINUTES_MS
    ) {
      throw new Error('kline bucket must be an aligned five-minute window.');
    }
    const open = positive(kline.o, 'k.o');
    const high = positive(kline.h, 'k.h');
    const low = positive(kline.l, 'k.l');
    const close = positive(kline.c, 'k.c');
    const volume = nonNegative(kline.v, 'k.v');
    const quoteVolume = nonNegative(kline.q, 'k.q');
    if (
      new Prisma.Decimal(high).lt(open) ||
      new Prisma.Decimal(high).lt(low) ||
      new Prisma.Decimal(high).lt(close) ||
      new Prisma.Decimal(low).gt(open) ||
      new Prisma.Decimal(low).gt(close)
    ) {
      throw new Error('kline OHLC values are inconsistent.');
    }
    const firstTradeId = integer(kline.f, 'k.f');
    const lastTradeId = integer(kline.L, 'k.L');
    const tradeCount = integer(kline.n, 'k.n');
    if (typeof kline.x !== 'boolean') throw new Error('k.x is required.');
    const sequence = `${eventTimeMs}:${lastTradeId}`;
    return {
      state: 'kline',
      kline: {
        symbol,
        eventTime: new Date(eventTimeMs),
        openTime: new Date(openTimeMs),
        closeTime: new Date(inclusiveCloseMs + 1),
        open,
        high,
        low,
        close,
        volume,
        quoteVolume,
        final: kline.x,
        firstTradeId,
        lastTradeId,
        tradeCount,
        eventId: `binance:${symbol}:${openTimeMs}:${sequence}:${kline.x ? '1' : '0'}`,
        sequence,
      },
    };
  } catch (error) {
    return failed(
      'INVALID_KLINE',
      error instanceof Error ? error.message : 'Invalid Binance kline.',
    );
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function integer(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return Number(value);
}

function positive(value: unknown, name: string): string {
  const result = decimal(value, name);
  if (new Prisma.Decimal(result).lte(0))
    throw new Error(`${name} must be positive.`);
  return result;
}

function nonNegative(value: unknown, name: string): string {
  const result = decimal(value, name);
  if (new Prisma.Decimal(result).lt(0)) {
    throw new Error(`${name} must be non-negative.`);
  }
  return result;
}

function decimal(value: unknown, name: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be a decimal.`);
  }
  try {
    const parsed = new Prisma.Decimal(value);
    if (!parsed.isFinite()) throw new Error();
    return parsed.toFixed(8);
  } catch {
    throw new Error(`${name} must be a decimal.`);
  }
}

function failed(reason: string, message: string): BinanceKlineParseResult {
  return { state: 'failed', reason, message };
}
