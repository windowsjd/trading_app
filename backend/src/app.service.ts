import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  LIVE_CANDLE_CONFIG,
  type LiveCandleConfig,
} from './assets/live-candle.config';
import { LiveCandleHealthService } from './assets/live-candle-health.service';
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
    const providerDegraded =
      liveEnabled && liveSnapshot
        ? Object.values(liveSnapshot.providers).some(
            (provider) =>
              provider.owner &&
              (provider.state === 'degraded' ||
                provider.state === 'reconnecting' ||
                provider.subscriptionsFailed > 0 ||
                (!provider.delayed &&
                  provider.eventLagMs !== null &&
                  provider.eventLagMs >
                    (this.liveCandleConfig?.staleThresholdMs ?? 30_000))),
          )
        : false;
    const reconciliation = await this.reconciliationReadiness(
      scheduler,
      now,
      database === 'ok',
    );
    const degraded =
      (redisConfig.url !== undefined && redis !== 'ok') ||
      (liveEnabled && pubSub !== 'connected') ||
      providerDegraded ||
      reconciliation.some((item) => item.state === 'stale');
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
        database,
        redis,
        scheduler: {
          enabled: scheduler.enabled,
          timezone: scheduler.timezone,
          jobs: scheduler.jobs,
        },
        kisWebSocketStreaming:
          this.kisWebSocketStreamingService?.getStatus() ?? null,
        binanceWebSocketStreaming:
          this.binanceWebSocketStreamingService?.getStatus() ?? null,
        liveCandle: {
          enabled: liveEnabled,
          pubSub,
          health: liveSnapshot,
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
