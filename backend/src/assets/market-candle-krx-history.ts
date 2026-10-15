import { Prisma } from '../generated/prisma/client';
import type { MarketSessionWindow } from '../orders/market-calendar.policy';
import { formatZonedCursor } from '../providers/kis/candles/kis-candle-time';

/**
 * Source name of KRX 4h rows built from verified KOSCOM 10-minute history.
 *
 * Date-attribution evidence for this source is SUPPLIER_DAILY_CORROBORATION_ONLY:
 * the 10-minute rows carry no date, so a session is attributed to its date only
 * because its aggregate O/H/L/C equals the same supplier's dated (`trdDd`)
 * daily bar — the provider date itself is never independently proven
 * (docs/investigations/2026-10-13-koscom-10m-date-quota, §4–5).
 */
export const KOSCOM_TEN_MINUTE_HISTORY_SOURCE = 'koscom_history_10m';

const KST = 'Asia/Seoul';
const TEN_MINUTES_MS = 10 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
// Same closing single-price auction length as candle-expected-slots.policy:
// the 10-minute bar ending at the close is the auction print — optional, and
// folded into the OHLCV when present.
const KRX_CLOSING_AUCTION_MS = 10 * 60_000;
// One request is one session (39 rows on a regular day); 100+ may be truncated.
const MAX_SESSION_ROWS = 99;

export type KrxTenMinuteRow = {
  /** END label: the row covers [label - 10m, label). */
  label: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: string;
};

export type KrxDailyReference = {
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
};

export type KrxFourHourBucketPlan = {
  openTime: Date;
  closeTime: Date;
  /** END labels that must be present for the bucket to be complete. */
  requiredLabels: number[];
  /** END labels that may exist (closing auction); folded in when present. */
  optionalLabels: number[];
};

export type KrxFourHourCandle = {
  openTime: Date;
  closeTime: Date;
  open: Prisma.Decimal;
  high: Prisma.Decimal;
  low: Prisma.Decimal;
  close: Prisma.Decimal;
  volume: Prisma.Decimal;
  amount: Prisma.Decimal;
  isClosed: true;
  sourceUpdatedAt: Date;
};

export type KrxComparableCandle = {
  openTime: Date;
  open: Prisma.Decimal | string;
  high: Prisma.Decimal | string;
  low: Prisma.Decimal | string;
  close: Prisma.Decimal | string;
  volume: Prisma.Decimal | string;
  amount: Prisma.Decimal | string | null;
};

export type KrxHoldReason =
  | 'NO_ROWS'
  | 'TOO_MANY_ROWS'
  | 'MALFORMED_ROWS'
  | 'CONFLICTING_DUPLICATE_ROWS'
  | 'OFF_GRID_ROWS'
  | 'MISSING_REQUIRED_ROWS'
  | 'DAILY_OHLC_MISMATCH'
  | 'REPEATED_ADJACENT_SESSION';

export type KrxVolumeRelation = 'equal' | 'session_less' | 'session_greater';

export type KrxSessionVerification =
  | {
      status: 'verified';
      candles: KrxFourHourCandle[];
      rowCount: number;
      auctionRowPresent: boolean;
      /** Recorded only: a volume difference never blocks a verified session. */
      volumeRelation: KrxVolumeRelation;
      duplicateRows: number;
    }
  | {
      status: 'held';
      reason: KrxHoldReason;
      detail: string;
    };

/**
 * The 4h buckets of one KRX session in 10-minute END-label terms, from the
 * actual calendar session (delayed opens and early closes included).
 *
 * Regular 09:00–15:30 day: 09:00–13:00 requires 09:10…13:00 (24 labels);
 * 13:00–15:30 requires 13:10…15:20 (14 labels) and allows 15:30 — the closing
 * auction window (close − 10m … close) — as an optional row.
 */
export function planKrxTenMinuteBuckets(
  session: MarketSessionWindow,
): KrxFourHourBucketPlan[] {
  const openMs = session.openTime.getTime();
  const closeMs = session.closeTime.getTime();
  const auctionStartMs = Math.max(openMs, closeMs - KRX_CLOSING_AUCTION_MS);
  const buckets: KrxFourHourBucketPlan[] = [];
  for (let start = openMs; start < closeMs; start += FOUR_HOURS_MS) {
    const end = Math.min(start + FOUR_HOURS_MS, closeMs);
    const requiredLabels: number[] = [];
    const optionalLabels: number[] = [];
    for (
      let label = start + TEN_MINUTES_MS;
      label <= end;
      label += TEN_MINUTES_MS
    ) {
      if (label - TEN_MINUTES_MS >= auctionStartMs) optionalLabels.push(label);
      else requiredLabels.push(label);
    }
    buckets.push({
      openTime: new Date(start),
      closeTime: new Date(end),
      requiredLabels,
      optionalLabels,
    });
  }
  return buckets;
}

