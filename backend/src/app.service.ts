import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  LIVE_CANDLE_CONFIG,
  validateLiveReconciliationDependencies,
  type LiveCandleConfig,
} from './assets/live-candle.config';
import { LiveCandleHealthService } from './assets/live-candle-health.service';
import {
  getMarketCalendarCoverage,
  readMarketCalendarCoverageConfig,
} from './orders/market-calendar/market-calendar.registry';
import { getMarketSessionOverrideRuntimeStatus } from './orders/market-calendar/market-session-override.store';
import { resolveRegularSessionForEvent } from './orders/market-calendar.policy';
import { AssetType } from './generated/prisma/client';
import { getOpsSchedulerConfig } from './ops/ops-config';
import { OpsJobRunService } from './ops/ops-job-run.service';
import { PrismaService } from './prisma/prisma.service';
import { BinanceWebSocketStreamingService } from './providers/binance/binance-websocket-streaming.service';
import { KisWebSocketStreamingService } from './providers/kis/kis-websocket-streaming.service';
import {
  TICKER_FANOUT_METRICS,
  type TickerFanoutMetricsSource,
} from './realtime/ticker-fanout-metrics';
import { LiveCandlePubSubService } from './realtime/live-candle-pubsub.service';
import { RedisService } from './redis/redis.service';
import { readRedisConfig } from './redis/redis.config';
import {
  isKoscomPollingOwnedByLiveSupervisor,
  readKoscomConfig,
} from './providers/koscom/koscom.config';
import { TiingoDiagnosticsService } from './providers/tiingo/tiingo-diagnostics.service';
import { FuturesMarkIngestion } from './futures/futures-mark-ingestion.service';
import { FuturesMarkRetentionService } from './futures/futures-mark-retention.service';
import { FuturesLastPriceRetentionService } from './futures/futures-last-price-retention.service';
import {
  DATABASE_STORAGE_RUNWAY_ALERT_DAYS,
  DatabaseStorageMonitorService,
} from './ops/database-storage-monitor.service';
import { AssetPriceSnapshotRetentionWorker } from './providers/asset-price-snapshot-retention.worker';
import { CryptoOrderBookHistoryService } from './providers/crypto-order-book-history.service';
import { CryptoOrderBookRetentionWorker } from './providers/crypto-order-book-retention.worker';

/**
 * Structured readiness reasons for the operator market-session override
 * runtime (additive next to MARKET_CALENDAR_COVERAGE_MISSING / _PROVISIONAL):
 * - NOT_LOADED: the first DB snapshot load has not completed yet; stock
 *   calendars are fail-closed (calendar_unavailable) until it does.
 * - UNAVAILABLE: the cold-start load failed and none has succeeded since;
 *   stock calendars stay fail-closed.
 * - LAST_KNOWN_GOOD: a snapshot was loaded but the most recent refresh
 *   failed; the last-known-good snapshot keeps serving (degraded only).
 * Crypto is unaffected by all three.
 */
export const MARKET_SESSION_OVERRIDE_READINESS_REASONS = {
  notLoaded: 'MARKET_SESSION_OVERRIDE_NOT_LOADED',
  unavailable: 'MARKET_SESSION_OVERRIDE_UNAVAILABLE',
  lastKnownGood: 'MARKET_SESSION_OVERRIDE_LAST_KNOWN_GOOD',
} as const;

/**
 * Reasons that need an operator, not just a note in the payload. `/readiness`
 * stays HTTP 200 for every state (its contract); `/readiness/alerts` answers
 * 503 while any of these is present, so a plain HTTP monitor can page without
 * parsing the body. The calendar and provider reasons stay out: they degrade
 * readiness by design (e.g. a provisional KRX year) and are not incidents.
 */
export const OPERATOR_ALERT_REASONS: ReadonlySet<string> = new Set([
  'CANDLE_DB_UNAVAILABLE',
  'DB_DISK_FULL',
  'DB_STORAGE_WARNING',
  'DB_STORAGE_ACTION_REQUIRED',
  'DB_STORAGE_CRITICAL',
  'DB_STORAGE_RUNWAY_SHORT',
  'DB_STORAGE_SAMPLE_STALE',
  'FUTURES_MARK_STALE',
  'FUTURES_MARK_PERSIST_FAILING',
  'FUTURES_MARK_RETENTION_FAILING',
  'FUTURES_MARK_RETENTION_BACKLOG',
  'FUTURES_LAST_PRICE_RETENTION_FAILING',
  'FUTURES_LAST_PRICE_RETENTION_BACKLOG',
  // Its backlog stays a readiness note: the first cleanup of the existing
  // history runs at the capped pace for hours by design, and storage growth
  // is paged by the DB_STORAGE_ codes.
  'ASSET_PRICE_SNAPSHOT_RETENTION_FAILING',
  // Display-only history, but a failing writer or a retention that cannot
  // keep up is a database incident in the making.
  'CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING',
  'CRYPTO_ORDER_BOOK_RETENTION_FAILING',
  'CRYPTO_ORDER_BOOK_RETENTION_BACKLOG',
]);

