import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AssetType,
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
  Prisma,
  type MarketCandleSyncState,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redactText } from '../providers/provider-secret-redaction';
import { toBinanceUsdtSymbol } from '../providers/provider-target-resolver.service';
import { normalizeKisUsMarketCode } from '../providers/kis/kis-websocket.subscription';
import { formatZonedCursor } from '../providers/kis/candles/kis-candle-time';
import {
  KIS_DOMESTIC_CANDLE_SOURCE,
  KIS_US_CANDLE_SOURCE,
} from '../providers/kis/candles/kis-candle.types';
import {
  KIS_DOMESTIC_PERIOD_SOURCE,
  KIS_OVERSEAS_PERIOD_SOURCE,
  type KisPeriodInterval,
  type KisPeriodPageResult,
} from '../providers/kis/candles/kis-period-candle.types';
import { KisDomesticPeriodAdapter } from '../providers/kis/candles/kis-domestic-period.adapter';
import { KisOverseasPeriodAdapter } from '../providers/kis/candles/kis-overseas-period.adapter';
import { KisPeriodCandleNormalizerService } from '../providers/kis/candles/kis-period-candle-normalizer.service';
import { BinanceCandleIngestionService } from '../providers/binance/binance-candle.ingestion.service';
import {
  BINANCE_CANDLE_SOURCE,
  type BinanceCandleInterval,
} from '../providers/binance/binance-candle.types';
import { MarketCandleIngestionService } from './market-candle-ingestion.service';
import { MarketCandlesRepository } from './market-candles.repository';
import {
  MarketCandleBackfillLockService,
  type MarketCandleBackfillLockHandle,
} from './market-candle-backfill-lock.service';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';
import {
  MARKET_CANDLE_SYNC_CONFIG,
  type MarketCandleSyncConfig,
} from './market-candle-sync.config';
import {
  MARKET_CANDLE_SYNC_FEEDS,
  MarketCandleSyncInputError,
  type MarketCandleAssetSyncResult,
  type MarketCandleFeed,
  type MarketCandleFeedPage,
  type MarketCandleFeedResult,
  type MarketCandleSyncCompletionReason,
  type MarketCandleSyncStopReason,
  type MarketCandleSyncSummary,
} from './market-candle-sync.types';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import { ProviderConfigError } from '../providers/provider.types';
import {
  inspectMarketSessionsInRange,
  resolveStockMarketDataUpperBound,
} from '../orders/market-calendar.policy';

const DAY_MS = 24 * 60 * 60_000;
// Retention windows: 5m 35 days, 1d/1w one year (documented storage policy).
const FEED_DEFAULT_LOOKBACK_MS: Record<MarketCandleFeed, number> = {
  '5m': 35 * DAY_MS,
  '1d': 365 * DAY_MS,
  '1w': 365 * DAY_MS,
};
// Approximate feed row caps: ~400 daily and ~60 weekly rows cover one year.
const FEED_ROW_CAPS: Partial<Record<MarketCandleFeed, number>> = {
  '1d': 400,
  '1w': 60,
};
const FEED_APPROX_INTERVAL_MS: Record<MarketCandleFeed, number> = {
  '5m': 5 * 60_000,
  '1d': DAY_MS,
  '1w': 7 * DAY_MS,
};
// KIS 5m feeds reuse the whole-range 2-1/2-2 fetchers, so one checkpointable
// "page" is a bounded time segment (which spans several provider pages).
// The domestic minute API seeds its date/hour cursor from the segment end, so
// short segments are cheap. The US minute API's continuation always starts
// from the latest data (KEYB cannot address a mid-range start), so slicing
// its range into segments would re-page from `now` for every segment; the US
// segment therefore covers the whole 35-day default range in one
// checkpointable unit.
const KIS_FIVE_MINUTE_SEGMENT_MS: Record<'kis_domestic' | 'kis_us', number> = {
  kis_domestic: 2 * DAY_MS,
  kis_us: 40 * DAY_MS,
};
const KIS_SEGMENT_MAX_PAGES = 60;
const KIS_SEGMENT_MAX_RAW_ROWS = 12_000;
const DOMESTIC_KRX_MARKETS = new Set(['KRX', 'KOSPI', 'KOSDAQ', 'KONEX']);
const SWEEP_TERMINAL_REASONS: ReadonlySet<MarketCandleSyncStopReason> = new Set(
  [
    'target_reached',
    'expected_no_data',
    'provider_exhausted',
    'empty_page',
    'data_incomplete',
  ],
);

type SyncAssetRecord = {
  id: string;
  symbol: string;
  market: string;
  assetType: AssetType;
  isActive: boolean;
};

type ProviderDescriptor =
  | { kind: 'kis_domestic'; symbol: string; marketCode: string }
  | { kind: 'kis_us'; symbol: string; marketCode: string }
  | { kind: 'binance'; symbol: string };

type FeedBudget = {
  pagesLeft: number;
  rowsLeft: number;
  deadlineMs: number;
};

export type MarketCandleSyncAssetInput = {
  assetId: string;
  targets?: readonly MarketCandleFeed[];
  from?: Date;
  to?: Date;
  mode?: MarketCandleSyncMode;
  resume?: boolean;
  dryRun?: boolean;
  now?: Date;
  signal?: AbortSignal;
  budget?: {
    maxPages: number;
    maxRows: number;
    maxDurationMs: number;
  };
};

export type MarketCandleSyncAssetsInput = {
  assetIds?: readonly string[];
  assetTypes?: readonly AssetType[];
  activeOnly?: boolean;
  targets?: readonly MarketCandleFeed[];
  from?: Date;
  to?: Date;
  mode?: MarketCandleSyncMode;
  resume?: boolean;
  continueOnError?: boolean;
  maxAssets?: number;
  dryRun?: boolean;
  now?: Date;
  signal?: AbortSignal;
};

/**
 * Checkpointed initial/incremental/repair sync of persisted candle feeds
 * (5m, 1d, 1w) for domestic stocks (KIS), US stocks (KIS), and crypto
 * (Binance).
 *
 * Provider mechanics stay in the per-provider services: 5m fetching reuses
 * the 2-1/2-2 MarketCandleIngestionService fetchers, 1d/1w pages come from
 * the KIS period adapters, and crypto pages from
 * BinanceCandleIngestionService. This service owns only the loop: acquire
 * the per-asset/feed backfill lock, fetch one page, persist its candles via
 * the idempotent repository upsert, and only then advance the persistent
 * checkpoint cursor — so a failed write never moves the cursor and any
 * failed/interrupted run can resume from its last durable page.
 */
