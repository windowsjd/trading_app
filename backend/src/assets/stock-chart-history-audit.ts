import { AssetType, CurrencyCode } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  resolveMarketSession,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { hasEffectiveMarketCalendarForDate } from '../orders/market-holidays.config';
import { resolvePeriodWindowForDate } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { KIS_FIXED_ASSET_UNIVERSE } from '../providers/kis/kis-fixed-asset-universe';
import { resolveRequiredFiveMinuteSlotEndMs } from './candle-expected-slots.policy';
import {
  KRX_COLLECTION_COHORTS,
  resolveKrxObligationStart,
  type KrxCollectionCohort,
} from './krx-central-candles.config';
import { usCandleRowFilter } from './us-candle-provider';

const DAY_MS = 24 * 60 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const FOUR_HOURS_MS = 4 * 60 * 60_000;
/** The read plan's recent 4h range, aggregated from stored 5m (30 days). */
const RECENT_FOUR_HOUR_WINDOW_MS = 30 * DAY_MS;
/** Bounds the backward walk for 576 sessions (≈ 840 calendar days). */
const MAX_LOOKBACK_DAYS = 900;
/** Dates listed per gap kind; the counts are always complete. */
const SAMPLE_DATES = 10;

export type StockChartKey = '5m' | '15m' | '30m' | '1h' | '4h' | '1d';

/**
 * The stock chart windows of `frontend/src/features/asset/chartTimeframes.ts`
 * (KRX and US alike, each on its exchange calendar): 5m/15m/30m/1h read the
 * stored 5m of the previous 3/6/12/24 sessions, 4h the previous 96 sessions
 * (stored completed 4h, recent buckets aggregated from 5m), 1d the previous
 * 576 sessions.
 */
export const STOCK_CHART_HISTORY_WINDOWS: readonly {
  chart: StockChartKey;
  sessions: number;
}[] = [
  { chart: '5m', sessions: 3 },
  { chart: '15m', sessions: 6 },
  { chart: '30m', sessions: 12 },
  { chart: '1h', sessions: 24 },
  { chart: '4h', sessions: 96 },
  { chart: '1d', sessions: 576 },
];
const FIVE_MINUTE_CHARTS: ReadonlySet<StockChartKey> = new Set([
  '5m',
  '15m',
  '30m',
  '1h',
]);

export type StockChartWindowState =
  /** Every session of the window has its candles. */
  | 'complete'
  /** Only sessions before the stock's listing are empty. */
  | 'limited_by_listing'
  /**
   * KRX 5m-sourced windows: only sessions before the stock's collection
   * obligation start A are empty. The central collector proves 5m from A
   * on; KOSCOM 1-minute history is fetched for the current date only, so
   * earlier 5m cannot be backfilled (design v2.1 `pre_obligation`).
   */
  | 'limited_by_collection_start'
  /**
   * Only sessions before a provider history depth measured and passed in
   * (`usIntradayHistoryFrom`, from the Tiingo smoke) are empty.
   */
  | 'limited_by_provider'
  /** A session that should have data has no (or incomplete) candles. */
  | 'incomplete'
  /** The window reaches a date without calendar data; nothing is judged. */
  | 'calendar_unavailable';

export type StockChartGap = { count: number; dates: string[] };

export type StockChartWindowReport = {
  chart: StockChartKey;
  sessionsExpected: number;
  sessionsCovered: number;
  state: StockChartWindowState;
  firstCoveredSession: string | null;
  /** Uncovered sessions older than the first covered one. */
  leadingMissing: StockChartGap;
  /** Uncovered sessions after the first covered one: a hole in the history. */
  interiorMissing: StockChartGap;
  /** Uncovered sessions explained by listing, collection start or provider depth. */
  explained: {
    beforeListing: number;
    beforeCollectionStart: number;
    beforeProviderHistory: number;
  };
  /** Uncovered sessions no recorded limit explains (the defects). */
  unexplained: StockChartGap;
};

