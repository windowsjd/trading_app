import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  MarketCandleSyncMode,
  MarketCandleSyncStatus,
} from '../generated/prisma/client';
import type {
  AssetCandlesAsset,
  AssetCandlesResponse,
  ParsedAssetCandlesQuery,
} from './asset-candles.service';
import { AssetCandlesCacheService } from './asset-candles-cache.service';
import type { CandleCacheKeyInput } from './asset-candles-cache.keys';
import {
  AssetCandlesSingleFlightService,
  CandleSingleFlightWaitTimeoutError,
} from './asset-candles-single-flight.service';
import { isCandleOperationalFallbackError } from './candle-operational-error';
import {
  CandleDatabaseLoader,
  type CandleDatabaseLoadResult,
} from './candle-database.loader';
import {
  CandleReadPlanBuilder,
  type CandleReadPlan,
} from './candle-read-plan.builder';
import {
  CANDLE_SERVING_CONFIG,
  type CandleServingConfig,
} from './candle-serving.config';
import { MarketCandleSyncService } from './market-candle-sync.service';
import type { MarketCandleAssetSyncResult } from './market-candle-sync.types';
import { LiveCandleOverlayService } from './live-candle-overlay.service';

export type CandleDeliveryState =
  | 'fresh_cache'
  | 'database_fresh'
  | 'provider_refreshed'
  | 'stale_cache_fallback'
  | 'database_fallback'
  | 'legacy_provider';

/**
 * Managed serving order (mode=database, managed read plan):
 * fresh Redis → PostgreSQL → bounded sync → PostgreSQL requery → stale Redis
 * → strict PostgreSQL last-known-good → provider-compatible error. Provider
 * rows are never returned without a durable write + requery.
 *
 * legacyLoader (provider-direct) is reachable ONLY through:
 * 1. CANDLE_SERVING_MODE=legacy — the explicit full rollback switch;
 * 2. read plans with managedByPersistence=false (out-of-policy requests);
 * 3. the cold-baseline policy: no completed coverage and a requested range
 *    beyond the on-demand repair budget (logged as cold_baseline_required) —
 *    operators seed those via the manual sync job.
 * Once a managed refresh has started, no failure path calls legacyLoader.
 */
@Injectable()
export class CandleServingService {
  private readonly logger = new Logger(CandleServingService.name);

  constructor(
    private readonly plans: CandleReadPlanBuilder,
    private readonly database: CandleDatabaseLoader,
    private readonly cache: AssetCandlesCacheService,
    private readonly singleFlight: AssetCandlesSingleFlightService,
    private readonly sync: MarketCandleSyncService,
    @Inject(CANDLE_SERVING_CONFIG)
    private readonly config: CandleServingConfig,
    @Optional() private readonly liveOverlay?: LiveCandleOverlayService,
  ) {}

  async serve(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    legacyLoader: () => Promise<AssetCandlesResponse>,
  ): Promise<AssetCandlesResponse> {
    const response = await this.serveBase(asset, query, legacyLoader);
    return this.liveOverlay
      ? this.liveOverlay.overlayHttpResponse(response, query)
      : response;
  }

  private async serveBase(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    legacyLoader: () => Promise<AssetCandlesResponse>,
  ): Promise<AssetCandlesResponse> {
    if (this.config.mode === 'legacy') {
      const response = await legacyLoader();
      this.logDelivery('legacy_provider', asset.id, query.interval);
      return response;
    }

    const plan = this.plans.build(asset, query);
    if (!plan.managedByPersistence) {
      const response = await legacyLoader();
      this.logDelivery('legacy_provider', asset.id, query.interval, {
        reason: plan.outOfPolicyReason,
      });
      return response;
    }

    const key = this.cacheKey(asset.id, query, plan);
    const cached = await this.cache.get(key);
    if (cached.status === 'fresh') {
      this.logDelivery('fresh_cache', asset.id, query.interval);
      return cached.value;
    }
    const stale = cached.status === 'stale' ? cached.value : null;

    // The initial database read participates in the stale fallback: a
    // database outage with a stale cached response degrades to that response
    // instead of failing the request. Validation/config/programmer errors
    // are never absorbed — only operational failures qualify.
    let initial: CandleDatabaseLoadResult;
    try {
      initial = await this.database.load(asset, query, plan);
    } catch (error) {
      if (stale && this.isOperationalRefreshError(error)) {
        this.logDelivery('stale_cache_fallback', asset.id, query.interval, {
          reason: this.errorName(error),
        });
        return stale;
      }
      throw error;
    }

    // A large request without completed baseline coverage is deliberately kept
    // on the rollout-safe provider-direct path. Operators must seed it through
    // the manual sync job before database serving can own it.
    if (
      !initial.completedCoverage &&
      plan.sourceRange.to.getTime() - plan.sourceRange.from.getTime() >
        this.config.maxOnDemandRepairRangeMs
    ) {
      const response = await legacyLoader();
      this.logDelivery('legacy_provider', asset.id, query.interval, {
        reason: 'cold_baseline_required',
      });
      return response;
    }

    try {
      const response = await this.singleFlight.getOrLoad({
        cacheKeyInput: key,
        staleWaiterMaxWaitMs: this.config.staleWaiterMaxWaitMs,
        loader: () => this.loadManaged(asset, query, plan),
      });
      // The coordinator can return a stale waiter value after its short wait.
      if (stale && response === stale) {
        this.logDelivery('stale_cache_fallback', asset.id, query.interval, {
          reason: 'remote_refresh_in_progress',
        });
      }
      return response;
    } catch (error) {
      if (!this.isOperationalRefreshError(error)) throw error;
      if (stale) {
        this.logDelivery('stale_cache_fallback', asset.id, query.interval, {
          reason: this.errorName(error),
        });
        return stale;
      }
      if (this.usableLastKnownGood(initial)) {
        this.logDelivery('database_fallback', asset.id, query.interval, {
          reason: this.errorName(error),
        });
        return initial.response as AssetCandlesResponse;
      }
      // The managed refresh failed and no degraded copy exists (no stale
      // Redis, no strict PostgreSQL last-known-good). The request fails with
      // the provider-compatible error contract. It must NOT be answered by a
      // provider-direct call: once a request is managed, provider rows only
      // reach clients through the durable store, and legacyLoader is
      // reachable solely via CANDLE_SERVING_MODE=legacy, an unmanaged read
      // plan, or the explicit cold-baseline policy above.
      this.logger.warn(
        JSON.stringify({
          event: 'candle_delivery_failed',
          state: 'managed_unresolved',
          assetId: asset.id,
          interval: query.interval,
          reason: this.errorName(error),
        }),
      );
      throw this.providerCompatibilityError(asset);
    }
  }

