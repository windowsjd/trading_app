import { Prisma } from '../../generated/prisma/client';
import type { CanonicalSyncCandle } from '../../assets/market-candle-sync.types';
import {
  resolveMarketSession,
  type MarketSessionWindow,
} from '../../orders/market-calendar.policy';
import { hasEffectiveMarketCalendarForDate } from '../../orders/market-holidays.config';
import type { TiingoDailyBar, TiingoIntradayBar } from './tiingo.parser';

/**
 * Pure normalization of Tiingo REST bars into stored US `market_candles`
 * rows (official mode, 2026-10-17; policy-decisions "Tiingo 미국주식 정식
 * 공급자"). Only real provider bars are stored: no interpolation, no copied
 * bar for a quiet interval, no synthesized volume.
 *
 *  - 5m: Tiingo equity intraday bars (`date` = bar start) inside the regular
 *    New York session of the exchange calendar, final once their window has
 *    ended plus a settle margin. Pre-/after-market bars are never stored.
 *  - 1d: Tiingo end-of-day RAW OHLCV (never `adj*`) on the same daily window
 *    as every stored US daily row (local midnight → next local midnight).
 *  - 1w: composed from those raw daily rows, only for a closed week whose
 *    every calendar session has its daily row (Monday-anchored, as stored).
 */

export const TIINGO_FIVE_MINUTES_MS = 5 * 60_000;
/** A 5-minute bar is stored once its window ended this long ago. */
export const TIINGO_BAR_SETTLE_MS = 2 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** A stored 1d/1w window: [openTime, closeTime), closed after `closedAt`. */
export type TiingoPeriodWindow = {
  openTime: Date;
  closeTime: Date;
  closedAt: Date;
};

export type TiingoCandleNormalization = {
  candles: CanonicalSyncCandle[];
  accepted: number;
  rejected: number;
  /** Outside the requested range or the regular session (never stored). */
  outside: number;
  /** Not yet final (the current or just-ended 5m window). */
  notFinal: number;
};

/**
 * US sessions whose New York trading date lies in [date(from), date(to − 1)],
 * oldest first. Null when any of those dates has no calendar coverage — an
 * unknown day is never treated as a holiday.
 */
export function usSessionsBetween(
  fromMs: number,
  toMs: number,
): MarketSessionWindow[] | null {
  if (!(toMs > fromMs)) return [];
  const sessions: MarketSessionWindow[] = [];
  const last = newYorkDate(toMs - 1);
  for (
    let date: string | null = newYorkDate(fromMs);
    date !== null && date <= last;
    date = nextDate(date)
  ) {
    if (!hasEffectiveMarketCalendarForDate('US', date)) return null;
    const session = resolveMarketSession('US', date.replace(/-/gu, ''));
    if (session) sessions.push(session);
  }
  return sessions;
}

export function normalizeTiingoFiveMinuteBars(input: {
  bars: readonly TiingoIntradayBar[];
  sessions: readonly MarketSessionWindow[];
  from: Date;
  to: Date;
  receivedAt: Date;
}): TiingoCandleNormalization {
  const result = emptyResult();
  for (const bar of input.bars) {
    const openMs = bar.openTime.getTime();
    const closeMs = openMs + TIINGO_FIVE_MINUTES_MS;
    if (openMs % TIINGO_FIVE_MINUTES_MS !== 0) {
      result.rejected += 1;
      continue;
    }
    const regular = input.sessions.some(
      (session) =>
        openMs >= session.openTime.getTime() &&
        closeMs <= session.closeTime.getTime(),
    );
    if (
      !regular ||
      openMs < input.from.getTime() ||
      openMs >= input.to.getTime()
    ) {
      result.outside += 1;
      continue;
    }
    if (closeMs + TIINGO_BAR_SETTLE_MS > input.receivedAt.getTime()) {
      result.notFinal += 1;
      continue;
    }
    // Volume is part of a stored bar; a bar without it is not invented.
    if (bar.volume === null) {
      result.rejected += 1;
      continue;
    }
    result.accepted += 1;
    result.candles.push({
      openTime: new Date(openMs),
      closeTime: new Date(closeMs),
      ...ohlcv(bar.open, bar.high, bar.low, bar.close, bar.volume),
      amount: null,
      isClosed: true,
      sourceUpdatedAt: input.receivedAt,
    });
  }
  return result;
}

/** Regular sessions inside [from, to) that are over and got no 5m bar at all. */
export function sessionsWithoutBars(input: {
  candles: readonly CanonicalSyncCandle[];
  sessions: readonly MarketSessionWindow[];
  from: Date;
  to: Date;
  receivedAt: Date;
}): string[] {
  return input.sessions
    .filter(
      (session) =>
        session.openTime.getTime() >= input.from.getTime() &&
        session.closeTime.getTime() <= input.to.getTime() &&
        session.closeTime.getTime() + TIINGO_BAR_SETTLE_MS <=
          input.receivedAt.getTime() &&
        !input.candles.some(
          (candle) =>
            candle.openTime.getTime() >= session.openTime.getTime() &&
            candle.openTime.getTime() < session.closeTime.getTime(),
        ),
    )
    .map((session) => session.localDate);
}

