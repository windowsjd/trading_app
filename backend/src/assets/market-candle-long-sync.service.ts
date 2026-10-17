import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { safeAdminDiagnosticLog } from '../common/admin-diagnostics';
import { classifyFailureCause } from '../common/safe-failure-cause';
import { AssetType } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  BINANCE_FUTURES_SYMBOLS,
  SPOT_ASSET_WHERE,
  isOfferedFuturesSymbol,
} from '../providers/binance/binance-product-catalog';
import { toBinanceUsdtSymbol } from '../providers/provider-target-resolver.service';
import { BinanceCandleIngestionService } from '../providers/binance/binance-candle.ingestion.service';
import { BINANCE_CANDLE_SOURCE } from '../providers/binance/binance-candle.types';
import { BINANCE_USDM_CANDLE_INGESTION } from '../providers/binance/binance-kline-usdm.client';
import { KoscomCandleAdapter } from '../providers/koscom/koscom-candle.adapter';
import { KoscomClient } from '../providers/koscom/koscom.client';
import { runWithKoscomCallCategory } from '../providers/koscom/koscom-call-context';
import { RedisService } from '../redis/redis.service';
import {
  KRX_CENTRAL_CANDLES_CONFIG,
  type KrxCentralCandlesConfig,
} from './krx-central-candles.config';
import {
  KOSCOM_HISTORY_SOURCE,
  KoscomError,
} from '../providers/koscom/koscom.config';
import {
  findPreviousMarketSession,
  resolveMarketSession,
  resolveStockMarketSessionState,
  type MarketSessionWindow,
} from '../orders/market-calendar.policy';
import { TIINGO_INTRADAY_CANDLE_SOURCE } from '../providers/tiingo/tiingo.config';
import { usSessionsBetween } from '../providers/tiingo/tiingo-candle-normalizer';
import { MarketCandleAggregationService } from './market-candle-aggregation.service';
import { usCandlesFromTiingo } from './us-candle-provider';
import { hasEffectiveMarketCalendarForDate } from '../orders/market-holidays.config';
import { formatZonedCursor } from '../providers/kis/candles/kis-candle-time';
import { parseFuturesContracts } from '../futures/futures-instrument-coverage';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import { MarketCandleBackfillLockService } from './market-candle-backfill-lock.service';
import { MarketCandlesRepository } from './market-candles.repository';
import { FuturesMarketCandlesRepository } from './market-candle-futures.repository';
import {
  KOSCOM_TEN_MINUTE_HISTORY_SOURCE,
  groupStoredKrxRows,
  isStoredKrxSessionComplete,
  verifyKrxTenMinuteSession,
  type KrxDailyReference,
  type KrxVolumeRelation,
  type StoredKrxCandle,
} from './market-candle-krx-history';

const DAY_MS = 24 * 60 * 60_000;
export const FOUR_HOURS_MS = 4 * 60 * 60_000;
const KST = 'Asia/Seoul';

/** Display/backfill windows (product policy, 2026-10-13). */
export const LONG_CANDLE_CRYPTO_WINDOW_DAYS = 96;
export const LONG_CANDLE_KRX_WINDOW_SESSIONS = 96;
/** Upper bounds: the 4h history is retained for 180 calendar days. */
export const LONG_CANDLE_MAX_CRYPTO_DAYS = 180;
export const LONG_CANDLE_MAX_KRX_SESSIONS = 125;

const DEFAULTS = {
  backfill: { cryptoDays: 96, krxSessions: 97 },
  incremental: { cryptoDays: 2, krxSessions: 5 },
} as const;
// A KRX session counts as completed this long after its calendar close.
const KRX_CLOSE_GRACE_MS = 20 * 60_000;
// A closed Binance bucket first fetched this soon after its close is fetched
// once more on the next run (late provider revisions).
const RECONFIRM_GRACE_MS = 2 * 60_000;
// The stored in-progress futures bucket is refreshed when older than this.
const FUTURES_CURRENT_REFRESH_MS = 30_000;
// Spot /api/v3/klines costs 2 weight for any limit; USDⓈ-M /fapi/v1/klines is
// cheapest per row below 500 (2 weight), and 1 weight below 100.
const SPOT_PAGE_LIMIT = 1000;
const USDM_PAGE_LIMIT = 499;
// Pause between Binance requests so Mark/Last recovery keeps a REST slot.
const BINANCE_REQUEST_SPACING_MS = 150;
const LOCK_TTL_SECONDS = 600;
const LOCK_RENEW_SECONDS = 60;
const KRX_MAX_CONSECUTIVE_FAILURES = 3;
const KRX_DAILY_PAGE_SESSIONS = 100;

/** KOSCOM failures that stop the whole run (budget/coordination/credentials). */
const KOSCOM_STOP_CODES = new Set([
  'KOSCOM_RATE_LIMITED',
  'KOSCOM_BUDGET_EXHAUSTED',
  'KOSCOM_AUTH_FAILED',
  'KOSCOM_DISABLED',
  'KOSCOM_COORDINATION_UNAVAILABLE',
  'KOSCOM_QUEUE_FULL',
  'KOSCOM_QUEUE_TIMEOUT',
  'KOSCOM_CANCELED',
]);
/** KOSCOM failures that describe the returned DATA: the session is held. */
const KOSCOM_DATA_CODES = new Set([
  'KOSCOM_MALFORMED_CANDLES',
  'KOSCOM_CANDLE_DATE_MISMATCH',
  'KOSCOM_INVALID_OHLC',
  'KOSCOM_CONFLICTING_CANDLES',
]);

/**
 * Ops job lock keys shared by the scheduled runs and the operator backfill
 * command, so the two never overlap for the same job.
 */
export const MARKET_CANDLE_LONG_SYNC_LOCK_KEY = 'market_candle_long_sync';
export const FUTURES_CANDLE_SYNC_LOCK_KEY = 'futures_candle_sync';

export type LongCandleMarket = 'spot' | 'krx' | 'us' | 'futures';

/** US 4h rows synthesized from stored Tiingo 5m (2026-10-17). */
export const TIINGO_US_FOUR_HOUR_SOURCE = 'tiingo_equity_intraday_4h';
export type LongCandleSyncMode = 'backfill' | 'incremental';

export type LongCandleKrxOptions = {
  /** Hard cap of KOSCOM calls in this run (10-minute + daily). */
  maxCalls?: number;
  /** Stop once an observed X-RateLimit-Remaining-Day is at or below this. */
  minRemainingDaily?: number;
  /** Minimum spacing between this run's KOSCOM calls. */
  minCallIntervalMs?: number;
  /** Refuse to run while the KRX regular session is open unless true. */
  allowDuringSession?: boolean;
  /**
   * When the stored `koscom_history` daily bar is missing, fetch the KOSCOM
   * daily history (1 call per ≤100 sessions). Incremental runs keep this off
   * and reuse the bars the existing 1d sync stores (no duplicate polling).
   */
  fetchMissingDaily?: boolean;
};

