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
 * 3. the cold-baseline policy for NON-aggregated feeds: no completed coverage
 *    and a requested range beyond the on-demand repair budget (logged as
 *    cold_baseline_required) — operators seed those via the manual sync job.
 *
 * Aggregated intervals (15m/30m/1h/4h) are deliberately excluded from (3).
 * They exist only as read-time aggregates of the stored 5m feed, so a
 * provider-direct answer is one truncated minute page bucketed without any
 * completeness check — e.g. a single bogus 4h candle for a 30-day request.
 * Without a baseline those requests fail with ASSET_CANDLES_BASELINE_NOT_READY
 * so the client can say "preparing" instead of drawing wrong candles.
 *
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
      this.logDelivery('legacy_provider', asset.id, query, null, {
        reason: 'serving_mode_legacy',
      });
      return response;
    }

    const plan = this.plans.build(asset, query);
    if (!plan.managedByPersistence) {
      const response = await legacyLoader();
      this.logDelivery('legacy_provider', asset.id, query, plan, {
        reason: plan.outOfPolicyReason,
      });
      return response;
    }

    const key = this.cacheKey(asset.id, query, plan);
    const cached = await this.cache.get(key);
    if (cached.status === 'fresh') {
      this.logDelivery('fresh_cache', asset.id, query, plan);
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
        this.logDelivery('stale_cache_fallback', asset.id, query, plan, {
          reason: this.errorName(error),
        });
        return stale;
      }
      throw error;
    }

    // A large request without completed baseline coverage cannot be answered
    // from the store yet. Operators seed it through the manual sync job.
    if (
      !initial.completedCoverage &&
      plan.sourceRange.to.getTime() - plan.sourceRange.from.getTime() >
        this.config.maxOnDemandRepairRangeMs
    ) {
      // 15m/30m/1h/4h are read-time aggregates of the stored 5m feed. The
      // provider-direct path would bucket ONE truncated minute page (KIS caps
      // a page at 120 rows) into "candles" without any constituent check, so a
      // 30-day 4h request comes back as a single fabricated candle. Fail
      // explicitly instead; the client shows a "preparing" state.
      if (plan.requiresAggregation) {
        this.logDeliveryFailed('baseline_not_ready', asset.id, query, plan, {
          reason: 'cold_baseline_required',
        });
        throw this.baselineNotReadyError();
      }
      const response = await legacyLoader();
      this.logDelivery('legacy_provider', asset.id, query, plan, {
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
        this.logDelivery('stale_cache_fallback', asset.id, query, plan, {
          reason: 'remote_refresh_in_progress',
        });
      }
      return response;
    } catch (error) {
      if (!this.isOperationalRefreshError(error)) throw error;
      if (stale) {
        this.logDelivery('stale_cache_fallback', asset.id, query, plan, {
          reason: this.errorName(error),
        });
        return stale;
      }
      if (this.usableLastKnownGood(initial)) {
        this.logDelivery('database_fallback', asset.id, query, plan, {
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
      this.logDeliveryFailed('managed_unresolved', asset.id, query, plan, {
        reason: this.errorName(error),
      });
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
      this.logDelivery('database_fresh', asset.id, query, plan, {
        completedCoverage: before.completedCoverage,
      });
      return before.response as AssetCandlesResponse;
    }

    if (!this.config.onDemandRefreshEnabled) {
      if (this.usableLastKnownGood(before)) {
        this.logDelivery('database_fallback', asset.id, query, plan, {
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
        query,
        plan,
        {
          completedCoverage: after.completedCoverage,
          ...(refreshComplete
            ? {}
            : { reason: 'refresh_incomplete_db_satisfied' }),
        },
      );
      return after.response as AssetCandlesResponse;
    }

    // Provider-confirmed coverage for the whole range, but some historical
    // aggregate buckets are missing constituents even after the repair (a
    // real hole in the 5m feed, e.g. an illiquid window the provider never
    // filled). The incomplete buckets stay DROPPED — they are never promoted
    // to normal candles — and the complete ones are served rather than
    // failing a 30-day chart over one gap.
    if (
      after.state === 'incomplete' &&
      after.completedCoverage &&
      after.response?.data.state === 'available'
    ) {
      this.logDelivery('database_fallback', asset.id, query, plan, {
        reason: 'incomplete_buckets_dropped',
        droppedIncompleteBuckets: after.droppedIncompleteBuckets,
      });
      return after.response;
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

  /**
   * Server-side delivery diagnostics. Everything an operator needs to tell a
   * database answer from a provider-direct one — delivery state, target and
   * source interval, requested range, coverage, fallback reason — is logged
   * here; the HTTP response shape is unchanged and leaks none of it.
   */
  private logDelivery(
    state: CandleDeliveryState,
    assetId: string,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan | null,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'candle_delivery',
        state,
        ...this.deliveryContext(assetId, query, plan),
        ...extra,
      }),
    );
  }

  private logDeliveryFailed(
    state: 'managed_unresolved' | 'baseline_not_ready',
    assetId: string,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan | null,
    extra: Record<string, unknown> = {},
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'candle_delivery_failed',
        state,
        ...this.deliveryContext(assetId, query, plan),
        ...extra,
      }),
    );
  }

  private deliveryContext(
    assetId: string,
    query: ParsedAssetCandlesQuery,
    plan: CandleReadPlan | null,
  ): Record<string, unknown> {
    return {
      assetId,
      interval: query.interval,
      range: query.range,
      limit: query.limit,
      ...(plan
        ? {
            sourceInterval: plan.sourceInterval,
            requiresAggregation: plan.requiresAggregation,
            requestedFrom: plan.requestedRange.from.toISOString(),
            requestedTo: plan.requestedRange.to.toISOString(),
            sourceFrom: plan.sourceRange.from.toISOString(),
            sourceTo: plan.sourceRange.to.toISOString(),
          }
        : {}),
    };
  }

  /**
   * The 5m baseline that 15m/30m/1h/4h are aggregated from has not been
   * seeded for this range yet. This is NOT a provider outage: the client is
   * expected to show a "chart data is being prepared" state and retry, and
   * the operator seeds the range with the manual `market_candle_sync` job.
   */
  private baselineNotReadyError(): HttpException {
    return new HttpException(
      {
        success: false,
        error: {
          code: 'ASSET_CANDLES_BASELINE_NOT_READY',
          message:
            'Stored 5m baseline coverage is being prepared for this candle range.',
          details: null,
        },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
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