/** A stored KRX 4h row as the long sync and the G4-H gate read it. */
export type StoredKrxCandle = KrxComparableCandle & {
  closeTime: Date;
  isClosed?: boolean;
  sourceProvider?: string;
};

/**
 * Closed `koscom_history_10m` rows by KST session date (YYYYMMDD), oldest
 * first. Other sources and unclosed rows never count toward a session.
 */
export function groupStoredKrxRows(
  rows: readonly StoredKrxCandle[],
): Map<string, StoredKrxCandle[]> {
  const bySession = new Map<string, StoredKrxCandle[]>();
  for (const row of rows) {
    if (row.sourceProvider !== KOSCOM_TEN_MINUTE_HISTORY_SOURCE) continue;
    if (row.isClosed === false) continue;
    const date = formatZonedCursor(row.openTime, KST).date;
    const list = bySession.get(date) ?? [];
    list.push(row);
    bySession.set(date, list);
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  }
  return bySession;
}

/** The session's grouped rows are exactly its planned 4h buckets. */
export function isStoredKrxSessionComplete(
  session: MarketSessionWindow,
  stored: Map<string, StoredKrxCandle[]>,
): boolean {
  const rows = stored.get(session.localDate.replaceAll('-', '')) ?? [];
  const planned = planKrxTenMinuteBuckets(session);
  return (
    rows.length === planned.length &&
    planned.every(
      (bucket, index) =>
        rows[index].openTime.getTime() === bucket.openTime.getTime() &&
        rows[index].closeTime.getTime() === bucket.closeTime.getTime(),
    )
  );
}

/**
 * Verifies one session of KOSCOM 10-minute rows and builds its 4h candles.
 *
 * Fail-closed, in order: no rows / possible truncation / unparsable rows /
 * conflicting duplicates / any label off the session's 10-minute END grid /
 * a missing required row / aggregate O/H/L/C not EXACTLY equal to the dated
 * daily bar / the same 4h result as the previous session. Nothing is ever
 * interpolated or split into 5-minute rows. A volume difference against the
 * daily bar is recorded, not rejected (after-hours volume is plausible).
 */
