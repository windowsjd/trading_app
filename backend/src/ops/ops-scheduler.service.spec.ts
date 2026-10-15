jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    provider_kis_ingest: 'provider_kis_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_lifecycle_transition: 'season_lifecycle_transition',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
    market_candle_retention: 'market_candle_retention',
    market_candle_sync: 'market_candle_sync',
    market_candle_reconciliation: 'market_candle_reconciliation',
    limit_order_matcher: 'limit_order_matcher',
    limit_order_candle_reconciliation: 'limit_order_candle_reconciliation',
    market_candle_long_sync: 'market_candle_long_sync',
    futures_candle_sync: 'futures_candle_sync',
  },
  OpsJobRunStatus: {
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    skipped: 'skipped',
    locked: 'locked',
  },
  OpsJobTrigger: {
    scheduler: 'scheduler',
    operator: 'operator',
    manual_script: 'manual_script',
    test: 'test',
  },
}));

jest.mock('../batch/daily-portfolio-snapshot-job.service', () => ({
  DailyPortfolioSnapshotJobService: class DailyPortfolioSnapshotJobService {},
}));
jest.mock('../batch/general-daily-snapshot-job.service', () => ({
  GeneralDailySnapshotJobService: class GeneralDailySnapshotJobService {},
}));
jest.mock('../batch/season-lifecycle-transition-job.service', () => ({
  SeasonLifecycleTransitionJobService: class SeasonLifecycleTransitionJobService {},
}));
jest.mock('../batch/season-settlement-job.service', () => ({
  SeasonSettlementJobService: class SeasonSettlementJobService {},
}));
jest.mock('../ranking/ranking-refresh.service', () => ({
  RankingRefreshService: class RankingRefreshService {},
}));
jest.mock('../providers/market-snapshot-health.service', () => ({
  MarketSnapshotHealthService: class MarketSnapshotHealthService {},
}));
jest.mock('../assets/market-candle-retention.service', () => ({
  MarketCandleRetentionService: class MarketCandleRetentionService {},
}));
jest.mock('../assets/market-candle-long-sync.service', () => ({
  MarketCandleLongSyncService: class MarketCandleLongSyncService {},
  LongCandleSyncInputError: class LongCandleSyncInputError extends Error {},
  MARKET_CANDLE_LONG_SYNC_LOCK_KEY: 'market_candle_long_sync',
  FUTURES_CANDLE_SYNC_LOCK_KEY: 'futures_candle_sync',
}));
jest.mock('../assets/market-candle-sync.service', () => ({
  MarketCandleSyncService: class MarketCandleSyncService {},
}));
jest.mock('../assets/krx-central-candle.service', () => ({
  KrxCentralCandleService: class KrxCentralCandleService {},
}));
jest.mock('../assets/krx-checkpoint-compaction.service', () => ({
  KrxCheckpointCompactionService: class KrxCheckpointCompactionService {},
}));
jest.mock('../assets/market-candle-reconciliation.service', () => ({
  MarketCandleReconciliationService: class MarketCandleReconciliationService {},
}));
jest.mock('../orders/limit-order-matching.service', () => ({
  LimitOrderMatchingService: class LimitOrderMatchingService {},
}));

import { OpsJobName, OpsJobRunStatus } from '../generated/prisma/client';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../orders/market-calendar/market-session-override.store';
import { getOpsSchedulerConfig } from './ops-config';
import { OpsSchedulerService } from './ops-scheduler.service';

// First argument of a mock's first call, read through unknown (jest types
// untyped mock calls as any).
const firstCallArg = (fn: jest.Mock): unknown =>
  (fn.mock.calls as unknown[][])[0][0];