export function normalizeTiingoDailyBars(input: {
  bars: readonly TiingoDailyBar[];
  /** The stored 1d window of a New York trading date (`YYYYMMDD`). */
  windowFor: (date: string) => TiingoPeriodWindow | null;
  from: Date;
  to: Date;
  receivedAt: Date;
}): TiingoCandleNormalization & { dates: string[] } {
  const result = { ...emptyResult(), dates: [] as string[] };
  for (const bar of input.bars) {
    const window = input.windowFor(bar.date.replace(/-/gu, ''));
    // A provider row on a date our calendar has no session for is refused.
    if (!window || bar.volume === null) {
      result.rejected += 1;
      continue;
    }
    if (
      window.openTime.getTime() < input.from.getTime() ||
      window.openTime.getTime() >= input.to.getTime()
    ) {
      result.outside += 1;
      continue;
    }
    if (window.closedAt.getTime() > input.receivedAt.getTime()) {
      result.notFinal += 1;
      continue;
    }
    result.accepted += 1;
    result.dates.push(bar.date);
    result.candles.push({
      openTime: window.openTime,
      closeTime: window.closeTime,
      // RAW values only; adjusted fields stay out of stored candles.
      ...ohlcv(bar.open, bar.high, bar.low, bar.close, bar.volume),
      amount: null,
      isClosed: true,
      sourceUpdatedAt: input.receivedAt,
    });
  }
  return result;
}

/**
 * Weekly rows from raw daily rows. A week is stored only when it is over and
 * every calendar session of it has its daily row; otherwise it is skipped
 * (counted), never filled.
 */
export function composeTiingoWeeklyCandles(input: {
  daily: ReadonlyArray<{ date: string; candle: CanonicalSyncCandle }>;
  /** The stored 1w window containing a trading date (`YYYYMMDD`). */
  weekFor: (date: string) => TiingoPeriodWindow | null;
  /** Calendar session dates (`YYYY-MM-DD`) inside a week window. */
  sessionDatesOf: (week: TiingoPeriodWindow) => string[] | null;
  from: Date;
  to: Date;
  receivedAt: Date;
}): TiingoCandleNormalization & { incompleteWeeks: number } {
  const result = { ...emptyResult(), incompleteWeeks: 0 };
  const weeks = new Map<
    number,
    {
      window: TiingoPeriodWindow;
      rows: Array<{ date: string; candle: CanonicalSyncCandle }>;
    }
  >();
  for (const row of input.daily) {
    const window = input.weekFor(row.date.replace(/-/gu, ''));
    if (!window) {
      result.rejected += 1;
      continue;
    }
    const key = window.openTime.getTime();
    const entry = weeks.get(key) ?? { window, rows: [] };
    entry.rows.push(row);
    weeks.set(key, entry);
  }
  for (const { window, rows } of [...weeks.values()].sort(
    (a, b) => a.window.openTime.getTime() - b.window.openTime.getTime(),
  )) {
    if (
      window.openTime.getTime() < input.from.getTime() ||
      window.openTime.getTime() >= input.to.getTime()
    ) {
      result.outside += 1;
      continue;
    }
    if (window.closedAt.getTime() > input.receivedAt.getTime()) {
      result.notFinal += 1;
      continue;
    }
    const expected = input.sessionDatesOf(window);
    const have = new Set(rows.map((row) => row.date));
    if (
      !expected ||
      expected.length === 0 ||
      !expected.every((date) => have.has(date))
    ) {
      result.incompleteWeeks += 1;
      continue;
    }
    const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const decimals = (pick: (candle: CanonicalSyncCandle) => unknown) =>
      ordered.map((row) => new Prisma.Decimal(String(pick(row.candle))));
    result.accepted += 1;
    result.candles.push({
      openTime: window.openTime,
      closeTime: window.closeTime,
      open: new Prisma.Decimal(String(ordered[0].candle.open)),
      high: Prisma.Decimal.max(...decimals((candle) => candle.high)),
      low: Prisma.Decimal.min(...decimals((candle) => candle.low)),
      close: new Prisma.Decimal(
        String(ordered[ordered.length - 1].candle.close),
      ),
      volume: decimals((candle) => candle.volume).reduce(
        (sum, value) => sum.add(value),
        new Prisma.Decimal(0),
      ),
      amount: null,
      isClosed: true,
      sourceUpdatedAt: input.receivedAt,
    });
  }
  return result;
}

/**
 * Start of the first regular 5m slot of these sessions that is not settled at
 * `receivedAt` (its bar would not be stored yet), or null when every slot is
 * settled — e.g. after the close, when nothing can still be pending.
 */
export function firstUnsettledSlotStart(
  sessions: readonly MarketSessionWindow[],
  receivedAt: Date,
): number | null {
  const settledUntil = receivedAt.getTime() - TIINGO_BAR_SETTLE_MS;
  for (const session of sessions)
    for (
      let slot = session.openTime.getTime();
      slot + TIINGO_FIVE_MINUTES_MS <= session.closeTime.getTime();
      slot += TIINGO_FIVE_MINUTES_MS
    )
      if (slot + TIINGO_FIVE_MINUTES_MS > settledUntil) return slot;
  return null;
}

function ohlcv(
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
) {
  return {
    open: new Prisma.Decimal(open),
    high: new Prisma.Decimal(high),
    low: new Prisma.Decimal(low),
    close: new Prisma.Decimal(close),
    volume: new Prisma.Decimal(volume),
  };
}

function emptyResult(): TiingoCandleNormalization {
  return { candles: [], accepted: 0, rejected: 0, outside: 0, notFinal: 0 };
}

/** New York calendar date (`YYYY-MM-DD`) of an instant. */
export function newYorkDate(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nextDate(date: string): string | null {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(ms)
    ? new Date(ms + DAY_MS).toISOString().slice(0, 10)
    : null;
}