export type StockChartAssetReport = {
  assetId: string;
  symbol: string;
  market: 'KRX' | 'US';
  listedOn: string | null;
  /** KRX: the cohort obligation start A (ISO), the 5m collection start. */
  collectionStart: string | null;
  windows: StockChartWindowReport[];
};

export type StockChartSummaryCell = {
  complete: number;
  limitedByListing: number;
  limitedByCollectionStart: number;
  limitedByProvider: number;
  incomplete: number;
  calendarUnavailable: number;
  incompleteSymbols: string[];
};

export type StockChartHistoryReport = {
  at: string;
  assets: StockChartAssetReport[];
  summary: Record<'KRX' | 'US', Record<StockChartKey, StockChartSummaryCell>>;
  /** No window is incomplete or calendar-unavailable. */
  pass: boolean;
};

export type StockChartHistoryLimits = {
  /** Listing dates, keyed `KRX:005930` / `US:SNDK` (default: the fixed universe). */
  listings?: ReadonlyMap<string, string>;
  /** KRX cohort registry deciding A (default: `KRX_COLLECTION_COHORTS`). */
  krxCohorts?: readonly KrxCollectionCohort[];
  /**
   * First US session date (YYYY-MM-DD) with a full set of Tiingo 5m bars,
   * as measured by `smoke:tiingo-official` (`historyDepth.intradayHistoryReach`).
   * Never assumed: without it, an older US gap stays `incomplete`.
   */
  usIntradayHistoryFrom?: string;
};

type StoredRow = {
  openTime: Date;
  closeTime: Date;
  isClosed: boolean;
  sourceProvider: string;
};

type AuditAsset = {
  id: string;
  symbol: string;
  assetType: AssetType;
  market: 'KRX' | 'US';
};

type Explanation = 'listing' | 'collection_start' | 'provider' | null;

const US_MARKETS = new Set(['NAS', 'NASDAQ', 'NYS', 'NYSE', 'AMS', 'AMEX']);
const KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);
const TIME_ZONES: Record<'KRX' | 'US', string> = {
  KRX: 'Asia/Seoul',
  US: 'America/New_York',
};

/**
 * Read-only audit of the stored chart history of every active stock against
 * the chart windows above (2026-10-17 expansion, report §10.3). It reads
 * stored candles only — no provider call, no write — with the read path's own
 * rules: a 5m session is covered when every required regular slot has a
 * closed candle (KRX closing-auction slots are never required), a 4h session
 * when each planned bucket (open + 4h, then to the close) has a stored closed
 * 4h row, or lies in the recent 30-day range with its 5m complete, and a 1d
 * session when its daily window has a closed row. US rows count only from the
 * current US provider (`US_STOCK_PRICE_PROVIDER`), like the read path.
 *
 * An uncovered session is explained only by a recorded limit: before the
 * listing date (`listedOn`), before a KRX stock's collection start A (5m
 * windows only), or before a measured US intraday depth passed in. Anything
 * else is a defect (`incomplete`) — whether it was never fetched or the
 * provider had nothing is for the backfill output to tell, never assumed.
 */
export class StockChartHistoryAudit {
  private readonly listings: ReadonlyMap<string, string>;
  private readonly krxCohorts: readonly KrxCollectionCohort[];

  constructor(
    private readonly prisma: Pick<PrismaService, 'asset' | 'marketCandle'>,
    private readonly limits: StockChartHistoryLimits = {},
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.listings = limits.listings ?? fixedListings();
    this.krxCohorts = limits.krxCohorts ?? KRX_COLLECTION_COHORTS;
  }