describe('OpsSchedulerService', () => {
  const originalEnv = { ...process.env };

  const createService = (
    input: {
      binanceWebSocketStreamingEnabled?: boolean;
    } = {},
  ) => {
    const runner = {
      runProviderFxIngestJob: jest.fn().mockResolvedValue({ success: true }),
      runProviderBinanceIngestJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runProviderKisIngestJob: jest.fn().mockResolvedValue({ success: true }),
      runScheduledDailySnapshotJobs: jest.fn().mockResolvedValue([]),
      runSeasonRankingGenerationJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runSeasonLifecycleTransitionJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runSeasonSettlementJob: jest.fn().mockResolvedValue({ success: true }),
      runRewardMarkerJob: jest.fn().mockResolvedValue({ success: true }),
      runMarketCandleRetentionJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runMarketCandleSyncJob: jest.fn().mockResolvedValue({ success: true }),
      runMarketCandleLongSyncJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runFuturesCandleSyncJob: jest.fn().mockResolvedValue({ success: true }),
      runMarketCandleReconciliationJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
    };
    const runService = {
      findLatestRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededReconciliationRun: jest.fn().mockResolvedValue(null),
      findLatestReconciliationAttempt: jest.fn().mockResolvedValue(null),
    };
    const providerConfigService = {
      getConfig: jest.fn().mockReturnValue({
        binance: {
          wsStreamingEnabled: input.binanceWebSocketStreamingEnabled ?? false,
        },
      }),
    };
    const reconciliationService = {
      hasRecentCanonicalCoverage: jest.fn().mockResolvedValue(false),
    };

    return {
      runner,
      runService,
      providerConfigService,
      reconciliationService,
      service: new OpsSchedulerService(
        runner as never,
        runService as never,
        undefined,
        providerConfigService as never,
        reconciliationService as never,
      ),
    };
  };

  // Typed accessor over the console.warn spy: jest exposes `any` call
  // tuples, so reads go through unknown before narrowing to the structured
  // warning detail the tests inspect.
  const coverageWarningDetails = (spy: jest.SpyInstance): unknown[] =>
    (spy.mock.calls as unknown[][])
      .map((call) => call[1])
      .filter(
        (detail) =>
          (detail as { reason?: string } | undefined)?.reason ===
          'MARKET_CALENDAR_COVERAGE_MISSING',
      );

  beforeEach(() => {
    jest.useFakeTimers();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('is disabled by default and does not register an interval', async () => {
    delete process.env.SCHEDULER_ENABLED;
    const { service } = createService();

    service.onModuleInit();

    expect(getOpsSchedulerConfig().enabled).toBe(false);
    expect(service.isIntervalRegistered()).toBe(false);
    await expect(service.runEnabledJobs()).resolves.toEqual([]);
  });

  it('runs retention only after 04:00 local time and once per successful business date', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED = 'true';
    const { runner, runService, service } = createService();

    await expect(
      service.runEnabledJobs(new Date('2026-07-10T18:59:00.000Z')),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleRetentionJob).not.toHaveBeenCalled();

    await service.runEnabledJobs(new Date('2026-07-10T19:00:00.000Z'));
    expect(runner.runMarketCandleRetentionJob).toHaveBeenCalledTimes(1);
    expect(runner.runMarketCandleRetentionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        retentionDays: 45,
        batchSize: 5000,
        metadataJson: { businessDate: '2026-07-11' },
      }),
    );

    runService.findLatestSucceededRunForJob.mockResolvedValueOnce({
      startedAt: new Date('2026-07-10T19:00:00.000Z'),
      finishedAt: new Date('2026-07-10T19:01:00.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-10T20:00:00.000Z'));
    expect(runner.runMarketCandleRetentionJob).toHaveBeenCalledTimes(1);

    runService.findLatestSucceededRunForJob.mockResolvedValueOnce({
      startedAt: new Date('2026-07-10T19:00:00.000Z'),
      finishedAt: new Date('2026-07-10T19:01:00.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-11T19:00:00.000Z'));
    expect(runner.runMarketCandleRetentionJob).toHaveBeenCalledTimes(2);
  });

  it('does not schedule market candle sync unless its flag is set', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS = 'id1,id2';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));

    expect(runner.runMarketCandleSyncJob).not.toHaveBeenCalled();
  });

  it('runs the incremental candle sync job on its own interval', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_INTERVAL_SECONDS = '600';
    const { runner, runService, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(1);
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        continueOnError: true,
        requestedBy: 'scheduler',
        now: '2026-07-10T03:00:00.000Z',
        assetIds: undefined,
      }),
    );

    // Inside the interval since the last (finished) run: not due.
    runService.findLatestRunForJob.mockResolvedValue({
      status: OpsJobRunStatus.succeeded,
      startedAt: new Date('2026-07-10T03:00:00.000Z'),
      finishedAt: new Date('2026-07-10T03:01:00.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-10T03:05:00.000Z'));
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(1);

    // Past the interval: due again.
    await service.runEnabledJobs(new Date('2026-07-10T03:11:30.000Z'));
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(2);
  });

  it('never starts the long-range 4h jobs without their own flags', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));

    expect(runner.runMarketCandleLongSyncJob).not.toHaveBeenCalled();
    expect(runner.runFuturesCandleSyncJob).not.toHaveBeenCalled();
  });

  it('runs the long-range 4h and futures candle jobs on their own intervals', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_LONG_SYNC_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_LONG_SYNC_MARKETS = 'krx';
    process.env.SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED = 'true';
    const { runner, runService, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-10T08:00:00.000Z'));
    expect(runner.runMarketCandleLongSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        markets: ['krx'],
        requestedBy: 'scheduler',
      }),
    );
    expect(runner.runFuturesCandleSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        requestedBy: 'scheduler',
      }),
    );

    // 30 s after the last finished runs: neither 900 s nor 60 s has elapsed.
    runService.findLatestRunForJob.mockResolvedValue({
      status: OpsJobRunStatus.succeeded,
      startedAt: new Date('2026-07-10T08:00:00.000Z'),
      finishedAt: new Date('2026-07-10T08:00:05.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-10T08:00:35.000Z'));
    expect(runner.runMarketCandleLongSyncJob).toHaveBeenCalledTimes(1);
    expect(runner.runFuturesCandleSyncJob).toHaveBeenCalledTimes(1);

    // 70 s later only the minute-cadenced futures job is due again.
    await service.runEnabledJobs(new Date('2026-07-10T08:01:15.000Z'));
    expect(runner.runMarketCandleLongSyncJob).toHaveBeenCalledTimes(1);
    expect(runner.runFuturesCandleSyncJob).toHaveBeenCalledTimes(2);
  });

  it('passes the configured asset allowlist to the candle sync job', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS = ' id1 , id2 , id1 ';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));

    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'incremental',
        continueOnError: true,
        assetIds: ['id1', 'id2'],
      }),
    );
  });

  it('does not fast-retry a failed candle sync before its interval', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_INTERVAL_SECONDS = '600';
    const { runner, runService, service } = createService();

    // One flaky feed marks the WHOLE run failed; per-tick retries would hit
    // the shared KIS budget every minute, so a failed run must still wait
    // out the interval (unlike the 60s provider snapshot jobs).
    runService.findLatestRunForJob.mockResolvedValue({
      status: OpsJobRunStatus.failed,
      startedAt: new Date('2026-07-10T03:00:00.000Z'),
      finishedAt: new Date('2026-07-10T03:01:30.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-10T03:03:00.000Z'));
    expect(runner.runMarketCandleSyncJob).not.toHaveBeenCalled();

    await service.runEnabledJobs(new Date('2026-07-10T03:12:00.000Z'));
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(1);
  });

  it('absorbs a candle sync job failure instead of failing the tick', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    const { runner, service } = createService();
    runner.runMarketCandleSyncJob.mockRejectedValueOnce(
      new Error('MARKET_CANDLE_SYNC_FAILED'),
    );

    await expect(
      service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z')),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(1);
  });

  it('skips a candle sync tick while the previous run is still in flight', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    const { runner, service } = createService();

    let release: (() => void) | undefined;
    runner.runMarketCandleSyncJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ success: true });
        }),
    );

    const first = service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));
    // Drain microtasks until the first tick reaches the in-flight sync.
    for (
      let spins = 0;
      runner.runMarketCandleSyncJob.mock.calls.length === 0 && spins < 100;
      spins += 1
    ) {
      await Promise.resolve();
    }
    await service.runEnabledJobs(new Date('2026-07-10T03:20:00.000Z'));
    expect(runner.runMarketCandleSyncJob).toHaveBeenCalledTimes(1);

    release?.();
    await first;
  });

  it('classifies scheduler startup exceptions without console raw text', async () => {
    jest.setSystemTime(new Date('2026-07-10T19:00:00.000Z'));
    process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP = 'true';
    const { service } = createService();
    jest
      .spyOn(service, 'runMarketCandleRetentionIfDue' as never)
      .mockRejectedValueOnce(
        Object.assign(
          new Error(
            'https://provider.invalid postgres://fake:fake@db.invalid/db 987654.12345678',
          ),
          { code: 'P1001' },
        ) as never,
      );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      service.onModuleInit();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith(
        'Market candle retention startup check failed.',
        {
          safeCause: {
            code: 'P1001',
            category: 'db_connection_failed',
            errorType: 'Error',
          },
        },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /provider.invalid|db.invalid|987654/,
      );
    } finally {
      warn.mockRestore();
      service.clearInterval();
    }
  });

  it('uses the same due check for startup retention', async () => {
    jest.setSystemTime(new Date('2026-07-10T19:00:00.000Z'));
    process.env.SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED = 'true';
    process.env.SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP = 'true';
    const { runner, service } = createService();
    service.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    expect(runner.runMarketCandleRetentionJob).toHaveBeenCalledTimes(1);
    service.clearInterval();
  });

  it('runs only enabled job flags when scheduler is enabled', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
    process.env.SCHEDULER_RANKING_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'false';
    const { runner, service } = createService();

    const results = await service.runEnabledJobs(
      new Date('2026-06-08T00:00:00.000Z'),
    );

    expect(results).toHaveLength(2);
    expect(runner.runProviderFxIngestJob).toHaveBeenCalledTimes(1);
    expect(runner.runSeasonRankingGenerationJob).toHaveBeenCalledTimes(1);
    expect(runner.runProviderFxIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
      }),
    );
    expect(runner.runSeasonRankingGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        createEquitySnapshots: true,
      }),
    );
    expect(runner.runScheduledDailySnapshotJobs).not.toHaveBeenCalled();
  });

  it('runs enabled provider jobs and passes KIS max snapshots', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_BINANCE_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_KIS_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS = '25';
    const { runner, service } = createService();

    const results = await service.runEnabledJobs(
      new Date('2026-06-08T00:00:00.000Z'),
    );

    expect(results).toHaveLength(2);
    expect(runner.runProviderFxIngestJob).not.toHaveBeenCalled();
    expect(runner.runProviderBinanceIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
      }),
    );
    expect(runner.runProviderKisIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        maxSnapshots: 25,
        kisPriceIngestionMode: 'websocket_trade',
      }),
    );
  });

  it('skips the Binance REST scheduler job when Binance WebSocket streaming is enabled', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_BINANCE_ENABLED = 'true';
    const { runner, service } = createService({
      binanceWebSocketStreamingEnabled: true,
    });

    const results = await service.runEnabledJobs(
      new Date('2026-06-08T00:00:00.000Z'),
    );

    expect(results).toEqual([]);
    expect(runner.runProviderBinanceIngestJob).not.toHaveBeenCalled();
  });

  it('does not create provider job runs when interval is not due', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS = '3600';
    const { runner, runService, service } = createService();
    runService.findLatestRunForJob.mockResolvedValueOnce({
      jobName: OpsJobName.provider_fx_ingest,
      status: OpsJobRunStatus.succeeded,
      startedAt: new Date('2026-06-08T00:10:00.000Z'),
      finishedAt: new Date('2026-06-08T00:10:05.000Z'),
    });

    const results = await service.runEnabledJobs(
      new Date('2026-06-08T00:30:00.000Z'),
    );

    expect(results).toEqual([]);
    expect(runner.runProviderFxIngestJob).not.toHaveBeenCalled();
  });

  it('allows provider retry on the next tick after a failed run', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
    const { runner, runService, service } = createService();
    runService.findLatestRunForJob.mockResolvedValueOnce({
      jobName: OpsJobName.provider_fx_ingest,
      status: OpsJobRunStatus.failed,
      startedAt: new Date('2026-06-08T00:29:00.000Z'),
      finishedAt: new Date('2026-06-08T00:29:05.000Z'),
    });

    await service.runEnabledJobs(new Date('2026-06-08T00:30:00.000Z'));

    expect(runner.runProviderFxIngestJob).toHaveBeenCalledTimes(1);
  });

  it('continues running other provider jobs when one provider runner throws', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_BINANCE_ENABLED = 'true';
    const { runner, service } = createService();
    runner.runProviderFxIngestJob.mockRejectedValueOnce(new Error('boom'));

    const results = await service.runEnabledJobs(
      new Date('2026-06-08T00:00:00.000Z'),
    );

    expect(results).toHaveLength(1);
    expect(runner.runProviderBinanceIngestJob).toHaveBeenCalledTimes(1);
  });

  it.each(['throw', 'failed-result'])(
    'logs a safe provider warning for %s and continues other jobs',
    async (failure) => {
      process.env.SCHEDULER_ENABLED = 'true';
      process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
      process.env.SCHEDULER_PROVIDER_BINANCE_ENABLED = 'true';
      process.env.EXCHANGE_RATE_API_KEY = 'private-test-key';
      process.env.KOREA_EXIM_EXCHANGE_AUTH_KEY = 'private-auth-key';
      process.env.DATABASE_URL = 'postgresql://user:password@db/private';
      const { runner, service } = createService();
      const message =
        'https://provider/private-test-key?authkey=private-auth-key postgresql://user:password@db/private {"balance":12345,"rawPayload":"private-data"}';
      if (failure === 'throw') {
        runner.runProviderFxIngestJob.mockRejectedValueOnce(
          Object.assign(new Error(message), { code: 'PROVIDER_HTTP_ERROR' }),
        );
      } else {
        runner.runProviderFxIngestJob.mockResolvedValueOnce({
          success: false,
          error: { code: 'PROVIDER_HTTP_ERROR', message },
          data: { rawPayload: message },
        });
      }
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await service.runEnabledJobs(new Date('2026-06-08T00:00:00.000Z'));
        expect(warn).toHaveBeenCalledWith('Provider scheduler job failed.', {
          jobName: OpsJobName.provider_fx_ingest,
          errorCode: 'PROVIDER_HTTP_ERROR',
          error: 'Provider job execution failed.',
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(runner.runProviderBinanceIngestJob).toHaveBeenCalledTimes(1);
        for (const secret of [
          'private-test-key',
          'private-auth-key',
          'postgresql://',
          '12345',
          'private-data',
          'rawPayload',
          'https://',
        ]) {
          expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
        }
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each(['https://provider/secret', 'PRIVATE_AUTH_KEY'])(
    'omits unsafe provider error codes (%s)',
    async (code) => {
      process.env.SCHEDULER_ENABLED = 'true';
      process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
      process.env.KOREA_EXIM_EXCHANGE_AUTH_KEY = 'PRIVATE_AUTH_KEY';
      const { runner, service } = createService();
      runner.runProviderFxIngestJob.mockRejectedValueOnce(
        Object.assign(new Error('private payload'), { code }),
      );
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await service.runEnabledJobs(new Date('2026-06-08T00:00:00.000Z'));
        expect(warn).toHaveBeenCalledWith('Provider scheduler job failed.', {
          jobName: OpsJobName.provider_fx_ingest,
          errorCode: undefined,
          error: 'Provider job execution failed.',
        });
      } finally {
        warn.mockRestore();
      }
    },
  );

  it('warns safely when one FX provider fails but the combined job succeeds', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_FX_ENABLED = 'true';
    const { runner, service } = createService();
    runner.runProviderFxIngestJob.mockResolvedValueOnce({
      success: true,
      data: {
        locked: false,
        skipped: false,
        run: {
          resultJson: {
            state: 'completed',
            providers: [
              {
                provider: 'korea_exim_exchange_rate',
                success: false,
                errorCode: 'KOREA_EXIM_DAILY_LIMIT_EXCEEDED',
                errorMessage: 'sensitive provider response',
              },
              { provider: 'exchange_rate_api', success: true },
            ],
          },
        },
      },
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await service.runEnabledJobs(new Date('2026-06-08T00:00:00.000Z'));
      expect(warn).toHaveBeenCalledWith(
        'Provider scheduler job partially failed.',
        {
          jobName: OpsJobName.provider_fx_ingest,
          provider: 'korea_exim_exchange_rate',
          errorCode: 'KOREA_EXIM_DAILY_LIMIT_EXCEEDED',
          error: 'One FX provider failed while another succeeded.',
        },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        'sensitive provider response',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not run provider jobs on startup when the startup flag is false', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_KIS_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP = 'false';
    const { runner, service } = createService();

    service.onModuleInit();
    await Promise.resolve();

    expect(runner.runProviderKisIngestJob).not.toHaveBeenCalled();
    service.clearInterval();
  });

  it('runs only provider jobs asynchronously on startup when enabled', async () => {
    process.env.SCHEDULER_PROVIDER_KIS_ENABLED = 'true';
    process.env.SCHEDULER_RANKING_ENABLED = 'true';
    process.env.SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP = 'true';
    const { runner, service } = createService();

    service.onModuleInit();
    expect(runner.runProviderKisIngestJob).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(runner.runProviderKisIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        kisPriceIngestionMode: 'websocket_trade',
      }),
    );
    expect(runner.runSeasonRankingGenerationJob).not.toHaveBeenCalled();
    service.clearInterval();
  });

  it('runs ranking every minute but enables scheduled equity snapshots only on five-minute buckets', async () => {
    process.env.SCHEDULER_RANKING_ENABLED = 'true';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-06-08T00:01:00.000Z'));
    await service.runEnabledJobs(new Date('2026-06-08T00:05:00.000Z'));

    expect(runner.runSeasonRankingGenerationJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        now: '2026-06-08T00:01:00.000Z',
        createEquitySnapshots: false,
      }),
    );
    expect(runner.runSeasonRankingGenerationJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        now: '2026-06-08T00:05:00.000Z',
        createEquitySnapshots: true,
      }),
    );
  });

  it('dispatches daily season and general jobs with the daily flag alone', async () => {
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_SEASON_ID = 'season-1';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-06-07T15:00:00.000Z'));

    expect(runner.runScheduledDailySnapshotJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        seasonId: 'season-1',
      }),
    );
    expect(
      getOpsSchedulerConfig().jobs[OpsJobName.daily_portfolio_snapshot],
    ).toBe(true);
  });

  it('registers the existing interval with only the daily flag and clears it on shutdown', () => {
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'true';
    const { service } = createService();
    service.onModuleInit();
    expect(service.isIntervalRegistered()).toBe(true);
    service.onModuleDestroy();
    expect(service.isIntervalRegistered()).toBe(false);
  });

  it('skips overlapping daily sweeps and permits a later tick after a failure', async () => {
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'true';
    const { runner, service } = createService();
    let rejectSweep!: (error: Error) => void;
    runner.runScheduledDailySnapshotJobs.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectSweep = reject;
        }),
    );
    const first = service.runEnabledJobs();
    const failed = expect(first).rejects.toThrow('DB unavailable');
    // Let the first tick reach the suspended daily runner.
    await Promise.resolve();
    await Promise.resolve();
    await service.runEnabledJobs();
    expect(runner.runScheduledDailySnapshotJobs).toHaveBeenCalledTimes(1);
    rejectSweep(new Error('DB unavailable'));
    await failed;
    await service.runEnabledJobs();
    expect(runner.runScheduledDailySnapshotJobs).toHaveBeenCalledTimes(2);
  });

  it('runs KRX reconciliation after the actual session close grace and only once per successful date', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    const { runner, runService, service } = createService();

    await expect(
      service.runEnabledJobs(new Date('2026-07-10T06:49:00.000Z')),
    ).resolves.toEqual([]);
    await service.runEnabledJobs(new Date('2026-07-10T06:50:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'KRX',
        targets: ['5m', '1d', '1w'],
        continueOnError: true,
        metadataJson: expect.objectContaining({
          reconciliationMarket: 'KRX',
          businessDate: '2026-07-10',
        }) as Record<string, unknown>,
      }),
    );

    runService.findLatestSucceededReconciliationRun.mockResolvedValueOnce({
      startedAt: new Date('2026-07-10T06:50:00.000Z'),
      finishedAt: new Date('2026-07-10T06:51:00.000Z'),
    });
    await service.runEnabledJobs(new Date('2026-07-10T08:00:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(1);
  });

  it('includes weekly reconciliation on Thursday before a Friday KRX holiday', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-07-16T06:50:00.000Z'));

    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'KRX',
        targets: ['5m', '1d', '1w'],
      }),
    );
  });

  it('never runs stock reconciliation on a real exchange holiday', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_US_ENABLED = 'true';
    const { runner, service } = createService();
    // 2026-07-17 is Constitution Day (KRX closed); use a time past the KRX
    // close grace. 2026-07-03 is Independence Day observed (US closed).
    await service.runEnabledJobs(new Date('2026-07-17T08:00:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'KRX',
        metadataJson: expect.objectContaining({
          businessDate: '2026-07-17',
        }) as Record<string, unknown>,
      }),
    );
    await service.runEnabledJobs(new Date('2026-07-03T22:00:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'US',
        metadataJson: expect.objectContaining({
          businessDate: '2026-07-03',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('skips weekends silently: scheduled no-data, not a coverage warning', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_US_ENABLED = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, service } = createService();
      // Saturday 2026-07-18 in both Asia/Seoul and America/New_York.
      await expect(
        service.runEnabledJobs(new Date('2026-07-18T09:00:00.000Z')),
      ).resolves.toEqual([]);
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns once per market and business date when the calendar year is uncovered', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_US_ENABLED = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, service } = createService();
      // Wednesday 2028-01-05: no 2028 calendar dataset exists. The provider
      // job must NOT run, and the skip must NOT look like a normal holiday.
      await service.runEnabledJobs(new Date('2028-01-05T08:00:00.000Z'));
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();
      expect(coverageWarningDetails(warnSpy)).toEqual([
        expect.objectContaining({ market: 'KRX', startup: false }),
        expect.objectContaining({ market: 'US', startup: false }),
      ]);

      // A later tick on the same business date does not repeat the warning.
      warnSpy.mockClear();
      await service.runEnabledJobs(new Date('2028-01-05T09:00:00.000Z'));
      expect(coverageWarningDetails(warnSpy)).toHaveLength(0);

      // The next business date warns again.
      await service.runEnabledJobs(new Date('2028-01-06T08:00:00.000Z'));
      expect(coverageWarningDetails(warnSpy)).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('uses the real early close plus grace on the day after Thanksgiving 2026', async () => {
    process.env.CANDLE_RECONCILIATION_US_ENABLED = 'true';
    const { runner, service } = createService();
    // US 2026-11-27 closes early at 13:00 ET (18:00Z); grace is 20 minutes.
    await expect(
      service.runEnabledJobs(new Date('2026-11-27T18:19:00.000Z')),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();

    await service.runEnabledJobs(new Date('2026-11-27T18:20:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'US',
        metadataJson: expect.objectContaining({
          businessDate: '2026-11-27',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('uses the real delayed close plus grace on KRX CSAT day 2026', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    const { runner, service } = createService();
    // KRX 2026-11-19 session is shifted to 10:00–16:30 KST (close 07:30Z);
    // due at close + 20 minutes grace, NOT at the regular 15:30 close.
    await expect(
      service.runEnabledJobs(new Date('2026-11-19T07:49:00.000Z')),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();

    await service.runEnabledJobs(new Date('2026-11-19T07:50:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'KRX',
        metadataJson: expect.objectContaining({
          businessDate: '2026-11-19',
        }) as Record<string, unknown>,
      }),
    );
  });

  it('uses a CUSTOM override close plus grace instead of the regular close', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    try {
      // Operator override: KRX 2026-07-13 closes early at 14:00 KST (05:00Z);
      // reconciliation is due at close + 20 minutes grace, NOT at 15:30 KST.
      applyMarketSessionOverrideSnapshot(
        [
          {
            market: 'KRX',
            localDate: '2026-07-13',
            overrideType: 'custom',
            openTime: '090000',
            closeTime: '140000',
            reason: 'early close override',
          },
        ],
        new Date(),
      );
      const { runner, service } = createService();

      await expect(
        service.runEnabledJobs(new Date('2026-07-13T05:19:00.000Z')),
      ).resolves.toEqual([]);
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();

      await service.runEnabledJobs(new Date('2026-07-13T05:20:00.000Z'));
      expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          market: 'KRX',
          metadataJson: expect.objectContaining({
            businessDate: '2026-07-13',
          }) as Record<string, unknown>,
        }),
      );
    } finally {
      resetMarketSessionOverrideStoreForTest();
    }
  });

  it('treats an override-closed day as scheduled no-data (no provider work, no warning)', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      applyMarketSessionOverrideSnapshot(
        [
          {
            market: 'KRX',
            localDate: '2026-07-13',
            overrideType: 'closed',
            openTime: null,
            closeTime: null,
            reason: 'emergency closure',
          },
        ],
        new Date(),
      );
      const { runner, service } = createService();

      await service.runEnabledJobs(new Date('2026-07-13T08:00:00.000Z'));
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalledWith(
        expect.objectContaining({
          market: 'KRX',
          metadataJson: expect.objectContaining({
            businessDate: '2026-07-13',
          }) as Record<string, unknown>,
        }),
      );
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      resetMarketSessionOverrideStoreForTest();
    }
  });

  it('observes calendar-unavailable on startup catch-up instead of silently skipping', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_STARTUP_CATCH_UP_ENABLED = 'true';
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runner, service } = createService();
      await expect(
        service.runStartupCandleReconciliation(
          new Date('2028-01-05T08:00:00.000Z'),
        ),
      ).resolves.toEqual([]);
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('calendar'),
        expect.objectContaining({
          reason: 'MARKET_CALENDAR_COVERAGE_MISSING',
          market: 'KRX',
          startup: true,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps crypto reconciliation independent of the stock calendar', async () => {
    process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
    const { runner, service } = createService();
    // 2028 has no stock calendar dataset; crypto trades continuously and
    // must still reconcile on its rolling interval.
    await service.runEnabledJobs(new Date('2028-01-05T08:00:00.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({ market: 'CRYPTO' }),
    );
  });

  it('does not run startup stock catch-up on a full-day holiday', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_STARTUP_CATCH_UP_ENABLED = 'true';
    const { runner, service } = createService();

    await expect(
      service.runStartupCandleReconciliation(
        new Date('2026-07-17T08:00:00.000Z'),
      ),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();
  });

  it('runs crypto reconciliation on a bounded rolling interval', async () => {
    process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_CRYPTO_INTERVAL_SECONDS = '300';
    const { runner, runService, service } = createService();
    runService.findLatestSucceededReconciliationRun
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        startedAt: new Date('2026-07-13T00:00:00.000Z'),
        finishedAt: new Date('2026-07-13T00:00:01.000Z'),
      });

    await service.runEnabledJobs(new Date('2026-07-13T00:00:00.000Z'));
    await service.runEnabledJobs(new Date('2026-07-13T00:04:59.000Z'));
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(1);
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        market: 'CRYPTO',
        targets: expect.arrayContaining(['5m', '1d']) as string[],
      }),
    );
  });

  it.each([
    OpsJobRunStatus.failed,
    OpsJobRunStatus.running,
    OpsJobRunStatus.succeeded,
  ])(
    'respects recorded crypto %s attempts after restart, including startup catch-up',
    async (status) => {
      process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
      process.env.CANDLE_RECONCILIATION_CRYPTO_INTERVAL_SECONDS = '300';
      const { runner, runService, service } = createService();
      runService.findLatestReconciliationAttempt.mockResolvedValue({
        status,
        startedAt: new Date('2026-07-13T00:00:00Z'),
        finishedAt:
          status === OpsJobRunStatus.running
            ? null
            : new Date('2026-07-13T00:00:01Z'),
      });
      await service.runMarketCandleReconciliationIfDue(
        new Date('2026-07-13T00:01:00Z'),
        'CRYPTO',
      );
      await service.runMarketCandleReconciliationIfDue(
        new Date('2026-07-13T00:04:59Z'),
        'CRYPTO',
        getOpsSchedulerConfig(),
        true,
      );
      expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();
      await service.runMarketCandleReconciliationIfDue(
        new Date('2026-07-13T00:05:01Z'),
        'CRYPTO',
      );
      expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(1);
    },
  );

  it('bounds consecutive crypto runner failures even before a run record is persisted', async () => {
    process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_CRYPTO_INTERVAL_SECONDS = '300';
    const { runner, service } = createService();
    runner.runMarketCandleReconciliationJob.mockRejectedValue(
      new Error('failed'),
    );
    for (const minute of [0, 5]) {
      await expect(
        service.runMarketCandleReconciliationIfDue(
          new Date(Date.UTC(2026, 6, 13, 0, minute)),
          'CRYPTO',
        ),
      ).rejects.toThrow('failed');
      for (const offset of [1, 2, 3, 4])
        await service.runMarketCandleReconciliationIfDue(
          new Date(Date.UTC(2026, 6, 13, 0, minute + offset)),
          'CRYPTO',
        );
    }
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a slow crypto attempt and releases the guard after completion', async () => {
    process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
    const { runner, runService, service } = createService();
    let finish!: (result: { success: boolean }) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    runner.runMarketCandleReconciliationJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          signalStarted();
        }),
    );
    const initial = service.runMarketCandleReconciliationIfDue(
      new Date('2026-07-13T00:00:00Z'),
      'CRYPTO',
    );
    await Promise.race([started, initial]);
    expect(typeof finish).toBe('function');
    await service.runMarketCandleReconciliationIfDue(
      new Date('2026-07-13T00:10:00Z'),
      'CRYPTO',
    );
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(1);
    finish({ success: true });
    await initial;
    runService.findLatestReconciliationAttempt.mockResolvedValue(null);
    await service.runMarketCandleReconciliationIfDue(
      new Date('2026-07-13T00:10:00Z'),
      'CRYPTO',
    );
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(2);
  });

  it('skips startup catch-up only when both the last success and canonical coverage are fresh', async () => {
    process.env.CANDLE_RECONCILIATION_CRYPTO_ENABLED = 'true';
    process.env.CANDLE_RECONCILIATION_STARTUP_CATCH_UP_ENABLED = 'true';
    const { runner, runService, reconciliationService, service } =
      createService();
    runService.findLatestSucceededReconciliationRun.mockResolvedValue({
      startedAt: new Date('2026-07-13T00:00:00.000Z'),
      finishedAt: new Date('2026-07-13T00:01:00.000Z'),
    });
    reconciliationService.hasRecentCanonicalCoverage.mockResolvedValue(true);

    await expect(
      service.runStartupCandleReconciliation(
        new Date('2026-07-13T00:02:00.000Z'),
      ),
    ).resolves.toEqual([]);
    expect(runner.runMarketCandleReconciliationJob).not.toHaveBeenCalled();

    reconciliationService.hasRecentCanonicalCoverage.mockResolvedValue(false);
    await service.runStartupCandleReconciliation(
      new Date('2026-07-13T00:02:00.000Z'),
    );
    expect(runner.runMarketCandleReconciliationJob).toHaveBeenCalledTimes(1);
  });
});

