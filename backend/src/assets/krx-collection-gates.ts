import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  findPreviousMarketSession,
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { PrismaService } from '../prisma/prisma.service';
import { KOSCOM_MINUTE_SOURCE } from '../providers/koscom/koscom.config';
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
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';

const DAY_MS = 24 * 60 * 60_000;
/** Post-close repair is over an hour after the close (§4.2 rule 5). */
const REPAIR_DONE_MS = 60 * 60_000;
export const G4I_MAX_DEFECT_RATE = 0.001;
/** The first-checkpoint search stays bounded however old A is. */
const FIRST_CHECKPOINT_SEARCH_MS = 14 * DAY_MS;
const LONG_4H_SOURCE = 'koscom_history_10m';
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
    concealmentZero: boolean;
    defectRateWithin: boolean;
    collectionStartedInTime: boolean;
  };
};

export type G4HAsset = {
  assetId: string;
  symbol: string;
  obligationStart: string | null;
  daily: { state: 'ready' | 'missing'; windowFrom: string | null };
  fourHour: {
    state: 'ready' | 'incomplete';
    sessionsWithRows: number;
    sessionsExpected: number;
  };
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
 * coverage, stored 4h sessions, and whether each 5m-family window is still
 * initial history (pre_obligation) — defects inside obligated windows are
 * G4-I's. Nothing here writes or calls a provider.
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
    const dailyStart = findPreviousMarketSession(krx, input.now, 576);
    const fourHourSessions = previousSessions(nowMs, 96);
    const out: G4HAsset[] = [];
    for (const asset of await this.assets(input.assetIds)) {
      const start = resolveKrxObligationStart(this.config, asset.symbol);
      const windowFrom = dailyStart
        ? kstDayStartMs(dailyStart.localDate)
        : null;
      const coverage =
        windowFrom === null
          ? null
          : await this.states.findCandleCoverage(
              asset.id,
              '1d',
              new Date(windowFrom),
              input.now,
              { bridge: krxDailyBridge(nowMs) },
            );
      const dailyReady =
        coverage !== null &&
        coverage.startsAtRequestedFrom &&
        !coverage.hasInteriorGap &&
        (coverage.contiguousCoveredTo?.getTime() ?? 0) >= nowMs;
      let sessionsWithRows = 0;
      for (const session of fourHourSessions) {
        const rows = await this.prisma.marketCandle.count({
          where: {
            assetId: asset.id,
            interval: '4h',
            sourceProvider: LONG_4H_SOURCE,
            openTime: {
              gte: new Date(kstDayStartMs(session.localDate)),
              lt: new Date(kstDayStartMs(session.localDate) + DAY_MS),
            },
          },
        });
        if (rows > 0) sessionsWithRows += 1;
      }
      out.push({
        assetId: asset.id,
        symbol: asset.symbol,
        obligationStart: start?.toISOString() ?? null,
        daily: {
          state: dailyReady ? 'ready' : 'missing',
          windowFrom:
            windowFrom === null ? null : new Date(windowFrom).toISOString(),
        },
        fourHour: {
          state:
            sessionsWithRows === fourHourSessions.length
              ? 'ready'
              : 'incomplete',
          sessionsWithRows,
          sessionsExpected: fourHourSessions.length,
        },
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

/** The `count` sessions before today's KST date (the `96d` 4h window). */
function previousSessions(nowMs: number, count: number): MarketSessionWindow[] {
  const out: MarketSessionWindow[] = [];
  for (let back = 1; back < 400 && out.length < count; back += 1) {
    const session = sessionOn(kstDate(nowMs - back * DAY_MS));
    if (session) out.push(session);
  }
  return out;
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