export type LongCandleSyncInput = {
  mode: LongCandleSyncMode;
  now?: Date;
  dryRun?: boolean;
  signal?: AbortSignal;
  /** Spot/KRX asset selection (default: every active asset of the market). */
  assetIds?: readonly string[];
  /** Futures instrument selection (default: approved + open-position instruments). */
  instrumentIds?: readonly string[];
  /** Explicit instrumentIds may name an inactive instrument (history only). */
  includeInactiveFutures?: boolean;
  /** Crypto window in days (spot/futures). */
  days?: number;
  /** KRX/US window in completed sessions. */
  sessions?: number;
  krx?: LongCandleKrxOptions;
};

export type LongCandleSeriesStatus =
  | 'up_to_date'
  | 'synced'
  | 'partial'
  | 'planned'
  | 'skipped'
  | 'failed';

export type LongCandleSeriesResult = {
  market: LongCandleMarket;
  seriesId: string;
  symbol: string;
  status: LongCandleSeriesStatus;
  /** Expected closed 4h buckets (crypto) or completed sessions (KRX). */
  expected: number;
  missingBefore: number;
  rowsWritten: number;
  providerCalls: number;
  held: { date: string; reason: string; detail?: string }[];
  pending: { date: string; reason: string }[];
  volumeRelations?: Record<KrxVolumeRelation, number>;
  errorCode: string | null;
};

export type LongCandleStopReason =
  | 'call_cap'
  | 'quota_reserve'
  | 'provider_unavailable'
  | 'canceled'
  | 'krx_session_open'
  | 'calendar_unavailable';

export type LongCandleSyncSummary = {
  market: LongCandleMarket;
  mode: LongCandleSyncMode;
  dryRun: boolean;
  window: {
    from: string | null;
    to: string | null;
    unit: 'days' | 'sessions';
    size: number;
  };
  startedAt: string;
  finishedAt: string;
  series: LongCandleSeriesResult[];
  totals: {
    series: number;
    rowsWritten: number;
    providerCalls: number;
    held: number;
    pending: number;
    /** Series that ended with an error, including partially written ones. */
    failed: number;
    /** Target series never attempted because the run stopped first. */
    notStarted: number;
  };
  stopReason: LongCandleStopReason | null;
  /**
   * The outcome the Ops runner and the backfill command record: true when a
   * series ended with an error (lock not acquired or lost, provider or storage
   * failure) or the run was canceled. Planned stops (call cap, quota reserve,
   * open session, calendar gap), held/pending sessions and deliberate skips
   * are not failures.
   */
  runFailed: boolean;
  /** Lowest KOSCOM X-RateLimit-Remaining-Day seen during the run (KRX only). */
  observedRemainingDaily?: number | null;
};

type RunContext = {
  now: Date;
  dryRun: boolean;
  signal?: AbortSignal;
  stopReason: LongCandleStopReason | null;
};

type KrxRunContext = RunContext & {
  calls: number;
  maxCalls: number;
  minRemainingDaily: number;
  minCallIntervalMs: number;
  lastCallAtMs: number;
  observedRemaining: number | null;
  startedAtMs: number;
};

export class LongCandleSyncInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LongCandleSyncInputError';
  }
}

/**
 * Backfill and incremental upkeep of the long-range COMPLETED 4h history.
 *
 *  - Spot: Binance Spot native 4h klines → market_candles(interval '4h').
 *  - KRX: KOSCOM 10-minute history, verified per session against the dated
 *    daily bar → market_candles(interval '4h', source koscom_history_10m).
 *  - Futures: Binance USDⓈ-M contract 4h klines per FuturesInstrument →
 *    futures_market_candles (never market_candles; never Spot data).
 *
 * The stored rows are the progress record: a rerun only asks the provider for
 * buckets/sessions that are not stored yet, so an interrupted run resumes
 * without refetching verified data, and duplicate runs converge through the
 * idempotent upserts and per-series Redis locks. Nothing here runs inside an
 * HTTP chart request, and nothing changes a price used for orders, fills,
 * TP/SL, valuation or liquidation.
 */
@Injectable()
export class MarketCandleLongSyncService {
  private readonly logger = new Logger(MarketCandleLongSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MarketCandlesRepository,
    private readonly futuresRepository: FuturesMarketCandlesRepository,
    private readonly locks: MarketCandleBackfillLockService,
    private readonly cache: AssetCandlesCacheService,
    private readonly spotCandles: BinanceCandleIngestionService,
    @Inject(BINANCE_USDM_CANDLE_INGESTION)
    private readonly usdmCandles: BinanceCandleIngestionService,
    private readonly koscom: KoscomCandleAdapter,
    private readonly koscomClient: KoscomClient,
    @Optional() private readonly redis?: RedisService,
    @Optional()
    @Inject(KRX_CENTRAL_CANDLES_CONFIG)
    private readonly krxCentral?: KrxCentralCandlesConfig,
  ) {}

  // ---------------------------------------------------------------- Spot --

  async syncSpot(input: LongCandleSyncInput): Promise<LongCandleSyncSummary> {
    const context = this.context(input);
    const days = this.cryptoDays(input);
    const window = cryptoWindow(context.now, days);
    const startedAt = new Date();
    const assets = await this.prisma.asset.findMany({
      where: {
        assetType: AssetType.crypto,
        ...SPOT_ASSET_WHERE,
        ...(input.assetIds
          ? { id: { in: [...input.assetIds] } }
          : { isActive: true }),
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true },
    });
    const series: LongCandleSeriesResult[] = [];
    for (const asset of assets) {
      if (this.stopped(context)) break;
      series.push(await this.syncSpotAsset(asset, window, context));
    }
    return this.summary(
      'spot',
      input,
      context,
      startedAt,
      series,
      { from: window.from, to: window.closedTo, unit: 'days', size: days },
      assets.length,
    );
  }

