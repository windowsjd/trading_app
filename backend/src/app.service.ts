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
import { resolveRegularSessionForEvent } from './orders/market-calendar.policy';
import { AssetType } from './generated/prisma/client';
import { getOpsSchedulerConfig } from './ops/ops-config';
import { OpsJobRunService } from './ops/ops-job-run.service';
import { PrismaService } from './prisma/prisma.service';
import { BinanceWebSocketStreamingService } from './providers/binance/binance-websocket-streaming.service';
import { KisWebSocketStreamingService } from './providers/kis/kis-websocket-streaming.service';
import { LiveCandlePubSubService } from './realtime/live-candle-pubsub.service';
import { RedisService } from './redis/redis.service';
import { readRedisConfig } from './redis/redis.config';

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

  async getReadiness() {
    const now = new Date();
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
    // add; stock-market session decisions fail safe in the meantime.
    const calendar = getMarketCalendarCoverage(
      readMarketCalendarCoverageConfig(process.env, now),
    );
    if (!calendar.complete) reasons.push('MARKET_CALENDAR_COVERAGE_MISSING');

    // Live ingestion without its reconciliation safety net (only reachable
    // outside production or via the explicit escape hatch).
    const liveReconciliationViolations =
      liveEnabled && this.liveCandleConfig
        ? validateLiveReconciliationDependencies({
            live: this.liveCandleConfig,
            reconciliation: {
              krx: { enabled: scheduler.marketCandleReconciliation.krx.enabled },
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
    // KIS socket outside the KRX regular session is healthy as long as the
    // connection itself is alive (heartbeats). Crypto trades continuously.
    const krxSessionOpen =
      resolveRegularSessionForEvent(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        now,
      ) !== null;
    const staleThresholdMs = this.liveCandleConfig?.staleThresholdMs ?? 30_000;
    const providerStale =
      liveEnabled && liveSnapshot
        ? Object.entries(liveSnapshot.providers).some(
            ([name, provider]) =>
              provider.owner &&
              !provider.delayed &&
              provider.eventLagMs !== null &&
              provider.eventLagMs > staleThresholdMs &&
              (name !== 'kis' || krxSessionOpen),
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
        database,
        redis,
        scheduler: {
          enabled: scheduler.enabled,
          timezone: scheduler.timezone,
          jobs: scheduler.jobs,
        },
        marketCalendar: calendar,
        kisWebSocketStreaming:
          this.kisWebSocketStreamingService?.getStatus() ?? null,
        binanceWebSocketStreaming:
          this.binanceWebSocketStreamingService?.getStatus() ?? null,
        liveCandle: {
          enabled: liveEnabled,
          pubSub,
          health: liveSnapshot,
          reconciliationDependencyWarnings: liveReconciliationViolations,
        },
        reconciliation,
        currentTime: now.toISOString(),
      },
    };
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
