import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  resolveMarketSession,
  type MarketSessionWindow,
} from '../../orders/market-calendar.policy';
import { formatZonedCursor } from '../kis/candles/kis-candle-time';
import { tiingoFailureCode } from './tiingo.errors';
import {
  parseTiingoDailyBars,
  parseTiingoIntradayBars,
  type TiingoDailyBar,
} from './tiingo.parser';
import { TiingoRestClient } from './tiingo-rest.client';

const US_EASTERN_TIME_ZONE = 'America/New_York';
const FIVE_MINUTES_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
/** ≈ 16 × 78 bars ≈ 110 KB per request; 96 sessions → ~7 requests cold. */
const SESSIONS_PER_REQUEST = 16;
/** Completed sessions are immutable enough to reuse for one evaluation sitting. */
const COMPLETED_SESSION_TTL_MS = 20 * 60_000;
/** The live session is re-read soon: its last bar is still forming. */
const CURRENT_SESSION_TTL_MS = 30_000;
const DAILY_TTL_MS = 15 * 60_000;
const MAX_CACHED_SESSIONS = 600;
const MAX_CACHED_DAILY_RANGES = 32;
/** Upper bound of sessions a single read may request (96d window + margin). */
export const MAX_SESSIONS_PER_READ = 140;

/** Same shape the stored 5m feed hands to the aggregation service. */
export type TiingoFiveMinuteRow = {
  openTime: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  amount: null;
  isClosed: boolean;
  sourceUpdatedAt: Date;
};

export type TiingoIntradayCoverage = {
  requestedSessions: number;
  coveredSessions: number;
  emptySessions: number;
  unfetchedSessions: number;
  firstBarAt: string | null;
  lastBarAt: string | null;
  invalidBars: number;
  duplicateBars: number;
  outOfSessionBars: number;
  requests: number;
  stopCode: string | null;
};

export type TiingoDailyCoverage = {
  requestedFrom: string;
  requestedTo: string;
  returnedBars: number;
  invalidBars: number;
  requests: number;
  stopCode: string | null;
};

export type TiingoCandleStatus = {
  intradayReads: number;
  dailyReads: number;
  restRequests: number;
  cachedSessions: number;
  lastRead: {
    kind: 'intraday' | 'daily';
    at: string;
    requestedSessions: number | null;
    coveredSessions: number | null;
    returnedBars: number;
    stopCode: string | null;
  } | null;
};

type SessionEntry = {
  rows: TiingoFiveMinuteRow[];
  expiresAt: number;
  insertedAt: number;
};

/**
 * Tiingo historical candles for the trial path. Rows stay in process memory
 * with short TTLs (no PostgreSQL rows, no Redis response cache), so nothing
 * survives a restart. Fetches are planned per exchange session from the shared
 * US calendar (holidays, early closes, DST) and run newest-first: if a request
 * fails or the request budget runs out, the recent part is still served and
 * the older sessions are reported as unfetched — never interpolated.
 */
@Injectable()
export class TiingoCandleService implements OnModuleDestroy {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly daily = new Map<
    string,
    { bars: TiingoDailyBar[]; invalid: number; expiresAt: number }
  >();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly counters = {
    intradayReads: 0,
    dailyReads: 0,
    restRequests: 0,
    lastRead: null as TiingoCandleStatus['lastRead'],
  };

  constructor(private readonly rest: TiingoRestClient) {}

  onModuleDestroy(): void {
    this.clear();
  }

  clear(): void {
    this.sessions.clear();
    this.daily.clear();
    this.inFlight.clear();
  }

  getStatus(): TiingoCandleStatus {
    return {
      intradayReads: this.counters.intradayReads,
      dailyReads: this.counters.dailyReads,
      restRequests: this.counters.restRequests,
      cachedSessions: this.sessions.size,
      lastRead: this.counters.lastRead ? { ...this.counters.lastRead } : null,
    };
  }

