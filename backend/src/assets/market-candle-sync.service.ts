import { Inject, Injectable } from '@nestjs/common';
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
  type MarketCandleSyncStopReason,
  type MarketCandleSyncSummary,
} from './market-candle-sync.types';

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
  ['target_reached', 'provider_exhausted', 'empty_page'],
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
    return {
      mode,
      dryRun: options.dryRun,
      requestedAssets: assets.length,
      processedAssets: results.length,
      skippedAssets,
      assets: results,
      totalFeeds: allFeeds.length,
      completedFeeds: allFeeds.filter(
        (feed) => feed.status === MarketCandleSyncStatus.completed,
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

    try {
      return await this.runFeedLocked(
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
      pagesLeft: this.config.maxPages,
      rowsLeft: Math.min(
        this.config.maxRows,
        FEED_ROW_CAPS[feed] ?? this.config.maxRows,
      ),
      deadlineMs: Date.now() + this.config.maxDurationMs,
    };

    let oldestOpenTime: Date | null = null;
    let latestOpenTime: Date | null = null;
    let stopReason: MarketCandleSyncStopReason = 'max_pages';
    let status: MarketCandleSyncStatus = MarketCandleSyncStatus.failed;
    let complete = false;
    let errorCode: string | null = null;
    let errorMessage: string | null = null;

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
          complete = page.complete;
          await this.stateRepository.markCompleted(state.id, new Date());
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
    const page = await this.binanceCandles.fetchKlinesPage({
      symbol: descriptor.symbol,
      interval: input.feed as BinanceCandleInterval,
      from: input.from,
      to: input.to,
      cursor:
        startTime !== null && startTime >= input.from.getTime()
          ? { startTime }
          : null,
      now: input.now,
    });
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
    const defaultEndDate = formatZonedCursor(
      new Date(input.to.getTime() - 1),
      timeZone,
    ).date;
    const cursorEndDate = readDateField(input.cursor, 'endDate');
    const endDate =
      cursorEndDate !== null && cursorEndDate <= defaultEndDate
        ? cursorEndDate
        : defaultEndDate;
    if (endDate < fromDate) {
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
      nextCursor: { endDate: nextEndDate, trCont: page.trCont ?? '' },
      stopReason: null,
      complete: false,
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

    const segmentSwept = SWEEP_TERMINAL_REASONS.has(result.stopReason);
    if (!segmentSwept) {
      // Abnormal or budget stop inside the segment. Whatever complete 5m
      // candles were built are still written by the caller, but the cursor
      // stays on this segment so a resume re-fetches it in full.
      return {
        candles: result.candles,
        pagesFetched: Math.max(1, result.pagesFetched),
        providerReturnedRows: result.providerReturnedRows,
        acceptedRows: result.acceptedRows,
        rejectedRows: result.rejectedRows,
        duplicateRows: result.duplicateRows,
        nextCursor: null,
        stopReason: result.stopReason,
        complete: false,
      };
    }

    const reachedTargetFrom = segmentFrom.getTime() <= input.from.getTime();
    return {
      candles: result.candles,
      pagesFetched: Math.max(1, result.pagesFetched),
      providerReturnedRows: result.providerReturnedRows,
      acceptedRows: result.acceptedRows,
      rejectedRows: result.rejectedRows,
      duplicateRows: result.duplicateRows,
      nextCursor: reachedTargetFrom
        ? null
        : { segmentTo: segmentFrom.getTime() },
      stopReason: reachedTargetFrom ? 'target_reached' : null,
      complete: reachedTargetFrom,
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
  };
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
