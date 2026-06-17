jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
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

import { OpsJobName } from '../generated/prisma/client';
import { getOpsSchedulerConfig } from './ops-config';
import { OpsSchedulerService } from './ops-scheduler.service';

describe('OpsSchedulerService', () => {
  const originalEnv = { ...process.env };

  const createService = () => {
    const runner = {
      runProviderFxIngestJob: jest.fn().mockResolvedValue({ success: true }),
      runProviderBinanceIngestJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runDailyPortfolioSnapshotJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runSeasonRankingGenerationJob: jest
        .fn()
        .mockResolvedValue({ success: true }),
      runSeasonSettlementJob: jest.fn().mockResolvedValue({ success: true }),
      runRewardMarkerJob: jest.fn().mockResolvedValue({ success: true }),
    };

    return {
      runner,
      service: new OpsSchedulerService(runner as never),
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
        dryRun: true,
      }),
    );
    expect(runner.runSeasonRankingGenerationJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
      }),
    );
    expect(runner.runDailyPortfolioSnapshotJob).not.toHaveBeenCalled();
  });

  it('passes Asia/Seoul business date to daily snapshot scheduler runner', async () => {
    process.env.SCHEDULER_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_ENABLED = 'true';
    process.env.SCHEDULER_DAILY_SNAPSHOT_SEASON_ID = 'season-1';
    const { runner, service } = createService();

    await service.runEnabledJobs(new Date('2026-06-07T15:00:00.000Z'));

    expect(runner.runDailyPortfolioSnapshotJob).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: true,
        seasonId: 'season-1',
        snapshotDate: '2026-06-08',
      }),
    );
    expect(
      getOpsSchedulerConfig().jobs[OpsJobName.daily_portfolio_snapshot],
    ).toBe(true);
  });
});