/**
 * 2b/2d: the Ops scheduler owns the KOSCOM price loop in slot mode — one
 * attempt per slot boundary per process, independent of the live candle
 * flag — and drains an in-flight cycle on shutdown (F27).
 */
describe('OpsSchedulerService KOSCOM price slot loop', () => {
  const originalEnv = process.env;
  const T = 3000;
  const base = Date.parse('2026-09-30T01:00:01.200Z');

  const create = (env: Record<string, string>) => {
    process.env = {
      ...originalEnv,
      KOSCOM_API_KEY: 'k',
      PROVIDER_INGESTION_ENABLED: 'true',
      KOSCOM_POLLING_ENABLED: 'true',
      ...env,
    };
    const koscom = {
      collect: jest.fn().mockResolvedValue({ success: true }),
      collectSlot: jest.fn().mockResolvedValue({ success: true }),
      drain: jest.fn().mockResolvedValue(undefined),
    };
    const { readKoscomConfig } = jest.requireActual<
      typeof import('../providers/koscom/koscom.config')
    >('../providers/koscom/koscom.config');
    const service = new OpsSchedulerService(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      koscom as never,
      { getConfig: () => readKoscomConfig() } as never,
    );
    return { service, koscom };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(base);
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  it('attempts each slot exactly once, at the boundary, and never the legacy interval', async () => {
    const { service, koscom } = create({ KOSCOM_PRICE_SLOT_ENABLED: 'true' });
    service.onModuleInit();
    const first = Math.floor(base / T);
    expect(koscom.collectSlot).toHaveBeenCalledTimes(1);
    expect(firstCallArg(koscom.collectSlot)).toEqual({
      slot: first,
      periodMs: T,
    });
    // Next boundary is 1.8 s away; nothing fires before it.
    await jest.advanceTimersByTimeAsync(1_700);
    expect(koscom.collectSlot).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100 + 4 * T);
    const slots = koscom.collectSlot.mock.calls.map(
      (call: [{ slot: number }]) => call[0].slot,
    );
    expect(slots).toEqual([
      first,
      first + 1,
      first + 2,
      first + 3,
      first + 4,
      first + 5,
    ]);
    expect(koscom.collect).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('keeps owning KOSCOM prices when live candles are enabled (2d)', async () => {
    const { service, koscom } = create({
      KOSCOM_PRICE_SLOT_ENABLED: 'true',
      CANDLE_LIVE_STREAMING_ENABLED: 'true',
    });
    service.onModuleInit();
    expect(koscom.collectSlot).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('leaves legacy mode unchanged: live candles enabled means no scheduler poll', async () => {
    const { service, koscom } = create({
      CANDLE_LIVE_STREAMING_ENABLED: 'true',
    });
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(3 * T);
    expect(koscom.collect).not.toHaveBeenCalled();
    expect(koscom.collectSlot).not.toHaveBeenCalled();
    service.clearInterval();
  });

  it('drains the in-flight cycle on shutdown and attempts no slot afterwards', async () => {
    const { service, koscom } = create({ KOSCOM_PRICE_SLOT_ENABLED: 'true' });
    service.onModuleInit();
    await service.onModuleDestroy();
    expect(koscom.drain).toHaveBeenCalledTimes(1);
    const timeout = (koscom.drain.mock.calls[0] as [number])[0];
    expect(timeout >= 5_000 && timeout <= 15_000).toBe(true);
    const calls = koscom.collectSlot.mock.calls.length;
    await jest.advanceTimersByTimeAsync(5 * T);
    expect(koscom.collectSlot.mock.calls.length).toBe(calls);
  });

  it('logs a set-but-ignored KOSCOM value once at start-up (F16)', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { service } = create({
      KOSCOM_PRICE_SLOT_ENABLED: 'true',
      KOSCOM_POLL_INTERVAL_MS: '120000',
    });
    service.onModuleInit();
    const details = (warn.mock.calls as unknown[][]).map((call) => call[1]);
    expect(details).toContainEqual({
      setting: 'KOSCOM_POLL_INTERVAL_MS',
      reason: 'out_of_range',
      fallback: 3000,
    });
    await service.onModuleDestroy();
    warn.mockRestore();
  });
});

/**
 * 3b: the central KRX schedule (design v2.1 §3, §4.4, §7.6) — calendar-
 * derived instants claimed cluster-wide, 4h long sync after each daily
 * phase, KRX left out of the interval sync and the reconciliation, and the
 * 05:00 checkpoint compaction once per business date.
 */
describe('OpsSchedulerService central KRX candles', () => {
  const originalEnv = process.env;

  const create = (enabled = true) => {
    const ok = () => jest.fn().mockResolvedValue({ success: true });
    const runner = {
      runKrxCentralCandleJob: ok(),
      runKrxCheckpointCompactionJob: ok(),
      runMarketCandleLongSyncJob: ok(),
      runMarketCandleSyncJob: ok(),
      runMarketCandleRetentionJob: ok(),
      runMarketCandleReconciliationJob: ok(),
      runFuturesCandleSyncJob: ok(),
      runScheduledDailySnapshotJobs: jest.fn().mockResolvedValue([]),
    };
    const runService = {
      findLatestRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededReconciliationRun: jest.fn().mockResolvedValue(null),
      findLatestReconciliationAttempt: jest.fn().mockResolvedValue(null),
    };
    const central = {
      isEnabled: jest.fn(() => enabled),
      tickDelayMs: 70_000,
      claimRun: jest.fn().mockResolvedValue(true),
    };
    const service = new OpsSchedulerService(
      runner as never,
      runService as never,
      undefined,
      {
        getConfig: () => ({ binance: { wsStreamingEnabled: false } }),
      } as never,
      {
        hasRecentCanonicalCoverage: jest.fn().mockResolvedValue(false),
      } as never,
      undefined,
      undefined,
      undefined,
      central as never,
    );
    return { service, runner, runService, central };
  };

  beforeEach(() => {
    jest.useFakeTimers();
    // The central flag alone keeps the scheduler tick alive (ops-config).
    process.env = { ...originalEnv, KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' };
  });
  afterEach(() => {
    jest.useRealTimers();
    process.env = originalEnv;
  });

  it('runs a claimed instant once per cluster, and the KRX 4h long sync after each daily phase', async () => {
    const { service, runner, central } = create();
    const at = Date.parse('2026-10-15T00:06:10.000Z');
    await service.runKrxCentralPhase('intraday', at);
    expect(central.claimRun).toHaveBeenCalledWith('intraday', at);
    expect(runner.runKrxCentralCandleJob).toHaveBeenCalledTimes(1);
    expect(firstCallArg(runner.runKrxCentralCandleJob)).toMatchObject({
      phase: 'intraday',
      trigger: 'scheduler',
      requestedBy: 'scheduler',
      dryRun: false,
    });
    expect(runner.runMarketCandleLongSyncJob).not.toHaveBeenCalled();

    // Another instance already claimed this instant: nothing runs here.
    const daily = Date.parse('2026-10-15T06:50:00.000Z');
    central.claimRun.mockResolvedValueOnce(false);
    await service.runKrxCentralPhase('daily', daily);
    expect(runner.runKrxCentralCandleJob).toHaveBeenCalledTimes(1);

    await service.runKrxCentralPhase('daily', daily + 1);
    expect(runner.runKrxCentralCandleJob).toHaveBeenCalledTimes(2);
    expect(runner.runMarketCandleLongSyncJob).toHaveBeenCalledTimes(1);
    expect(firstCallArg(runner.runMarketCandleLongSyncJob)).toMatchObject({
      mode: 'incremental',
      markets: ['krx'],
    });
  });

  it('does nothing when the central collection is disabled', async () => {
    const { service, runner, central } = create(false);
    await service.runKrxCentralPhase('intraday', Date.now());
    expect(central.claimRun).not.toHaveBeenCalled();
    expect(runner.runKrxCentralCandleJob).not.toHaveBeenCalled();
    await service.runEnabledJobs(new Date('2026-07-10T20:00:00.000Z'));
    expect(runner.runKrxCheckpointCompactionJob).not.toHaveBeenCalled();
  });

  it('arms the calendar loop: the first tick is the bucket end plus the delay', async () => {
    // 2026-10-15 09:04 KST: the 09:00–09:05 bucket is collected at 09:06:10.
    jest.setSystemTime(Date.parse('2026-10-15T00:04:00.000Z'));
    const { service, central } = create();
    service.onModuleInit();
    await jest.advanceTimersByTimeAsync(130_000 - 100);
    expect(central.claimRun).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(central.claimRun).toHaveBeenCalledTimes(1);
    expect(central.claimRun.mock.calls[0]).toEqual([
      'intraday',
      Date.parse('2026-10-15T00:06:10.000Z'),
    ]);
    // Re-armed for the next bucket (09:11:10), not the same instant.
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(central.claimRun.mock.calls[1]).toEqual([
      'intraday',
      Date.parse('2026-10-15T00:11:10.000Z'),
    ]);
    service.clearInterval();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(central.claimRun).toHaveBeenCalledTimes(2);
  });

  it('keeps KRX out of the interval sync and gates it on its own lock key only', async () => {
    process.env.SCHEDULER_MARKET_CANDLE_SYNC_ENABLED = 'true';
    const on = create();
    await on.service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));
    expect(on.runService.findLatestRunForJob).toHaveBeenCalledWith(
      'market_candle_sync',
      'market_candle_sync:manual',
    );
    expect(firstCallArg(on.runner.runMarketCandleSyncJob)).toMatchObject({
      mode: 'incremental',
      assetTypes: ['us_stock', 'crypto'],
    });

    const off = create(false);
    await off.service.runEnabledJobs(new Date('2026-07-10T03:00:00.000Z'));
    const input = firstCallArg(off.runner.runMarketCandleSyncJob) as object;
    expect('assetTypes' in input).toBe(false);
  });

  it('skips KRX reconciliation with a single warning while the central collection owns it', async () => {
    process.env.CANDLE_RECONCILIATION_KRX_ENABLED = 'true';
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const { service, runner } = create();
    await service.runEnabledJobs(new Date('2026-07-10T06:50:00.000Z'));
    await service.runEnabledJobs(new Date('2026-07-10T07:50:00.000Z'));
    const krxRuns = (
      runner.runMarketCandleReconciliationJob.mock.calls as unknown[][]
    ).filter((call) => (call[0] as { market?: string }).market === 'KRX');
    expect(krxRuns.length).toBe(0);
    const skips = (warn.mock.calls as unknown[][]).filter(
      (call) =>
        call[0] ===
        'KRX candle reconciliation skipped: the central KRX collection owns it.',
    );
    expect(skips.length).toBe(1);
    warn.mockRestore();
  });

  it('compacts KRX checkpoints after 05:00 local time, once per successful business date', async () => {
    const { service, runner, runService } = create();
    await service.runEnabledJobs(new Date('2026-07-10T19:59:00.000Z'));
    expect(runner.runKrxCheckpointCompactionJob).not.toHaveBeenCalled();

    await service.runEnabledJobs(new Date('2026-07-10T20:00:00.000Z'));
    expect(runner.runKrxCheckpointCompactionJob).toHaveBeenCalledTimes(1);
    expect(runService.findLatestSucceededRunForJob).toHaveBeenCalledWith(
      'market_candle_sync',
      'market_candle_sync:krx_compaction',
    );
    expect(firstCallArg(runner.runKrxCheckpointCompactionJob)).toMatchObject({
      trigger: 'scheduler',
      dryRun: false,
      now: '2026-07-10T20:00:00.000Z',
    });

    const done = {
      startedAt: new Date('2026-07-10T20:00:00.000Z'),
      finishedAt: new Date('2026-07-10T20:01:00.000Z'),
    };
    runService.findLatestSucceededRunForJob.mockResolvedValueOnce(done);
    await service.runEnabledJobs(new Date('2026-07-10T23:00:00.000Z'));
    expect(runner.runKrxCheckpointCompactionJob).toHaveBeenCalledTimes(1);

    runService.findLatestSucceededRunForJob.mockResolvedValueOnce(done);
    await service.runEnabledJobs(new Date('2026-07-11T20:00:00.000Z'));
    expect(runner.runKrxCheckpointCompactionJob).toHaveBeenCalledTimes(2);
  });
});
