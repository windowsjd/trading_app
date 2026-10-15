import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { getCalendarDataset } from '../orders/market-calendar/market-calendar.registry';
import { hasEffectiveMarketCalendarForDate } from '../orders/market-holidays.config';
import { PrismaService } from '../prisma/prisma.service';
import { resolveKisDailyPeriodWindows } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import {
  KOSCOM_HISTORY_SOURCE,
  KOSCOM_MINUTE_SOURCE,
} from '../providers/koscom/koscom.config';
import {
  dailyCandleDefects,
  type DailyCandleWindow,
} from './daily-candle-evidence.policy';
import {
  FIVE_MINUTES_MS,
  kstDate,
  kstDayStartMs,
  krxDailyBridge,
  krxSessionSlotState,
  requiredFiveMinuteSlotStarts,
} from './krx-candle-collection.policy';
import {
  resolveKrxObligationStart,
  type KrxCentralCandlesConfig,
} from './krx-central-candles.config';
import { compactedFirstCreatedAt } from './krx-checkpoint-compaction.service';
import {
  KOSCOM_TEN_MINUTE_HISTORY_SOURCE,
  groupStoredKrxRows,
  isStoredKrxSessionComplete,
  planKrxTenMinuteBuckets,
  type StoredKrxCandle,
} from './market-candle-krx-history';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';

const DAY_MS = 24 * 60 * 60_000;
/** Post-close repair is over an hour after the close (§4.2 rule 5). */
const REPAIR_DONE_MS = 60 * 60_000;
export const G4I_MAX_DEFECT_RATE = 0.001;
/** The first-checkpoint search stays bounded however old A is. */
const FIRST_CHECKPOINT_SEARCH_MS = 14 * DAY_MS;
const DAILY_SESSIONS = 576;
const FOUR_HOUR_SESSIONS = 96;
/** Dates listed per defect kind; the counts are always complete. */
const SAMPLE_DATES = 20;
const INTRADAY_WINDOWS = [
  { interval: '5m', sessions: 3 },
  { interval: '15m', sessions: 6 },
  { interval: '30m', sessions: 12 },
  { interval: '1h', sessions: 24 },
] as const;

export type G4ISession = {
  sessionDate: string;
  obligated: number;
  held: number;
  /** Unproven closed required slots no held alert explains (must be 0). */
  concealed: number;
  unprovenSlots: string[];
};

export type G4IAsset = {
  assetId: string;
  symbol: string;
  obligationStart: string | null;
  sessions: G4ISession[];
  firstCheckpointAt: string | null;
  /** The first central tick after A plus one bucket (§12.4 G4-I). */
  firstTickDeadline: string | null;
  startedInTime: boolean | null;
};

export type G4IReport = {
  sessions: string[];
  assets: G4IAsset[];
  totals: {
    obligated: number;
    held: number;
    concealed: number;
    defectRate: number | null;
  };
  pass: {
    /**
     * Evidence exists: every stock has a recorded A and some slot is
     * obligated. Without it the other flags pass vacuously (an empty
     * registry measures nothing).
     */
    measured: boolean;
    concealmentZero: boolean;
    defectRateWithin: boolean;
    collectionStartedInTime: boolean;
  };
};

/** Session dates (YYYY-MM-DD, oldest first): the first few and the total. */
export type G4HDates = { count: number; dates: string[] };
export type G4HDefects = {
  count: number;
  sessions: { date: string; defects: string[] }[];
};

export type G4HDaily = {
  /** ready: §5.4's two conditions hold for every closed session. */
  state: 'ready' | 'incomplete';
  windowFrom: string | null;
  calendarAvailable: boolean;
  /**
   * KRX years in the window whose calendar is still provisional (not yet
   * audited against KRX's own notice, e.g. 2024 until Q14): sessions are
   * judged by it, so `ready` rests on that calendar.
   */
  provisionalCalendarYears: number[];
  /** ① complete checkpoints cover [windowFrom, now) (union + holiday bridge). */
  coverageComplete: boolean;
  /** ② closed calendar sessions in the window, each needing a confirmed bar. */
  sessionsExpected: number;
  confirmed: number;
  missing: G4HDates;
  /** Stored but not confirmed by the daily audit's rule. */
  unconfirmed: G4HDefects;
  /** Stored 1d rows on no session window: a wrong date or an off-grid open. */
  unexpected: G4HDates;
};