@Injectable()
export class MarketCandleSyncService {
  private readonly logger = new Logger(MarketCandleSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: MarketCandlesRepository,
    private readonly stateRepository: MarketCandleSyncStateRepository,
    private readonly lockService: MarketCandleBackfillLockService,
    private readonly fiveMinuteIngestion: MarketCandleIngestionService,
    private readonly domesticPeriodAdapter: KisDomesticPeriodAdapter,
    private readonly overseasPeriodAdapter: KisOverseasPeriodAdapter,
    private readonly periodNormalizer: KisPeriodCandleNormalizerService,
    private readonly binanceCandles: BinanceCandleIngestionService,
    @Inject(MARKET_CANDLE_SYNC_CONFIG)
    private readonly config: MarketCandleSyncConfig,
    private readonly cache: AssetCandlesCacheService,
  ) {}

  async syncAsset(
    input: MarketCandleSyncAssetInput,
  ): Promise<MarketCandleAssetSyncResult> {
    const targets = this.parseTargets(input.targets);
    const mode = this.parseMode(input.mode, input.from, input.to);
    const asset = await this.prisma.asset.findUnique({
      where: { id: this.requireText(input.assetId, 'assetId') },
      select: {
        id: true,
        symbol: true,
        market: true,
        assetType: true,
        isActive: true,
      },
    });
    if (!asset) {
      throw new MarketCandleSyncInputError(
        `Asset ${input.assetId} does not exist.`,
      );
    }
    const descriptor = this.resolveDescriptor(asset);
    if (!descriptor.ok) {
      throw new MarketCandleSyncInputError(
        `Asset ${asset.id} is unsupported for candle sync: ${descriptor.reason}`,
      );
    }
    return this.syncOneAsset(asset, descriptor.descriptor, {
      targets,
      mode,
      from: input.from,
      to: input.to,
      resume: input.resume !== false,
      continueOnError: true,
      dryRun: input.dryRun === true,
      now: input.now ?? new Date(),
      signal: input.signal,
      budget: input.budget,
    });
  }

