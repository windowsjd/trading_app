import { Prisma } from '../../generated/prisma/client';

export const LIMIT_ORDER_CANDLE_INTERVAL = '5m' as const;
export const FIVE_MINUTES_MS = 5 * 60_000;

/**
 * First closed 5-minute window a newly submitted order may be filled from.
 *
 * The candle that is already running when an order is submitted is NOT usable:
 * its low may have been printed before the order existed, and a 5m bar carries
 * no information about WHEN inside the window the low happened. So the
 * boundary is rounded UP to the next 5-minute boundary, and an order submitted
 * exactly on a boundary may use the window that starts at that instant.
 *
 *   10:00:00.000 -> 10:00   (the whole 10:00-10:05 window is after submission)
 *   10:00:00.001 -> 10:05
 *   10:02:30.000 -> 10:05
 *   10:04:59.999 -> 10:05
 */
export function calculateCandleMatchingEligibleFrom(submittedAt: Date): Date {
  const ms = submittedAt.getTime();
  const remainder =
    ((ms % FIVE_MINUTES_MS) + FIVE_MINUTES_MS) % FIVE_MINUTES_MS;
  return new Date(remainder === 0 ? ms : ms + (FIVE_MINUTES_MS - remainder));
}

export type CanonicalCandleRow = {
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  isClosed: boolean;
  sourceProvider: string;
  sourceUpdatedAt: Date;
};

export type CanonicalCandleCheck =
  | { ok: true }
  | { ok: false; reason: string; permanent: boolean };

/**
 * Structural validation of a stored candle before it may trigger a fill.
 *
 * This deliberately mirrors the finalizer's own acceptance rules
 * (LiveCandleFinalizerService.isStrictlyValid + the closed/complete gate)
 * rather than inventing a second, subtly different notion of "canonical".
 * The finalizer never persists an incomplete or discontinuous 5m row — it
 * defers those buckets to REST repair — so a row that is present, closed and
 * structurally consistent IS the canonical candle. Live Redis state, open
 * candles, REST previews, chart fallbacks and cached overlays are never read
 * here: path B only ever reads committed MarketCandle rows.
 */
export function checkCanonicalClosedCandle(
  candle: CanonicalCandleRow,
): CanonicalCandleCheck {
  if (candle.interval !== LIMIT_ORDER_CANDLE_INTERVAL) {
    return reject('candle_interval_unsupported');
  }
  if (!candle.isClosed) return reject('candle_not_closed');
  if (
    !(candle.openTime instanceof Date) ||
    !(candle.closeTime instanceof Date) ||
    Number.isNaN(candle.openTime.getTime()) ||
    Number.isNaN(candle.closeTime.getTime())
  ) {
    return reject('candle_window_invalid');
  }
  if (candle.closeTime.getTime() <= candle.openTime.getTime()) {
    return reject('candle_window_invalid');
  }
  if (
    candle.closeTime.getTime() - candle.openTime.getTime() !==
    FIVE_MINUTES_MS
  ) {
    return reject('candle_window_not_five_minutes');
  }
  if (candle.openTime.getTime() % FIVE_MINUTES_MS !== 0) {
    return reject('candle_window_unaligned');
  }
  const values = [candle.open, candle.high, candle.low, candle.close];
  if (values.some((value) => !value.isFinite() || value.lte(0))) {
    return reject('candle_price_not_positive');
  }
  if (
    candle.low.gt(candle.open) ||
    candle.low.gt(candle.close) ||
    candle.low.gt(candle.high) ||
    candle.high.lt(candle.open) ||
    candle.high.lt(candle.close)
  ) {
    return reject('candle_ohlc_inconsistent');
  }
  const provider = candle.sourceProvider.trim();
  if (!provider) return reject('candle_source_missing');
  if (!provider.startsWith('binance') && !provider.startsWith('kis')) {
    return reject('candle_source_unsupported');
  }
  if (
    !(candle.sourceUpdatedAt instanceof Date) ||
    Number.isNaN(candle.sourceUpdatedAt.getTime())
  ) {
    return reject('candle_source_updated_at_invalid');
  }
  return { ok: true };
}

function reject(reason: string): CanonicalCandleCheck {
  // Everything checked here is a property of the immutable stored row, so a
  // rejection can never become acceptable on a later tick.
  return { ok: false, reason, permanent: true };
}