export type G4HFourHour = {
  /**
   * ready: every session is exactly its planned buckets. held: the rest is
   * held by a recorded long-sync run (acceptable with its alert, §12.4, but
   * never complete). incomplete: anything partial, missing or misdated.
   */
  state: 'ready' | 'held' | 'incomplete';
  calendarAvailable: boolean;
  provisionalCalendarYears: number[];
  sessionsExpected: number;
  complete: number;
  held: { date: string; reason: string }[];
  partial: G4HDefects;
  missing: G4HDates;
  unexpected: G4HDates;
};

export type G4HAsset = {
  assetId: string;
  symbol: string;
  obligationStart: string | null;
  daily: G4HDaily;
  fourHour: G4HFourHour;
  intraday: {
    interval: string;
    sessions: number;
    state: 'pre_obligation' | 'post_obligation';
    /** First session date whose window lies wholly after A. */
    readyFrom: string | null;
  }[];
};

/**
 * Read-only expansion gates (design v2.1 §12.4, stage 5 preparation).
 *
 * G4-I counts DB evidence for every active domestic stock after its
 * obligation start A, with the reader's own code (checkpoint union, bridge,
 * required slots): concealment (an unproven closed slot that is not held,
 * i.e. never audited missing twice) must be 0, unproven ≤ 0.1 % of the
 * obligated slots, and the first central checkpoint within the first tick
 * after A. G4-H reports history readiness per stock and interval: 1d 576
 * (checkpoint coverage AND one confirmed bar per closed session), 4h 96
 * sessions judged by the long sync's own completeness rule (held sessions
 * apart, never complete), and whether each 5m-family window is still initial
 * history (pre_obligation) — defects inside obligated windows are G4-I's.
 * Nothing here writes or calls a provider.
 */
export class KrxCollectionGateDiagnostics {
  constructor(
    private readonly prisma: PrismaService,
    private readonly states: MarketCandleSyncStateRepository,
    private readonly config: KrxCentralCandlesConfig,
  ) {}

