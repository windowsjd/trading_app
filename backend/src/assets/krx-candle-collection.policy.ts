import {
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { hasEffectiveMarketCalendarForDate } from '../orders/market-holidays.config';
import { resolveRequiredFiveMinuteSlotEndMs } from './candle-expected-slots.policy';

/**
 * Pure rules of the central KRX candle collection (design v2.1 §4.2).
 *
 * Required slots are the existing aggregation-completeness definition
 * (candle-expected-slots.policy): the 5-minute grid of `[open, close − 10m)`;
 * the 10-minute closing auction is never required. A slot is CLOSED once
 * `slotStart + 5m ≤ now` — only closed required slots ever need proof.
 */
export const FIVE_MINUTES_MS = 5 * 60_000;
const KST_OFFSET_MS = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** One intraday minute request covers ≤ 95 minutes (the adapter page). */
export const KRX_INTRADAY_WINDOW_MS = 90 * 60_000;

/** Coverage reach of the gap [fromMs, toMs): see findCandleCoverage. */
export type CoverageBridge = (fromMs: number, toMs: number) => number;

export function kstDate(ms: number): string {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstDayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00+09:00`);
}

/**
 * KRX sessions whose local trading date lies in [date(from), date(to − 1)],
 * oldest first. Null when any of those dates has no calendar coverage — the
 * caller must then fail closed (never treat an unknown day as a holiday).
 */
export function krxSessionsBetween(
  fromMs: number,
  toMs: number,
): MarketSessionWindow[] | null {
  if (!(toMs > fromMs)) return [];
  const sessions: MarketSessionWindow[] = [];
  for (let day = kstDayStartMs(kstDate(fromMs)); day < toMs; day += DAY_MS) {
    const date = kstDate(day);
    if (!hasEffectiveMarketCalendarForDate('KRX', date)) return null;
    const session = resolveMarketSession('KRX', date.replace(/-/gu, ''));
    if (session) sessions.push(session);
  }
  return sessions;
}

export function requiredFiveMinuteSlotStarts(
  session: MarketSessionWindow,
): number[] {
  const slots: number[] = [];
  const end = resolveRequiredFiveMinuteSlotEndMs(session);
  for (let s = session.openTime.getTime(); s < end; s += FIVE_MINUTES_MS)
    slots.push(s);
  return slots;
}

/**
 * KRX 5m holiday bridge (design v2.1 §4.2 rule 7): a gap of the coverage
 * union is "connected" as far as it contains no CLOSED required slot.
 * Returns the reach: `toMs` when the whole gap holds no closed required slot,
 * else the start of the first such slot (never before `fromMs`). Weekends,
 * holidays, nights, the closing auction and the still-open current bucket
 * are bridged; a missing minute bar of a closed required slot never is.
 * Unknown calendar dates bridge nothing (fail closed).
 */
export function krxFiveMinuteBridge(nowMs: number): CoverageBridge {
  return (fromMs, toMs) => {
    if (!(toMs > fromMs)) return toMs;
    // A slot starting up to 5 minutes before `fromMs` still overlaps the gap.
    const sessions = krxSessionsBetween(fromMs - FIVE_MINUTES_MS, toMs);
    if (sessions === null) return fromMs;
    for (const session of sessions)
      for (const slot of requiredFiveMinuteSlotStarts(session)) {
        if (slot + FIVE_MINUTES_MS > nowMs) break; // not closed yet
        if (slot < toMs && slot + FIVE_MINUTES_MS > fromMs)
          return Math.max(fromMs, slot);
      }
    return toMs;
  };
}

/**
 * KRX 1d holiday bridge (rule 7): a gap is connected as far as no session
 * close lies in `(from, min(to, now)]` — no confirmed daily bar can be
 * missing there. The reach stops at 00:00 KST of the first such session
 * date (where that day's daily candle window opens).
 */
export function krxDailyBridge(nowMs: number): CoverageBridge {
  return (fromMs, toMs) => {
    if (!(toMs > fromMs)) return toMs;
    const sessions = krxSessionsBetween(fromMs, toMs);
    if (sessions === null) return fromMs;
    const limit = Math.min(toMs, nowMs);
    for (const session of sessions) {
      const close = session.closeTime.getTime();
      if (close > fromMs && close <= limit)
        return Math.max(fromMs, kstDayStartMs(session.localDate));
    }
    return toMs;
  };
}

/** A checkpoint row as the planners read it (any status). */
export type KrxCheckpointRow = {
  mode: string;
  status: string;
  coverageComplete: boolean;
  targetFrom: Date;
  targetTo: Date;
  coveredFrom: Date | null;
  coveredTo: Date | null;
  createdAt: Date;
  /** Audited central run (not a proven-prefix claim): its phase, else null. */
  auditPhase: 'intraday' | 'repair' | null;
  /** The first unproven required slot a completed audited run found. */
  auditFirstMissingMs: number | null;
};

/** Merged confirmed coverage `[from, to)` intervals, oldest first. */
export function coverageIntervals(
  rows: readonly KrxCheckpointRow[],
): [number, number][] {
  const raw = rows
    .filter(
      (row) =>
        row.status === 'completed' &&
        row.coverageComplete &&
        row.coveredFrom !== null &&
        row.coveredTo !== null &&
        row.coveredFrom.getTime() < row.coveredTo.getTime(),
    )
    .map((row) => [row.coveredFrom!.getTime(), row.coveredTo!.getTime()])
    .sort((a, b) => a[0] - b[0]) as [number, number][];
  const merged: [number, number][] = [];
  for (const [from, to] of raw) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function isCovered(intervals: readonly [number, number][], slot: number) {
  return intervals.some(
    ([from, to]) => from <= slot && to >= slot + FIVE_MINUTES_MS,
  );
}

/**
 * Audited completed runs that found `slot` as their first unproven slot
 * (optionally only those of one phase). A run that never evaluated the slot
 * (it stopped at an earlier missing slot, or failed) is not an attempt.
 */
export function slotAttempts(
  rows: readonly KrxCheckpointRow[],
  slot: number,
  phase?: 'intraday' | 'repair',
): number {
  return rows.filter(
    (row) =>
      row.status === 'completed' &&
      row.auditPhase !== null &&
      (phase === undefined || row.auditPhase === phase) &&
      row.auditFirstMissingMs === slot,
  ).length;
}

export type KrxSessionSlotState = {
  /** Closed required slots of the session at/after A that are unproven. */
  unproven: number[];
  /** Unproven slots an audited run found missing at least twice. */
  held: number[];
  /** Contiguous confirmed coverage end from the session open (or A). */
  frontierMs: number;
};

/**
 * Proof state of one session's closed required slots (design §4.2 rules
 * 3–4). The obligation start A cuts the session: slots before it carry no
 * obligation. `rows` are the session's 5m checkpoints created at/after A.
 */
export function krxSessionSlotState(input: {
  session: MarketSessionWindow;
  nowMs: number;
  rows: readonly KrxCheckpointRow[];
  obligationStartMs: number;
}): KrxSessionSlotState {
  const intervals = coverageIntervals(input.rows);
  const startMs = Math.max(
    input.session.openTime.getTime(),
    input.obligationStartMs,
  );
  const bridge = krxFiveMinuteBridge(input.nowMs);
  // Contiguous reach from the session start, bridging non-required stretches.
  let frontierMs = startMs;
  for (const [from, to] of intervals) {
    if (to <= frontierMs) continue;
    if (from > frontierMs && bridge(frontierMs, from) < from) break;
    frontierMs = Math.max(frontierMs, to);
  }
  const unproven = requiredFiveMinuteSlotStarts(input.session).filter(
    (slot) =>
      slot >= startMs &&
      slot + FIVE_MINUTES_MS <= input.nowMs &&
      !isCovered(intervals, slot),
  );
  const held = unproven.filter((slot) => slotAttempts(input.rows, slot) >= 2);
  return { unproven, held, frontierMs };
}

/**
 * The single intraday request window of a tick (§4.2 rules 1–2, 4):
 * `from = floor5(max(F, now − 90 min, H))` where F is the contiguous
 * frontier and H the end of the latest held slot, `to = now`. Always one
 * provider page (≤ 95 minutes). Null when nothing is left to fetch.
 */
export function planKrxIntradayWindow(input: {
  session: MarketSessionWindow;
  nowMs: number;
  rows: readonly KrxCheckpointRow[];
  obligationStartMs: number;
}): { fromMs: number; toMs: number; state: KrxSessionSlotState } | null {
  const state = krxSessionSlotState(input);
  const heldEnd = state.held.length
    ? state.held[state.held.length - 1] + FIVE_MINUTES_MS
    : -Infinity;
  const toMs = Math.min(input.nowMs, input.session.closeTime.getTime());
  const fromMs =
    Math.floor(
      Math.max(
        state.frontierMs,
        input.nowMs - KRX_INTRADAY_WINDOW_MS,
        heldEnd,
      ) / FIVE_MINUTES_MS,
    ) * FIVE_MINUTES_MS;
  const boundedFrom = Math.max(
    fromMs,
    input.session.openTime.getTime(),
    input.obligationStartMs,
  );
  return boundedFrom < toMs ? { fromMs: boundedFrom, toMs, state } : null;
}

/**
 * Intraday tick instants of a session: every 5m bucket end (the last one
 * capped at the close) plus the publication delay (§4.2 rule 1, §3).
 */
export function krxIntradayTickTimes(
  session: MarketSessionWindow,
  delayMs: number,
): number[] {
  const ticks: number[] = [];
  const open = session.openTime.getTime();
  const close = session.closeTime.getTime();
  for (let end = open + FIVE_MINUTES_MS; ; end += FIVE_MINUTES_MS) {
    ticks.push(Math.min(end, close) + delayMs);
    if (end >= close) break;
  }
  return ticks;
}

/** Post-close phases after the close (design v2.1 §3: 15:40 / 15:50 / 16:30 / 18:00). */
export const KRX_POST_CLOSE_PHASES = [
  { offsetMs: 10 * 60_000, phase: 'repair' },
  { offsetMs: 20 * 60_000, phase: 'daily' },
  { offsetMs: 40 * 60_000, phase: 'repair' },
  { offsetMs: 60 * 60_000, phase: 'daily' },
  { offsetMs: 150 * 60_000, phase: 'daily' },
] as const;

/**
 * Pre-open daily re-read (2026-10-18): 30 min before each session's open the
 * daily phase re-reads the PREVIOUS session's dated KOSCOM daily bar. The
 * latest session's KOSCOM daily is provisional — after the close it tracks
 * the integrated after-market (NXT, to 20:00) last price, not the 15:30
 * closing-auction close (10-16: 217,000 vs 215,500; unchanged through 10-17
 * 18:11 KST) — while 10-15's bar read at 06:33 KST on 10-16 already was the
 * KRX close. The post-close phases run before 20:00, so without this re-read
 * a provisional close would stay stored.
 */
export const KRX_PRE_OPEN_DAILY_OFFSET_MS = 30 * 60_000;

export type KrxCentralPhase = 'intraday' | 'repair' | 'daily';

/**
 * The next central-collection instant strictly after `nowMs`, scanning the
 * calendar up to `lookaheadDays`. Null without calendar coverage.
 */
export function nextKrxCentralRun(
  nowMs: number,
  delayMs: number,
  lookaheadDays = 10,
): {
  atMs: number;
  phase: KrxCentralPhase;
  session: MarketSessionWindow;
} | null {
  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const date = kstDate(nowMs + offset * DAY_MS);
    if (!hasEffectiveMarketCalendarForDate('KRX', date)) return null;
    const session = resolveMarketSession('KRX', date.replace(/-/gu, ''));
    if (!session) continue;
    const runs: { atMs: number; phase: KrxCentralPhase }[] = [
      {
        atMs: session.openTime.getTime() - KRX_PRE_OPEN_DAILY_OFFSET_MS,
        phase: 'daily' as const,
      },
      ...krxIntradayTickTimes(session, delayMs).map((atMs) => ({
        atMs,
        phase: 'intraday' as const,
      })),
      ...KRX_POST_CLOSE_PHASES.map((entry) => ({
        atMs: session.closeTime.getTime() + entry.offsetMs,
        phase: entry.phase,
      })),
    ].sort((a, b) => a.atMs - b.atMs);
    const next = runs.find((run) => run.atMs > nowMs);
    if (next) return { ...next, session };
  }
  return null;
}

/**
 * The closing single-price auction window `[close − 10m, close)` of a KRX
 * session (2026-10-18). Its 5m buckets are never REQUIRED slots — candle
 * completeness is unchanged — but they are the session's KRX close
 * evidence: the last one ends with the closing-auction print that the
 * closed-market display shows. KOSCOM publishes that print minutes after the
 * close (10-16: the 15:20 bucket was stored at 15:31 KST, the 15:25 bucket
 * only at 15:42), so the close + delay tick usually misses it and the
 * post-close repair requests it instead.
 */
export function krxClosingAuctionWindow(session: MarketSessionWindow): {
  fromMs: number;
  toMs: number;
} {
  return {
    fromMs: resolveRequiredFiveMinuteSlotEndMs(session),
    toMs: session.closeTime.getTime(),
  };
}

/** At most this many post-close requests per session for the auction window. */
export const KRX_CLOSING_AUCTION_REPAIR_ATTEMPTS = 2;

/** Post-close repair runs that already requested exactly the auction window. */
export function closingAuctionAttempts(
  rows: readonly KrxCheckpointRow[],
  window: { fromMs: number; toMs: number },
  closeMs: number,
): number {
  return rows.filter(
    (row) =>
      row.auditPhase === 'repair' &&
      row.targetFrom.getTime() === window.fromMs &&
      row.targetTo.getTime() === window.toMs &&
      row.createdAt.getTime() >= closeMs,
  ).length;
}

/**
 * Post-close repair target of one asset (§4.2 rule 5): the first unproven
 * closed required slot that an audited post-close run has not already found
 * missing twice, extended over the following unproven slots up to one page.
 */
export function planKrxRepairWindow(input: {
  session: MarketSessionWindow;
  nowMs: number;
  rows: readonly KrxCheckpointRow[];
  obligationStartMs: number;
}): { fromMs: number; toMs: number } | null {
  const state = krxSessionSlotState(input);
  const candidates = state.unproven.filter(
    (slot) => slotAttempts(input.rows, slot, 'repair') < 2,
  );
  if (candidates.length === 0) return null;
  const fromMs = candidates[0];
  let toMs = fromMs + FIVE_MINUTES_MS;
  for (const slot of state.unproven) {
    if (slot < toMs) continue;
    if (
      slot !== toMs ||
      slot + FIVE_MINUTES_MS - fromMs > KRX_INTRADAY_WINDOW_MS
    )
      break;
    toMs = slot + FIVE_MINUTES_MS;
  }
  return { fromMs, toMs };
}
