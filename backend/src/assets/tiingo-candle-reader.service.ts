import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  inspectMarketSessionsInRange,
  resolveStockMarketSessionState,
} from '../orders/market-calendar.policy';
import { zonedDateTimeToUtc } from '../providers/kis/candles/kis-candle-time';
import type { TiingoAssetTarget } from '../providers/tiingo/tiingo-asset-map.service';
import {
  TiingoCandleService,
  listUsSessions,
  type TiingoFiveMinuteRow,
} from '../providers/tiingo/tiingo-candle.service';
import { TiingoQuoteService } from '../providers/tiingo/tiingo-quote.service';
import type {
  AssetCandlesAsset,
  AssetCandlesResponse,
  CandleInterval,
  ParsedAssetCandlesQuery,
  TiingoCandleSource,
} from './asset-candles.service';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';
import {
  CandleResponseBuilder,
  type PersistedResponseCandle,
} from './candle-response.builder';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';

const US_EASTERN_TIME_ZONE = 'America/New_York';
const FIVE_MINUTES_MS = 5 * 60_000;
const AGGREGATION_PADDING_MS = 4 * 60 * 60_000;
/** Regular-session buckets per full US session (09:30–16:00). */
const BUCKETS_PER_SESSION: Record<'5m' | '15m' | '30m' | '1h' | '4h', number> =
  { '5m': 78, '15m': 26, '30m': 13, '1h': 7, '4h': 2 };

export type TiingoCandleReadResult = {
  response: AssetCandlesResponse;
  /** Fixed provider failure code when part (or all) of the window failed. */
  stopCode: string | null;
  droppedIncompleteBuckets: number;
};

/** A provider failure left nothing to serve (mapped to 503 by the caller). */
export class TiingoCandleUnavailableError extends Error {
  constructor(readonly stopCode: string) {
    super(stopCode);
    this.name = 'TiingoCandleUnavailableError';
  }
}

/**
 * Candle reads for Tiingo-managed US equities (trial). Rows are fetched from
 * Tiingo, normalized and aggregated in memory, and answered directly: no
 * PostgreSQL rows, no Redis response cache and no live-candle store are
 * involved, so trial data never persists.
 *
 * Policies reused unchanged: the read plan's requested window and limit, the
 * stored-feed aggregation (session-anchored 15m/30m/1h/4h; US 4h = 09:30–13:30
 * and 13:30–16:00, early closes capped), incomplete-bucket dropping (never
 * interpolated) and the candle payload format. A short window is returned as
 * is; the `source.coverage` field says it is partial.
 */
@Injectable()
export class TiingoCandleReaderService {
  constructor(
    private readonly quotes: TiingoQuoteService,
    private readonly candles: TiingoCandleService,
    private readonly plans: CandleReadPlanBuilder,
    private readonly aggregation: MarketCandleAggregationService,
    private readonly responses: CandleResponseBuilder,
  ) {}

  /** The Tiingo target when this asset's candles come from the trial path
   * (official mode serves the stored Tiingo candles instead). */
  async targetFor(asset: AssetCandlesAsset): Promise<TiingoAssetTarget | null> {
    if (!this.quotes.isTrialDisplayEnabled()) return null;
    return this.quotes.targetForAsset({
      id: asset.id,
      symbol: asset.symbol,
      market: asset.market,
      assetType: asset.assetType,
      priceCurrency: asset.priceCurrency,
    });
  }

  async read(
    asset: AssetCandlesAsset,
    target: TiingoAssetTarget,
    query: ParsedAssetCandlesQuery,
  ): Promise<TiingoCandleReadResult> {
    const plan = this.plans.build(asset, query);
    const { from, to } = plan.requestedRange;
    const inspection = inspectMarketSessionsInRange(asset, from, to);
    if (inspection.calendarCovered && !inspection.hasTradingSession) {
      // Weekend/holiday-only window: confirmed empty, no provider call.
      return {
        response: this.responses.buildTiingo(asset, query, [], {
          dataset:
            query.interval === '1d' || query.interval === '1w'
              ? 'eod'
              : 'equity_intraday',
          priceAdjustment:
            query.interval === '1d' || query.interval === '1w'
              ? 'split_dividend_adjusted'
              : 'raw',
          coverage: 'empty',
          requestedSessions: 0,
          coveredSessions: 0,
          currentCandleTime: null,
        }),
        stopCode: null,
        droppedIncompleteBuckets: 0,
      };
    }
    if (query.interval === '1d' || query.interval === '1w')
      return this.readDaily(asset, target, query, from, to, plan.limit);
    return this.readIntraday(asset, target, query, from, to, plan.limit);
  }