  async g4i(input: {
    now: Date;
    sessions?: number;
    assetIds?: readonly string[];
  }): Promise<G4IReport> {
    const nowMs = input.now.getTime();
    const sessions = completedSessions(nowMs, input.sessions ?? 3);
    const assets = await this.assets(input.assetIds);
    const out: G4IAsset[] = [];
    for (const asset of assets) {
      const start = resolveKrxObligationStart(this.config, asset.symbol);
      const result: G4IAsset = {
        assetId: asset.id,
        symbol: asset.symbol,
        obligationStart: start?.toISOString() ?? null,
        sessions: [],
        firstCheckpointAt: null,
        firstTickDeadline: null,
        startedInTime: null,
      };
      out.push(result);
      if (!start || start.getTime() > nowMs) continue;
      for (const session of sessions) {
        if (session.closeTime.getTime() <= start.getTime()) continue;
        const rows = await this.states.findCheckpointsOverlapping(
          asset.id,
          '5m',
          session.openTime,
          session.closeTime,
          start,
        );
        const state = krxSessionSlotState({
          session,
          nowMs,
          rows,
          obligationStartMs: start.getTime(),
        });
        const from = Math.max(session.openTime.getTime(), start.getTime());
        result.sessions.push({
          sessionDate: session.localDate,
          obligated: requiredFiveMinuteSlotStarts(session).filter(
            (slot) => slot >= from && slot + FIVE_MINUTES_MS <= nowMs,
          ).length,
          held: state.held.length,
          concealed: state.unproven.length - state.held.length,
          unprovenSlots: state.unproven.map((slot) =>
            new Date(slot).toISOString(),
          ),
        });
      }
      const firstSession = firstSessionAfter(start.getTime());
      if (firstSession) {
        const firstTick =
          Math.max(firstSession.openTime.getTime(), start.getTime()) +
          FIVE_MINUTES_MS +
          this.config.tickDelayMs;
        const deadline = firstTick + FIVE_MINUTES_MS;
        result.firstTickDeadline = new Date(deadline).toISOString();
        // Compaction dates a merged row by its group's newest member and
        // keeps the earliest createdAt in its cursor.
        const rows = await this.prisma.marketCandleSyncState.findMany({
          where: {
            assetId: asset.id,
            feed: '5m',
            sourceProvider: KOSCOM_MINUTE_SOURCE,
            createdAt: {
              gte: start,
              lt: new Date(start.getTime() + FIRST_CHECKPOINT_SEARCH_MS),
            },
          },
          select: { createdAt: true, cursorJson: true },
        });
        const firstMs = rows.length
          ? Math.min(
              ...rows.map(
                (row) =>
                  compactedFirstCreatedAt(row.cursorJson) ??
                  row.createdAt.getTime(),
              ),
            )
          : null;
        result.firstCheckpointAt =
          firstMs === null ? null : new Date(firstMs).toISOString();
        if (deadline <= nowMs || firstMs !== null)
          result.startedInTime = firstMs !== null && firstMs <= deadline;
      }
    }
    const all = out.flatMap((asset) => asset.sessions);
    const obligated = all.reduce((sum, s) => sum + s.obligated, 0);
    const held = all.reduce((sum, s) => sum + s.held, 0);
    const concealed = all.reduce((sum, s) => sum + s.concealed, 0);
    const defectRate = obligated > 0 ? (held + concealed) / obligated : null;
    return {
      sessions: sessions.map((session) => session.localDate),
      assets: out,
      totals: { obligated, held, concealed, defectRate },
      pass: {
        measured:
          out.length > 0 &&
          out.every((asset) => asset.obligationStart !== null) &&
          obligated > 0,
        concealmentZero: concealed === 0,
        defectRateWithin:
          defectRate === null || defectRate <= G4I_MAX_DEFECT_RATE,
        collectionStartedInTime: out.every(
          (asset) => asset.startedInTime !== false,
        ),
      },
    };
  }

  async g4h(input: {
    now: Date;
    assetIds?: readonly string[];
  }): Promise<G4HAsset[]> {
    const nowMs = input.now.getTime();
    const krx = { assetType: 'domestic_stock' as const, market: 'KRX' };
    const dailyStart = findPreviousMarketSession(
      krx,
      input.now,
      DAILY_SESSIONS,
    );
    const windowFrom = dailyStart
      ? new Date(kstDayStartMs(dailyStart.localDate))
      : null;
    const dailyWindows = windowFrom
      ? resolveKisDailyPeriodWindows('KRX', windowFrom, input.now)
      : null;
    const fourHourWindow = previousSessions(nowMs, FOUR_HOUR_SESSIONS);
    const assets = await this.assets(input.assetIds);
    const oldest = fourHourWindow.sessions.at(-1);
    const holds = oldest
      ? await this.recordedHolds(
          assets.map((asset) => asset.id),
          oldest.openTime,
        )
      : new Map<string, Map<string, string>>();
    const out: G4HAsset[] = [];
    for (const asset of assets) {
      const start = resolveKrxObligationStart(this.config, asset.symbol);
      out.push({
        assetId: asset.id,
        symbol: asset.symbol,
        obligationStart: start?.toISOString() ?? null,
        daily: await this.dailyReadiness(
          asset.id,
          input.now,
          windowFrom,
          dailyWindows,
        ),
        fourHour: await this.fourHourReadiness(
          asset.id,
          fourHourWindow,
          holds.get(asset.id),
        ),
        intraday: INTRADAY_WINDOWS.map(({ interval, sessions }) => {
          const windowStart = findPreviousMarketSession(
            krx,
            input.now,
            sessions,
          );
          const first = start ? firstSessionAfter(start.getTime()) : null;
          const pre =
            start !== null &&
            (windowStart === null ||
              windowStart.openTime.getTime() < start.getTime());
          return {
            interval,
            sessions,
            state: pre ? 'pre_obligation' : 'post_obligation',
            readyFrom: first ? nthSessionAfter(first, sessions) : null,
          };
        }),
      });
    }
    return out;
  }

