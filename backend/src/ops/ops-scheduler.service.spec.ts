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
jest.mock('../assets/market-candle-sync.service', () => ({
  MarketCandleSyncService: class MarketCandleSyncService {},
}));

import { OpsJobName, OpsJobRunStatus } from '../generated/prisma/client';
import { getOpsSchedulerConfig } from './ops-config';
import { OpsSchedulerService } from './ops-scheduler.service';

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
      runDailyPortfolioSnapshotJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
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
    };
    const runService = {
      findLatestRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededRunForJob: jest.fn().mockResolvedValue(null),
    };
    const providerConfigService = {
      getConfig: jest.fn().mockReturnValue({
        binance: {
          wsStreamingEnabled: input.binanceWebSocketStreamingEnabled ?? false,
        },
      }),
    };

    return {
      runner,
      runService,
      providerConfigService,
      service: new OpsSchedulerService(
        runner as never,
        runService as never,
        undefined,
        providerConfigService as never,
      ),
    };
  };

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
        retentionDays: 35,
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
    expect(runner.runDailyPortfolioSnapshotJob).not.toHaveBeenCalled();
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

  it('passes Asia/Seoul business date to daily snapshot scheduler runner', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_SEASON_ID = 'season-1';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-06-07T15:00:00.000Z'));

    expect(runner.runDailyPortfolioSnapshotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        seasonId: 'season-1',
        snapshotDate: '2026-06-08',
      }),
    );
    expect(
      getOpsSchedulerConfig().jobs[OpsJobName.daily_portfolio_snapshot],
    ).toBe(true);
  });
});