  private async loadManaged(
    asset: AssetCandlesAsset,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan,
  ): Promise<AssetCandlesResponse> {
    const before = await this.database.load(asset, query, plan);
    if (
      (before.state === 'available' || before.state === 'confirmed_empty') &&
      before.fresh
    ) {
      this.logDelivery('database_fresh', asset.id, query.interval);
      return before.response as AssetCandlesResponse;
    }

    if (!this.config.onDemandRefreshEnabled) {
      if (this.usableLastKnownGood(before)) {
        this.logDelivery('database_fallback', asset.id, query.interval, {
          reason: 'on_demand_refresh_disabled',
        });
        return before.response as AssetCandlesResponse;
      }
      throw new CandleOperationalRefreshError('On-demand refresh is disabled.');
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.onDemandRefreshMaxDurationMs,
    );
    let result: MarketCandleAssetSyncResult;
    try {
      const repair =
        before.state === 'missing' || before.state === 'incomplete';
      result = await this.sync.syncAsset({
        assetId: asset.id,
        targets: [plan.sourceInterval as '5m' | '1d' | '1w'],
        mode: repair
          ? MarketCandleSyncMode.repair
          : MarketCandleSyncMode.incremental,
        from: plan.sourceRange.from,
        to: plan.sourceRange.to,
        resume: false,
        now: query.clock,
        signal: controller.signal,
        budget: {
          maxPages: this.config.onDemandRefreshMaxPages,
          maxRows: this.config.onDemandRefreshMaxRows,
          maxDurationMs: this.config.onDemandRefreshMaxDurationMs,
        },
      });
    } finally {
      clearTimeout(timer);
    }

    // Never use provider result rows. The durable store is always queried
    // again after sync, including incomplete/failed runs.
    const after = await this.database.load(asset, query, plan);
    if (after.state === 'available' || after.state === 'confirmed_empty') {
      const refreshComplete = result.feeds.every(
        (feed) =>
          feed.status === MarketCandleSyncStatus.completed && feed.complete,
      );
      this.logDelivery(
        refreshComplete ? 'provider_refreshed' : 'database_fallback',
        asset.id,
        query.interval,
        refreshComplete ? {} : { reason: 'refresh_incomplete_db_satisfied' },
      );
      return after.response as AssetCandlesResponse;
    }
    const feed = result.feeds[0];
    throw new CandleOperationalRefreshError(
      feed?.errorCode ?? feed?.stopReason ?? 'Candle refresh did not complete.',
    );
  }

  private usableLastKnownGood(result: CandleDatabaseLoadResult): boolean {
    return (
      result.response?.data.state === 'available' &&
      result.completedCoverage &&
      result.droppedIncompleteBuckets === 0
    );
  }

  private cacheKey(
    assetId: string,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan,
  ): CandleCacheKeyInput {
    return {
      assetId,
      range: query.range,
      interval: query.interval,
      limit: query.limit,
      requestedDate: query.requestedDate,
      includePrevious: query.includePrevious,
      latest: plan.latestRequest,
      ...(plan.latestRequest
        ? {}
        : {
            normalizedFrom: plan.requestedRange.from.toISOString(),
            normalizedTo: plan.requestedRange.to.toISOString(),
          }),
      explicitTo: plan.explicitTo,
    };
  }

  /**
   * Operational failures eligible for the stale/database fallback: refresh
   * coordination timeouts, database connectivity/timeout/pool errors, Redis
   * unavailability, and provider-refresh operational failures. Validation,
   * configuration, and programmer errors always propagate.
   */
  private isOperationalRefreshError(error: unknown): boolean {
    return (
      error instanceof CandleOperationalRefreshError ||
      error instanceof CandleSingleFlightWaitTimeoutError ||
      isCandleOperationalFallbackError(error, ['CandleOperationalRefreshError'])
    );
  }

  private providerCompatibilityError(asset: AssetCandlesAsset): HttpException {
    const crypto = asset.assetType === 'crypto';
    return new HttpException(
      {
        success: false,
        error: {
          code: crypto
            ? 'ASSET_CANDLES_PROVIDER_ERROR'
            : 'ASSET_CANDLES_PROVIDER_UNAVAILABLE',
          message: crypto
            ? 'Binance candle provider is unavailable.'
            : 'KIS candle provider is unavailable.',
          details: null,
        },
      },
      crypto ? HttpStatus.BAD_GATEWAY : HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private logDelivery(
    state: CandleDeliveryState,
    assetId: string,
    interval: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'candle_delivery',
        state,
        assetId,
        interval,
        ...extra,
      }),
    );
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name : 'operational_error';
  }
}

export class CandleOperationalRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CandleOperationalRefreshError';
  }
}