  /**
   * §5.4: ① complete checkpoints cover the window and ② every closed
   * calendar session has a stored bar the daily audit would confirm (a
   * checkpoint alone can outlive its rows). Holidays are never expected; a
   * row dated on no session is a defect.
   */
  private async dailyReadiness(
    assetId: string,
    now: Date,
    windowFrom: Date | null,
    windows: readonly DailyCandleWindow[] | null,
  ): Promise<G4HDaily> {
    const nowMs = now.getTime();
    const result: G4HDaily = {
      state: 'incomplete',
      windowFrom: windowFrom?.toISOString() ?? null,
      calendarAvailable: windowFrom !== null && windows !== null,
      provisionalCalendarYears:
        windowFrom === null
          ? []
          : provisionalKrxYears(windowFrom.getTime(), nowMs),
      coverageComplete: false,
      sessionsExpected: 0,
      confirmed: 0,
      missing: dates([]),
      unconfirmed: defects([]),
      unexpected: dates([]),
    };
    if (windowFrom === null || windows === null) return result;
    const coverage = await this.states.findCandleCoverage(
      assetId,
      '1d',
      windowFrom,
      now,
      { bridge: krxDailyBridge(nowMs) },
    );
    result.coverageComplete =
      coverage.startsAtRequestedFrom &&
      !coverage.hasInteriorGap &&
      (coverage.contiguousCoveredTo?.getTime() ?? 0) >= nowMs;
    const rows = await this.prisma.marketCandle.findMany({
      where: {
        assetId,
        interval: '1d',
        openTime: { gte: windowFrom, lt: now },
      },
      orderBy: { openTime: 'asc' },
      select: {
        openTime: true,
        closeTime: true,
        isClosed: true,
        sourceProvider: true,
        sourceUpdatedAt: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        amount: true,
      },
    });
    const byOpenTime = new Map(
      rows.map((row) => [row.openTime.getTime(), row]),
    );
    // The audit's clock: receipts normally follow the observation instant.
    const observedAt = new Date(Math.max(nowMs, Date.now()));
    const missing: string[] = [];
    const unconfirmed: { date: string; defects: string[] }[] = [];
    for (const window of windows) {
      if (window.closedAt.getTime() > nowMs) continue;
      result.sessionsExpected += 1;
      const date = kstDate(window.openTime.getTime());
      const row = byOpenTime.get(window.openTime.getTime());
      if (!row) {
        missing.push(date);
        continue;
      }
      const found = dailyCandleDefects(row, window, {
        sourceProvider: KOSCOM_HISTORY_SOURCE,
        observedAt,
      });
      if (found.length > 0) unconfirmed.push({ date, defects: found });
      else result.confirmed += 1;
    }
    const known = new Set(windows.map((window) => window.openTime.getTime()));
    result.missing = dates(missing);
    result.unconfirmed = defects(unconfirmed);
    result.unexpected = dates(
      rows
        .filter((row) => !known.has(row.openTime.getTime()))
        .map((row) => row.openTime.toISOString()),
    );
    if (
      result.coverageComplete &&
      result.confirmed === result.sessionsExpected &&
      result.unexpected.count === 0
    )
      result.state = 'ready';
    return result;
  }