  private async readIntraday(
    asset: AssetCandlesAsset,
    target: TiingoAssetTarget,
    query: ParsedAssetCandlesQuery,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<TiingoCandleReadResult> {
    const interval = intradayInterval(query.interval);
    const aggregated = interval !== '5m';
    const now = query.clock;
    const { rows, coverage } = await this.candles.loadFiveMinuteBars({
      symbol: target.symbol,
      from: new Date(
        from.getTime() - (aggregated ? AGGREGATION_PADDING_MS : 0),
      ),
      to,
      now,
      maxSessions: Math.ceil(limit / BUCKETS_PER_SESSION[interval]) + 1,
    });
    let usable: (PersistedResponseCandle & { current: boolean })[] = [];
    let dropped = 0;
    if (!aggregated) {
      usable = rows
        .filter(
          (row) =>
            row.openTime.getTime() >= from.getTime() &&
            row.openTime.getTime() < to.getTime(),
        )
        .map((row) => ({
          ...toResponseRow(row),
          current:
            row.openTime.getTime() <= now.getTime() &&
            now.getTime() < row.openTime.getTime() + FIVE_MINUTES_MS,
        }));
    } else if (rows.length > 0) {
      const result = this.aggregation.aggregateCandles({
        assetType: asset.assetType,
        interval,
        candles: rows,
        from,
        to,
        now,
      });
      for (const candle of result.candles) {
        if (candle.isCurrent || (candle.complete && candle.isClosed)) {
          usable.push({
            openTime: candle.openTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            amount: null,
            current: candle.isCurrent,
          });
        } else {
          // A historical bucket with missing 5m constituents is dropped.
          dropped += 1;
        }
      }
    }
    const selected = usable.slice(-limit);
    if (selected.length === 0 && coverage.stopCode)
      throw /* @diagnosticSurface internal: Mapped by AssetCandlesService to the candle provider-unavailable HTTP factory. */ new TiingoCandleUnavailableError(
        coverage.stopCode,
      );
    return {
      response: this.responses.buildTiingo(asset, query, selected, {
        dataset: 'equity_intraday',
        priceAdjustment: 'raw',
        coverage: coverageOf(
          selected.length,
          coverage.coveredSessions,
          coverage.requestedSessions,
          coverage.stopCode,
          dropped,
        ),
        requestedSessions: coverage.requestedSessions,
        coveredSessions: coverage.coveredSessions,
        currentCandleTime:
          selected.find((row) => row.current)?.openTime.toISOString() ?? null,
      }),
      stopCode: coverage.stopCode,
      droppedIncompleteBuckets: dropped,
    };
  }

  /**
   * 1d/1w from Tiingo EOD bars, split- and dividend-adjusted like the KIS
   * period feed (MODP=1). Today's bar, before the official EOD row exists, is
   * composed from today's regular-session 5m bars and marked current.
   */
  private async readDaily(
    asset: AssetCandlesAsset,
    target: TiingoAssetTarget,
    query: ParsedAssetCandlesQuery,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<TiingoCandleReadResult> {
    const now = query.clock;
    const { bars, coverage } = await this.candles.loadDailyBars({
      symbol: target.symbol,
      from,
      to,
      now,
    });
    let stopCode = coverage.stopCode;
    let dropped = 0;
    const daily = new Map<string, DailyRow>();
    for (const bar of bars) {
      const volume = bar.adjVolume ?? bar.volume;
      const openTime = etMidnight(bar.date);
      const closeTime = nextEtMidnight(bar.date);
      if (
        !openTime ||
        !closeTime ||
        !bar.adjOpen ||
        !bar.adjHigh ||
        !bar.adjLow ||
        !bar.adjClose ||
        volume === null
      ) {
        // One adjustment basis only: a bar without adjusted values is dropped.
        dropped += 1;
        continue;
      }
      daily.set(bar.date, {
        openTime,
        closeTime,
        open: bar.adjOpen,
        high: bar.adjHigh,
        low: bar.adjLow,
        close: bar.adjClose,
        volume,
        amount: null,
      });
    }
    const today = resolveStockMarketSessionState(asset, now)?.currentSession;
    if (
      today &&
      today.openTime.getTime() <= now.getTime() &&
      !daily.has(today.localDate)
    ) {
      const intraday = await this.candles.loadFiveMinuteBars({
        symbol: target.symbol,
        from: today.openTime,
        to: new Date(Math.min(now.getTime(), today.closeTime.getTime()) + 1),
        now,
        maxSessions: 1,
      });
      stopCode ??= intraday.coverage.stopCode;
      const provisional = composeDaily(intraday.rows, today.localDate);
      if (provisional) daily.set(today.localDate, provisional);
    }
    const ordered = [...daily.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, row]) => row);
    // Bucket start in [from, to), like stored reads and the aggregation: a
    // day/week that began before the window start is not shown.
    const inWindow = (openTime: Date) =>
      openTime.getTime() >= from.getTime() && openTime.getTime() < to.getTime();
    const rows = query.interval === '1w' ? composeWeekly(ordered) : ordered;
    const inRange = rows.filter((row) => inWindow(row.openTime));
    const selected = inRange.slice(-limit);
    if (selected.length === 0 && stopCode)
      throw /* @diagnosticSurface internal: Mapped by AssetCandlesService to the candle provider-unavailable HTTP factory. */ new TiingoCandleUnavailableError(
        stopCode,
      );
    const requestedSessions = listUsSessions(from, to).filter((session) => {
      const dayStart = etMidnight(session.localDate);
      return (
        dayStart !== null &&
        inWindow(dayStart) &&
        session.openTime.getTime() <= now.getTime()
      );
    }).length;
    const coveredSessions = Math.min(
      ordered.filter((row) => inWindow(row.openTime)).length,
      requestedSessions,
    );
    const last = selected.at(-1);
    return {
      response: this.responses.buildTiingo(
        asset,
        query,
        selected.map(
          ({ openTime, open, high, low, close, volume, amount }) => ({
            openTime,
            open,
            high,
            low,
            close,
            volume,
            amount,
          }),
        ),
        {
          dataset: 'eod',
          priceAdjustment: 'split_dividend_adjusted',
          coverage: coverageOf(
            selected.length,
            coveredSessions,
            requestedSessions,
            stopCode,
            dropped,
          ),
          requestedSessions,
          coveredSessions,
          // A day/week bucket is in progress until its calendar end.
          currentCandleTime:
            last && now.getTime() < last.closeTime.getTime()
              ? last.openTime.toISOString()
              : null,
        },
      ),
      stopCode,
      droppedIncompleteBuckets: dropped,
    };
  }
}

