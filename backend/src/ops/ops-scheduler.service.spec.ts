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
jest.mock('../assets/market-candle-reconciliation.service', () => ({
  MarketCandleReconciliationService: class MarketCandleReconciliationService {},
}));

import { OpsJobName, OpsJobRunStatus } from '../generated/prisma/client';
import {
  applyMarketSessionOverrideSnapshot,
  resetMarketSessionOverrideStoreForTest,
} from '../orders/market-calendar/market-session-override.store';
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
      runMarketCandleReconciliationJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
    };
    const runService = {
      findLatestRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededRunForJob: jest.fn().mockResolvedValue(null),
      findLatestSucceededReconciliationRun: jest.fn().mockResolvedValue(null),
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