  /**
   * The 4h `96d` history judged by the long sync's own rule: a session is
   * complete only when its stored rows are exactly the calendar session's
   * planned buckets (closed `koscom_history_10m`, exact open/close — delayed
   * opens and early closes included) and nothing else is stored that day.
   */
  private async fourHourReadiness(
    assetId: string,
    window: { sessions: MarketSessionWindow[]; calendarGap: boolean },
    holds: ReadonlyMap<string, string> | undefined,
  ): Promise<G4HFourHour> {
    const oldestFirst = [...window.sessions].reverse();
    const result: G4HFourHour = {
      state: 'incomplete',
      calendarAvailable: !window.calendarGap,
      provisionalCalendarYears: oldestFirst.length
        ? provisionalKrxYears(
            oldestFirst[0].openTime.getTime(),
            oldestFirst.at(-1)!.openTime.getTime(),
          )
        : [],
      sessionsExpected: window.sessions.length,
      complete: 0,
      held: [],
      partial: defects([]),
      missing: dates([]),
      unexpected: dates([]),
    };
    if (oldestFirst.length === 0) return result;
    const rows: StoredKrxCandle[] = await this.prisma.marketCandle.findMany({
      where: {
        assetId,
        interval: '4h',
        openTime: {
          gte: new Date(kstDayStartMs(oldestFirst[0].localDate)),
          lt: new Date(kstDayStartMs(oldestFirst.at(-1)!.localDate) + DAY_MS),
        },
      },
      orderBy: { openTime: 'asc' },
      select: {
        openTime: true,
        closeTime: true,
        isClosed: true,
        sourceProvider: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        amount: true,
      },
    });
    const verified = groupStoredKrxRows(rows);
    const byDate = new Map<string, StoredKrxCandle[]>();
    for (const row of rows) {
      const date = kstDate(row.openTime.getTime());
      byDate.set(date, [...(byDate.get(date) ?? []), row]);
    }
    const missing: string[] = [];
    const partial: { date: string; defects: string[] }[] = [];
    for (const session of oldestFirst) {
      const stored = byDate.get(session.localDate) ?? [];
      if (
        isStoredKrxSessionComplete(session, verified) &&
        stored.length === planKrxTenMinuteBuckets(session).length
      ) {
        result.complete += 1;
        continue;
      }
      if (stored.length > 0) {
        partial.push({
          date: session.localDate,
          defects: fourHourDefects(session, stored),
        });
        continue;
      }
      const reason = holds?.get(session.localDate.replaceAll('-', ''));
      if (reason) result.held.push({ date: session.localDate, reason });
      else missing.push(session.localDate);
    }
    const sessionDates = new Set(oldestFirst.map((s) => s.localDate));
    result.partial = defects(partial);
    result.missing = dates(missing);
    result.unexpected = dates(
      [...byDate.keys()].filter((date) => !sessionDates.has(date)),
    );
    if (
      !window.calendarGap &&
      result.partial.count === 0 &&
      result.missing.count === 0 &&
      result.unexpected.count === 0
    )
      result.state = result.held.length > 0 ? 'held' : 'ready';
    return result;
  }