  async run(input: {
    now: Date;
    markets?: readonly ('KRX' | 'US')[];
    assetIds?: readonly string[];
  }): Promise<StockChartHistoryReport> {
    const markets = new Set(input.markets ?? ['KRX', 'US']);
    const assets = (await this.assets(input.assetIds)).filter((asset) =>
      markets.has(asset.market),
    );
    const reports: StockChartAssetReport[] = [];
    const sessionCache = new Map<
      'KRX' | 'US',
      { sessions: MarketSessionWindow[]; calendarGap: boolean }
    >();
    for (const asset of assets) {
      let previous = sessionCache.get(asset.market);
      if (!previous) {
        previous = previousSessions(
          asset.market,
          input.now.getTime(),
          Math.max(...STOCK_CHART_HISTORY_WINDOWS.map((w) => w.sessions)),
        );
        sessionCache.set(asset.market, previous);
      }
      reports.push(await this.auditAsset(asset, previous, input.now));
    }
    return {
      at: input.now.toISOString(),
      assets: reports,
      summary: summarize(reports),
      pass: reports.every((report) =>
        report.windows.every(
          (window) =>
            window.state !== 'incomplete' &&
            window.state !== 'calendar_unavailable',
        ),
      ),
    };
  }

  private async auditAsset(
    asset: AuditAsset,
    previous: { sessions: MarketSessionWindow[]; calendarGap: boolean },
    now: Date,
  ): Promise<StockChartAssetReport> {
    const newestFirst = previous.sessions;
    const listedOn = this.listings.get(listingKey(asset)) ?? null;
    const collectionStart =
      asset.market === 'KRX'
        ? resolveKrxObligationStart({ cohorts: this.krxCohorts }, asset.symbol)
        : null;
    const oldestOf = (count: number) =>
      newestFirst[Math.min(count, newestFirst.length) - 1];
    const keep = usCandleRowFilter(asset, this.env);
    const rows = async (
      interval: '5m' | '4h' | '1d',
      from: Date | undefined,
    ) =>
      from === undefined
        ? []
        : (
            await this.prisma.marketCandle.findMany({
              where: {
                assetId: asset.id,
                interval,
                openTime: { gte: from, lt: now },
              },
              select: {
                openTime: true,
                closeTime: true,
                isClosed: true,
                sourceProvider: true,
              },
            })
          ).filter(
            (row: StoredRow) => row.isClosed && (keep ? keep(row) : true),
          );
    const dailyOldest = oldestOf(576);
    const [fiveMinute, fourHour, daily] = await Promise.all([
      rows('5m', oldestOf(24)?.openTime),
      rows('4h', oldestOf(96)?.openTime),
      rows(
        '1d',
        dailyOldest
          ? new Date(dailyOldest.openTime.getTime() - DAY_MS)
          : undefined,
      ),
    ]);
    const slots = new Set(fiveMinute.map((row) => row.openTime.getTime()));
    const fourHourRows = new Map(
      fourHour.map((row) => [row.openTime.getTime(), row.closeTime.getTime()]),
    );
    const dailyOpens = new Set(daily.map((row) => row.openTime.getTime()));
    const recentFromMs = now.getTime() - RECENT_FOUR_HOUR_WINDOW_MS;

    const fiveMinuteComplete = (fromMs: number, toMs: number) => {
      for (let slot = fromMs; slot < toMs; slot += FIVE_MINUTES_MS)
        if (!slots.has(slot)) return false;
      return true;
    };
    const coveredFiveMinute = (session: MarketSessionWindow) =>
      fiveMinuteComplete(
        session.openTime.getTime(),
        resolveRequiredFiveMinuteSlotEndMs(session),
      );
    const coveredFourHour = (session: MarketSessionWindow) =>
      plannedFourHourBuckets(session).every(
        (bucket) =>
          fourHourRows.get(bucket.openMs) === bucket.closeMs ||
          (bucket.openMs >= recentFromMs &&
            fiveMinuteComplete(
              bucket.openMs,
              Math.min(
                bucket.closeMs,
                resolveRequiredFiveMinuteSlotEndMs(session),
              ),
            )),
      );
    const coveredDaily = (session: MarketSessionWindow) => {
      const window = resolvePeriodWindowForDate(
        asset.market,
        session.localDate.replace(/-/gu, ''),
        '1d',
      );
      return window !== null && dailyOpens.has(window.openTime.getTime());
    };

    const explain =
      (chart: StockChartKey) =>
      (session: MarketSessionWindow): Explanation => {
        if (listedOn !== null && session.localDate < listedOn) return 'listing';
        if (
          collectionStart !== null &&
          FIVE_MINUTE_CHARTS.has(chart) &&
          session.closeTime.getTime() <= collectionStart.getTime()
        )
          return 'collection_start';
        if (
          asset.market === 'US' &&
          this.limits.usIntradayHistoryFrom !== undefined &&
          chart !== '1d' &&
          session.localDate < this.limits.usIntradayHistoryFrom
        )
          return 'provider';
        return null;
      };

    return {
      assetId: asset.id,
      symbol: asset.symbol,
      market: asset.market,
      listedOn,
      collectionStart: collectionStart?.toISOString() ?? null,
      windows: STOCK_CHART_HISTORY_WINDOWS.map(({ chart, sessions }) =>
        judgeWindow({
          chart,
          sessions,
          newestFirst,
          calendarGap: previous.calendarGap,
          isCovered:
            chart === '4h'
              ? coveredFourHour
              : chart === '1d'
                ? coveredDaily
                : coveredFiveMinute,
          explain: explain(chart),
        }),
      ),
    };
  }