  async syncAssets(
    input: MarketCandleSyncAssetsInput = {},
  ): Promise<MarketCandleSyncSummary> {
    const startedAt = new Date();
    const now = input.now ?? startedAt;
    const targets = this.parseTargets(input.targets);
    const mode = this.parseMode(input.mode, input.from, input.to);
    const continueOnError = input.continueOnError !== false;
    const maxAssets = this.parseOptionalPositiveInteger(
      input.maxAssets,
      'maxAssets',
    );

    const assets = await this.prisma.asset.findMany({
      where: {
        ...(input.assetIds !== undefined
          ? { id: { in: [...input.assetIds] } }
          : {}),
        ...(input.assetTypes !== undefined
          ? { assetType: { in: [...input.assetTypes] } }
          : {}),
        ...(input.activeOnly !== false ? { isActive: true } : {}),
      },
      orderBy: [{ symbol: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        symbol: true,
        market: true,
        assetType: true,
        isActive: true,
      },
    });

    const skippedAssets: MarketCandleSyncSummary['skippedAssets'] = [];
    if (input.assetIds !== undefined) {
      const found = new Set(assets.map((asset) => asset.id));
      for (const assetId of new Set(input.assetIds)) {
        if (!found.has(assetId)) {
          skippedAssets.push({
            assetId,
            symbol: '',
            reason: 'ASSET_NOT_FOUND_OR_FILTERED',
          });
        }
      }
    }

    const selected =
      maxAssets !== undefined && assets.length > maxAssets
        ? assets.slice(0, maxAssets)
        : assets;
    for (const overflow of assets.slice(selected.length)) {
      skippedAssets.push({
        assetId: overflow.id,
        symbol: overflow.symbol,
        reason: 'MAX_ASSETS_EXCEEDED',
      });
    }

    const supported: {
      asset: SyncAssetRecord;
      descriptor: ProviderDescriptor;
    }[] = [];
    for (const asset of selected) {
      const resolution = this.resolveDescriptor(asset);
      if (resolution.ok) {
        supported.push({ asset, descriptor: resolution.descriptor });
      } else {
        skippedAssets.push({
          assetId: asset.id,
          symbol: asset.symbol,
          reason: resolution.reason,
        });
      }
    }

    const options = {
      targets,
      mode,
      from: input.from,
      to: input.to,
      resume: input.resume !== false,
      continueOnError,
      dryRun: input.dryRun === true,
      now,
      signal: input.signal,
      budget: undefined,
    };
    const results: MarketCandleAssetSyncResult[] = [];
    let aborted = false;

    // KIS-backed assets run strictly one at a time on top of the shared rate
    // limiter; crypto assets may fan out up to the configured concurrency.
    const kisEntries = supported.filter(
      (entry) => entry.descriptor.kind !== 'binance',
    );
    const cryptoEntries = supported.filter(
      (entry) => entry.descriptor.kind === 'binance',
    );

    for (const entry of kisEntries) {
      if (aborted || input.signal?.aborted) {
        skippedAssets.push({
          assetId: entry.asset.id,
          symbol: entry.asset.symbol,
          reason: aborted ? 'ABORTED_AFTER_FAILURE' : 'CANCELED',
        });
        continue;
      }
      const result = await this.syncOneAsset(
        entry.asset,
        entry.descriptor,
        options,
      );
      results.push(result);
      if (result.failedFeeds > 0 && !continueOnError) aborted = true;
    }

    for (
      let offset = 0;
      offset < cryptoEntries.length;
      offset += this.config.assetConcurrency
    ) {
      const chunk = cryptoEntries.slice(
        offset,
        offset + this.config.assetConcurrency,
      );
      if (aborted || input.signal?.aborted) {
        for (const entry of chunk) {
          skippedAssets.push({
            assetId: entry.asset.id,
            symbol: entry.asset.symbol,
            reason: aborted ? 'ABORTED_AFTER_FAILURE' : 'CANCELED',
          });
        }
        continue;
      }
      const chunkResults = await Promise.all(
        chunk.map((entry) =>
          this.syncOneAsset(entry.asset, entry.descriptor, options),
        ),
      );
      results.push(...chunkResults);
      if (
        chunkResults.some((result) => result.failedFeeds > 0) &&
        !continueOnError
      ) {
        aborted = true;
      }
    }

    const allFeeds = results.flatMap((result) => result.feeds);
    // completedFeeds counts runs that TERMINATED normally, not confirmed
    // coverage: a run that stopped at a provider retention edge is completed
    // yet coverage-incomplete. The two coverage counters below make that
    // distinction explicit for operators.
    const completedFeeds = allFeeds.filter(
      (feed) => feed.status === MarketCandleSyncStatus.completed,
    );
    return {
      mode,
      dryRun: options.dryRun,
      requestedAssets: assets.length,
      processedAssets: results.length,
      skippedAssets,
      assets: results,
      totalFeeds: allFeeds.length,
      completedFeeds: completedFeeds.length,
      coverageCompleteFeeds: completedFeeds.filter(
        (feed) => feed.coverageComplete,
      ).length,
      completedWithIncompleteCoverageFeeds: completedFeeds.filter(
        (feed) => !feed.coverageComplete,
      ).length,
      failedFeeds: allFeeds.filter(
        (feed) =>
          feed.status === MarketCandleSyncStatus.failed ||
          feed.status === MarketCandleSyncStatus.canceled,
      ).length,
      startedAt,
      finishedAt: new Date(),
    };
  }

  private async syncOneAsset(
    asset: SyncAssetRecord,
    descriptor: ProviderDescriptor,
    options: {
      targets: readonly MarketCandleFeed[];
      mode: MarketCandleSyncMode;
      from?: Date;
      to?: Date;
      resume: boolean;
      continueOnError: boolean;
      dryRun: boolean;
      now: Date;
      signal?: AbortSignal;
      budget?: MarketCandleSyncAssetInput['budget'];
    },
  ): Promise<MarketCandleAssetSyncResult> {
    const feeds: MarketCandleFeedResult[] = [];
    for (const feed of options.targets) {
      const result = await this.runFeed(asset, descriptor, feed, options);
      feeds.push(result);
      if (
        !options.continueOnError &&
        (result.status === MarketCandleSyncStatus.failed ||
          result.status === MarketCandleSyncStatus.canceled)
      ) {
        break;
      }
    }
    return {
      assetId: asset.id,
      symbol: asset.symbol,
      assetType: asset.assetType,
      feeds,
      failedFeeds: feeds.filter(
        (feed) =>
          feed.status === MarketCandleSyncStatus.failed ||
          feed.status === MarketCandleSyncStatus.canceled,
      ).length,
    };
  }

  private async runFeed(
    asset: SyncAssetRecord,
    descriptor: ProviderDescriptor,
    feed: MarketCandleFeed,
    options: {
      mode: MarketCandleSyncMode;
      from?: Date;
      to?: Date;
      resume: boolean;
      dryRun: boolean;
      now: Date;
      signal?: AbortSignal;
      budget?: MarketCandleSyncAssetInput['budget'];
    },
  ): Promise<MarketCandleFeedResult> {
    const sourceProvider = this.sourceProviderFor(descriptor, feed);
    const base = {
      provider: sourceProvider,
      assetId: asset.id,
      interval: feed,
      mode: options.mode,
      dryRun: options.dryRun,
    };
    let range: { from: Date; to: Date };
    try {
      range = await this.resolveTargetRange(asset.id, feed, options);
    } catch (error) {
      if (error instanceof MarketCandleSyncInputError) throw error;
      return this.failedResult(base, {
        rangeFrom: options.from ?? options.now,
        rangeTo: options.to ?? options.now,
        stopReason: 'provider_error',
        errorCode: 'RANGE_RESOLUTION_FAILED',
        errorMessage: redactText(messageOf(error)),
      });
    }

    if (range.from.getTime() >= range.to.getTime()) {
      // Nothing to sync (e.g. incremental with fresh data inside overlap).
      return {
        ...base,
        rangeFrom: range.from,
        rangeTo: range.to,
        pagesFetched: 0,
        providerReturnedRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        duplicateRows: 0,
        writtenRows: 0,
        oldestOpenTime: null,
        latestOpenTime: null,
        complete: true,
        coverageComplete: true,
        completionReason: 'target_reached',
        coveredFrom: range.from,
        coveredTo: range.to,
        stopReason: 'target_reached',
        status: MarketCandleSyncStatus.completed,
        syncStateId: null,
        resumed: false,
        errorCode: null,
        errorMessage: null,
      };
    }

    if (options.dryRun) {
      return {
        ...base,
        rangeFrom: range.from,
        rangeTo: range.to,
        pagesFetched: 0,
        providerReturnedRows: 0,
        acceptedRows: 0,
        rejectedRows: 0,
        duplicateRows: 0,
        writtenRows: 0,
        oldestOpenTime: null,
        latestOpenTime: null,
        complete: false,
        coverageComplete: false,
        completionReason: null,
        coveredFrom: null,
        coveredTo: null,
        stopReason: 'dry_run',
        status: MarketCandleSyncStatus.pending,
        syncStateId: null,
        resumed: false,
        errorCode: null,
        errorMessage: null,
      };
    }

    const lockResult = await this.lockService.acquire({
      assetId: asset.id,
      feed,
      ttlSeconds: this.config.lockTtlSeconds,
      renewSeconds: this.config.lockRenewSeconds,
      now: options.now,
    });
    if (!lockResult.acquired) {
      return this.failedResult(base, {
        rangeFrom: range.from,
        rangeTo: range.to,
        stopReason: 'lock_not_acquired',
        errorCode:
          lockResult.reason === 'busy' ? 'LOCK_BUSY' : 'LOCK_UNAVAILABLE',
        errorMessage:
          lockResult.reason === 'busy'
            ? 'Another instance is already syncing this asset/feed.'
            : 'The backfill lock store is unavailable; refusing to sync without mutual exclusion.',
      });
    }

    let result: MarketCandleFeedResult;
    try {
      result = await this.runFeedLocked(
        asset,
        descriptor,
        feed,
        sourceProvider,
        range,
        lockResult.handle,
        options,
      );
    } finally {
      await this.lockService.release(lockResult.handle);
    }
    if (result.writtenRows > 0) {
      const invalidated = await this.cache.invalidateAsset(asset.id);
      if (invalidated.status === 'error') {
        this.logger.warn(
          JSON.stringify({
            event: 'candle_cache_invalidation_failed',
            assetId: asset.id,
            feed,
          }),
        );
      }
    }
    return result;
  }

  private async runFeedLocked(
    asset: SyncAssetRecord,
    descriptor: ProviderDescriptor,
    feed: MarketCandleFeed,
    sourceProvider: string,
    range: { from: Date; to: Date },
    lockHandle: MarketCandleBackfillLockHandle,
    options: {
      mode: MarketCandleSyncMode;
      resume: boolean;
      dryRun: boolean;
      now: Date;
      signal?: AbortSignal;
      budget?: MarketCandleSyncAssetInput['budget'];
    },
  ): Promise<MarketCandleFeedResult> {
    const base = {
      provider: sourceProvider,
      assetId: asset.id,
      interval: feed,
      mode: options.mode,
      dryRun: false,
    };

    // Resolve the checkpoint row: take over a resumable run (with ITS stored
    // target range and cursor), or cancel stale active rows and start fresh.
    let state: MarketCandleSyncState | null = null;
    let resumed = false;
    if (options.resume) {
      const resumable = await this.stateRepository.findResumable(
        asset.id,
        feed,
      );
      if (resumable) {
        state = await this.stateRepository.resumeRun(resumable.id);
        resumed = state !== null;
      }
    } else {
      await this.stateRepository.cancelActiveRuns(
        asset.id,
        feed,
        'Superseded by a new sync run with resume=false.',
      );
    }
    if (!state) {
      try {
        state = await this.stateRepository.createRunning({
          assetId: asset.id,
          feed,
          sourceProvider,
          mode: options.mode,
          targetFrom: range.from,
          targetTo: range.to,
        });
      } catch (error) {
        // A concurrent owner slipped in despite the lock (e.g. a stale
        // active row surfaced between cancel and create); do not fight it.
        return this.failedResult(base, {
          rangeFrom: range.from,
          rangeTo: range.to,
          stopReason: 'lock_not_acquired',
          errorCode: 'ACTIVE_SYNC_EXISTS',
          errorMessage: redactText(messageOf(error)),
        });
      }
    }

    const targetFrom = state.targetFrom;
    const targetTo = state.targetTo;
    let cursor = asJsonObject(state.cursorJson);
    const budget: FeedBudget = {
      pagesLeft: Math.min(
        this.config.maxPages,
        this.requireBudgetValue(options.budget?.maxPages, 'budget.maxPages') ??
          this.config.maxPages,
      ),
      rowsLeft: Math.min(
        this.config.maxRows,
        this.requireBudgetValue(options.budget?.maxRows, 'budget.maxRows') ??
          this.config.maxRows,
        FEED_ROW_CAPS[feed] ?? this.config.maxRows,
      ),
      deadlineMs:
        Date.now() +
        Math.min(
          this.config.maxDurationMs,
          this.requireBudgetValue(
            options.budget?.maxDurationMs,
            'budget.maxDurationMs',
          ) ?? this.config.maxDurationMs,
        ),
    };

    let oldestOpenTime: Date | null = null;
    let latestOpenTime: Date | null = null;
    let stopReason: MarketCandleSyncStopReason = 'max_pages';
    let status: MarketCandleSyncStatus = MarketCandleSyncStatus.failed;
    let complete = false;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;
    // Provider-confirmed coverage accumulated across pages (and, on resume,
    // across runs — seeded from the checkpoint row). Pages sweep contiguously
    // from one end of the target range, so a min/max merge stays exact.
    let coveredFrom: Date | null = state.coveredFrom ?? null;
    let coveredTo: Date | null = state.coveredTo ?? null;
    let coverageComplete = false;
    let completionReason: MarketCandleSyncCompletionReason | null = null;

    while (true) {
      if (options.signal?.aborted) {
        stopReason = 'canceled';
        status = MarketCandleSyncStatus.canceled;
        errorCode = 'CANCELED';
        await this.stateRepository.markCanceled(state.id, {
          errorCode,
          errorMessage: 'Sync canceled by caller signal.',
        });
        break;
      }
      const budgetStop = this.checkBudget(budget);
      if (budgetStop) {
        stopReason = budgetStop;
        status = MarketCandleSyncStatus.failed;
        errorCode = budgetStop.toUpperCase();
        await this.stateRepository.markFailed(state.id, {
          errorCode,
          errorMessage: `Feed budget exhausted (${budgetStop}); resume to continue from the checkpoint.`,
        });
        break;
      }
      const ownershipKept = await this.lockService.renewIfDue(
        lockHandle,
        new Date(),
      );
      if (!ownershipKept) {
        // Never run another provider page without proven ownership.
        stopReason = 'lock_lost';
        status = MarketCandleSyncStatus.failed;
        errorCode = 'LOCK_OWNERSHIP_LOST';
        await this.stateRepository.markFailed(state.id, {
          errorCode,
          errorMessage:
            'Backfill lock ownership was lost; stopped before the next provider page.',
        });
        break;
      }

      let page: MarketCandleFeedPage;
      try {
        page = await this.fetchFeedPage({
          asset,
          descriptor,
          feed,
          from: targetFrom,
          to: targetTo,
          cursor,
          now: options.now,
          signal: options.signal,
          budget,
        });
      } catch (error) {
        if (error instanceof ProviderConfigError) throw error;
        stopReason = 'provider_error';
        status = MarketCandleSyncStatus.failed;
        errorCode = 'PROVIDER_CALL_FAILED';
        errorMessage = redactText(messageOf(error));
        await this.stateRepository.markFailed(state.id, {
          errorCode,
          errorMessage,
        });
        break;
      }

      let writtenRows = 0;
      if (page.candles.length > 0) {
        try {
          const written = await this.repository.upsertMany(
            page.candles.map((candle) => ({
              assetId: asset.id,
              interval: feed,
              openTime: candle.openTime,
              closeTime: candle.closeTime,
              open: candle.open,
              high: candle.high,
              low: candle.low,
              close: candle.close,
              volume: candle.volume,
              amount: candle.amount,
              isClosed: candle.isClosed,
              sourceProvider,
              sourceUpdatedAt: candle.sourceUpdatedAt,
            })),
          );
          writtenRows = written.writtenCount;
        } catch (error) {
          // Candle write failed: the checkpoint cursor is NOT advanced, so a
          // resume re-fetches this page and the idempotent upsert converges.
          stopReason = 'write_failed';
          status = MarketCandleSyncStatus.failed;
          errorCode = 'CANDLE_WRITE_FAILED';
          errorMessage = redactText(messageOf(error));
          await this.stateRepository.markFailed(state.id, {
            errorCode,
            errorMessage,
          });
          break;
        }
        const first = page.candles[0].openTime;
        const last = page.candles[page.candles.length - 1].openTime;
        oldestOpenTime = earlier(oldestOpenTime, first);
        oldestOpenTime = earlier(oldestOpenTime, last);
        latestOpenTime = later(latestOpenTime, first);
        latestOpenTime = later(latestOpenTime, last);
      }

      // Merge the page's provider-confirmed subrange into the run coverage.
      // Only ranges the provider positively swept are merged; abnormal pages
      // claim nothing.
      if (page.coveredFrom !== null && page.coveredTo !== null) {
        coveredFrom =
          coveredFrom === null ||
          page.coveredFrom.getTime() < coveredFrom.getTime()
            ? page.coveredFrom
            : coveredFrom;
        coveredTo =
          coveredTo === null || page.coveredTo.getTime() > coveredTo.getTime()
            ? page.coveredTo
            : coveredTo;
      }

      // On an abnormal terminal page (canceled/timeout/malformed) the cursor
      // is preserved so a resume re-fetches from the same position.
      const recorded = await this.stateRepository.recordPageSuccess(state.id, {
        cursorJson: page.nextCursor ?? cursor,
        pagesFetched: page.pagesFetched,
        providerRowsReceived: page.providerReturnedRows,
        rowsAccepted: page.acceptedRows,
        rowsRejected: page.rejectedRows,
        rowsDuplicated: page.duplicateRows,
        rowsWritten: writtenRows,
        lastSuccessfulPageAt: new Date(),
        coveredFrom,
        coveredTo,
      });
      if (!recorded) {
        stopReason = 'lock_lost';
        status = MarketCandleSyncStatus.failed;
        errorCode = 'CHECKPOINT_CONFLICT';
        errorMessage =
          'Checkpoint row was no longer running while recording page progress.';
        break;
      }
      budget.pagesLeft -= Math.max(1, page.pagesFetched);
      budget.rowsLeft -= page.acceptedRows;

      if (page.nextCursor === null) {
        stopReason = page.stopReason ?? 'provider_exhausted';
        if (stopReason === 'canceled') {
          status = MarketCandleSyncStatus.canceled;
          errorCode = 'CANCELED';
          await this.stateRepository.markCanceled(state.id, {
            errorCode,
            errorMessage: 'Provider page fetch was canceled.',
          });
        } else if (stopReason === 'max_duration') {
          status = MarketCandleSyncStatus.failed;
          errorCode = 'MAX_DURATION';
          await this.stateRepository.markFailed(state.id, {
            errorCode,
            errorMessage:
              'Provider page timed out; resume to continue from the checkpoint.',
          });
        } else if (SWEEP_TERMINAL_REASONS.has(stopReason)) {
          status = MarketCandleSyncStatus.completed;
          // Coverage completeness is judged from the accumulated
          // provider-confirmed range, never from the terminal reason alone:
          // empty_page / provider_exhausted runs that stopped before
          // targetFrom stay coverageComplete=false and are not accepted as
          // serving coverage. coveredTo is clamped to `now` by the page
          // fetchers, so a target range ending at/after `now` counts as
          // complete once everything that can exist so far was confirmed.
          const requiredTo = Math.min(
            targetTo.getTime(),
            options.now.getTime(),
          );
          coverageComplete =
            coveredFrom !== null &&
            coveredTo !== null &&
            coveredFrom.getTime() <= targetFrom.getTime() &&
            coveredTo.getTime() >= requiredTo;
          complete = coverageComplete;
          const progressRow = await this.stateRepository.findById(state.id);
          const acceptedTotal = progressRow?.rowsAccepted ?? page.acceptedRows;
          completionReason = coverageComplete
            ? acceptedTotal > 0
              ? 'target_reached'
              : 'confirmed_empty'
            : stopReason === 'empty_page'
              ? 'empty_page_before_target'
              : stopReason === 'data_incomplete'
                ? 'data_incomplete'
                : 'provider_exhausted_before_target';
          await this.stateRepository.markCompleted(state.id, new Date(), {
            coverageComplete,
            completionReason,
            coveredFrom,
            coveredTo,
            // The repository re-validates the completeness claim against
            // this effective bound: a targetTo in the future can only be
            // confirmed up to the sync-time `now`.
            requiredCoveredTo: new Date(requiredTo),
          });
        } else {
          status = MarketCandleSyncStatus.failed;
          errorCode = stopReason.toUpperCase();
          await this.stateRepository.markFailed(state.id, {
            errorCode,
            errorMessage: `Feed terminated abnormally (${stopReason}).`,
          });
        }
        break;
      }
      cursor = page.nextCursor;
    }

    const finalState = await this.stateRepository.findById(state.id);
    // On a checkpoint conflict the row belongs to someone else; report our
    // local failure instead of the other owner's row state.
    const conflicted = errorCode === 'CHECKPOINT_CONFLICT';
    return {
      ...base,
      rangeFrom: targetFrom,
      rangeTo: targetTo,
      pagesFetched: finalState?.pagesFetched ?? 0,
      providerReturnedRows: finalState?.providerRowsReceived ?? 0,
      acceptedRows: finalState?.rowsAccepted ?? 0,
      rejectedRows: finalState?.rowsRejected ?? 0,
      duplicateRows: finalState?.rowsDuplicated ?? 0,
      writtenRows: finalState?.rowsWritten ?? 0,
      oldestOpenTime,
      latestOpenTime,
      complete,
      coverageComplete,
      completionReason,
      coveredFrom,
      coveredTo,
      stopReason,
      status: conflicted ? status : (finalState?.status ?? status),
      syncStateId: state.id,
      resumed,
      errorCode: conflicted ? errorCode : (finalState?.errorCode ?? errorCode),
      errorMessage: conflicted
        ? errorMessage
        : (finalState?.errorMessage ?? errorMessage),
    };
  }

  // One checkpointable page for the feed. See MarketCandleFeedPage.
  private async fetchFeedPage(input: {
    asset: SyncAssetRecord;
    descriptor: ProviderDescriptor;
    feed: MarketCandleFeed;
    from: Date;
    to: Date;
    cursor: Prisma.JsonObject | null;
    now: Date;
    signal?: AbortSignal;
    budget: FeedBudget;
  }): Promise<MarketCandleFeedPage> {
    if (input.descriptor.kind === 'binance') {
      return this.fetchBinancePage(input, input.descriptor);
    }
    const effectiveTo = new Date(
      Math.min(input.to.getTime(), input.now.getTime()),
    );
    if (effectiveTo.getTime() <= input.from.getTime()) {
      return emptyFeedPage('target_reached', true);
    }
    const range = inspectMarketSessionsInRange(
      input.asset,
      input.from,
      effectiveTo,
    );
    if (!range.calendarCovered) {
      return emptyFeedPage('calendar_unavailable', false);
    }
    if (!range.hasTradingSession) {
      return {
        ...emptyFeedPage('expected_no_data', true),
        coveredFrom: input.from,
        coveredTo: effectiveTo,
      };
    }
    if (input.feed === '5m') {
      return this.fetchKisFiveMinuteSegment(input, input.descriptor);
    }
    return this.fetchKisPeriodPage(input, input.descriptor);
  }

  private async fetchBinancePage(
    input: {
      feed: MarketCandleFeed;
      from: Date;
      to: Date;
      cursor: Prisma.JsonObject | null;
      now: Date;
    },
    descriptor: { kind: 'binance'; symbol: string },
  ): Promise<MarketCandleFeedPage> {
    const startTime = readIntegerField(input.cursor, 'startTime');
    const pageStartMs =
      startTime !== null && startTime >= input.from.getTime()
        ? startTime
        : input.from.getTime();
    const page = await this.binanceCandles.fetchKlinesPage({
      symbol: descriptor.symbol,
      interval: input.feed as BinanceCandleInterval,
      from: input.from,
      to: input.to,
      cursor:
        pageStartMs > input.from.getTime() ? { startTime: pageStartMs } : null,
      now: input.now,
    });
    // Coverage: every klines request is bounded by endTime=to-1, so a normal
    // response is authoritative for the whole [pageStart, to) window — a
    // short/empty page positively confirms absence up to `to`. Claims are
    // clamped to `now` because the provider cannot confirm the future.
    // Abnormal terminations (malformed, cursor stall) claim nothing.
    const clampMs = Math.min(input.to.getTime(), input.now.getTime());
    let coveredFrom: Date | null = null;
    let coveredTo: Date | null = null;
    if (page.nextCursor) {
      coveredFrom = new Date(pageStartMs);
      coveredTo = new Date(Math.min(page.nextCursor.startTime, clampMs));
    } else if (
      page.stopReason === 'target_reached' ||
      page.stopReason === 'provider_exhausted' ||
      page.stopReason === 'empty_page'
    ) {
      coveredFrom = new Date(pageStartMs);
      coveredTo = new Date(clampMs);
    }
    if (
      coveredFrom !== null &&
      coveredTo !== null &&
      coveredFrom >= coveredTo
    ) {
      coveredFrom = null;
      coveredTo = null;
    }
    return {
      candles: page.candles,
      pagesFetched: 1,
      providerReturnedRows: page.providerReturnedRows,
      acceptedRows: page.acceptedRows,
      rejectedRows: page.rejectedRows,
      duplicateRows: page.duplicateRows,
      nextCursor: page.nextCursor
        ? { startTime: page.nextCursor.startTime }
        : null,
      stopReason: page.stopReason,
      complete: page.complete,
      coveredFrom,
      coveredTo,
    };
  }

  private async fetchKisPeriodPage(
    input: {
      asset: SyncAssetRecord;
      feed: MarketCandleFeed;
      from: Date;
      to: Date;
      cursor: Prisma.JsonObject | null;
      now: Date;
      signal?: AbortSignal;
      budget: FeedBudget;
    },
    descriptor: {
      kind: 'kis_domestic' | 'kis_us';
      symbol: string;
      marketCode: string;
    },
  ): Promise<MarketCandleFeedPage> {
    const domestic = descriptor.kind === 'kis_domestic';
    const timeZone = domestic ? 'Asia/Seoul' : 'America/New_York';
    const fromDate = formatZonedCursor(input.from, timeZone).date;
    const providerTo = resolveStockMarketDataUpperBound(
      input.asset,
      input.to,
      input.now,
    );
    if (!providerTo) {
      return emptyFeedPage('calendar_unavailable', false);
    }
    const defaultEndDate = formatZonedCursor(
      new Date(providerTo.getTime() - 1),
      timeZone,
    ).date;
    const cursorEndDate = readDateField(input.cursor, 'endDate');
    const endDate =
      cursorEndDate !== null && cursorEndDate <= defaultEndDate
        ? cursorEndDate
        : defaultEndDate;
    if (endDate < fromDate) {
      // The persisted date cursor already moved past targetFrom: the previous
      // pages confirmed the whole range (their coverage is in the checkpoint).
      return emptyFeedPage('target_reached', true);
    }

    const adapter = domestic
      ? this.domesticPeriodAdapter
      : this.overseasPeriodAdapter;
    const page: KisPeriodPageResult = await adapter.fetchPeriodPage({
      asset: {
        id: input.asset.id,
        symbol: descriptor.symbol,
        marketCode: descriptor.marketCode,
      },
      interval: input.feed as KisPeriodInterval,
      fromDate,
      endDate,
      signal: input.signal,
      timeoutMs: Math.min(
        30_000,
        Math.max(1, input.budget.deadlineMs - Date.now()),
      ),
    });
    if (page.state !== 'ok') {
      return emptyFeedPage(
        page.state === 'canceled'
          ? 'canceled'
          : page.state === 'max_duration'
            ? 'max_duration'
            : 'malformed_response',
        false,
      );
    }
    if (page.rows.length === 0) {
      // No data rows on this page: an empty response body, or only blank
      // padding entries — the provider has nothing more for this range.
      return {
        ...emptyFeedPage(
          page.providerReturnedRows === 0 ? 'empty_page' : 'provider_exhausted',
          false,
        ),
        providerReturnedRows: page.providerReturnedRows,
      };
    }
    if (page.oldestDate === null) {
      return {
        ...emptyFeedPage('malformed_response', false),
        providerReturnedRows: page.providerReturnedRows,
        rejectedRows: page.rows.length,
      };
    }

    const normalized = domestic
      ? this.periodNormalizer.normalizeDomesticPeriodRows({
          rows: page.rows,
          interval: input.feed as KisPeriodInterval,
          from: input.from,
          to: input.to,
          now: input.now,
        })
      : this.periodNormalizer.normalizeOverseasPeriodRows({
          rows: page.rows,
          interval: input.feed as KisPeriodInterval,
          from: input.from,
          to: input.to,
          now: input.now,
        });

    if (page.oldestDate <= fromDate) {
      // The date cursor chained contiguously from targetTo down past
      // targetFrom, so the whole target range is provider-confirmed. Clamp to
      // `now`: a target ending in the future cannot be confirmed beyond now.
      const coveredToMs = Math.min(input.to.getTime(), input.now.getTime());
      return {
        candles: normalized.candles,
        pagesFetched: 1,
        providerReturnedRows: page.providerReturnedRows,
        acceptedRows: normalized.acceptedRows,
        rejectedRows: normalized.rejectedRows,
        duplicateRows: normalized.duplicateRows,
        nextCursor: null,
        stopReason: 'target_reached',
        complete: true,
        coveredFrom: coveredToMs > input.from.getTime() ? input.from : null,
        coveredTo:
          coveredToMs > input.from.getTime() ? new Date(coveredToMs) : null,
      };
    }
    const nextEndDate = previousDate(page.oldestDate);
    if (nextEndDate === null || nextEndDate >= endDate) {
      return {
        candles: normalized.candles,
        pagesFetched: 1,
        providerReturnedRows: page.providerReturnedRows,
        acceptedRows: normalized.acceptedRows,
        rejectedRows: normalized.rejectedRows,
        duplicateRows: normalized.duplicateRows,
        nextCursor: null,
        stopReason: 'cursor_not_advanced',
        complete: false,
        coveredFrom: null,
        coveredTo: null,
      };
    }
    return {
      candles: normalized.candles,
      pagesFetched: 1,
      providerReturnedRows: page.providerReturnedRows,
      acceptedRows: normalized.acceptedRows,
      rejectedRows: normalized.rejectedRows,
      duplicateRows: normalized.duplicateRows,
      // The date cursor always moves strictly into the past; trCont is
      // metadata only (BYMD paging keeps every request idempotent).
      // Intermediate pages deliberately claim no coverage: local-date
      // boundaries do not map exactly onto UTC instants, so coverage is only
      // claimed when the terminal page proves the whole range was swept.
      nextCursor: { endDate: nextEndDate, trCont: page.trCont ?? '' },
      stopReason: null,
      complete: false,
      coveredFrom: null,
      coveredTo: null,
    };
  }

  private async fetchKisFiveMinuteSegment(
    input: {
      asset: SyncAssetRecord;
      from: Date;
      to: Date;
      cursor: Prisma.JsonObject | null;
      now: Date;
      signal?: AbortSignal;
      budget: FeedBudget;
    },
    descriptor: {
      kind: 'kis_domestic' | 'kis_us';
      symbol: string;
      marketCode: string;
    },
  ): Promise<MarketCandleFeedPage> {
    const segmentMs = KIS_FIVE_MINUTE_SEGMENT_MS[descriptor.kind];
    const cursorTo = readIntegerField(input.cursor, 'segmentTo');
    const segmentTo =
      cursorTo !== null &&
      cursorTo > input.from.getTime() &&
      cursorTo <= input.to.getTime()
        ? new Date(cursorTo)
        : input.to;
    const segmentFrom = new Date(
      Math.max(input.from.getTime(), segmentTo.getTime() - segmentMs),
    );

    const fetchInput = {
      asset: {
        id: input.asset.id,
        symbol: descriptor.symbol,
        marketCode: descriptor.marketCode,
      },
      from: segmentFrom,
      to: segmentTo,
      maxPages: Math.min(KIS_SEGMENT_MAX_PAGES, input.budget.pagesLeft),
      maxRows: KIS_SEGMENT_MAX_RAW_ROWS,
      maxDurationMs: Math.max(1, input.budget.deadlineMs - Date.now()),
      signal: input.signal,
      now: input.now,
    };
    const result =
      descriptor.kind === 'kis_domestic'
        ? await this.fiveMinuteIngestion.fetchDomesticFiveMinuteCandles(
            fetchInput,
          )
        : await this.fiveMinuteIngestion.fetchUsFiveMinuteCandles(fetchInput);

    const base = {
      candles: result.candles,
      pagesFetched: Math.max(1, result.pagesFetched),
      providerReturnedRows: result.providerReturnedRows,
      acceptedRows: result.acceptedRows,
      rejectedRows: result.rejectedRows,
      duplicateRows: result.duplicateRows,
    };
    const clampedSegmentToMs = Math.min(
      segmentTo.getTime(),
      input.now.getTime(),
    );

    if (result.stopReason === 'expected_no_data') {
      const reachedTargetFrom = segmentFrom.getTime() <= input.from.getTime();
      return {
        ...base,
        nextCursor: reachedTargetFrom
          ? null
          : { segmentTo: segmentFrom.getTime() },
        stopReason: reachedTargetFrom ? 'target_reached' : null,
        complete: reachedTargetFrom,
        coveredFrom: segmentFrom,
        coveredTo: new Date(clampedSegmentToMs),
      };
    }
    if (result.stopReason === 'calendar_unavailable') {
      return {
        ...base,
        nextCursor: null,
        stopReason: 'calendar_unavailable',
        complete: false,
        coveredFrom: null,
        coveredTo: null,
      };
    }

    // Only the adapter's own target_reached proves the segment was swept down
    // to segmentFrom. Geometry alone (segmentFrom <= targetFrom) must never
    // imply completeness: the US continuation and the domestic date cursor
    // both stop early when the provider's minute retention runs out.
    //
    // A completed provider SWEEP is still not completed DATA: the ingestion
    // result's `complete` also requires the stored candles to be whole
    // (accepted rows exist, and for the domestic builder incompleteBuckets
    // is zero). A target_reached sweep whose data is incomplete has holes at
    // unknown positions inside the segment, so it must not claim any covered
    // range — and the run must terminate here: continuing to older segments
    // would let the min/max coverage merge bridge right over the hole.
    // Partial candles already fetched are still written by the caller.
    if (result.stopReason === 'target_reached') {
      if (result.complete !== true) {
        return {
          ...base,
          nextCursor: null,
          stopReason: 'data_incomplete',
          complete: false,
          coveredFrom: null,
          coveredTo: null,
        };
      }
      const reachedTargetFrom = segmentFrom.getTime() <= input.from.getTime();
      return {
        ...base,
        nextCursor: reachedTargetFrom
          ? null
          : { segmentTo: segmentFrom.getTime() },
        stopReason: reachedTargetFrom ? 'target_reached' : null,
        complete: reachedTargetFrom,
        coveredFrom:
          clampedSegmentToMs > segmentFrom.getTime() ? segmentFrom : null,
        coveredTo:
          clampedSegmentToMs > segmentFrom.getTime()
            ? new Date(clampedSegmentToMs)
            : null,
      };
    }

    if (
      result.stopReason === 'empty_page' ||
      result.stopReason === 'provider_exhausted'
    ) {
      // The provider has nothing further into the past (retention edge,
      // pre-listing range, or a genuinely empty tail — indistinguishable
      // here). Terminate the run: sweeping even older segments cannot
      // succeed. Received rows confirm coverage only from the first full 5m
      // bucket at/after the oldest received row — and only when no
      // incomplete bucket was dropped inside that window, since a dropped
      // bucket is a hole the claim would silently cover.
      let coveredFrom: Date | null = null;
      let coveredTo: Date | null = null;
      if (
        result.oldestOpenTime !== null &&
        (result.incompleteBuckets ?? 0) === 0
      ) {
        const flooredOldest = Math.max(
          ceilToFiveMinutes(result.oldestOpenTime.getTime()),
          segmentFrom.getTime(),
        );
        if (flooredOldest < clampedSegmentToMs) {
          coveredFrom = new Date(flooredOldest);
          coveredTo = new Date(clampedSegmentToMs);
        }
      }
      return {
        ...base,
        nextCursor: null,
        stopReason: result.stopReason,
        complete: false,
        coveredFrom,
        coveredTo,
      };
    }

    // Abnormal or budget stop inside the segment. Whatever complete 5m
    // candles were built are still written by the caller, but the cursor
    // stays on this segment so a resume re-fetches it in full.
    return {
      ...base,
      nextCursor: null,
      stopReason: result.stopReason,
      complete: false,
      coveredFrom: null,
      coveredTo: null,
    };
  }

  private async resolveTargetRange(
    assetId: string,
    feed: MarketCandleFeed,
    options: {
      mode: MarketCandleSyncMode;
      from?: Date;
      to?: Date;
      now: Date;
    },
  ): Promise<{ from: Date; to: Date }> {
    const to = options.to ?? options.now;
    const defaultFrom = new Date(
      options.now.getTime() - FEED_DEFAULT_LOOKBACK_MS[feed],
    );
    if (options.mode === MarketCandleSyncMode.repair) {
      // Validated upfront: repair always has explicit from/to.
      return { from: options.from as Date, to };
    }
    if (options.mode === MarketCandleSyncMode.initial) {
      return { from: options.from ?? defaultFrom, to };
    }
    // incremental: continue from the latest stored row with overlap so
    // provider-side revisions of recent candles are re-fetched. Only the
    // latest row is inspected — interior gaps need repair mode.
    const latest = await this.repository.findLatest({
      assetId,
      interval: feed,
    });
    const base = options.from ?? defaultFrom;
    if (!latest) return { from: base, to };
    const overlapMs = Math.max(
      this.config.incrementalOverlapMinutes * 60_000,
      2 * FEED_APPROX_INTERVAL_MS[feed],
    );
    const from = new Date(
      Math.max(base.getTime(), latest.openTime.getTime() - overlapMs),
    );
    return { from, to };
  }

  private resolveDescriptor(
    asset: SyncAssetRecord,
  ):
    | { ok: true; descriptor: ProviderDescriptor }
    | { ok: false; reason: string } {
    const symbol = asset.symbol.trim().toUpperCase();
    if (asset.assetType === AssetType.domestic_stock) {
      if (!DOMESTIC_KRX_MARKETS.has(asset.market.trim().toUpperCase())) {
        return { ok: false, reason: 'UNSUPPORTED_DOMESTIC_MARKET' };
      }
      if (!/^\d{6}$/u.test(symbol)) {
        return { ok: false, reason: 'INVALID_KIS_DOMESTIC_SYMBOL' };
      }
      return {
        ok: true,
        descriptor: { kind: 'kis_domestic', symbol, marketCode: 'J' },
      };
    }
    if (asset.assetType === AssetType.us_stock) {
      const marketCode = normalizeKisUsMarketCode(asset.market);
      if (!marketCode) {
        return { ok: false, reason: 'UNSUPPORTED_US_MARKET' };
      }
      if (!/^[A-Z0-9][A-Z0-9.-]{0,19}$/u.test(symbol)) {
        return { ok: false, reason: 'INVALID_KIS_US_SYMBOL' };
      }
      return {
        ok: true,
        descriptor: { kind: 'kis_us', symbol, marketCode },
      };
    }
    if (asset.assetType === AssetType.crypto) {
      const binanceSymbol = toBinanceUsdtSymbol(symbol);
      if (!binanceSymbol) {
        return { ok: false, reason: 'INVALID_BINANCE_SYMBOL' };
      }
      return {
        ok: true,
        descriptor: { kind: 'binance', symbol: binanceSymbol },
      };
    }
    return { ok: false, reason: 'UNSUPPORTED_ASSET_TYPE' };
  }

  private sourceProviderFor(
    descriptor: ProviderDescriptor,
    feed: MarketCandleFeed,
  ): string {
    if (descriptor.kind === 'binance') return BINANCE_CANDLE_SOURCE;
    if (feed === '5m') {
      return descriptor.kind === 'kis_domestic'
        ? KIS_DOMESTIC_CANDLE_SOURCE
        : KIS_US_CANDLE_SOURCE;
    }
    return descriptor.kind === 'kis_domestic'
      ? KIS_DOMESTIC_PERIOD_SOURCE
      : KIS_OVERSEAS_PERIOD_SOURCE;
  }

  private checkBudget(budget: FeedBudget): MarketCandleSyncStopReason | null {
    if (budget.pagesLeft <= 0) return 'max_pages';
    if (budget.rowsLeft <= 0) return 'max_rows';
    if (Date.now() >= budget.deadlineMs) return 'max_duration';
    return null;
  }

  private requireBudgetValue(
    value: number | undefined,
    label: string,
  ): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new MarketCandleSyncInputError(
        `${label} must be a positive integer.`,
      );
    }
    return value;
  }

  private failedResult(
    base: {
      provider: string;
      assetId: string;
      interval: MarketCandleFeed;
      mode: MarketCandleSyncMode;
      dryRun: boolean;
    },
    failure: {
      rangeFrom: Date;
      rangeTo: Date;
      stopReason: MarketCandleSyncStopReason;
      errorCode: string;
      errorMessage: string | null;
    },
  ): MarketCandleFeedResult {
    return {
      ...base,
      rangeFrom: failure.rangeFrom,
      rangeTo: failure.rangeTo,
      pagesFetched: 0,
      providerReturnedRows: 0,
      acceptedRows: 0,
      rejectedRows: 0,
      duplicateRows: 0,
      writtenRows: 0,
      oldestOpenTime: null,
      latestOpenTime: null,
      complete: false,
      coverageComplete: false,
      completionReason: null,
      coveredFrom: null,
      coveredTo: null,
      stopReason: failure.stopReason,
      status: MarketCandleSyncStatus.failed,
      syncStateId: null,
      resumed: false,
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
    };
  }

  private parseTargets(
    targets: readonly MarketCandleFeed[] | undefined,
  ): readonly MarketCandleFeed[] {
    if (targets === undefined) return MARKET_CANDLE_SYNC_FEEDS;
    const unique = [...new Set(targets)];
    if (unique.length === 0) {
      throw new MarketCandleSyncInputError('targets must not be empty.');
    }
    for (const target of unique) {
      if (!MARKET_CANDLE_SYNC_FEEDS.includes(target)) {
        throw new MarketCandleSyncInputError(
          `targets must be a subset of ${MARKET_CANDLE_SYNC_FEEDS.join(', ')}.`,
        );
      }
    }
    return unique;
  }

  private parseMode(
    mode: MarketCandleSyncMode | undefined,
    from: Date | undefined,
    to: Date | undefined,
  ): MarketCandleSyncMode {
    const resolved = mode ?? MarketCandleSyncMode.incremental;
    if (!Object.values(MarketCandleSyncMode).includes(resolved)) {
      throw new MarketCandleSyncInputError(
        'mode must be initial, incremental, or repair.',
      );
    }
    for (const [name, value] of [
      ['from', from],
      ['to', to],
    ] as const) {
      if (
        value !== undefined &&
        (!(value instanceof Date) || Number.isNaN(value.getTime()))
      ) {
        throw new MarketCandleSyncInputError(`${name} must be a valid Date.`);
      }
    }
    if (from && to && from.getTime() >= to.getTime()) {
      throw new MarketCandleSyncInputError(
        'from must be earlier than to (half-open [from, to)).',
      );
    }
    if (resolved === MarketCandleSyncMode.repair && (!from || !to)) {
      throw new MarketCandleSyncInputError(
        'repair mode requires explicit from and to.',
      );
    }
    return resolved;
  }

  private parseOptionalPositiveInteger(
    value: number | undefined,
    name: string,
  ): number | undefined {
    if (value === undefined) return undefined;
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MarketCandleSyncInputError(
        `${name} must be a positive integer.`,
      );
    }
    return value;
  }

  private requireText(value: string, name: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new MarketCandleSyncInputError(
        `${name} must be a non-empty string.`,
      );
    }
    return value.trim();
  }
}