type DailyRow = PersistedResponseCandle & { closeTime: Date };

/** Interval the trial path does not serve (mapped to a 400 by the caller). */
export class TiingoCandleIntervalError extends Error {
  constructor() {
    super('TIINGO_INTERVAL_UNSUPPORTED');
    this.name = 'TiingoCandleIntervalError';
  }
}

function intradayInterval(
  interval: CandleInterval,
): '5m' | '15m' | '30m' | '1h' | '4h' {
  if (
    interval === '5m' ||
    interval === '15m' ||
    interval === '30m' ||
    interval === '1h' ||
    interval === '4h'
  )
    return interval;
  // 1m is not offered for the trial path (the app does not request it).
  throw /* @diagnosticSurface internal: Mapped by AssetCandlesService to the candle interval validation factory. */ new TiingoCandleIntervalError();
}

function toResponseRow(row: TiingoFiveMinuteRow): PersistedResponseCandle {
  return {
    openTime: row.openTime,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    amount: null,
  };
}

function coverageOf(
  returned: number,
  covered: number,
  requested: number,
  stopCode: string | null,
  dropped: number,
): TiingoCandleSource['coverage'] {
  if (returned === 0) return 'empty';
  return covered >= requested && !stopCode && dropped === 0
    ? 'complete'
    : 'partial';
}

function etMidnight(date: string): Date | null {
  return zonedDateTimeToUtc(
    date.replaceAll('-', ''),
    '000000',
    US_EASTERN_TIME_ZONE,
  );
}

function nextEtMidnight(date: string, days = 1): Date | null {
  const utc = Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000;
  return etMidnight(new Date(utc).toISOString().slice(0, 10));
}

/** Today's provisional daily bar from its regular-session 5m bars. */
function composeDaily(
  rows: readonly TiingoFiveMinuteRow[],
  date: string,
): DailyRow | null {
  const openTime = etMidnight(date);
  const closeTime = nextEtMidnight(date);
  if (!openTime || !closeTime || rows.length === 0) return null;
  let high = new Prisma.Decimal(rows[0].high);
  let low = new Prisma.Decimal(rows[0].low);
  let volume = new Prisma.Decimal(0);
  for (const row of rows) {
    if (high.lt(row.high)) high = new Prisma.Decimal(row.high);
    if (low.gt(row.low)) low = new Prisma.Decimal(row.low);
    volume = volume.add(row.volume);
  }
  return {
    openTime,
    closeTime,
    open: rows[0].open,
    high,
    low,
    close: rows[rows.length - 1].close,
    volume,
    amount: null,
  };
}

/** Monday-anchored ET weeks, like the stored KIS 1w feed. */
function composeWeekly(rows: readonly DailyRow[]): DailyRow[] {
  const weeks = new Map<string, DailyRow>();
  for (const row of rows) {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: US_EASTERN_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(row.openTime);
    const utc = Date.parse(`${date}T00:00:00.000Z`);
    const mondayOffset = (new Date(utc).getUTCDay() + 6) % 7;
    const monday = new Date(utc - mondayOffset * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const openTime = etMidnight(monday);
    const closeTime = nextEtMidnight(monday, 7);
    if (!openTime || !closeTime) continue;
    const existing = weeks.get(monday);
    if (!existing) {
      weeks.set(monday, { ...row, openTime, closeTime });
      continue;
    }
    const high = new Prisma.Decimal(row.high);
    const low = new Prisma.Decimal(row.low);
    if (high.gt(existing.high)) existing.high = high;
    if (low.lt(existing.low)) existing.low = low;
    existing.close = row.close;
    existing.volume = new Prisma.Decimal(existing.volume).add(row.volume);
  }
  return [...weeks.values()].sort(
    (a, b) => a.openTime.getTime() - b.openTime.getTime(),
  );
}