  private async assets(assetIds?: readonly string[]): Promise<AuditAsset[]> {
    const rows = await this.prisma.asset.findMany({
      where: {
        assetType: { in: [AssetType.domestic_stock, AssetType.us_stock] },
        ...(assetIds ? { id: { in: [...assetIds] } } : { isActive: true }),
      },
      orderBy: [{ assetType: 'asc' }, { symbol: 'asc' }],
      select: {
        id: true,
        symbol: true,
        assetType: true,
        market: true,
        currencyCode: true,
      },
    });
    return rows.flatMap((row): AuditAsset[] => {
      const market = row.market.trim().toUpperCase();
      if (
        row.assetType === AssetType.domestic_stock &&
        row.currencyCode === CurrencyCode.KRW &&
        KRX_MARKETS.has(market)
      )
        return [{ ...row, market: 'KRX' as const }];
      if (
        row.assetType === AssetType.us_stock &&
        row.currencyCode === CurrencyCode.USD &&
        US_MARKETS.has(market)
      )
        return [{ ...row, market: 'US' as const }];
      return [];
    });
  }
}

/**
 * Planned 4h buckets of a regular session, the long sync's and the read
 * path's own: open → open + 4h, then to the close (KRX 09:00–13:00 and
 * 13:00–15:30, US 09:30–13:30 and 13:30–16:00; one bucket on a short day).
 */
export function plannedFourHourBuckets(
  session: MarketSessionWindow,
): { openMs: number; closeMs: number }[] {
  const closeMs = session.closeTime.getTime();
  const buckets: { openMs: number; closeMs: number }[] = [];
  for (
    let openMs = session.openTime.getTime();
    openMs < closeMs;
    openMs += FOUR_HOURS_MS
  )
    buckets.push({
      openMs,
      closeMs: Math.min(openMs + FOUR_HOURS_MS, closeMs),
    });
  return buckets;
}

/**
 * The `count` sessions strictly before the market's local date of `nowMs`
 * (the chart's `prevN_open` meaning), newest first. A date without calendar
 * data stops the walk instead of passing for a holiday.
 */
export function previousSessions(
  market: 'KRX' | 'US',
  nowMs: number,
  count: number,
): { sessions: MarketSessionWindow[]; calendarGap: boolean } {
  const today = localDate(nowMs, TIME_ZONES[market]);
  const sessions: MarketSessionWindow[] = [];
  for (
    let back = 1;
    back <= MAX_LOOKBACK_DAYS && sessions.length < count;
    back += 1
  ) {
    const date = shiftDate(today, -back);
    if (!hasEffectiveMarketCalendarForDate(market, date))
      return { sessions, calendarGap: true };
    const session = resolveMarketSession(market, date.replace(/-/gu, ''));
    if (session) sessions.push(session);
  }
  return { sessions, calendarGap: sessions.length < count };
}