  private async syncSpotAsset(
    asset: { id: string; symbol: string },
    window: CryptoWindow,
    context: RunContext,
  ): Promise<LongCandleSeriesResult> {
    const result = emptySeries('spot', asset.id, asset.symbol);
    const symbol = toBinanceUsdtSymbol(asset.symbol.trim().toUpperCase());
    if (!symbol)
      return {
        ...result,
        status: 'skipped',
        errorCode: 'INVALID_BINANCE_SYMBOL',
      };
    const stored = await this.repository.findRange({
      assetId: asset.id,
      interval: '4h',
      from: window.from,
      to: window.closedTo,
    });
    const plan = planCryptoFetch(window, stored, context.now, false);
    result.expected = plan.expected;
    result.missingBefore = plan.missing;
    if (!plan.fetchFrom) return { ...result, status: 'up_to_date' };
    if (context.dryRun) {
      result.providerCalls = Math.ceil(
        (window.closedTo.getTime() - plan.fetchFrom.getTime()) /
          FOUR_HOURS_MS /
          SPOT_PAGE_LIMIT,
      );
      return { ...result, status: 'planned' };
    }
    return this.withSeriesLock(asset.id, 'long-4h', result, async (renew) => {
      let cursor: { startTime: number } | null = null;
      let errorCode: string | null = null;
      do {
        if (this.stopped(context) || !(await renew())) {
          return { ...result, status: 'partial', errorCode: 'INTERRUPTED' };
        }
        await this.spaceBinanceRequest(result.providerCalls);
        const page = await this.spotCandles.fetchKlinesPage({
          symbol,
          interval: '4h',
          from: plan.fetchFrom as Date,
          to: window.closedTo,
          cursor,
          now: context.now,
          limit: SPOT_PAGE_LIMIT,
        });
        result.providerCalls += 1;
        // Spot keeps only CLOSED buckets: the current Spot bucket is served
        // from the live 5m aggregation, never from a stored provisional row.
        const closed = page.candles.filter((candle) => candle.isClosed);
        if (closed.length > 0) {
          const written = await this.repository.upsertMany(
            closed.map((candle) => ({
              assetId: asset.id,
              interval: '4h' as const,
              openTime: candle.openTime,
              closeTime: candle.closeTime,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              amount: candle.amount,
              isClosed: true,
              sourceProvider: BINANCE_CANDLE_SOURCE,
              sourceUpdatedAt: candle.sourceUpdatedAt,
            })),
          );
          result.rowsWritten += written.writtenCount;
        }
        if (
          page.stopReason === 'malformed_response' ||
          page.stopReason === 'cursor_not_advanced'
        ) {
          errorCode = `PROVIDER_${page.stopReason.toUpperCase()}`;
          break;
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (result.rowsWritten > 0) await this.invalidateAsset(asset.id);
      return { ...result, errorCode, status: errorCode ? 'partial' : 'synced' };
    });
  }

  // ------------------------------------------------------------------ US --

  /**
   * US stocks on Tiingo (2026-10-17): COMPLETED 4h buckets — 09:30–13:30 and
   * 13:30–16:00 New York, one 09:30–13:00 bucket on early-close days, the
   * read-time aggregation's own buckets — synthesized from the stored Tiingo
   * 5m rows, and only when every regular 5m slot of the bucket is stored
   * (never interpolated). No provider call: the 5m sync and its backfill
   * fetch the bars; these rows keep the 96-session 4h chart beyond the 5m
   * retention. On the KIS provider nothing runs (no stored US 4h there).
   */
  async syncUs(input: LongCandleSyncInput): Promise<LongCandleSyncSummary> {
    const context = this.context(input);
    const sessions = this.krxSessions(input);
    const startedAt = new Date();
    const usAsset = { assetType: AssetType.us_stock, market: 'NAS' };
    if (!usCandlesFromTiingo(usAsset))
      return this.summary(
        'us',
        input,
        context,
        startedAt,
        [],
        { from: null, to: null, unit: 'sessions', size: sessions },
        0,
      );
    const anchor = findPreviousMarketSession(usAsset, context.now, sessions);
    const window = anchor
      ? usSessionsBetween(anchor.openTime.getTime(), context.now.getTime())
      : null;
    const completed = (window ?? []).filter(
      (session) =>
        session.openTime.getTime() >= (anchor?.openTime.getTime() ?? 0) &&
        session.closeTime.getTime() <= context.now.getTime(),
    );
    if (!anchor || !window || completed.length === 0) {
      context.stopReason = 'calendar_unavailable';
      return this.summary(
        'us',
        input,
        context,
        startedAt,
        [],
        { from: null, to: null, unit: 'sessions', size: sessions },
        0,
      );
    }
    const range = {
      from: completed[0].openTime,
      to: completed[completed.length - 1].closeTime,
    };
    const assets = await this.prisma.asset.findMany({
      where: {
        assetType: AssetType.us_stock,
        ...(input.assetIds
          ? { id: { in: [...input.assetIds] } }
          : { isActive: true }),
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true },
    });
    const series: LongCandleSeriesResult[] = [];
    for (const asset of assets) {
      if (this.stopped(context)) break;
      series.push(await this.syncUsAsset(asset, completed, range, context));
    }
    return this.summary(
      'us',
      input,
      context,
      startedAt,
      series,
      { ...range, unit: 'sessions', size: sessions },
      assets.length,
    );
  }

  private async syncUsAsset(
    asset: { id: string; symbol: string },
    sessions: readonly MarketSessionWindow[],
    range: { from: Date; to: Date },
    context: RunContext,
  ): Promise<LongCandleSeriesResult> {
    const result = emptySeries('us', asset.id, asset.symbol);
    const [storedHistory, storedFiveMinute] = await Promise.all([
      this.repository.findRange({
        assetId: asset.id,
        interval: '4h',
        from: range.from,
        to: range.to,
      }),
      this.repository.findRange({
        assetId: asset.id,
        interval: '5m',
        from: range.from,
        to: range.to,
      }),
    ]);
    const stored = new Set(
      storedHistory
        .filter(
          (row) =>
            row.isClosed && row.sourceProvider === TIINGO_US_FOUR_HOUR_SOURCE,
        )
        .map((row) => row.openTime.getTime()),
    );
    const buckets = this.usAggregation().aggregateCandles({
      assetType: AssetType.us_stock,
      interval: '4h',
      candles: storedFiveMinute.filter(
        (row) =>
          row.sourceProvider === TIINGO_INTRADAY_CANDLE_SOURCE && row.isClosed,
      ),
      from: range.from,
      to: range.to,
      now: context.now,
    }).candles;
    // Two buckets per session, one on an early-close day.
    result.expected = sessions.reduce(
      (sum, session) =>
        sum +
        (session.closeTime.getTime() - session.openTime.getTime() >
        FOUR_HOURS_MS
          ? 2
          : 1),
      0,
    );
    result.missingBefore = Math.max(0, result.expected - stored.size);
    const ready = buckets.filter(
      (bucket) =>
        bucket.complete &&
        bucket.isClosed &&
        !bucket.isCurrent &&
        !stored.has(bucket.openTime.getTime()),
    );
    // A session whose 5m bars are not all stored yet stays pending (the 5m
    // sync or backfill fills it; nothing is synthesized from a partial day).
    const covered = new Set([
      ...stored,
      ...ready.map((bucket) => bucket.openTime.getTime()),
    ]);
    result.pending = sessions
      .filter(
        (session) =>
          ![...covered].some(
            (openMs) =>
              openMs >= session.openTime.getTime() &&
              openMs < session.closeTime.getTime(),
          ),
      )
      .map((session) => ({
        date: session.localDate,
        reason: 'five_minute_incomplete',
      }));
    if (ready.length === 0) return result;
    if (context.dryRun) return { ...result, status: 'planned' };
    return this.withSeriesLock(asset.id, 'long-4h', result, async (renew) => {
      if (this.stopped(context) || !(await renew()))
        return { ...result, status: 'partial', errorCode: 'INTERRUPTED' };
      const written = await this.repository.upsertMany(
        ready.map((bucket) => ({
          assetId: asset.id,
          interval: '4h' as const,
          openTime: bucket.openTime,
          closeTime: bucket.closeTime,
          open: bucket.open,
          high: bucket.high,
          low: bucket.low,
          close: bucket.close,
          volume: bucket.volume,
          amount: null,
          isClosed: true,
          sourceProvider: TIINGO_US_FOUR_HOUR_SOURCE,
          sourceUpdatedAt: bucket.sourceUpdatedAt,
        })),
      );
      result.rowsWritten += written.writtenCount;
      if (result.rowsWritten > 0) await this.invalidateAsset(asset.id);
      return { ...result, status: 'synced' };
    });
  }

  private usAggregation(): MarketCandleAggregationService {
    // Stateless bucket rules (the read path's own); no repository read here.
    return new MarketCandleAggregationService(this.repository);
  }

  // ------------------------------------------------------------- Futures --

  async syncFutures(
    input: LongCandleSyncInput,
  ): Promise<LongCandleSyncSummary> {
    const context = this.context(input);
    const days = this.cryptoDays(input);
    const window = cryptoWindow(context.now, days);
    const startedAt = new Date();
    if (input.includeInactiveFutures && !input.instrumentIds?.length) {
      // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
      throw new LongCandleSyncInputError(
        'includeInactiveFutures requires explicit instrumentIds.',
      );
    }
    const instruments = await this.prisma.futuresInstrument.findMany({
      where: input.instrumentIds
        ? { id: { in: [...input.instrumentIds] } }
        : {
            OR: [
              {
                isActive: true,
                markVerifiedAt: { not: null },
                underlyingAsset: {
                  isActive: true,
                  symbol: { in: [...BINANCE_FUTURES_SYMBOLS] },
                },
              },
              { positions: { some: { status: 'open' } } },
            ],
          },
      orderBy: [{ id: 'asc' }],
      select: {
        id: true,
        isActive: true,
        productType: true,
        settlementCurrency: true,
        markContractJson: true,
        underlyingAsset: {
          select: { symbol: true, market: true, assetType: true },
        },
      },
    });
    const series: LongCandleSeriesResult[] = [];
    for (const instrument of instruments.sort((a, b) =>
      a.underlyingAsset.symbol.localeCompare(b.underlyingAsset.symbol),
    )) {
      if (this.stopped(context)) break;
      const symbol = instrument.underlyingAsset.symbol;
      const base = emptySeries('futures', instrument.id, symbol);
      const identityOk =
        isOfferedFuturesSymbol(symbol) &&
        /^[A-Z0-9]+USDT$/u.test(symbol) &&
        instrument.productType === 'synthetic_perpetual' &&
        instrument.settlementCurrency === 'USD' &&
        instrument.underlyingAsset.market === 'BINANCE' &&
        instrument.underlyingAsset.assetType === 'crypto';
      if (!identityOk) {
        series.push({
          ...base,
          status: 'skipped',
          errorCode: 'INSTRUMENT_NOT_IN_CATALOG',
        });
        continue;
      }
      if (
        !instrument.isActive &&
        !input.includeInactiveFutures &&
        input.instrumentIds
      ) {
        series.push({
          ...base,
          status: 'skipped',
          errorCode: 'INSTRUMENT_INACTIVE',
        });
        continue;
      }
      // Only an exact verified USDⓈ-M PERPETUAL contract mapping is collected.
      if (
        !parseFuturesContracts({ symbols: [instrument.markContractJson] }).has(
          symbol,
        )
      ) {
        series.push({
          ...base,
          status: 'skipped',
          errorCode: 'CONTRACT_UNVERIFIED',
        });
        continue;
      }
      series.push(
        await this.syncFuturesInstrument(
          instrument.id,
          symbol,
          window,
          context,
        ),
      );
    }
    return this.summary(
      'futures',
      input,
      context,
      startedAt,
      series,
      { from: window.from, to: window.closedTo, unit: 'days', size: days },
      instruments.length,
    );
  }

  private async syncFuturesInstrument(
    instrumentId: string,
    symbol: string,
    window: CryptoWindow,
    context: RunContext,
  ): Promise<LongCandleSeriesResult> {
    const result = emptySeries('futures', instrumentId, symbol);
    const stored = await this.futuresRepository.findRange({
      futuresInstrumentId: instrumentId,
      interval: '4h',
      from: window.from,
      to: window.currentTo,
    });
    const plan = planCryptoFetch(window, stored, context.now, true);
    result.expected = plan.expected;
    result.missingBefore = plan.missing;
    if (!plan.fetchFrom) return { ...result, status: 'up_to_date' };
    if (context.dryRun) {
      result.providerCalls = Math.ceil(
        (window.currentTo.getTime() - plan.fetchFrom.getTime()) /
          FOUR_HOURS_MS /
          USDM_PAGE_LIMIT,
      );
      return { ...result, status: 'planned' };
    }
    return this.withSeriesLock(
      `futures-instrument:${instrumentId}`,
      'usdm-4h',
      result,
      async (renew) => {
        let cursor: { startTime: number } | null = null;
        let errorCode: string | null = null;
        do {
          if (this.stopped(context) || !(await renew())) {
            return { ...result, status: 'partial', errorCode: 'INTERRUPTED' };
          }
          await this.spaceBinanceRequest(result.providerCalls);
          const remainingSlots = Math.ceil(
            (window.currentTo.getTime() -
              (cursor?.startTime ?? (plan.fetchFrom as Date).getTime())) /
              FOUR_HOURS_MS,
          );
          const page = await this.usdmCandles.fetchKlinesPage({
            symbol,
            interval: '4h',
            from: plan.fetchFrom as Date,
            to: window.currentTo,
            cursor,
            now: context.now,
            limit: Math.max(1, Math.min(USDM_PAGE_LIMIT, remainingSlots)),
          });
          result.providerCalls += 1;
          if (page.candles.length > 0) {
            const written = await this.futuresRepository.upsertMany(
              page.candles.map((candle) => ({
                futuresInstrumentId: instrumentId,
                interval: '4h' as const,
                contractSymbol: symbol,
                openTime: candle.openTime,
                closeTime: candle.closeTime,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                amount: candle.amount,
                // The open bucket is stored as provisional (isClosed=false)
                // and finalized by a later run once its window has passed.
                isClosed: candle.isClosed,
                sourceUpdatedAt: candle.sourceUpdatedAt,
              })),
            );
            result.rowsWritten += written.writtenCount;
          }
          if (
            page.stopReason === 'malformed_response' ||
            page.stopReason === 'cursor_not_advanced'
          ) {
            errorCode = `PROVIDER_${page.stopReason.toUpperCase()}`;
            break;
          }
          cursor = page.nextCursor;
        } while (cursor);
        return {
          ...result,
          errorCode,
          status: errorCode ? 'partial' : 'synced',
        };
      },
    );
  }

  // ----------------------------------------------------------------- KRX --

  syncKrx(input: LongCandleSyncInput): Promise<LongCandleSyncSummary> {
    // Daily references fetched here serve the 4h verification, not the 1d feed.
    return runWithKoscomCallCategory(
      input.mode === 'backfill' ? 'backfill' : 'long_4h',
      () => this.syncKrxInContext(input),
    );
  }

  private async syncKrxInContext(
    input: LongCandleSyncInput,
  ): Promise<LongCandleSyncSummary> {
    const base = this.context(input);
    const sessionsWanted = this.krxSessions(input);
    const defaults =
      input.mode === 'backfill'
        ? { maxCalls: 1500, minCallIntervalMs: 1000, fetchMissingDaily: true }
        : { maxCalls: 60, minCallIntervalMs: 250, fetchMissingDaily: false };
    const context: KrxRunContext = {
      ...base,
      calls: 0,
      maxCalls: positive(
        input.krx?.maxCalls,
        defaults.maxCalls,
        'krx.maxCalls',
      ),
      minRemainingDaily: nonNegative(
        input.krx?.minRemainingDaily,
        20_000,
        'krx.minRemainingDaily',
      ),
      minCallIntervalMs: nonNegative(
        input.krx?.minCallIntervalMs,
        defaults.minCallIntervalMs,
        'krx.minCallIntervalMs',
      ),
      lastCallAtMs: 0,
      observedRemaining: null,
      startedAtMs: Date.now(),
    };
    const fetchMissingDaily =
      input.krx?.fetchMissingDaily ?? defaults.fetchMissingDaily;
    const startedAt = new Date();
    const finish = (
      series: LongCandleSeriesResult[],
      sessions: MarketSessionWindow[],
      targets = series.length,
    ) => ({
      ...this.summary(
        'krx',
        input,
        context,
        startedAt,
        series,
        {
          from: sessions[0]?.openTime ?? null,
          to: sessions.at(-1)?.closeTime ?? null,
          unit: 'sessions' as const,
          size: sessionsWanted,
        },
        targets,
      ),
      observedRemainingDaily: context.observedRemaining,
    });

    const state = resolveStockMarketSessionState(
      { assetType: 'domestic_stock', market: 'KRX' },
      context.now,
    );
    if (state?.state === 'open' && !input.krx?.allowDuringSession) {
      // Live KOSCOM price/order-book polling owns the budget during the session.
      context.stopReason = 'krx_session_open';
      return finish([], []);
    }
    const enumerated = enumerateCompletedKrxSessions(
      context.now,
      sessionsWanted,
    );
    if (enumerated.calendarGap && enumerated.sessions.length < sessionsWanted) {
      context.stopReason = 'calendar_unavailable';
    }
    const sessions = enumerated.sessions;
    if (sessions.length === 0) return finish([], sessions);

    const assets = await this.prisma.asset.findMany({
      where: {
        assetType: AssetType.domestic_stock,
        ...(input.assetIds
          ? { id: { in: [...input.assetIds] } }
          : { isActive: true }),
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: { id: true, symbol: true, market: true },
    });
    const series: LongCandleSeriesResult[] = [];
    // F23 (central mode): a held session is retried once on a later trading
    // day, then left to the operator backfill (which ignores the backoff).
    const heldBackoff =
      this.krxCentral?.enabled === true &&
      this.redis !== undefined &&
      input.mode === 'incremental';
    for (const asset of assets) {
      if (this.stopped(context)) break;
      series.push(
        await this.syncKrxAsset(
          asset,
          sessions,
          context,
          fetchMissingDaily,
          heldBackoff,
        ),
      );
    }
    return finish(series, sessions, assets.length);
  }

  private heldKey(assetId: string, date: string): string {
    return `koscom:krx-long4h-held:${assetId}:${date}`;
  }

  /** Whether a held session may be fetched again under the F23 backoff. */
  private async heldRetryAllowed(
    assetId: string,
    date: string,
    latestSessionDate: string,
  ): Promise<boolean> {
    try {
      const raw = await this.redis!.get(this.heldKey(assetId, date));
      if (!raw) return true;
      const record = JSON.parse(raw) as {
        attempts?: number;
        afterSession?: string;
      };
      return (
        (record.attempts ?? 0) < 2 &&
        typeof record.afterSession === 'string' &&
        record.afterSession < latestSessionDate
      );
    } catch {
      return true;
    }
  }

  private async recordHeld(
    assetId: string,
    date: string,
    latestSessionDate: string,
  ): Promise<void> {
    try {
      const key = this.heldKey(assetId, date);
      const raw = await this.redis!.get(key);
      const attempts = raw
        ? ((JSON.parse(raw) as { attempts?: number }).attempts ?? 0) + 1
        : 1;
      await this.redis!.setWithTtl(
        key,
        JSON.stringify({ attempts, afterSession: latestSessionDate }),
        60 * 24 * 60 * 60,
      );
      if (attempts >= 2)
        this.logger.warn(
          JSON.stringify({
            event: 'krx_long4h_session_held',
            assetId,
            sessionDate: date,
            attempts,
          }),
        );
    } catch {
      // Without Redis the session is simply retried next run (old behaviour).
    }
  }

  private async syncKrxAsset(
    asset: { id: string; symbol: string; market: string },
    sessions: readonly MarketSessionWindow[],
    context: KrxRunContext,
    fetchMissingDaily: boolean,
    heldBackoff = false,
  ): Promise<LongCandleSeriesResult> {
    const volumeRelations: Record<KrxVolumeRelation, number> = {
      equal: 0,
      session_less: 0,
      session_greater: 0,
    };
    const result: LongCandleSeriesResult = {
      ...emptySeries('krx', asset.id, asset.symbol),
      volumeRelations,
    };
    result.expected = sessions.length;
    if (!/^\d{6}$/u.test(asset.symbol)) {
      return { ...result, status: 'skipped', errorCode: 'INVALID_KRX_SYMBOL' };
    }
    // One session earlier than the window: the comparison baseline for the
    // first session's repeated-previous-session check.
    const baselineFrom = new Date(sessions[0].openTime.getTime() - 10 * DAY_MS);
    const storedRows = await this.repository.findRange({
      assetId: asset.id,
      interval: '4h',
      from: baselineFrom,
      to: sessions[sessions.length - 1].closeTime,
    });
    const storedBySession = groupStoredKrxRows(storedRows);
    const missing = sessions.filter(
      (session) => !isStoredKrxSessionComplete(session, storedBySession),
    );
    result.missingBefore = missing.length;
    if (missing.length === 0) return { ...result, status: 'up_to_date' };

    const dailyRefs = await this.storedKoscomDailyReferences(
      asset.id,
      missing[0].openTime,
      missing[missing.length - 1].closeTime,
    );
    const needDaily = missing.filter((s) => !dailyRefs.has(localDate(s)));
    if (context.dryRun) {
      result.providerCalls =
        missing.length +
        (fetchMissingDaily
          ? Math.ceil(needDaily.length / KRX_DAILY_PAGE_SESSIONS)
          : 0);
      return { ...result, status: 'planned' };
    }

    return this.withSeriesLock(asset.id, 'long-4h', result, async (renew) => {
      let errorCode: string | null = null;
      if (fetchMissingDaily && needDaily.length > 0) {
        for (const chunk of chunkBySessionSpan(
          needDaily,
          sessions,
          KRX_DAILY_PAGE_SESSIONS,
        )) {
          if (!(await renew())) {
            errorCode = 'LOCK_LOST';
            break;
          }
          if (!(await this.admitKoscomCall(context))) break;
          result.providerCalls += 1;
          try {
            const page = await this.koscom.fetchPeriodPage({
              asset: {
                id: asset.id,
                symbol: asset.symbol,
                marketCode: asset.market,
              },
              interval: '1d',
              fromDate: localDate(chunk[0]),
              endDate: localDate(chunk[chunk.length - 1]),
              signal: context.signal,
            });
            for (const row of page.rows) {
              const value = row.value;
              const date = String(value.stck_bsop_date);
              dailyRefs.set(date, {
                open: String(value.stck_oprc),
                high: String(value.stck_hgpr),
                low: String(value.stck_lwpr),
                close: String(value.stck_clpr),
                volume: String(value.acml_vol),
                receivedAt: row.receivedAt,
              });
            }
          } catch (error) {
            const code = koscomCode(error);
            if (KOSCOM_STOP_CODES.has(code)) {
              context.stopReason = context.signal?.aborted
                ? 'canceled'
                : 'provider_unavailable';
              // Daily references come first: no session was written yet.
              return { ...result, status: 'failed', errorCode: code };
            }
            // Without dated daily bars nothing below can be verified; the
            // affected sessions simply stay pending.
            errorCode = code;
          } finally {
            this.observeKoscomQuota(context);
          }
        }
      }

      let consecutiveFailures = 0;
      let verifiedSessions = 0;
      const latestSessionDate = localDate(sessions[sessions.length - 1]);
      for (const session of missing) {
        const date = localDate(session);
        if (this.stopped(context) || errorCode === 'LOCK_LOST') break;
        const daily = dailyRefs.get(date);
        if (!daily) {
          result.pending.push({ date, reason: 'DAILY_REFERENCE_UNAVAILABLE' });
          continue;
        }
        if (
          heldBackoff &&
          !(await this.heldRetryAllowed(asset.id, date, latestSessionDate))
        ) {
          result.pending.push({ date, reason: 'HELD_BACKOFF' });
          continue;
        }
        if (!(await renew())) {
          errorCode = 'LOCK_LOST';
          break;
        }
        if (!(await this.admitKoscomCall(context))) break;
        result.providerCalls += 1;
        let page: Awaited<
          ReturnType<KoscomCandleAdapter['fetchDomesticTenMinuteSession']>
        >;
        try {
          page = await this.koscom.fetchDomesticTenMinuteSession({
            asset: { symbol: asset.symbol, marketCode: asset.market },
            date,
            openHHmm: formatZonedCursor(session.openTime, KST).time.slice(0, 4),
            closeHHmm: formatZonedCursor(session.closeTime, KST).time.slice(
              0,
              4,
            ),
            signal: context.signal,
          });
          consecutiveFailures = 0;
        } catch (error) {
          const code = koscomCode(error);
          if (KOSCOM_STOP_CODES.has(code)) {
            context.stopReason = context.signal?.aborted
              ? 'canceled'
              : 'provider_unavailable';
            errorCode = code;
            break;
          }
          if (KOSCOM_DATA_CODES.has(code)) {
            result.held.push({ date, reason: code });
            if (heldBackoff)
              await this.recordHeld(asset.id, date, latestSessionDate);
            consecutiveFailures = 0;
            continue;
          }
          errorCode = code;
          result.pending.push({ date, reason: code });
          consecutiveFailures += 1;
          if (consecutiveFailures >= KRX_MAX_CONSECUTIVE_FAILURES) break;
          continue;
        } finally {
          this.observeKoscomQuota(context);
        }
        const previous = previousStoredSession(session, storedBySession);
        const verdict = verifyKrxTenMinuteSession({
          session,
          rows: page.rows,
          invalidRows: page.invalidRows,
          daily,
          receivedAt: page.receivedAt,
          previousSessionCandles: previous,
        });
        if (verdict.status === 'held') {
          result.held.push({
            date,
            reason: verdict.reason,
            detail: verdict.detail,
          });
          if (heldBackoff)
            await this.recordHeld(asset.id, date, latestSessionDate);
          continue;
        }
        const written = await this.repository.upsertMany(
          verdict.candles.map((candle) => ({
            assetId: asset.id,
            interval: '4h' as const,
            openTime: candle.openTime,
            closeTime: candle.closeTime,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            amount: candle.amount,
            isClosed: true,
            sourceProvider: KOSCOM_TEN_MINUTE_HISTORY_SOURCE,
            sourceUpdatedAt: candle.sourceUpdatedAt,
          })),
        );
        result.rowsWritten += written.writtenCount;
        verifiedSessions += 1;
        volumeRelations[verdict.volumeRelation] += 1;
        storedBySession.set(
          date,
          verdict.candles.map((candle) => ({
            ...candle,
            sourceProvider: KOSCOM_TEN_MINUTE_HISTORY_SOURCE,
          })),
        );
      }
      if (result.rowsWritten > 0) await this.invalidateAsset(asset.id);
      if (
        errorCode === null &&
        context.stopReason === 'canceled' &&
        verifiedSessions < missing.length
      ) {
        // Same code as an interrupted crypto series: the rest was not visited.
        errorCode = 'INTERRUPTED';
      }
      let status: LongCandleSeriesStatus = 'partial';
      if (verifiedSessions === missing.length) status = 'synced';
      else if (
        verifiedSessions === 0 &&
        result.held.length === 0 &&
        errorCode !== null
      ) {
        status = 'failed';
      }
      return { ...result, errorCode, status };
    });
  }

  private async storedKoscomDailyReferences(
    assetId: string,
    from: Date,
    to: Date,
  ): Promise<Map<string, KrxDailyReference>> {
    // 1d rows open at local midnight; widen by a day on both ends.
    const rows = await this.repository.findRange({
      assetId,
      interval: '1d',
      from: new Date(from.getTime() - DAY_MS),
      to: new Date(to.getTime() + DAY_MS),
    });
    const refs = new Map<string, KrxDailyReference>();
    for (const row of rows) {
      // Only the same supplier's dated daily bar is accepted as attribution
      // evidence (live-verified 2026-10-13). Older KIS daily rows are not,
      // and neither is a bar captured before that session's close.
      if (row.sourceProvider !== KOSCOM_HISTORY_SOURCE || !row.isClosed)
        continue;
      const date = formatZonedCursor(row.openTime, KST).date;
      const session = resolveMarketSession('KRX', date);
      if (
        !session ||
        row.sourceUpdatedAt.getTime() < session.closeTime.getTime()
      ) {
        continue;
      }
      refs.set(date, {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        receivedAt: row.sourceUpdatedAt,
      });
    }
    return refs;
  }

  private async admitKoscomCall(context: KrxRunContext): Promise<boolean> {
    if (context.signal?.aborted) {
      context.stopReason = 'canceled';
      return false;
    }
    if (context.calls >= context.maxCalls) {
      context.stopReason = 'call_cap';
      return false;
    }
    if (
      context.observedRemaining !== null &&
      context.observedRemaining <= context.minRemainingDaily
    ) {
      context.stopReason = 'quota_reserve';
      return false;
    }
    const waitMs =
      context.lastCallAtMs + context.minCallIntervalMs - Date.now();
    if (waitMs > 0) await sleep(waitMs, context.signal);
    if (context.signal?.aborted) {
      context.stopReason = 'canceled';
      return false;
    }
    context.calls += 1;
    context.lastCallAtMs = Date.now();
    return true;
  }

  private observeKoscomQuota(context: KrxRunContext): void {
    const observed = this.koscomClient.getLastObservedRateLimit();
    if (
      !observed ||
      observed.remainingDay === null ||
      observed.observedAt.getTime() < context.startedAtMs
    ) {
      return;
    }
    // Several remaining-count streams were observed live: keep the LOWEST.
    context.observedRemaining =
      context.observedRemaining === null
        ? observed.remainingDay
        : Math.min(context.observedRemaining, observed.remainingDay);
  }

  // -------------------------------------------------------------- shared --

  private async withSeriesLock(
    key: string,
    feed: string,
    result: LongCandleSeriesResult,
    work: (renew: () => Promise<boolean>) => Promise<LongCandleSeriesResult>,
  ): Promise<LongCandleSeriesResult> {
    const acquired = await this.locks.acquire({
      assetId: key,
      feed,
      ttlSeconds: LOCK_TTL_SECONDS,
      renewSeconds: LOCK_RENEW_SECONDS,
    });
    if (!acquired.acquired) {
      // Like market_candle_sync: no mutual exclusion means nothing was synced.
      // Scheduled runs and the backfill command already share one Ops job
      // lock, so a busy series lock signals a stale or foreign writer.
      return {
        ...result,
        status: 'failed',
        errorCode:
          acquired.reason === 'busy' ? 'LOCK_BUSY' : 'LOCK_UNAVAILABLE',
      };
    }
    try {
      return await work(() => this.locks.renewIfDue(acquired.handle));
    } catch (error) {
      this.logger.warn(
        safeAdminDiagnosticLog({
          event: 'long_candle_series_failed',
          market: result.market,
          seriesId: result.seriesId,
          safeCause: classifyFailureCause(error),
        }),
      );
      return {
        ...result,
        status: result.rowsWritten > 0 ? 'partial' : 'failed',
        errorCode: errorCodeOf(error),
      };
    } finally {
      await this.locks.release(acquired.handle).catch(() => false);
    }
  }

  private async invalidateAsset(assetId: string): Promise<void> {
    const outcome = await this.cache.invalidateAsset(assetId);
    if (outcome.status === 'error') {
      this.logger.warn(
        JSON.stringify({
          event: 'long_candle_cache_invalidation_failed',
          assetId,
        }),
      );
    }
  }

  private async spaceBinanceRequest(callsSoFar: number): Promise<void> {
    if (callsSoFar > 0) await sleep(BINANCE_REQUEST_SPACING_MS);
  }

  private context(input: LongCandleSyncInput): RunContext {
    if (input.mode !== 'backfill' && input.mode !== 'incremental') {
      // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
      throw new LongCandleSyncInputError(
        'mode must be backfill or incremental.',
      );
    }
    const now = input.now ?? new Date();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
      throw new LongCandleSyncInputError('now must be a valid Date.');
    }
    return {
      now,
      dryRun: input.dryRun === true,
      signal: input.signal,
      stopReason: null,
    };
  }

  private cryptoDays(input: LongCandleSyncInput): number {
    const days = input.days ?? DEFAULTS[input.mode].cryptoDays;
    if (
      !Number.isSafeInteger(days) ||
      days < 1 ||
      days > LONG_CANDLE_MAX_CRYPTO_DAYS
    ) {
      // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
      throw new LongCandleSyncInputError(
        `days must be an integer from 1 to ${LONG_CANDLE_MAX_CRYPTO_DAYS}.`,
      );
    }
    return days;
  }

  private krxSessions(input: LongCandleSyncInput): number {
    const sessions = input.sessions ?? DEFAULTS[input.mode].krxSessions;
    if (
      !Number.isSafeInteger(sessions) ||
      sessions < 1 ||
      sessions > LONG_CANDLE_MAX_KRX_SESSIONS
    ) {
      // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
      throw new LongCandleSyncInputError(
        `sessions must be an integer from 1 to ${LONG_CANDLE_MAX_KRX_SESSIONS}.`,
      );
    }
    return sessions;
  }

  private stopped(context: RunContext): boolean {
    if (context.signal?.aborted && context.stopReason === null) {
      context.stopReason = 'canceled';
    }
    return (
      context.stopReason !== null &&
      context.stopReason !== 'calendar_unavailable'
    );
  }

  private summary(
    market: LongCandleMarket,
    input: LongCandleSyncInput,
    context: RunContext,
    startedAt: Date,
    series: LongCandleSeriesResult[],
    window: {
      from: Date | null;
      to: Date | null;
      unit: 'days' | 'sessions';
      size: number;
    },
    targets: number,
  ): LongCandleSyncSummary {
    const failed = series.filter(seriesFailed).length;
    return {
      market,
      mode: input.mode,
      dryRun: context.dryRun,
      window: {
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
        unit: window.unit,
        size: window.size,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      series,
      totals: {
        series: series.length,
        rowsWritten: series.reduce((sum, s) => sum + s.rowsWritten, 0),
        providerCalls: series.reduce((sum, s) => sum + s.providerCalls, 0),
        held: series.reduce((sum, s) => sum + s.held.length, 0),
        pending: series.reduce((sum, s) => sum + s.pending.length, 0),
        failed,
        notStarted: Math.max(0, targets - series.length),
      },
      stopReason: context.stopReason,
      runFailed: failed > 0 || context.stopReason === 'canceled',
    };
  }
}

/**
 * A series failed when it ended with an error, even after writing some rows
 * (status 'partial' keeps the written range visible). A 'skipped' series with
 * a code (invalid symbol, unverified contract, …) was deliberately left out.
 */
function seriesFailed(series: LongCandleSeriesResult): boolean {
  return (
    series.status === 'failed' ||
    (series.status !== 'skipped' && series.errorCode !== null)
  );
}

// ------------------------------------------------------------- helpers --

export type CryptoWindow = {
  /** First 4h bucket of the window (aligned). */
  from: Date;
  /** End of the last CLOSED bucket = start of the current bucket. */
  closedTo: Date;
  /** End of the current (open) bucket. */
  currentTo: Date;
};

/** UTC-aligned 4h window of `days` × 24h ending at the current bucket. */
export function cryptoWindow(now: Date, days: number): CryptoWindow {
  const closedTo = Math.floor(now.getTime() / FOUR_HOURS_MS) * FOUR_HOURS_MS;
  const from =
    Math.floor((now.getTime() - days * DAY_MS) / FOUR_HOURS_MS) * FOUR_HOURS_MS;
  return {
    from: new Date(from),
    closedTo: new Date(closedTo),
    currentTo: new Date(closedTo + FOUR_HOURS_MS),
  };
}

/**
 * Which part of a crypto window must be (re)fetched: from the first missing
 * closed bucket, the newest closed bucket that was fetched right at its close
 * (late revisions), or — for futures — the stale current bucket.
 */
export function planCryptoFetch(
  window: CryptoWindow,
  stored: readonly {
    openTime: Date;
    closeTime: Date;
    isClosed: boolean;
    sourceUpdatedAt: Date;
  }[],
  now: Date,
  includeCurrent: boolean,
): { expected: number; missing: number; fetchFrom: Date | null } {
  const closed = new Map<number, (typeof stored)[number]>();
  let current: (typeof stored)[number] | undefined;
  for (const row of stored) {
    const openMs = row.openTime.getTime();
    if (row.isClosed && openMs < window.closedTo.getTime())
      closed.set(openMs, row);
    if (openMs === window.closedTo.getTime()) current = row;
  }
  let expected = 0;
  let firstMissing: number | null = null;
  let missing = 0;
  for (
    let slot = window.from.getTime();
    slot < window.closedTo.getTime();
    slot += FOUR_HOURS_MS
  ) {
    expected += 1;
    if (!closed.has(slot)) {
      missing += 1;
      firstMissing ??= slot;
    }
  }
  const candidates: number[] = [];
  if (firstMissing !== null) candidates.push(firstMissing);
  const latestClosedStart = window.closedTo.getTime() - FOUR_HOURS_MS;
  const latest = closed.get(latestClosedStart);
  if (
    latest &&
    latest.sourceUpdatedAt.getTime() <
      latest.closeTime.getTime() + RECONFIRM_GRACE_MS
  ) {
    candidates.push(latestClosedStart);
  }
  if (
    includeCurrent &&
    (!current ||
      current.sourceUpdatedAt.getTime() <
        now.getTime() - FUTURES_CURRENT_REFRESH_MS)
  ) {
    candidates.push(window.closedTo.getTime());
  }
  return {
    expected,
    missing,
    fetchFrom: candidates.length > 0 ? new Date(Math.min(...candidates)) : null,
  };
}

/**
 * The `count` most recent KRX sessions that closed at least the grace period
 * before `now`, oldest first. Stops (calendarGap) at the first date without an
 * audited calendar dataset instead of treating it as a holiday.
 */
export function enumerateCompletedKrxSessions(
  now: Date,
  count: number,
): { sessions: MarketSessionWindow[]; calendarGap: boolean } {
  const today = formatZonedCursor(now, KST).date;
  const todayMs = Date.UTC(
    Number(today.slice(0, 4)),
    Number(today.slice(4, 6)) - 1,
    Number(today.slice(6, 8)),
  );
  const sessions: MarketSessionWindow[] = [];
  const maxDays = count * 3 + 30;
  for (
    let offset = 0;
    offset <= maxDays && sessions.length < count;
    offset += 1
  ) {
    const date = new Date(todayMs - offset * DAY_MS).toISOString().slice(0, 10);
    if (!hasEffectiveMarketCalendarForDate('KRX', date)) {
      return { sessions: sessions.reverse(), calendarGap: true };
    }
    const session = resolveMarketSession('KRX', date.replaceAll('-', ''));
    if (
      session &&
      session.closeTime.getTime() + KRX_CLOSE_GRACE_MS <= now.getTime()
    ) {
      sessions.push(session);
    }
  }
  return { sessions: sessions.reverse(), calendarGap: false };
}

function previousStoredSession(
  session: MarketSessionWindow,
  stored: Map<string, StoredKrxCandle[]>,
): StoredKrxCandle[] | null {
  const date = localDate(session);
  const earlier = [...stored.keys()].filter((key) => key < date).sort();
  const previousDate = earlier.at(-1);
  if (!previousDate) return null;
  // Only the IMMEDIATELY preceding calendar session is a valid baseline.
  const previousMs = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
  );
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(previousMs - offset * DAY_MS)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    if (resolveMarketSession('KRX', candidate)) {
      return candidate === previousDate
        ? (stored.get(candidate) ?? null)
        : null;
    }
  }
  return null;
}

/**
 * Groups sessions so each group's date range spans at most `maxSpan` calendar
 * sessions (the KOSCOM daily history returns at most 100 rows per call).
 */
function chunkBySessionSpan(
  selected: readonly MarketSessionWindow[],
  all: readonly MarketSessionWindow[],
  maxSpan: number,
): MarketSessionWindow[][] {
  const index = new Map(all.map((session, i) => [session.localDate, i]));
  const chunks: MarketSessionWindow[][] = [];
  let current: MarketSessionWindow[] = [];
  let startIndex = 0;
  for (const session of selected) {
    const position = index.get(session.localDate) ?? 0;
    if (current.length > 0 && position - startIndex >= maxSpan) {
      chunks.push(current);
      current = [];
    }
    if (current.length === 0) startIndex = position;
    current.push(session);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function localDate(session: MarketSessionWindow): string {
  return session.localDate.replaceAll('-', '');
}

function emptySeries(
  market: LongCandleMarket,
  seriesId: string,
  symbol: string,
): LongCandleSeriesResult {
  return {
    market,
    seriesId,
    symbol,
    status: 'up_to_date',
    expected: 0,
    missingBefore: 0,
    rowsWritten: 0,
    providerCalls: 0,
    held: [],
    pending: [],
    errorCode: null,
  };
}

function koscomCode(error: unknown): string {
  return error instanceof KoscomError ? error.code : 'KOSCOM_OPERATION_FAILED';
}

function errorCodeOf(error: unknown): string {
  if (error instanceof KoscomError) return error.code;
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return error instanceof Error ? error.name : 'LONG_CANDLE_SYNC_FAILED';
}

function positive(value: number | undefined, fallback: number, name: string) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
    throw new LongCandleSyncInputError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonNegative(
  value: number | undefined,
  fallback: number,
  name: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    // @diagnosticSurface internal: Operator/scheduler input validation; the Ops runner maps it to MARKET_CANDLE_LONG_SYNC_INVALID_INPUT.
    throw new LongCandleSyncInputError(
      `${name} must be a non-negative integer.`,
    );
  }
  return resolved;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
