import type { Prisma } from '../../generated/prisma/client';

export const BINANCE_CANDLE_SOURCE = 'binance_klines';
// /api/v3/klines caps a single response at 1000 rows.
export const BINANCE_KLINES_MAX_LIMIT = 1000;

export type BinanceCandleInterval = '5m' | '1d' | '1w';

export const BINANCE_CANDLE_INTERVAL_MS: Record<BinanceCandleInterval, number> =
  {
    '5m': 5 * 60_000,
    '1d': 24 * 60 * 60_000,
    '1w': 7 * 24 * 60 * 60_000,
  };

export type BinanceCandlePageInput = {
  symbol: string;
  interval: BinanceCandleInterval;
  // Half-open UTC target range [from, to).
  from: Date;
  to: Date;
  // Forward cursor; when omitted the page starts at `from`.
  cursor?: { startTime: number } | null;
  now?: Date;
  limit?: number;
};

export type BinanceCandlePageStopReason =
  | 'target_reached'
  | 'provider_exhausted'
  | 'empty_page'
  | 'cursor_not_advanced'
  | 'malformed_response';

export type CanonicalBinanceCandle = {
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  // Quote-asset volume (kline field index 7).
  amount: Prisma.Decimal | null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

export type BinanceCandlePageResult = {
  candles: CanonicalBinanceCandle[];
  providerReturnedRows: number;
  acceptedRows: number;
  rejectedRows: number;
  duplicateRows: number;
  // Non-null while more pages may exist; strictly greater than the previous
  // cursor so the pagination always moves forward.
  nextCursor: { startTime: number } | null;
  // Set when nextCursor is null (the feed terminated on this page).
  stopReason: BinanceCandlePageStopReason | null;
  // True when the target range was fully swept (last kline reaches `to`).
  complete: boolean;
};

export class BinanceCandleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BinanceCandleInputError';
  }
}