function judgeWindow(input: {
  chart: StockChartKey;
  sessions: number;
  newestFirst: readonly MarketSessionWindow[];
  calendarGap: boolean;
  isCovered: (session: MarketSessionWindow) => boolean;
  explain: (session: MarketSessionWindow) => Explanation;
}): StockChartWindowReport {
  const window = input.newestFirst.slice(0, input.sessions).reverse();
  const flags = window.map((session) => input.isCovered(session));
  const firstIndex = flags.indexOf(true);
  const leading: string[] = [];
  const interior: string[] = [];
  const unexplained: string[] = [];
  const explained = {
    beforeListing: 0,
    beforeCollectionStart: 0,
    beforeProviderHistory: 0,
  };
  flags.forEach((ok, index) => {
    if (ok) return;
    const session = window[index];
    (firstIndex === -1 || index < firstIndex ? leading : interior).push(
      session.localDate,
    );
    const reason = input.explain(session);
    if (reason === 'listing') explained.beforeListing += 1;
    else if (reason === 'collection_start')
      explained.beforeCollectionStart += 1;
    else if (reason === 'provider') explained.beforeProviderHistory += 1;
    else unexplained.push(session.localDate);
  });
  let state: StockChartWindowState;
  if (window.length < input.sessions && input.calendarGap)
    state = 'calendar_unavailable';
  else if (leading.length + interior.length === 0) state = 'complete';
  else if (unexplained.length > 0) state = 'incomplete';
  else if (explained.beforeProviderHistory > 0) state = 'limited_by_provider';
  else if (explained.beforeCollectionStart > 0)
    state = 'limited_by_collection_start';
  else state = 'limited_by_listing';
  return {
    chart: input.chart,
    sessionsExpected: window.length,
    sessionsCovered: flags.filter(Boolean).length,
    state,
    firstCoveredSession:
      firstIndex === -1 ? null : window[firstIndex].localDate,
    leadingMissing: gap(leading),
    interiorMissing: gap(interior),
    explained,
    unexplained: gap(unexplained),
  };
}

function summarize(
  reports: readonly StockChartAssetReport[],
): StockChartHistoryReport['summary'] {
  const empty = () =>
    Object.fromEntries(
      STOCK_CHART_HISTORY_WINDOWS.map(({ chart }) => [
        chart,
        {
          complete: 0,
          limitedByListing: 0,
          limitedByCollectionStart: 0,
          limitedByProvider: 0,
          incomplete: 0,
          calendarUnavailable: 0,
          incompleteSymbols: [] as string[],
        },
      ]),
    ) as Record<StockChartKey, StockChartSummaryCell>;
  const summary = { KRX: empty(), US: empty() };
  for (const report of reports)
    for (const window of report.windows) {
      const cell = summary[report.market][window.chart];
      switch (window.state) {
        case 'complete':
          cell.complete += 1;
          break;
        case 'limited_by_listing':
          cell.limitedByListing += 1;
          break;
        case 'limited_by_collection_start':
          cell.limitedByCollectionStart += 1;
          break;
        case 'limited_by_provider':
          cell.limitedByProvider += 1;
          break;
        case 'calendar_unavailable':
          cell.calendarUnavailable += 1;
          break;
        default:
          cell.incomplete += 1;
          cell.incompleteSymbols.push(report.symbol);
      }
    }
  return summary;
}

function gap(dates: readonly string[]): StockChartGap {
  return { count: dates.length, dates: dates.slice(0, SAMPLE_DATES) };
}

function listingKey(asset: { market: 'KRX' | 'US'; symbol: string }): string {
  return `${asset.market}:${asset.symbol.trim().toUpperCase()}`;
}

/** Listing dates recorded in the fixed universe, keyed `KRX:005930` / `US:SNDK`. */
export function fixedListings(): Map<string, string> {
  return new Map(
    KIS_FIXED_ASSET_UNIVERSE.flatMap((entry) =>
      entry.listedOn
        ? [
            [
              listingKey({
                market: entry.assetType === 'domestic_stock' ? 'KRX' : 'US',
                symbol: entry.symbol,
              }),
              entry.listedOn,
            ] as const,
          ]
        : [],
    ),
  );
}

function localDate(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
