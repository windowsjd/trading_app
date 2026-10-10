import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import IORedis from 'ioredis';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Manifest, Credentials } from './manifest';
import { preflight, controlKey, identitySignature } from './preflight';
import { Metrics, ProcessSampler, writeJson, jsonl } from './metrics';
import { Replay } from './replay';
import {
  instrumentPg,
  instrumentSends,
  instrumentMethod,
  instrumentValkey,
} from './server-metrics';
import type { PrismaService as PrismaServiceType } from '../../src/prisma/prisma.service';
import { FUTURES_PROVIDER_SOCKET_FACTORY } from '../../src/providers/provider-socket-factory';

export function applyTestEnvironment(m: Manifest, c: Credentials) {
  // No dotenv imports, and no inherited production/provider credentials.
  const retained = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      ['PATH', 'LANG', 'TZ', 'TMPDIR', 'LD_LIBRARY_PATH', 'PORT'].includes(k),
    ),
  );
  process.env = {
    ...retained,
    NODE_ENV: 'test',
    DATABASE_URL: c.databaseUrl,
    REDIS_URL: c.valkeyUrl,
    JWT_ACCESS_SECRET: c.jwtSecret,
    JWT_ACCESS_TTL: m.accessTokenTtl,
    REFRESH_TOKEN_TTL: '7d',
    PROVIDER_INGESTION_ENABLED: 'true',
    PROVIDER_INGESTION_RUN_ON_STARTUP: 'false',
    BINANCE_PUBLIC_MARKET_DATA_ENABLED: 'true',
    BINANCE_CRYPTO_USDT_AS_USD_EQUIVALENT: 'true',
    BINANCE_WEBSOCKET_STREAMING_ENABLED: 'true',
    KIS_MARKET_DATA_ENABLED: 'true',
    KIS_APP_KEY: 'load-test-kis-key',
    KIS_APP_SECRET: 'load-test-kis-secret',
    KIS_REST_BASE_URL: 'https://openapi.koreainvestment.com:9443',
    KIS_WS_BASE_URL: 'ws://ops.koreainvestment.com:21000',
    KIS_WEBSOCKET_STREAMING_ENABLED: 'false',
    KIS_API_ENVIRONMENT: 'real',
    KOSCOM_API_KEY: 'load-test-koscom-key',
    KOSCOM_MARKET_DATA_ENABLED: 'true',
    KOSCOM_POLLING_ENABLED: 'true',
    EXCHANGE_RATE_API_ENABLED: 'true',
    EXCHANGE_RATE_API_KEY: 'load-test-fx-key',
    KOREA_EXIM_EXCHANGE_ENABLED: 'false',
    LIMIT_ORDER_ENABLED: 'true',
    SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED: 'true',
    FUTURES_TRADING_MODE: 'ENABLED',
    FUTURES_RISK_ENGINE_ENABLED: 'true',
    FUTURES_MARK_INGESTION_ENABLED: 'true',
    FUTURES_LAST_PRICE_INGESTION_ENABLED: 'true',
    CONDITIONAL_ORDERS_ENABLED: 'true',
    CANDLE_LIVE_STREAMING_ENABLED: 'true',
    CANDLE_LIVE_BINANCE_ENABLED: 'true',
    CANDLE_LIVE_KIS_ENABLED: 'false',
    CANDLE_LIVE_KIS_US_DELAYED_ENABLED: 'false',
    CANDLE_SERVING_MODE: 'database',
    CANDLE_CACHE_ENABLED: 'false',
    SCHEDULER_ENABLED: 'true',
    SCHEDULER_DAILY_SNAPSHOT_ENABLED: 'true',
    // The replay drives this existing Ops job at its market-data cadence.
    // Keep the shared scheduler tick and every financial worker unchanged.
    SCHEDULER_PROVIDER_FX_ENABLED: 'false',
    SCHEDULER_PROVIDER_KIS_ENABLED: 'true',
    SCHEDULER_PROVIDER_BINANCE_ENABLED: 'false',
    SCHEDULER_MARKET_CANDLE_RECONCILIATION_ENABLED: 'true',
    SCHEDULER_MARKET_CANDLE_SYNC_ENABLED: 'false',
    SCHEDULER_RANKING_ENABLED: 'false',
    SCHEDULER_SEASON_LIFECYCLE_ENABLED: 'false',
    SCHEDULER_SETTLEMENT_ENABLED: 'false',
  };
  // ConfigModule's existing dotenv file paths are relative to cwd. Bootstrap
  // from an empty directory so the repository's .env files cannot be loaded.
  process.chdir(mkdtempSync(resolve(tmpdir(), 'trading-load-empty-env-')));
}
export async function serve(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
  out: string,
  metrics = new Metrics(),
) {
  mkdirSync(out, { recursive: true });
  const environment = await preflight(m, c, true);
  applyTestEnvironment(m, c);
  const replay = new Replay(m, metrics);
  const savedFetch = globalThis.fetch;
  globalThis.fetch = replay.fetch as typeof fetch;
  const dbMetrics = instrumentPg(metrics);
  const restoreSends = instrumentSends(metrics);
  const { AppModule } = require('../../src/app.module');
  const {
    LIVE_CANDLE_SOCKET_FACTORY,
  } = require('../../src/realtime/live-candle-stream-supervisor.service');
  @Global()
  @Module({
    providers: [
      {
        provide: FUTURES_PROVIDER_SOCKET_FACTORY,
        useValue: replay.createSocket,
      },
    ],
    exports: [FUTURES_PROVIDER_SOCKET_FACTORY],
  })
  class ReplayTransports {}
  const module = await Test.createTestingModule({
    imports: [ReplayTransports, AppModule],
  })
    .overrideProvider(LIVE_CANDLE_SOCKET_FACTORY)
    .useValue(replay.createSocket)
    .compile()
    .catch((error) => {
      globalThis.fetch = savedFetch;
      dbMetrics.close();
      restoreSends();
      throw error;
    });
  const app = module.createNestApplication({ logger: ['error', 'warn'] });
  const {
    AdminDiagnosticLogger,
  } = require('../../src/common/admin-diagnostic.logger');
  const {
    adminDiagnosticRequestMiddleware,
  } = require('../../src/common/admin-diagnostics');
  const { createCorsOptions } = require('../../src/common/cors.config');
  app.useLogger(new AdminDiagnosticLogger());
  app.use(adminDiagnosticRequestMiddleware);
  app.enableCors(createCorsOptions());
  app.useWebSocketAdapter(new WsAdapter(app));
  app.use((_req: any, res: any, next: () => void) => {
    res.setHeader(
      'x-load-test-identity',
      identitySignature(m, c, manifestHash),
    );
    next();
  });
  const {
    FuturesLimitWorker,
  } = require('../../src/futures/futures-limit-worker.service');
  const {
    ConditionalWorker,
  } = require('../../src/conditional/conditional-worker.service');
  const {
    FuturesRiskWorker,
  } = require('../../src/futures/futures-risk-worker.service');
  const {
    FuturesLiquidationService,
  } = require('../../src/futures/futures-liquidation.service');
  const {
    LimitOrderMatchingService,
  } = require('../../src/orders/limit-order-matching.service');
  const {
    AssetTickerGateway,
  } = require('../../src/realtime/asset-ticker.gateway');
  for (const cls of [FuturesLimitWorker, ConditionalWorker, FuturesRiskWorker])
    instrumentMethod(app.get(cls), 'tick', metrics, cls.name);
  instrumentMethod(
    app.get(LimitOrderMatchingService),
    'matchDueLimitOrders',
    metrics,
    'spotMatching',
  );
  const {
    LimitOrderExecutionService,
  } = require('../../src/orders/limit-order-execution.service');
  instrumentMethod(
    app.get(LimitOrderExecutionService),
    'fillLimitOrder',
    metrics,
    'spotEligibleFill',
  );
  const {
    FuturesLimitService,
  } = require('../../src/futures/futures-limit.service');
  const {
    ConditionalService,
  } = require('../../src/conditional/conditional.service');
  const { OpsJobLockService } = require('../../src/ops/ops-job-lock.service');
  const { RedisService } = require('../../src/redis/redis.service');
  instrumentValkey(app.get(RedisService), metrics);
  instrumentMethod(
    app.get(FuturesLimitService),
    'evaluate',
    metrics,
    'futuresEntry',
    true,
  );
  instrumentMethod(
    app.get(ConditionalService),
    'evaluate',
    metrics,
    'protection',
    true,
  );
  instrumentMethod(
    app.get(OpsJobLockService),
    'acquireLock',
    metrics,
    'ownership',
  );
  instrumentMethod(app.get(OpsJobLockService), 'extendLock', metrics, 'lease');
  instrumentMethod(
    app.get(FuturesLiquidationService),
    'candidateScopes',
    metrics,
    'riskAccount',
    true,
  );
  const url = new URL(m.target.apiOrigin);
  replay.start();
  try {
    await app.listen(Number(process.env.PORT || url.port || 3000), '0.0.0.0');
  } catch (error) {
    replay.stop();
    await app.close();
    globalThis.fetch = savedFetch;
    dbMetrics.close();
    restoreSends();
    throw error;
  }
  const control = new IORedis(c.valkeyUrl, {
    commandTimeout: 5000,
    maxRetriesPerRequest: 0,
  });
  control.on('error', () => metrics.failure('CONTROL_VALKEY_ERROR'));
  const { PrismaService } = require('../../src/prisma/prisma.service');
  const db = app.get<PrismaServiceType>(PrismaService);
  const {
    OpsJobRunnerService,
  } = require('../../src/ops/ops-job-runner.service');
  const { getOpsSchedulerConfig } = require('../../src/ops/ops-config');
  const fxRunner = app.get(OpsJobRunnerService);
  instrumentMethod(fxRunner, 'runProviderFxIngestJob', metrics, 'replayFx');
  let nextFx = 0;
  writeJson(resolve(out, 'server-manifest.json'), {
    manifestHash,
    sha: m.expectedGitSha,
    environment,
    replayHash: replay.fingerprint(),
    flags: Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /ENABLED$|^FUTURES_TRADING_MODE$|^CANDLE_SERVING_MODE$|^JWT_ACCESS_TTL$/.test(
          k,
        ),
      ),
    ),
    node: process.version,
    measurement:
      'pg client query includes network/lock wait; poolAcquire includes new connection setup; SQL BEGIN to COMMIT/ROLLBACK spans; original pool settings unchanged',
  });
  const sampler = new ProcessSampler();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await control.set(
    controlKey(m, 'server'),
    JSON.stringify({
      manifestHash,
      sha: m.expectedGitSha,
      startedAt: new Date().toISOString(),
      environment,
      replayHash: replay.fingerprint(),
    }),
  );
  try {
    while (!stopped) {
      if (performance.now() >= nextFx) {
        nextFx = performance.now() + m.replay.fxIntervalSeconds * 1000;
        const config = getOpsSchedulerConfig();
        const result = await fxRunner.runProviderFxIngestJob({
          trigger: 'scheduler',
          requestedBy: 'scheduler',
          dryRun: false,
          lockTtlSeconds: config.lockTtlSeconds,
          maxAttempts: config.maxAttempts,
        });
        if (!result.success) metrics.failure('REPLAY_FX_INGEST_FAILED');
      }
      const phase = await control.get(controlKey(m, 'phase'));
      if (phase) {
        metrics.phase = phase;
        replay.setPhase(phase);
      }
      const clock = await db.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS now`;
      const sample = {
        ...sampler.sample(),
        databaseClock: clock[0].now.toISOString(),
        phase: metrics.phase,
        fanout: app.get(AssetTickerGateway).getTickerFanoutMetrics(),
        pools: dbMetrics.sample(),
        replayTick: replay.tick,
        replaySockets: replay.sockets.size,
        metrics: metrics.summary(),
      };
      jsonl(resolve(out, 'server.samples.jsonl'), sample);
      await control.set(
        controlKey(m, 'server-sample'),
        JSON.stringify(sample),
        'EX',
        10,
      );
      if (
        Object.keys(metrics.counters).some((k) =>
          /EXTERNAL_PROVIDER|NETWORK_BLOCKED/.test(k),
        )
      ) {
        await control.set(controlKey(m, 'abort'), 'EXTERNAL_PROVIDER_ATTEMPT');
        stopped = true;
      }
      await delay(1000);
    }
  } finally {
    replay.stop();
    await app.close();
    sampler.close();
    writeJson(resolve(out, 'server-summary.json'), metrics.serializable());
    await control
      .set(
        controlKey(m, 'server-summary'),
        JSON.stringify(metrics.serializable()),
      )
      .catch(() => undefined);
    control.disconnect();
    globalThis.fetch = savedFetch;
    dbMetrics.close();
    restoreSends();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