  /** Regular-session 5m bars for every US session overlapping [from, to). */
  async loadFiveMinuteBars(input: {
    symbol: string;
    from: Date;
    to: Date;
    now: Date;
    /** Newest sessions needed to fill the caller's candle limit. */
    maxSessions: number;
  }): Promise<{
    rows: TiingoFiveMinuteRow[];
    coverage: TiingoIntradayCoverage;
  }> {
    this.counters.intradayReads += 1;
    const nowMs = input.now.getTime();
    const sessions = listUsSessions(input.from, input.to)
      .filter((session) => session.openTime.getTime() <= nowMs)
      .slice(-Math.max(1, Math.min(input.maxSessions, MAX_SESSIONS_PER_READ)));
    const coverage: TiingoIntradayCoverage = {
      requestedSessions: sessions.length,
      coveredSessions: 0,
      emptySessions: 0,
      unfetchedSessions: 0,
      firstBarAt: null,
      lastBarAt: null,
      invalidBars: 0,
      duplicateBars: 0,
      outOfSessionBars: 0,
      requests: 0,
      stopCode: null,
    };
    const symbol = input.symbol.toUpperCase();
    // Newest first: recent candles appear even when older history is short.
    for (const chunk of missingRuns(
      sessions,
      (session) => !this.freshSession(symbol, session.localDate, nowMs),
      SESSIONS_PER_REQUEST,
    )) {
      if (coverage.stopCode) break;
      try {
        await this.fetchChunk(symbol, chunk, input.now, coverage);
      } catch (error) {
        coverage.stopCode = tiingoFailureCode(error);
      }
    }
    const fromMs = input.from.getTime();
    const toMs = input.to.getTime();
    const rows: TiingoFiveMinuteRow[] = [];
    for (const session of sessions) {
      const entry = this.sessions.get(sessionKey(symbol, session.localDate));
      if (!entry) {
        coverage.unfetchedSessions += 1;
        continue;
      }
      if (entry.rows.length === 0) coverage.emptySessions += 1;
      else coverage.coveredSessions += 1;
      for (const row of entry.rows) {
        const openMs = row.openTime.getTime();
        if (openMs < fromMs || openMs >= toMs) continue;
        rows.push({
          ...row,
          isClosed: openMs + FIVE_MINUTES_MS <= nowMs,
        });
      }
    }
    rows.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
    coverage.firstBarAt = rows[0]?.openTime.toISOString() ?? null;
    coverage.lastBarAt = rows.at(-1)?.openTime.toISOString() ?? null;
    this.counters.lastRead = {
      kind: 'intraday',
      at: input.now.toISOString(),
      requestedSessions: coverage.requestedSessions,
      coveredSessions: coverage.coveredSessions,
      returnedBars: rows.length,
      stopCode: coverage.stopCode,
    };
    return { rows, coverage };
  }

  /** End-of-day bars (raw + adjusted) for the ET dates of [from, to]. */
  async loadDailyBars(input: {
    symbol: string;
    from: Date;
    to: Date;
    now: Date;
  }): Promise<{ bars: TiingoDailyBar[]; coverage: TiingoDailyCoverage }> {
    this.counters.dailyReads += 1;
    const symbol = input.symbol.toUpperCase();
    const startDate = dashed(
      formatZonedCursor(input.from, US_EASTERN_TIME_ZONE).date,
    );
    const endDate = dashed(
      formatZonedCursor(new Date(input.to.getTime() - 1), US_EASTERN_TIME_ZONE)
        .date,
    );
    const coverage: TiingoDailyCoverage = {
      requestedFrom: startDate,
      requestedTo: endDate,
      returnedBars: 0,
      invalidBars: 0,
      requests: 0,
      stopCode: null,
    };
    const key = `${symbol}|${startDate}|${endDate}`;
    const nowMs = input.now.getTime();
    let entry = this.daily.get(key);
    if (!entry || entry.expiresAt <= nowMs) {
      try {
        entry = await this.shared(`daily|${key}`, async () => {
          coverage.requests += 1;
          this.counters.restRequests += 1;
          const result = await this.rest.getDailyPrices(symbol, {
            startDate,
            endDate,
          });
          const parsed = parseTiingoDailyBars(result.json);
          const value = {
            bars: parsed.bars,
            invalid: parsed.invalid,
            expiresAt: Date.now() + DAILY_TTL_MS,
          };
          this.daily.set(key, value);
          while (this.daily.size > MAX_CACHED_DAILY_RANGES) {
            const oldest = this.daily.keys().next();
            if (oldest.done) break;
            this.daily.delete(oldest.value);
          }
          return value;
        });
      } catch (error) {
        coverage.stopCode = tiingoFailureCode(error);
        entry = undefined;
      }
    }
    const bars = (entry?.bars ?? []).filter(
      (bar) => bar.date >= startDate && bar.date <= endDate,
    );
    coverage.returnedBars = bars.length;
    coverage.invalidBars = entry?.invalid ?? 0;
    this.counters.lastRead = {
      kind: 'daily',
      at: input.now.toISOString(),
      requestedSessions: null,
      coveredSessions: null,
      returnedBars: bars.length,
      stopCode: coverage.stopCode,
    };
    return { bars, coverage };
  }

  private freshSession(symbol: string, localDate: string, nowMs: number) {
    const entry = this.sessions.get(sessionKey(symbol, localDate));
    return Boolean(entry && entry.expiresAt > nowMs);
  }