@Injectable()
export class AppService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly kisWebSocketStreamingService?: KisWebSocketStreamingService,
    @Optional()
    private readonly binanceWebSocketStreamingService?: BinanceWebSocketStreamingService,
    @Optional()
    private readonly redis?: RedisService,
    @Optional()
    private readonly liveCandleHealth?: LiveCandleHealthService,
    @Optional()
    private readonly liveCandlePubSub?: LiveCandlePubSubService,
    @Optional()
    private readonly opsJobRuns?: OpsJobRunService,
    @Optional()
    @Inject(LIVE_CANDLE_CONFIG)
    private readonly liveCandleConfig?: LiveCandleConfig,
    @Optional()
    @Inject(TICKER_FANOUT_METRICS)
    private readonly assetTickerGateway?: TickerFanoutMetricsSource,
    @Optional()
    private readonly tiingoDiagnostics?: TiingoDiagnosticsService,
    @Optional()
    private readonly futuresMarkIngestion?: FuturesMarkIngestion,
    @Optional()
    private readonly futuresMarkRetention?: FuturesMarkRetentionService,
    @Optional()
    private readonly futuresLastPriceRetention?: FuturesLastPriceRetentionService,
    @Optional()
    private readonly databaseStorage?: DatabaseStorageMonitorService,
    @Optional()
    private readonly assetPriceRetention?: AssetPriceSnapshotRetentionWorker,
    @Optional()
    private readonly cryptoOrderBookHistory?: CryptoOrderBookHistoryService,
    @Optional()
    private readonly cryptoOrderBookRetention?: CryptoOrderBookRetentionWorker,
  ) {}

  getHealth() {
    return {
      success: true,
      data: {
        service: 'ok',
      },
    };
  }

  async getDbHealth() {
    await this.prisma.$queryRaw`SELECT 1`;

    return {
      success: true,
      data: {
        database: 'ok',
      },
    };
  }

  async getReadiness(now: Date = new Date()) {
    const scheduler = getOpsSchedulerConfig();
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unavailable';
    }

    const redisConfig = readRedisConfig();
    let redis: 'disabled' | 'ok' | 'unavailable' = redisConfig.url
      ? 'unavailable'
      : 'disabled';
    if (redisConfig.url && this.redis) {
      try {
        redis = (await this.redis.ping()) === 'PONG' ? 'ok' : 'unavailable';
      } catch {
        redis = 'unavailable';
      }
    }

    const liveSnapshot = this.liveCandleHealth?.snapshot() ?? null;
    const liveEnabled = this.liveCandleConfig?.enabled === true;
    const pubSub =
      this.liveCandlePubSub?.getStatus() ??
      (liveEnabled ? 'unavailable' : 'disabled');

    const reasons: string[] = [];

    // Versioned market calendar coverage over the required year range.
    // Missing years degrade readiness and tell operators which datasets to
    // add; stock-market session decisions fail safe in the meantime. A year
    // whose dataset is only provisional (not yet verified against the
    // official exchange notice) also degrades readiness — provisional data
    // must never be presented as audited — without making the service
    // unavailable; crypto is unaffected by the stock-market calendar.
    const calendar = getMarketCalendarCoverage(
      readMarketCalendarCoverageConfig(process.env, now),
    );
    if (!calendar.complete) reasons.push('MARKET_CALENDAR_COVERAGE_MISSING');
    if (calendar.markets.some((market) => market.provisionalYears.length > 0)) {
      reasons.push('MARKET_CALENDAR_PROVISIONAL');
    }

    // Operator override runtime state (loaded synchronously from the
    // in-process store — readiness never queries the DB for this). Static
    // coverage alone is not enough for the stock calendar to be ready: until
    // the first override snapshot loads, session decisions are fail-closed.
    const marketSessionOverride = getMarketSessionOverrideRuntimeStatus();
    if (marketSessionOverride.state === 'not_loaded') {
      reasons.push(MARKET_SESSION_OVERRIDE_READINESS_REASONS.notLoaded);
    } else if (marketSessionOverride.state === 'unavailable') {
      reasons.push(MARKET_SESSION_OVERRIDE_READINESS_REASONS.unavailable);
    } else if (marketSessionOverride.state === 'last_known_good') {
      reasons.push(MARKET_SESSION_OVERRIDE_READINESS_REASONS.lastKnownGood);
    }

    // Live ingestion without its reconciliation safety net (only reachable
    // outside production or via the explicit escape hatch).
    const koscom = readKoscomConfig();
    const liveReconciliationViolations =
      liveEnabled && this.liveCandleConfig
        ? validateLiveReconciliationDependencies({
            live: this.liveCandleConfig,
            koscomPollingEnabled: isKoscomPollingOwnedByLiveSupervisor(koscom),
            reconciliation: {
              krx: {
                enabled: scheduler.marketCandleReconciliation.krx.enabled,
              },
              us: { enabled: scheduler.marketCandleReconciliation.us.enabled },
              crypto: {
                enabled: scheduler.marketCandleReconciliation.crypto.enabled,
              },
            },
            nodeEnv: undefined,
          })
        : [];
    if (liveReconciliationViolations.length > 0) {
      reasons.push('LIVE_RECONCILIATION_REQUIRED');
    }

    // Trade freshness is only meaningful while the market can trade: a quiet
    // domestic collector outside the KRX session is expected to be quiet.
    // Crypto trades continuously; delayed US KIS is excluded below.
    // This uses tradeStaleThresholdMs (readiness-only); the supervisor's
    // reconnect watchdog uses connectionLivenessTimeoutMs instead.
    const krxSessionOpen =
      resolveRegularSessionForEvent(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        now,
      ) !== null;
    const staleThresholdMs =
      this.liveCandleConfig?.tradeStaleThresholdMs ?? 30_000;
    const providerStale =
      liveEnabled && liveSnapshot
        ? Object.entries(liveSnapshot.providers).some(
            ([name, provider]) =>
              provider.owner &&
              !provider.delayed &&
              provider.eventLagMs !== null &&
              provider.eventLagMs > staleThresholdMs &&
              (!['kis', 'koscom'].includes(name) || krxSessionOpen),
          )
        : false;
    if (providerStale) reasons.push('LIVE_PROVIDER_STALE');
    const providerDegraded =
      liveEnabled && liveSnapshot
        ? Object.values(liveSnapshot.providers).some(
            (provider) =>
              provider.owner &&
              (provider.state === 'degraded' ||
                provider.state === 'reconnecting'),
          )
        : false;
    if (
      liveEnabled &&
      liveSnapshot &&
      Object.values(liveSnapshot.providers).some(
        (provider) =>
          provider.owner && provider.lastErrorCode === 'SUBSCRIPTION_SHARD_CAP',
      )
    ) {
      reasons.push('SUBSCRIPTION_SHARD_CAP');
    }
    if (liveEnabled && pubSub !== 'connected') {
      reasons.push('LIVE_PUBSUB_UNAVAILABLE');
    }
    if (database === 'unavailable') reasons.push('CANDLE_DB_UNAVAILABLE');

    const reconciliation = await this.reconciliationReadiness(
      scheduler,
      now,
      database === 'ok',
    );
    if (reconciliation.some((item) => item.state === 'stale')) {
      reasons.push('RECONCILIATION_STALE');
    }
    const marketCandleRetention = await this.candleRetentionReadiness(
      scheduler,
      now,
      database === 'ok',
    );
    if (marketCandleRetention.state === 'failed')
      reasons.push('MARKET_CANDLE_RETENTION_FAILED');
    if (marketCandleRetention.state === 'stale')
      reasons.push('MARKET_CANDLE_RETENTION_STALE');

    // Collector/worker/storage health from in-process state only: readiness
    // adds no query against the large snapshot tables.
    const operations = this.operationalHealth(now);
    reasons.push(...operations.reasons);

    const degraded =
      (redisConfig.url !== undefined && redis !== 'ok') ||
      providerDegraded ||
      providerStale ||
      reasons.length > 0;
    const status =
      database === 'unavailable'
        ? 'unavailable'
        : degraded
          ? 'degraded'
          : 'ready';

    return {
      success: status !== 'unavailable',
      data: {
        app: 'ok',
        status,
        reasons,
        alerts: reasons.filter((reason) => OPERATOR_ALERT_REASONS.has(reason)),
        database,
        redis,
        scheduler: {
          enabled: scheduler.enabled,
          timezone: scheduler.timezone,
          jobs: scheduler.jobs,
        },
        marketCalendar: calendar,
        // Ticker delivery counters (slow-client coalescing/backpressure).
        assetTicker: this.assetTickerGateway?.getTickerFanoutMetrics() ?? null,
        marketSessionOverride: {
          mode: marketSessionOverride.mode,
          state: marketSessionOverride.state,
          loaded: marketSessionOverride.loaded,
          loadedAt: marketSessionOverride.loadedAt?.toISOString() ?? null,
          lastRefreshFailedAt:
            marketSessionOverride.lastRefreshFailedAt?.toISOString() ?? null,
          activeOverrideCount: marketSessionOverride.activeOverrideCount,
        },
        kisWebSocketStreaming:
          this.kisWebSocketStreamingService?.getStatus() ?? null,
        binanceWebSocketStreaming:
          this.binanceWebSocketStreamingService?.getStatus() ?? null,
        // Tiingo US-equity trial (informational; never changes status).
        // Codes, counters and timestamps only — no prices or credentials.
        tiingo: this.tiingoDiagnostics?.getStatus(now) ?? null,
        liveCandle: {
          enabled: liveEnabled,
          pubSub,
          health: liveSnapshot,
          reconciliationDependencyWarnings: liveReconciliationViolations,
        },
        reconciliation,
        marketCandleRetention,
        futuresMark: operations.futuresMark,
        futuresRetention: operations.futuresRetention,
        assetPriceRetention: operations.assetPriceRetention,
        cryptoOrderBookHistory: operations.cryptoOrderBookHistory,
        databaseStorage: operations.databaseStorage,
        currentTime: now.toISOString(),
      },
    };
  }

  /** Operator-alert view of readiness for external HTTP monitors: 503 while
   * any OPERATOR_ALERT_REASONS code is present, else 200. It runs exactly the
   * /readiness queries (SELECT 1 and small Ops-run reads for enabled jobs). */
  async getReadinessAlerts(now: Date = new Date()) {
    const { data } = await this.getReadiness(now);
    const alerting = data.alerts.length > 0;
    return {
      httpStatus: alerting ? 503 : 200,
      body: {
        success: !alerting,
        data: {
          status: data.status,
          alerts: data.alerts,
          currentTime: data.currentTime,
        },
      },
    };
  }

  /** Reasons stay empty while the related feature is disabled. A disk-full
   * write failure is reported for 10 minutes after the last occurrence. */
  private operationalHealth(now: Date) {
    const reasons: string[] = [];
    const recent = (at: string | null | undefined) =>
      !!at && now.getTime() - Date.parse(at) <= 600000;
    const futuresMark =
      this.futuresMarkIngestion?.getStatus(now.getTime()) ?? null;
    if (futuresMark?.enabled) {
      if (futuresMark.staleTargets > 0) reasons.push('FUTURES_MARK_STALE');
      if (futuresMark.consecutivePersistFailures >= 3)
        reasons.push('FUTURES_MARK_PERSIST_FAILING');
    }
    const futuresRetention = {
      mark: this.futuresMarkRetention?.getStatus() ?? null,
      last: this.futuresLastPriceRetention?.getStatus() ?? null,
    };
    const assetPriceRetention = this.assetPriceRetention?.getStatus() ?? null;
    const cryptoOrderBookHistory = {
      recorder: this.cryptoOrderBookHistory?.getStatus() ?? null,
      retention: this.cryptoOrderBookRetention?.getStatus() ?? null,
    };
    const recorder = cryptoOrderBookHistory.recorder;
    if (recorder?.enabled && recorder.consecutiveWriteFailures >= 3)
      reasons.push('CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING');
    for (const [prefix, job] of [
      ['FUTURES_MARK_RETENTION', futuresRetention.mark],
      ['FUTURES_LAST_PRICE_RETENTION', futuresRetention.last],
      ['ASSET_PRICE_SNAPSHOT_RETENTION', assetPriceRetention],
      ['CRYPTO_ORDER_BOOK_RETENTION', cryptoOrderBookHistory.retention],
    ] as const) {
      if (!job?.enabled) continue;
      if (job.failing) reasons.push(`${prefix}_FAILING`);
      if (job.backlog) reasons.push(`${prefix}_BACKLOG`);
    }
    if (
      (futuresMark?.enabled &&
        futuresMark.lastPersistFailure?.kind === 'disk_full' &&
        recent(futuresMark.lastPersistFailure.at)) ||
      (recorder?.enabled &&
        recorder.lastWriteFailure?.kind === 'disk_full' &&
        recent(recorder.lastWriteFailure.at)) ||
      [
        ...Object.values(futuresRetention),
        assetPriceRetention,
        cryptoOrderBookHistory.retention,
      ].some(
        (job) =>
          job?.enabled &&
          job.lastFailureKind === 'disk_full' &&
          recent(job.lastFailedAt),
      )
    )
      reasons.push('DB_DISK_FULL');
    const databaseStorage =
      this.databaseStorage?.getStatus(now.getTime()) ?? null;
    if (databaseStorage?.enabled) {
      if (databaseStorage.level === 'warning')
        reasons.push('DB_STORAGE_WARNING');
      if (databaseStorage.level === 'action_required')
        reasons.push('DB_STORAGE_ACTION_REQUIRED');
      if (databaseStorage.level === 'critical')
        reasons.push('DB_STORAGE_CRITICAL');
      if (
        databaseStorage.daysUntil80Percent !== null &&
        databaseStorage.daysUntil80Percent < DATABASE_STORAGE_RUNWAY_ALERT_DAYS
      )
        reasons.push('DB_STORAGE_RUNWAY_SHORT');
      // A failing sampler must not keep showing its last good level.
      if (databaseStorage.sampleStale) reasons.push('DB_STORAGE_SAMPLE_STALE');
    }
    return {
      reasons,
      futuresMark,
      futuresRetention,
      assetPriceRetention,
      cryptoOrderBookHistory,
      databaseStorage,
    };
  }

  /** The daily candle retention job, when the scheduler runs it: failed when
   * its latest run failed, stale when no successful run finished in the last
   * 26 h (daily at 04:00 plus slack), pending before its first run. Two small
   * Ops-run reads; none while the job is disabled. */
  private async candleRetentionReadiness(
    scheduler: ReturnType<typeof getOpsSchedulerConfig>,
    now: Date,
    databaseAvailable: boolean,
  ) {
    if (!scheduler.enabled || !scheduler.jobs.market_candle_retention)
      return { state: 'disabled' as const, lastSuccessfulAt: null };
    if (!databaseAvailable || !this.opsJobRuns)
      return { state: 'unknown' as const, lastSuccessfulAt: null };
    const [latest, succeeded] = await Promise.all([
      this.opsJobRuns.findLatestRunForJob('market_candle_retention'),
      this.opsJobRuns.findLatestSucceededRunForJob('market_candle_retention'),
    ]);
    const lastAt = succeeded?.finishedAt ?? succeeded?.startedAt ?? null;
    const state = !latest
      ? ('pending' as const)
      : latest.status === 'failed'
        ? ('failed' as const)
        : lastAt && now.getTime() - lastAt.getTime() <= 26 * 3_600_000
          ? ('fresh' as const)
          : latest.status === 'running' && !lastAt
            ? ('pending' as const)
            : ('stale' as const);
    return { state, lastSuccessfulAt: lastAt?.toISOString() ?? null };
  }

  private async reconciliationReadiness(
    scheduler: ReturnType<typeof getOpsSchedulerConfig>,
    now: Date,
    databaseAvailable: boolean,
  ) {
    const config = scheduler.marketCandleReconciliation;
    const markets = [
      ['KRX', config.krx.enabled, config.maxCatchUpHours * 3_600_000],
      ['US', config.us.enabled, config.maxCatchUpHours * 3_600_000],
      ['CRYPTO', config.crypto.enabled, config.crypto.intervalSeconds * 3_000],
    ] as const;
    return Promise.all(
      markets.map(async ([market, enabled, staleAfterMs]) => {
        if (!enabled) {
          return { market, state: 'disabled' as const, lastSuccessfulAt: null };
        }
        if (!databaseAvailable || !this.opsJobRuns) {
          return { market, state: 'unknown' as const, lastSuccessfulAt: null };
        }
        const latest =
          await this.opsJobRuns.findLatestSucceededReconciliationRun(market);
        const lastAt = latest?.finishedAt ?? latest?.startedAt ?? null;
        return {
          market,
          state:
            lastAt && now.getTime() - lastAt.getTime() <= staleAfterMs
              ? ('fresh' as const)
              : ('stale' as const),
          lastSuccessfulAt: lastAt?.toISOString() ?? null,
        };
      }),
    );
  }
}