function emptyFeedPage(
  stopReason: MarketCandleSyncStopReason,
  complete: boolean,
): MarketCandleFeedPage {
  return {
    candles: [],
    pagesFetched: 1,
    providerReturnedRows: 0,
    acceptedRows: 0,
    rejectedRows: 0,
    duplicateRows: 0,
    nextCursor: null,
    stopReason,
    complete,
    coveredFrom: null,
    coveredTo: null,
  };
}

function ceilToFiveMinutes(ms: number): number {
  return Math.ceil(ms / 300_000) * 300_000;
}

function asJsonObject(
  value: Prisma.JsonValue | null,
): Prisma.JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : null;
}

function readIntegerField(
  cursor: Prisma.JsonObject | null,
  field: string,
): number | null {
  const value = cursor?.[field];
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function readDateField(
  cursor: Prisma.JsonObject | null,
  field: string,
): string | null {
  const value = cursor?.[field];
  return typeof value === 'string' && /^\d{8}$/u.test(value) ? value : null;
}

function previousDate(dateText: string): string | null {
  const year = Number(dateText.slice(0, 4));
  const month = Number(dateText.slice(4, 6));
  const day = Number(dateText.slice(6, 8));
  const ms = Date.UTC(year, month - 1, day) - DAY_MS;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(
    date.getUTCDate(),
  )}`;
}

function earlier(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() < current.getTime()
    ? candidate
    : current;
}

function later(current: Date | null, candidate: Date): Date {
  return current === null || candidate.getTime() > current.getTime()
    ? candidate
    : current;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : 'Unknown error';
}