  /**
   * Sessions a recorded (non-dry-run) KRX long-sync run — the Ops job or the
   * backfill command — listed as held, by asset and YYYYMMDD date, with the
   * newest run's reason. Held sessions are never stored, so this record is
   * the only durable trace besides the alert.
   */
  private async recordedHolds(
    assetIds: readonly string[],
    since: Date,
  ): Promise<Map<string, Map<string, string>>> {
    const out = new Map<string, Map<string, string>>();
    if (assetIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<
      Array<{ asset_id: string; session_date: string; reason: string }>
    >`SELECT DISTINCT ON (s.value ->> 'seriesId', h.value ->> 'date')
        s.value ->> 'seriesId' AS asset_id,
        h.value ->> 'date' AS session_date,
        h.value ->> 'reason' AS reason
      FROM ops_job_runs r
      CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.result_json) = 'object'
        THEN r.result_json ELSE '{}' END) m
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.value -> 'series') = 'array'
        THEN m.value -> 'series' ELSE '[]' END) s
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.value -> 'held') = 'array'
        THEN s.value -> 'held' ELSE '[]' END) h
      WHERE r.job_name = 'market_candle_long_sync'
        AND NOT r.dry_run
        AND r.started_at >= ${since}
        AND m.key = 'krx'
        AND s.value ->> 'seriesId' = ANY (${[...assetIds]})
      ORDER BY s.value ->> 'seriesId', h.value ->> 'date', r.started_at DESC`;
    for (const row of rows) {
      const byDate = out.get(row.asset_id) ?? new Map<string, string>();
      byDate.set(row.session_date, row.reason);
      out.set(row.asset_id, byDate);
    }
    return out;
  }

  private assets(assetIds?: readonly string[]) {
    return this.prisma.asset.findMany({
      where: {
        assetType: AssetType.domestic_stock,
        currencyCode: CurrencyCode.KRW,
        isActive: true,
        ...(assetIds ? { id: { in: [...assetIds] } } : {}),
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true },
    });
  }
}

function sessionOn(date: string): MarketSessionWindow | null {
  return resolveMarketSession('KRX', date.replace(/-/gu, ''));
}

/** The last `count` sessions whose post-close repair is over, newest first. */
function completedSessions(
  nowMs: number,
  count: number,
): MarketSessionWindow[] {
  const out: MarketSessionWindow[] = [];
  for (let back = 0; back < 60 && out.length < count; back += 1) {
    const session = sessionOn(kstDate(nowMs - back * DAY_MS));
    if (session && session.closeTime.getTime() + REPAIR_DONE_MS <= nowMs)
      out.push(session);
  }
  return out;
}

/**
 * The `count` sessions before today's KST date (the `96d` 4h window), newest
 * first. A date without calendar data stops the walk (calendarGap) instead
 * of passing for a holiday, as in the long sync.
 */
function previousSessions(
  nowMs: number,
  count: number,
): { sessions: MarketSessionWindow[]; calendarGap: boolean } {
  const sessions: MarketSessionWindow[] = [];
  for (let back = 1; back < 400 && sessions.length < count; back += 1) {
    const date = kstDate(nowMs - back * DAY_MS);
    if (!hasEffectiveMarketCalendarForDate('KRX', date))
      return { sessions, calendarGap: true };
    const session = sessionOn(date);
    if (session) sessions.push(session);
  }
  return { sessions, calendarGap: sessions.length < count };
}

/** Why a stored session is not exactly its plan (diagnostic detail). */
function fourHourDefects(
  session: MarketSessionWindow,
  stored: readonly StoredKrxCandle[],
): string[] {
  const planned = planKrxTenMinuteBuckets(session);
  const onPlan = (row: StoredKrxCandle) =>
    planned.some(
      (bucket) =>
        bucket.openTime.getTime() === row.openTime.getTime() &&
        bucket.closeTime.getTime() === row.closeTime.getTime(),
    );
  const found = new Set<string>();
  for (const row of stored) {
    if (row.sourceProvider !== KOSCOM_TEN_MINUTE_HISTORY_SOURCE)
      found.add('source');
    if (row.isClosed === false) found.add('not_closed');
    if (!onPlan(row)) found.add('off_plan');
  }
  const usable = stored.filter(
    (row) =>
      row.sourceProvider === KOSCOM_TEN_MINUTE_HISTORY_SOURCE &&
      row.isClosed !== false,
  );
  if (
    planned.some(
      (bucket) =>
        !usable.some(
          (row) =>
            row.openTime.getTime() === bucket.openTime.getTime() &&
            row.closeTime.getTime() === bucket.closeTime.getTime(),
        ),
    )
  )
    found.add('missing_bucket');
  return [...found].sort();
}

/** KRX calendar years in [fromMs, toMs] whose dataset is provisional. */
function provisionalKrxYears(fromMs: number, toMs: number): number[] {
  const years: number[] = [];
  const last = Number(kstDate(toMs).slice(0, 4));
  for (let year = Number(kstDate(fromMs).slice(0, 4)); year <= last; year++)
    if (getCalendarDataset('KRX', year)?.version.includes('provisional'))
      years.push(year);
  return years;
}

function dates(list: readonly string[]): G4HDates {
  return { count: list.length, dates: list.slice(0, SAMPLE_DATES) };
}

function defects(
  list: readonly { date: string; defects: string[] }[],
): G4HDefects {
  return { count: list.length, sessions: list.slice(0, SAMPLE_DATES) };
}

function firstSessionAfter(ms: number): MarketSessionWindow | null {
  for (let ahead = 0; ahead < 30; ahead += 1) {
    const session = sessionOn(kstDate(ms + ahead * DAY_MS));
    if (session && session.closeTime.getTime() > ms) return session;
  }
  return null;
}

/** The session date `n` sessions after `first`: its prevN window starts at `first`. */
function nthSessionAfter(first: MarketSessionWindow, n: number): string | null {
  let remaining = n;
  for (let ahead = 1; ahead < 120; ahead += 1) {
    const date = kstDate(kstDayStartMs(first.localDate) + ahead * DAY_MS);
    if (!sessionOn(date)) continue;
    remaining -= 1;
    if (remaining === 0) return date;
  }
  return null;
}
