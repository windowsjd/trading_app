import {
  isBookSequence,
  isRecord,
  parseBookLevels,
  type OrderBookLevel,
} from '../order-book.types';

export type BinanceDepthResult =
  | { state: 'other' }
  | { state: 'invalid'; reason: string }
  | {
      state: 'depth';
      symbol: string;
      sequence: string;
      asks: OrderBookLevel[];
      bids: OrderBookLevel[];
    };

/** Partial depth lacks s/e/E. Only its combined stream name identifies it. */
export function parseBinanceDepth(frame: string): BinanceDepthResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(frame);
  } catch {
    return { state: 'other' };
  }
  if (!isRecord(envelope)) return { state: 'other' };
  const raw = isRecord(envelope.data) ? envelope.data : envelope;
  const stream = typeof envelope.stream === 'string' ? envelope.stream : '';
  if (!stream.includes('@depth') && !('lastUpdateId' in raw))
    return { state: 'other' };
  const match = /^([a-z0-9]+usdt)@depth10$/u.exec(stream);
  if (!match || raw === envelope)
    return { state: 'invalid', reason: 'INVALID_DEPTH_STREAM' };
  const sequence =
    typeof raw.lastUpdateId === 'number' &&
    Number.isSafeInteger(raw.lastUpdateId) &&
    raw.lastUpdateId >= 0
      ? String(raw.lastUpdateId)
      : raw.lastUpdateId;
  if (!isBookSequence(sequence))
    return { state: 'invalid', reason: 'INVALID_DEPTH_SEQUENCE' };
  const asks = parseTuples(raw.asks, 'asks');
  const bids = parseTuples(raw.bids, 'bids');
  if (!asks || !bids)
    return { state: 'invalid', reason: 'INVALID_DEPTH_LEVELS' };
  return {
    state: 'depth',
    symbol: match[1].toUpperCase(),
    sequence,
    asks,
    bids,
  };
}

function parseTuples(
  value: unknown,
  side: 'asks' | 'bids',
): OrderBookLevel[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const tuples = value as unknown[];
  if (tuples.some((row) => !Array.isArray(row) || row.length !== 2))
    return null;
  return parseBookLevels(
    tuples.map((row) => {
      const tuple = row as unknown[];
      return { price: tuple[0], quantity: tuple[1] };
    }),
    side,
  );
}

/** Preserve configured host/query options while requesting combined envelopes. */
export function binanceCombinedStreamUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, '').replace(/\/(?:ws|stream)$/u, '')}/stream`;
  return url.toString();
}
