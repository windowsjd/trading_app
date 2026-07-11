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
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  MarketCandleSyncMode: {
    initial: 'initial',
    incremental: 'incremental',
    repair: 'repair',
  },
}));

jest.mock('../assets/market-candle-sync.service', () => ({
  MarketCandleSyncService: class MarketCandleSyncService {},
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
jest.mock('../assets/market-candle-retention.service', () => ({
  MarketCandleRetentionService: class MarketCandleRetentionService {},
}));
jest.mock('../providers/binance/binance-price.ingestion.service', () => ({
  BinancePriceIngestionService: class BinancePriceIngestionService {},
}));
jest.mock('../providers/kis/kis-rest-current-price.ingestion.service', () => ({
  KisRestCurrentPriceIngestionService: class KisRestCurrentPriceIngestionService {},
}));
jest.mock('../providers/kis/kis-websocket.client', () => ({
  KisWebSocketClient: class KisWebSocketClient {},
}));
jest.mock('../providers/exchange-rate/exchange-rate.ingestion.service', () => ({
  ExchangeRateIngestionService: class ExchangeRateIngestionService {},
}));
jest.mock(
  '../providers/korea-exim/korea-exim-exchange.ingestion.service',
  () => ({
    KoreaEximExchangeIngestionService: class KoreaEximExchangeIngestionService {},
  }),
);

import {
  OpsJobName,
  OpsJobRunStatus,
  OpsJobTrigger,
} from '../generated/prisma/client';
import { OpsJobRunnerService } from './ops-job-runner.service';

describe('OpsJobRunnerService', () => {
  const startedAt = new Date('2026-06-08T00:00:00.000Z');
  const serializedRun = (
    overrides: Partial<{
      id: string;
      jobName: OpsJobName;
      status: OpsJobRunStatus;
      resultJson: unknown;
    }> = {},
  ) => ({
    id: overrides.id ?? 'run-1',
    jobName: overrides.jobName ?? OpsJobName.daily_portfolio_snapshot,
    status: overrides.status ?? OpsJobRunStatus.succeeded,
    trigger: OpsJobTrigger.test,
    requestedBy: null,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    durationMs: 0,
    lockKey: null,
    idempotencyKey: null,
    dryRun: true,
    attempt: 1,
    maxAttempts: 1,
    errorCode: null,
    errorMessage: null,
    resultJson: overrides.resultJson ?? null,
    metadataJson: null,
    createdAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
  });

  const createService = () => {
    const dailyPortfolioSnapshotJobService = {
      run: jest.fn(),
    };
    const seasonLifecycleTransitionJobService = {
      run: jest.fn(),
    };
    const seasonSettlementJobService = {
      run: jest.fn(),
    };
    const rankingRefreshService = {
      refreshCurrentRankingsForActiveSeasons: jest.fn(),
    };
    const exchangeRateIngestionService = {
      ingestUsdKrw: jest.fn(),
    };
    const koreaEximExchangeIngestionService = {
      ingestUsdKrw: jest.fn(),
    };
    const binancePriceIngestionService = {
      ingestPrices: jest.fn(),
    };
    const kisRestCurrentPriceIngestionService = {
      ingestCurrentPrices: jest.fn(),
    };
    const kisWebSocketClient = {
      runTradePriceIngestion: jest.fn(),
    };
    const providerTargetResolver = {
      resolveProviderTargets: jest.fn().mockResolvedValue({
        targetSource: 'merged',
        activeAssetCount: 3,
        binanceSymbols: ['BTCUSDT', 'ETHUSDT'],
        kisDomesticSymbols: ['005930'],
        kisUsSymbols: ['AAPL'],
        unsupportedAssets: [],
      }),
    };
    const marketCandleRetentionService = {
      run: jest.fn(),
    };
    const marketCandleSyncService = {
      syncAssets: jest.fn(),
      syncAsset: jest.fn(),
    };
    const prisma = {
      season: {
        findMany: jest.fn(),
      },
    };
    const lockService = {
      acquireLock: jest.fn(),
      extendLock: jest.fn().mockResolvedValue(true),
      releaseLock: jest.fn(),
    };
    const runService = {
      recordSkipped: jest.fn(),
      recordLocked: jest.fn(),
      createRunning: jest.fn(),
      recordSucceeded: jest.fn(),
      recordFailed: jest.fn(),
      serializeRun: jest.fn((run) => run.serialized ?? serializedRun()),
    };

    return {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      seasonLifecycleTransitionJobService,
      seasonSettlementJobService,
      rankingRefreshService,
      exchangeRateIngestionService,
      koreaEximExchangeIngestionService,
      binancePriceIngestionService,
      kisRestCurrentPriceIngestionService,
      kisWebSocketClient,
      providerTargetResolver,
      marketCandleRetentionService,
      marketCandleSyncService,
      prisma,
      service: new OpsJobRunnerService(
        dailyPortfolioSnapshotJobService as never,
        seasonLifecycleTransitionJobService as never,
        seasonSettlementJobService as never,
        rankingRefreshService as never,
        exchangeRateIngestionService as never,
        koreaEximExchangeIngestionService as never,
        binancePriceIngestionService as never,
        kisRestCurrentPriceIngestionService as never,
        kisWebSocketClient as never,
        providerTargetResolver as never,
        marketCandleRetentionService as never,
        marketCandleSyncService as never,
        prisma as never,
        lockService as never,
        runService as never,
      ),
    };
  };

  it('runs provider FX ingestion through locked provider services', async () => {
    const {
      exchangeRateIngestionService,
      koreaEximExchangeIngestionService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_fx_ingest:usd_krw',
      ownerId: 'owner-fx',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-fx',
      startedAt,
    });
    koreaEximExchangeIngestionService.ingestUsdKrw.mockResolvedValueOnce({
      success: true,
      provider: 'korea_exim_exchange_rate',
      dryRun: false,
      created: 1,
      skipped: 0,
      wouldCreate: 0,
    });
    exchangeRateIngestionService.ingestUsdKrw.mockResolvedValueOnce({
      success: true,
      provider: 'exchange_rate_api',
      dryRun: false,
      created: 0,
      skipped: 1,
      wouldCreate: 0,
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_fx_ingest,
      }),
    });

    const response = await service.runProviderFxIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(koreaEximExchangeIngestionService.ingestUsdKrw).toHaveBeenCalledWith(
      {
        dryRun: false,
        requestedBy: 'scheduler',
      },
    );
    expect(exchangeRateIngestionService.ingestUsdKrw).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'scheduler',
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-fx',
        startedAt,
      },
      expect.objectContaining({
        resultJson: expect.objectContaining({
          state: 'completed',
          created: 1,
          skipped: 1,
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'provider_fx_ingest:usd_krw',
      ownerId: 'owner-fx',
    });
  });

  it('runs retention through the shared lock/run path and records its result', async () => {
    const { lockService, runService, marketCandleRetentionService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_retention:5m',
      ownerId: 'retention-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'retention-run',
      startedAt,
    });
    marketCandleRetentionService.run.mockResolvedValueOnce({
      cutoff: new Date('2026-06-06T00:00:00.000Z'),
      retentionDays: 35,
      deletedCount: 12,
      batchCount: 2,
      startedAt: new Date('2026-07-11T00:00:00.000Z'),
      finishedAt: new Date('2026-07-11T00:00:01.000Z'),
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.market_candle_retention,
      }),
    });

    await service.runMarketCandleRetentionJob({
      trigger: OpsJobTrigger.test,
      now: '2026-07-11T00:00:00.000Z',
    });
    expect(marketCandleRetentionService.run).toHaveBeenCalledWith(
      expect.objectContaining({ retentionDays: 35, batchSize: 5000 }),
    );
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultJson: expect.objectContaining({
          cutoff: '2026-06-06T00:00:00.000Z',
          deletedCount: 12,
          batchCount: 2,
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'market_candle_retention:5m',
      ownerId: 'retention-owner',
    });
  });

  it('does not call retention storage during a dry run', async () => {
    const { lockService, runService, marketCandleRetentionService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_retention:5m',
      ownerId: 'dry-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'dry-run',
      startedAt,
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.market_candle_retention,
      }),
    });
    await service.runMarketCandleRetentionJob({
      dryRun: true,
      now: '2026-07-11T00:00:00.000Z',
    });
    expect(marketCandleRetentionService.run).not.toHaveBeenCalled();
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultJson: expect.objectContaining({ dryRun: true, deletedCount: 0 }),
      }),
    );
  });

  it('releases the retention lock when creating the Ops run record fails', async () => {
    const { lockService, runService, service } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_retention:5m',
      ownerId: 'orphan-prevention-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockRejectedValueOnce(new Error('run DB failed'));
    await expect(service.runMarketCandleRetentionJob()).rejects.toThrow(
      'run DB failed',
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'market_candle_retention:5m',
      ownerId: 'orphan-prevention-owner',
    });
  });

  it('runs market candle sync through the shared lock/run path with parsed inputs', async () => {
    const { lockService, runService, marketCandleSyncService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_sync:manual',
      ownerId: 'sync-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'sync-run',
      startedAt,
    });
    marketCandleSyncService.syncAssets.mockResolvedValueOnce({
      mode: 'incremental',
      dryRun: false,
      requestedAssets: 1,
      processedAssets: 1,
      skippedAssets: [],
      assets: [],
      totalFeeds: 3,
      completedFeeds: 3,
      failedFeeds: 0,
      startedAt: new Date('2026-07-11T00:00:00.000Z'),
      finishedAt: new Date('2026-07-11T00:00:05.000Z'),
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({ jobName: OpsJobName.market_candle_sync }),
    });

    const response = await service.runMarketCandleSyncJob({
      trigger: OpsJobTrigger.test,
      assetTypes: ['crypto'],
      targets: ['5m', '1d'],
      mode: 'incremental',
      from: '2026-06-01T00:00:00.000Z',
      resume: true,
      continueOnError: true,
      maxAssets: 5,
    });
    expect(response.success).toBe(true);
    expect(marketCandleSyncService.syncAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        assetTypes: ['crypto'],
        targets: ['5m', '1d'],
        mode: 'incremental',
        from: new Date('2026-06-01T00:00:00.000Z'),
        resume: true,
        continueOnError: true,
        maxAssets: 5,
        dryRun: false,
      }),
    );
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultJson: expect.objectContaining({
          totalFeeds: 3,
          failedFeeds: 0,
          startedAt: '2026-07-11T00:00:00.000Z',
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'market_candle_sync:manual',
      ownerId: 'sync-owner',
    });
  });

  it('records a failed sync run when any feed failed', async () => {
    const { lockService, runService, marketCandleSyncService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_sync:manual',
      ownerId: 'sync-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'sync-run',
      startedAt,
    });
    marketCandleSyncService.syncAssets.mockResolvedValueOnce({
      mode: 'incremental',
      dryRun: false,
      requestedAssets: 1,
      processedAssets: 1,
      skippedAssets: [],
      assets: [],
      totalFeeds: 3,
      completedFeeds: 2,
      failedFeeds: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    runService.recordFailed.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.market_candle_sync,
        status: OpsJobRunStatus.failed,
      }),
    });

    const response = await service.runMarketCandleSyncJob({});
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(response.error.code).toBe('MARKET_CANDLE_SYNC_FAILED');
    }
    expect(runService.recordFailed).toHaveBeenCalled();
    expect(lockService.releaseLock).toHaveBeenCalled();
  });

  it('plans a market candle sync dry run without executing the real sync', async () => {
    const { lockService, runService, marketCandleSyncService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'market_candle_sync:manual',
      ownerId: 'dry-owner',
      expiresAt: new Date('2026-07-11T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'dry-run',
      startedAt,
    });
    marketCandleSyncService.syncAssets.mockResolvedValueOnce({
      mode: 'incremental',
      dryRun: true,
      requestedAssets: 2,
      processedAssets: 2,
      skippedAssets: [],
      assets: [],
      totalFeeds: 6,
      completedFeeds: 0,
      failedFeeds: 0,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({ jobName: OpsJobName.market_candle_sync }),
    });

    await service.runMarketCandleSyncJob({ dryRun: true });
    // Exactly one call, and it is the dryRun planning call.
    expect(marketCandleSyncService.syncAssets).toHaveBeenCalledTimes(1);
    expect(marketCandleSyncService.syncAssets).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        resultJson: expect.objectContaining({ dryRun: true }),
      }),
    );
  });

  it('rejects invalid market candle sync inputs before touching the lock', async () => {
    const { lockService, marketCandleSyncService, service } = createService();
    await expect(
      service.runMarketCandleSyncJob({ targets: ['1m'] }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'MARKET_CANDLE_SYNC_INVALID_INPUT',
        }),
      }),
    });
    await expect(
      service.runMarketCandleSyncJob({ mode: 'bogus' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'MARKET_CANDLE_SYNC_INVALID_INPUT',
        }),
      }),
    });
    await expect(
      service.runMarketCandleSyncJob({ from: 'not-a-date' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        error: expect.objectContaining({
          code: 'MARKET_CANDLE_SYNC_INVALID_INPUT',
        }),
      }),
    });
    expect(lockService.acquireLock).not.toHaveBeenCalled();
    expect(marketCandleSyncService.syncAssets).not.toHaveBeenCalled();
  });

  it('runs provider Binance ingestion through the locked provider service', async () => {
    const { binancePriceIngestionService, lockService, runService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_binance_ingest:prices',
      ownerId: 'owner-binance',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-binance',
      startedAt,
    });
    binancePriceIngestionService.ingestPrices.mockResolvedValueOnce({
      success: true,
      provider: 'binance',
      dryRun: false,
      created: 2,
      skipped: 0,
      wouldCreate: 0,
      failed: 0,
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_binance_ingest,
      }),
    });

    const response = await service.runProviderBinanceIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(binancePriceIngestionService.ingestPrices).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'scheduler',
      symbols: ['BTCUSDT', 'ETHUSDT'],
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-binance',
        startedAt,
      },
      expect.objectContaining({
        resultJson: expect.objectContaining({
          state: 'completed',
          created: 2,
          failed: 0,
          targetSummary: expect.objectContaining({
            targetSource: 'merged',
            binanceSymbolCount: 2,
          }),
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'provider_binance_ingest:prices',
      ownerId: 'owner-binance',
    });
  });

  it('records provider Binance job as succeeded with no_targets when no symbols resolve', async () => {
    const {
      binancePriceIngestionService,
      lockService,
      providerTargetResolver,
      runService,
      service,
    } = createService();
    providerTargetResolver.resolveProviderTargets.mockResolvedValueOnce({
      targetSource: 'active_assets',
      activeAssetCount: 0,
      binanceSymbols: [],
      kisDomesticSymbols: [],
      kisUsSymbols: [],
      unsupportedAssets: [],
    });
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_binance_ingest:prices',
      ownerId: 'owner-binance',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-binance',
      startedAt,
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_binance_ingest,
      }),
    });

    const response = await service.runProviderBinanceIngestJob({
      trigger: OpsJobTrigger.test,
      targetSource: 'active_assets',
    });

    expect(response.success).toBe(true);
    expect(binancePriceIngestionService.ingestPrices).not.toHaveBeenCalled();
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-binance',
        startedAt,
      },
      expect.objectContaining({
        resultJson: expect.objectContaining({
          state: 'no_targets',
          reason: 'NO_PROVIDER_TARGET',
          targetSummary: expect.objectContaining({
            targetSource: 'active_assets',
            binanceSymbolCount: 0,
          }),
        }),
      }),
    );
  });

  it('runs provider KIS REST current price ingestion with maxSnapshots through the locked provider service', async () => {
    const {
      kisRestCurrentPriceIngestionService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_kis_ingest:rest_current_price',
      ownerId: 'owner-kis',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-kis',
      startedAt,
    });
    kisRestCurrentPriceIngestionService.ingestCurrentPrices.mockResolvedValueOnce(
      {
        success: true,
        provider: 'kis',
        ingestion: 'rest_current_price',
        dryRun: false,
        received: 3,
        created: 2,
        skipped: 1,
        wouldCreate: 0,
        failed: 0,
        snapshots: [],
      },
    );
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_kis_ingest,
      }),
    });

    const response = await service.runProviderKisRestCurrentPriceIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
      maxSnapshots: 10,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(
      kisRestCurrentPriceIngestionService.ingestCurrentPrices,
    ).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'scheduler',
      domesticSymbols: ['005930'],
      usSymbols: ['AAPL'],
      maxSnapshots: 10,
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-kis',
        startedAt,
      },
      expect.objectContaining({
        resultJson: expect.objectContaining({
          state: 'completed',
          created: 2,
          failed: 0,
          targetSummary: expect.objectContaining({
            kisDomesticSymbolCount: 1,
            kisUsSymbolCount: 1,
          }),
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'provider_kis_ingest:rest_current_price',
      ownerId: 'owner-kis',
    });
  });

  it('runs provider KIS WebSocket trade ingestion by default through the locked provider service', async () => {
    const {
      kisRestCurrentPriceIngestionService,
      kisWebSocketClient,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_kis_ingest:websocket_trade',
      ownerId: 'owner-kis-ws',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-kis-ws',
      startedAt,
    });
    kisWebSocketClient.runTradePriceIngestion.mockResolvedValueOnce({
      success: true,
      provider: 'kis',
      dryRun: false,
      durationMs: 30000,
      subscriptions: {
        requested: 2,
        sent: 2,
        skipped: [],
      },
      receivedFrames: 5,
      acknowledged: 2,
      created: 2,
      skipped: 1,
      wouldCreate: 0,
      failed: 0,
      snapshots: [],
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_kis_ingest,
      }),
    });

    const response = await service.runProviderKisIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
      maxSnapshots: 10,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(
      kisRestCurrentPriceIngestionService.ingestCurrentPrices,
    ).not.toHaveBeenCalled();
    expect(kisWebSocketClient.runTradePriceIngestion).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'scheduler',
      domesticSymbols: ['005930'],
      usSymbols: ['AAPL'],
      maxSnapshots: 10,
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-kis-ws',
        startedAt,
      },
      expect.objectContaining({
        resultJson: expect.objectContaining({
          state: 'completed',
          ingestionMode: 'websocket_trade',
          subscriptions: expect.objectContaining({
            sent: 2,
          }),
          receivedFrames: 5,
          created: 2,
          failed: 0,
          targetSummary: expect.objectContaining({
            kisDomesticSymbolCount: 1,
            kisUsSymbolCount: 1,
          }),
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'provider_kis_ingest:websocket_trade',
      ownerId: 'owner-kis-ws',
    });
  });

  it('keeps provider KIS REST current price available through explicit ingestion mode', async () => {
    const {
      kisRestCurrentPriceIngestionService,
      kisWebSocketClient,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_kis_ingest:rest_current_price',
      ownerId: 'owner-kis-rest',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-kis-rest',
      startedAt,
    });
    kisRestCurrentPriceIngestionService.ingestCurrentPrices.mockResolvedValueOnce(
      {
        success: true,
        provider: 'kis',
        ingestion: 'rest_current_price',
        dryRun: false,
        received: 1,
        created: 1,
        skipped: 0,
        wouldCreate: 0,
        failed: 0,
        snapshots: [],
      },
    );
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_kis_ingest,
      }),
    });

    await service.runProviderKisIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
      kisPriceIngestionMode: 'rest_current_price',
    });

    expect(kisWebSocketClient.runTradePriceIngestion).not.toHaveBeenCalled();
    expect(
      kisRestCurrentPriceIngestionService.ingestCurrentPrices,
    ).toHaveBeenCalledWith({
      dryRun: false,
      requestedBy: 'scheduler',
      domesticSymbols: ['005930'],
      usSymbols: ['AAPL'],
      maxSnapshots: undefined,
    });
  });

  it('records provider KIS WebSocket failures with provider error details', async () => {
    const { kisWebSocketClient, lockService, runService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_kis_ingest:websocket_trade',
      ownerId: 'owner-kis-ws',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-kis-ws',
      startedAt,
    });
    kisWebSocketClient.runTradePriceIngestion.mockResolvedValueOnce({
      success: false,
      provider: 'kis',
      dryRun: false,
      durationMs: 30000,
      subscriptions: {
        requested: 0,
        sent: 0,
        skipped: [],
      },
      receivedFrames: 0,
      acknowledged: 0,
      created: 0,
      skipped: 0,
      wouldCreate: 0,
      failed: 1,
      snapshots: [],
      errorCode: 'KIS_WS_BASE_URL_MISSING',
      errorMessage: 'KIS_WS_BASE_URL is required for KIS WebSocket ingestion.',
    });
    runService.recordFailed.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_kis_ingest,
        status: OpsJobRunStatus.failed,
      }),
    });

    const response = await service.runProviderKisWebSocketTradeIngestJob({
      trigger: OpsJobTrigger.test,
      requestedBy: 'scheduler',
    });

    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'PROVIDER_KIS_INGEST_FAILED',
      },
    });
    expect(runService.recordFailed).toHaveBeenCalledWith(
      {
        id: 'run-kis-ws',
        startedAt,
      },
      expect.objectContaining({
        errorCode: 'PROVIDER_KIS_INGEST_FAILED',
        errorMessage: 'Provider KIS WebSocket trade ingestion failed.',
        resultJson: expect.objectContaining({
          state: 'failed',
          ingestionMode: 'websocket_trade',
          errorCode: 'KIS_WS_BASE_URL_MISSING',
          failed: 1,
        }),
      }),
    );
  });

  it('records provider KIS failures as failed ops job runs', async () => {
    const {
      kisRestCurrentPriceIngestionService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'provider_kis_ingest:rest_current_price',
      ownerId: 'owner-kis',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-kis',
      startedAt,
    });
    kisRestCurrentPriceIngestionService.ingestCurrentPrices.mockResolvedValueOnce(
      {
        success: false,
        provider: 'kis',
        ingestion: 'rest_current_price',
        dryRun: false,
        received: 0,
        created: 0,
        skipped: 0,
        wouldCreate: 0,
        failed: 1,
        snapshots: [],
        errorCode: 'PROVIDER_DISABLED',
        errorMessage: 'KIS provider is disabled.',
      },
    );
    runService.recordFailed.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.provider_kis_ingest,
        status: OpsJobRunStatus.failed,
      }),
    });

    const response = await service.runProviderKisRestCurrentPriceIngestJob({
      trigger: OpsJobTrigger.test,
    });

    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'PROVIDER_KIS_INGEST_FAILED',
      },
      data: {
        run: {
          status: OpsJobRunStatus.failed,
        },
      },
    });
    expect(runService.recordFailed).toHaveBeenCalledWith(
      {
        id: 'run-kis',
        startedAt,
      },
      expect.objectContaining({
        errorCode: 'PROVIDER_KIS_INGEST_FAILED',
        errorMessage: 'Provider KIS REST current price ingestion failed.',
        resultJson: expect.objectContaining({
          state: 'failed',
          failed: 1,
        }),
      }),
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'provider_kis_ingest:rest_current_price',
      ownerId: 'owner-kis',
    });
  });

  it('keeps reward_marker as skipped/NOT_IMPLEMENTED instead of fake success', async () => {
    const { dailyPortfolioSnapshotJobService, runService, service } =
      createService();
    runService.recordSkipped.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.reward_marker,
        status: OpsJobRunStatus.skipped,
        resultJson: {
          reason: 'NOT_IMPLEMENTED',
        },
      }),
    });

    const response = await service.runRewardMarkerJob({
      trigger: OpsJobTrigger.test,
      dryRun: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        skipped: true,
        run: {
          status: OpsJobRunStatus.skipped,
          resultJson: {
            reason: 'NOT_IMPLEMENTED',
          },
        },
      },
    });
    expect(runService.recordSkipped).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: OpsJobName.reward_marker,
        dryRun: true,
        resultJson: expect.objectContaining({
          reason: 'NOT_IMPLEMENTED',
        }),
      }),
    );
    expect(runService.createRunning).not.toHaveBeenCalled();
    expect(dailyPortfolioSnapshotJobService.run).not.toHaveBeenCalled();
  });

  it('runs daily snapshot through the existing batch service and releases lock', async () => {
    const {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: 'owner-1',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-1',
      startedAt,
    });
    dailyPortfolioSnapshotJobService.run.mockResolvedValueOnce({
      success: true,
      data: {
        run: {
          id: 'batch-run-1',
          status: 'succeeded',
          dryRun: true,
          resultPayloadJson: {
            sourceSummary: {
              providerApiUsed: true,
            },
          },
        },
        deduplicated: false,
        skipped: false,
      },
    });
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun(),
    });

    const response = await service.runDailyPortfolioSnapshotJob({
      trigger: OpsJobTrigger.test,
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
      lockTtlSeconds: 600,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: false,
        skipped: false,
      },
    });
    expect(dailyPortfolioSnapshotJobService.run).toHaveBeenCalledWith({
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
      requestedBy: undefined,
    });
    expect(runService.recordSucceeded).toHaveBeenCalledWith(
      {
        id: 'run-1',
        startedAt,
      },
      {
        resultJson: expect.objectContaining({
          batchRunId: 'batch-run-1',
          resultPayloadJson: {
            sourceSummary: {
              providerApiUsed: true,
            },
          },
        }),
      },
    );
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: 'owner-1',
    });
  });

  it('records locked run when daily snapshot lock is active', async () => {
    const {
      dailyPortfolioSnapshotJobService,
      lockService,
      runService,
      service,
    } = createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: false,
      lockKey: 'daily_portfolio_snapshot:season-1:2026-06-08',
      ownerId: null,
      activeOwnerId: 'owner-active',
      expiresAt: new Date('2026-06-08T00:10:00.000Z'),
    });
    runService.recordLocked.mockResolvedValueOnce({
      serialized: serializedRun({
        status: OpsJobRunStatus.locked,
      }),
    });

    const response = await service.runDailyPortfolioSnapshotJob({
      trigger: OpsJobTrigger.test,
      seasonId: 'season-1',
      snapshotDate: '2026-06-08',
      dryRun: true,
    });

    expect(response).toMatchObject({
      success: true,
      data: {
        locked: true,
        skipped: true,
      },
    });
    expect(dailyPortfolioSnapshotJobService.run).not.toHaveBeenCalled();
    expect(runService.recordLocked).toHaveBeenCalledWith(
      expect.objectContaining({
        resultJson: expect.objectContaining({
          reason: 'LOCKED',
          activeOwnerId: 'owner-active',
        }),
      }),
    );
  });

  it('runs current ranking refresh with explicit scheduled equity snapshot flag', async () => {
    const { lockService, rankingRefreshService, runService, service } =
      createService();
    lockService.acquireLock.mockResolvedValueOnce({
      acquired: true,
      lockKey: 'season_ranking_generation:current',
      ownerId: 'owner-ranking',
      expiresAt: new Date('2026-06-08T00:11:00.000Z'),
    });
    runService.createRunning.mockResolvedValueOnce({
      id: 'run-ranking',
      startedAt,
    });
    rankingRefreshService.refreshCurrentRankingsForActiveSeasons.mockResolvedValueOnce(
      {
        seasonsProcessed: 1,
      },
    );
    runService.recordSucceeded.mockResolvedValueOnce({
      serialized: serializedRun({
        jobName: OpsJobName.season_ranking_generation,
      }),
    });

    await service.runSeasonRankingGenerationJob({
      trigger: OpsJobTrigger.scheduler,
      now: '2026-06-08T00:05:00.000Z',
      createEquitySnapshots: true,
    });

    expect(
      rankingRefreshService.refreshCurrentRankingsForActiveSeasons,
    ).toHaveBeenCalledWith(new Date('2026-06-08T00:05:00.000Z'), {
      createEquitySnapshots: true,
    });
    expect(lockService.releaseLock).toHaveBeenCalledWith({
      lockKey: 'season_ranking_generation:current',
      ownerId: 'owner-ranking',
    });
  });
});