export function verifyKrxTenMinuteSession(input: {
  session: MarketSessionWindow;
  rows: readonly KrxTenMinuteRow[];
  invalidRows: number;
  daily: KrxDailyReference;
  receivedAt: Date;
  previousSessionCandles?: readonly KrxComparableCandle[] | null;
}): KrxSessionVerification {
  const held = (reason: KrxHoldReason, detail: string) =>
    ({ status: 'held', reason, detail }) as const;
  if (input.rows.length === 0 && input.invalidRows === 0) {
    return held('NO_ROWS', 'Provider returned no 10-minute rows.');
  }
  if (input.rows.length + input.invalidRows > MAX_SESSION_ROWS) {
    return held(
      'TOO_MANY_ROWS',
      `Provider returned ${input.rows.length + input.invalidRows} rows; the session may be truncated.`,
    );
  }
  if (input.invalidRows > 0) {
    return held(
      'MALFORMED_ROWS',
      `${input.invalidRows} row(s) had an unparsable time or invalid OHLCV.`,
    );
  }

  const byLabel = new Map<number, KrxTenMinuteRow>();
  let duplicateRows = 0;
  for (const row of input.rows) {
    const key = row.label.getTime();
    const existing = byLabel.get(key);
    if (existing) {
      duplicateRows += 1;
      if (!sameRow(existing, row)) {
        return held(
          'CONFLICTING_DUPLICATE_ROWS',
          `Two different rows share one 10-minute label.`,
        );
      }
      continue;
    }
    byLabel.set(key, row);
  }

  const buckets = planKrxTenMinuteBuckets(input.session);
  const allowed = new Set<number>();
  for (const bucket of buckets) {
    for (const label of bucket.requiredLabels) allowed.add(label);
    for (const label of bucket.optionalLabels) allowed.add(label);
  }
  const offGrid = [...byLabel.keys()].filter((label) => !allowed.has(label));
  if (offGrid.length > 0) {
    return held(
      'OFF_GRID_ROWS',
      `${offGrid.length} row(s) fall outside the session's 10-minute END grid.`,
    );
  }
  const missing = buckets.reduce(
    (count, bucket) =>
      count +
      bucket.requiredLabels.filter((label) => !byLabel.has(label)).length,
    0,
  );
  if (missing > 0) {
    return held(
      'MISSING_REQUIRED_ROWS',
      `${missing} required 10-minute row(s) are missing; gaps are never interpolated.`,
    );
  }

  const ordered = [...byLabel.values()].sort(
    (left, right) => left.label.getTime() - right.label.getTime(),
  );
  const session = aggregate(ordered);
  const daily = {
    open: new Prisma.Decimal(input.daily.open),
    high: new Prisma.Decimal(input.daily.high),
    low: new Prisma.Decimal(input.daily.low),
    close: new Prisma.Decimal(input.daily.close),
    volume: new Prisma.Decimal(input.daily.volume),
  };
  if (
    !session.open.eq(daily.open) ||
    !session.high.eq(daily.high) ||
    !session.low.eq(daily.low) ||
    !session.close.eq(daily.close)
  ) {
    return held(
      'DAILY_OHLC_MISMATCH',
      'Aggregate O/H/L/C does not exactly match the dated daily bar; date attribution is unconfirmed.',
    );
  }

  const candles: KrxFourHourCandle[] = buckets.map((bucket) => {
    const startMs = bucket.openTime.getTime();
    const endMs = bucket.closeTime.getTime();
    const constituents = ordered.filter((row) => {
      const label = row.label.getTime();
      return label > startMs && label <= endMs;
    });
    const value = aggregate(constituents);
    return {
      openTime: bucket.openTime,
      closeTime: bucket.closeTime,
      ...value,
      isClosed: true as const,
      sourceUpdatedAt: input.receivedAt,
    };
  });

  if (
    input.previousSessionCandles &&
    sameFourHourResult(input.previousSessionCandles, candles)
  ) {
    return held(
      'REPEATED_ADJACENT_SESSION',
      'The 4h result equals the previous session; a re-returned previous session cannot be told apart.',
    );
  }

  const auctionLabels = new Set(buckets.flatMap((b) => b.optionalLabels));
  return {
    status: 'verified',
    candles,
    rowCount: ordered.length,
    auctionRowPresent: ordered.some((row) =>
      auctionLabels.has(row.label.getTime()),
    ),
    volumeRelation: session.volume.eq(daily.volume)
      ? 'equal'
      : session.volume.lt(daily.volume)
        ? 'session_less'
        : 'session_greater',
    duplicateRows,
  };
}

/** True when every 4h bucket repeats the other session's OHLCV and amount. */
export function sameFourHourResult(
  left: readonly KrxComparableCandle[],
  right: readonly KrxComparableCandle[],
): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((candle, index) => {
    const other = right[index];
    return (
      equalDecimal(candle.open, other.open) &&
      equalDecimal(candle.high, other.high) &&
      equalDecimal(candle.low, other.low) &&
      equalDecimal(candle.close, other.close) &&
      equalDecimal(candle.volume, other.volume) &&
      equalDecimal(candle.amount ?? '0', other.amount ?? '0')
    );
  });
}

function aggregate(rows: readonly KrxTenMinuteRow[]) {
  let high = new Prisma.Decimal(rows[0].high);
  let low = new Prisma.Decimal(rows[0].low);
  let volume = new Prisma.Decimal(0);
  let amount = new Prisma.Decimal(0);
  for (const row of rows) {
    const rowHigh = new Prisma.Decimal(row.high);
    const rowLow = new Prisma.Decimal(row.low);
    if (rowHigh.gt(high)) high = rowHigh;
    if (rowLow.lt(low)) low = rowLow;
    volume = volume.add(row.volume);
    amount = amount.add(row.amount);
  }
  return {
    open: new Prisma.Decimal(rows[0].open),
    high,
    low,
    close: new Prisma.Decimal(rows[rows.length - 1].close),
    volume,
    amount,
  };
}

function sameRow(left: KrxTenMinuteRow, right: KrxTenMinuteRow): boolean {
  return (
    equalDecimal(left.open, right.open) &&
    equalDecimal(left.high, right.high) &&
    equalDecimal(left.low, right.low) &&
    equalDecimal(left.close, right.close) &&
    equalDecimal(left.volume, right.volume) &&
    equalDecimal(left.amount, right.amount)
  );
}

function equalDecimal(
  left: Prisma.Decimal | string,
  right: Prisma.Decimal | string,
): boolean {
  return new Prisma.Decimal(left).eq(right);
}