  private async fetchChunk(
    symbol: string,
    chunk: MarketSessionWindow[],
    now: Date,
    coverage: TiingoIntradayCoverage,
  ): Promise<void> {
    const ordered = [...chunk].sort(
      (a, b) => a.openTime.getTime() - b.openTime.getTime(),
    );
    const startDate = ordered[0].localDate;
    const endDate = ordered[ordered.length - 1].localDate;
    await this.shared(
      `intraday|${symbol}|${startDate}|${endDate}`,
      async () => {
        coverage.requests += 1;
        this.counters.restRequests += 1;
        const result = await this.rest.getIntradayPrices(symbol, {
          startDate,
          endDate,
        });
        const parsed = parseTiingoIntradayBars(result.json);
        coverage.invalidBars += parsed.invalid;
        coverage.duplicateBars += parsed.duplicates;
        const bySession = new Map<string, TiingoFiveMinuteRow[]>(
          ordered.map((session) => [session.localDate, []]),
        );
        for (const bar of parsed.bars) {
          const openMs = bar.openTime.getTime();
          const session = ordered.find(
            (candidate) =>
              openMs >= candidate.openTime.getTime() &&
              openMs < candidate.closeTime.getTime(),
          );
          // Regular-session grid only; pre/post-market bars are not candles here.
          if (
            !session ||
            (openMs - session.openTime.getTime()) % FIVE_MINUTES_MS !== 0
          ) {
            coverage.outOfSessionBars += 1;
            continue;
          }
          if (bar.volume === null) {
            coverage.invalidBars += 1;
            continue;
          }
          bySession.get(session.localDate)?.push({
            openTime: bar.openTime,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            amount: null,
            isClosed: false,
            sourceUpdatedAt: result.receivedAt,
          });
        }
        const nowMs = now.getTime();
        for (const session of ordered) {
          const completed = session.closeTime.getTime() <= nowMs;
          this.storeSession(symbol, session.localDate, {
            rows: bySession.get(session.localDate) ?? [],
            expiresAt:
              Date.now() +
              (completed ? COMPLETED_SESSION_TTL_MS : CURRENT_SESSION_TTL_MS),
            insertedAt: Date.now(),
          });
        }
      },
    );
  }

  private storeSession(symbol: string, localDate: string, entry: SessionEntry) {
    const key = sessionKey(symbol, localDate);
    this.sessions.delete(key);
    this.sessions.set(key, entry);
    while (this.sessions.size > MAX_CACHED_SESSIONS) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }

  /** Concurrent identical reads share one provider request. */
  private shared<T>(key: string, load: () => Promise<T>): Promise<T> {
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const work = load().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }
}

/** US regular sessions overlapping [from, to), oldest first, bounded. */
export function listUsSessions(from: Date, to: Date): MarketSessionWindow[] {
  const sessions: MarketSessionWindow[] = [];
  const first = formatZonedCursor(from, US_EASTERN_TIME_ZONE).date;
  const last = formatZonedCursor(
    new Date(to.getTime() - 1),
    US_EASTERN_TIME_ZONE,
  ).date;
  let cursor = Date.UTC(
    Number(first.slice(0, 4)),
    Number(first.slice(4, 6)) - 1,
    Number(first.slice(6, 8)),
  );
  const end = Date.UTC(
    Number(last.slice(0, 4)),
    Number(last.slice(4, 6)) - 1,
    Number(last.slice(6, 8)),
  );
  for (; cursor <= end; cursor += DAY_MS) {
    const date = new Date(cursor).toISOString().slice(0, 10).replace(/-/gu, '');
    const session = resolveMarketSession('US', date);
    if (
      session &&
      session.openTime.getTime() < to.getTime() &&
      session.closeTime.getTime() > from.getTime()
    )
      sessions.push(session);
  }
  return sessions;
}

/**
 * Contiguous runs of sessions that need a fetch, newest run first, each split
 * into requests of at most `size` sessions. A fresh cached session breaks a
 * run, so already-held dates are never requested again.
 */
export function missingRuns(
  sessions: readonly MarketSessionWindow[],
  isMissing: (session: MarketSessionWindow) => boolean,
  size: number,
): MarketSessionWindow[][] {
  const chunks: MarketSessionWindow[][] = [];
  let run: MarketSessionWindow[] = [];
  const flush = () => {
    for (let index = 0; index < run.length; index += size)
      chunks.push(run.slice(index, index + size));
    run = [];
  };
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    if (isMissing(sessions[index])) run.push(sessions[index]);
    else flush();
  }
  flush();
  return chunks;
}

function sessionKey(symbol: string, localDate: string): string {
  return `${symbol}|${localDate}`;
}

function dashed(compact: string): string {
  return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
}
