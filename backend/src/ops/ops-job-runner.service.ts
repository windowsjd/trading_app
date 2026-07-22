import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
} from '@nestjs/common';
import {
  OpsJobName,
  OpsJobRun,
  OpsJobTrigger,
  SeasonStatus,
} from '../generated/prisma/client';
import { DailyPortfolioSnapshotJobService } from '../batch/daily-portfolio-snapshot-job.service';
import { SeasonLifecycleTransitionJobService } from '../batch/season-lifecycle-transition-job.service';
import { SeasonSettlementJobService } from '../batch/season-settlement-job.service';
import { SEASON_SETTLEMENT_JOB_NAME } from '../batch/season-settlement-job.types';
import { BinancePriceIngestionService } from '../providers/binance/binance-price.ingestion.service';
import { ExchangeRateIngestionService } from '../providers/exchange-rate/exchange-rate.ingestion.service';
import { KisRestCurrentPriceIngestionService } from '../providers/kis/kis-rest-current-price.ingestion.service';
import { KisWebSocketClient } from '../providers/kis/kis-websocket.client';
import { KoreaEximExchangeIngestionService } from '../providers/korea-exim/korea-exim-exchange.ingestion.service';
import {
  ProviderTargetResolverService,
  type ProviderTargetSource,
  type ProviderTargets,
} from '../providers/provider-target-resolver.service';
import { RankingRefreshService } from '../ranking/ranking-refresh.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  getOpsSchedulerConfig,
  type KisPriceIngestionMode,
} from './ops-config';
import { OpsJobLockService } from './ops-job-lock.service';
import { OpsJobRunService, SerializedOpsJobRun } from './ops-job-run.service';
import { MarketCandleRetentionService } from '../assets/market-candle-retention.service';
import { readMarketCandleRetentionConfig } from '../assets/market-candle-retention.config';
import { MarketCandleSyncService } from '../assets/market-candle-sync.service';
import {
  MARKET_CANDLE_SYNC_FEEDS,
  MarketCandleSyncInputError,
  type MarketCandleFeed,
  type MarketCandleSyncSummary,
} from '../assets/market-candle-sync.types';
import { AssetType, MarketCandleSyncMode } from '../generated/prisma/client';
import {
  MarketCandleReconciliationService,
  type MarketCandleReconciliationInput,
  type ReconciliationMarket,
} from '../assets/market-candle-reconciliation.service';
import { resolveStockMarketSessionState } from '../orders/market-calendar.policy';
import { LimitOrderCandleReconciliationService } from '../orders/limit-matching/limit-order-candle-reconciliation.service';

export type OpsJobRunnerResponse =
  | {
      success: true;
      data: {
        run: SerializedOpsJobRun;
        locked: boolean;
        skipped: boolean;
      };
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
      };
      data: {
        run: SerializedOpsJobRun;
      };
    };

export type OpsJobRunnerInput = {
  trigger?: OpsJobTrigger;
  requestedBy?: string | null;
  dryRun?: boolean;
  idempotencyKey?: string | null;
  metadataJson?: unknown;
  lockTtlSeconds?: number;
  maxAttempts?: number;
  maxSnapshots?: number;
  targetSource?: ProviderTargetSource;
  kisPriceIngestionMode?: KisPriceIngestionMode;
  now?: string | null;
};

export type DailySnapshotOpsJobInput = OpsJobRunnerInput & {
  seasonId?: string | null;
  snapshotDate?: string | null;
};

export type TimedOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  createEquitySnapshots?: boolean;
};

export type MarketCandleRetentionOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  retentionDays?: number;
  batchSize?: number;
};

export type LimitOrderCandleReconciliationOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  lookbackMs?: number;
  candleBatchSize?: number;
  orderBatchSize?: number;
};

export type MarketCandleSyncOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  assetIds?: string[];
  assetTypes?: string[];
  targets?: string[];
  mode?: string;
  from?: string | null;
  to?: string | null;
  resume?: boolean;
  continueOnError?: boolean;
  maxAssets?: number;
};

export type MarketCandleReconciliationOpsJobInput = OpsJobRunnerInput & {
  now?: string | null;
  assetIds?: string[];
  assetTypes?: string[];
  market?: string;
  from?: string | null;
  to?: string | null;
  targets?: string[];
  maxAssets?: number;
  maxPages?: number;
  continueOnError?: boolean;
};

type ParsedMarketCandleSyncInput = {
  assetIds?: string[];
  assetTypes?: AssetType[];
  targets?: MarketCandleFeed[];
  mode?: MarketCandleSyncMode;
  from?: Date;
  to?: Date;
  resume?: boolean;
  continueOnError?: boolean;
  maxAssets?: number;
  now?: Date;
};

@Injectable()
export class OpsJobRunnerService {
  constructor(
    private readonly dailyPortfolioSnapshotJobService: DailyPortfolioSnapshotJobService,
    private readonly seasonLifecycleTransitionJobService: SeasonLifecycleTransitionJobService,
    private readonly seasonSettlementJobService: SeasonSettlementJobService,
    private readonly rankingRefreshService: RankingRefreshService,
    private readonly exchangeRateIngestionService: ExchangeRateIngestionService,
    private readonly koreaEximExchangeIngestionService: KoreaEximExchangeIngestionService,
    private readonly binancePriceIngestionService: BinancePriceIngestionService,
    private readonly kisRestCurrentPriceIngestionService: KisRestCurrentPriceIngestionService,
    private readonly kisWebSocketClient: KisWebSocketClient,
    private readonly providerTargetResolver: ProviderTargetResolverService,
    private readonly marketCandleRetentionService: MarketCandleRetentionService,
    private readonly marketCandleSyncService: MarketCandleSyncService,
    private readonly prisma: PrismaService,
    private readonly lockService: OpsJobLockService,
    private readonly runService: OpsJobRunService,
    @Optional()
    private readonly marketCandleReconciliationService?: MarketCandleReconciliationService,
    @Optional()
    private readonly limitOrderCandleReconciliationService?: LimitOrderCandleReconciliationService,
  ) {}

  /**
   * Path-B safety net: sweep confirmed 5m candles for limit buys whose price
   * was touched but whose live trade event never reached the Redis Stream.
   * Runs on the ordinary 60s Ops tick under the shared OpsJobLock — a 5m
   * safety net has no need for a dedicated sub-second loop.
   */
  runLimitOrderCandleReconciliationJob(
    input: LimitOrderCandleReconciliationOpsJobInput = {},
  ) {
    const service = this.limitOrderCandleReconciliationService;
    if (!service) {
      throw new Error(
        'Limit-order candle reconciliation service is unavailable.',
      );
    }
    const now = this.parseOptionalDate(input.now) ?? new Date();
    return this.runLockedOpsJob(
      OpsJobName.limit_order_candle_reconciliation,
      input,
      'limit_order_candle_reconciliation:5m',
      async () => ({
        ...(await service.reconcile({
          now,
          lookbackMs: input.lookbackMs,
          candleBatchSize: input.candleBatchSize,
          orderBatchSize: input.orderBatchSize,
        })),
      }),
      {
        renewLock: true,
        dryRunResult: { dryRun: true, now: now.toISOString() },
      },
    );
  }

  runProviderFxIngestJob(input: OpsJobRunnerInput = {}) {
    return this.runLockedOpsJob(
      OpsJobName.provider_fx_ingest,
      input,
      'provider_fx_ingest:usd_krw',
      async () => {
        const koreaExim =
          await this.koreaEximExchangeIngestionService.ingestUsdKrw({
            dryRun: false,
            requestedBy: input.requestedBy ?? undefined,
          });
        const exchangeRate =
          await this.exchangeRateIngestionService.ingestUsdKrw({
            dryRun: false,
            requestedBy: input.requestedBy ?? undefined,
          });

        const result = {
          state:
            koreaExim.success || exchangeRate.success ? 'completed' : 'failed',
          providers: [koreaExim, exchangeRate],
          created: koreaExim.created + exchangeRate.created,
          skipped: koreaExim.skipped + exchangeRate.skipped,
          wouldCreate: koreaExim.wouldCreate + exchangeRate.wouldCreate,
        };

        if (result.state === 'failed') {
          this.throwProviderJobFailed(
            'PROVIDER_FX_INGEST_FAILED',
            'Provider FX ingestion failed.',
            result,
          );
        }

        return result;
      },
    );
  }

  runProviderBinanceIngestJob(input: OpsJobRunnerInput = {}) {
    return this.runLockedOpsJob(
      OpsJobName.provider_binance_ingest,
      input,
      'provider_binance_ingest:prices',
      async () => {
        const targets =
          await this.providerTargetResolver.resolveProviderTargets({
            targetSource: input.targetSource,
          });
        if (targets.binanceSymbols.length === 0) {
          return {
            state: 'no_targets',
            provider: 'binance',
            targetSummary: this.buildTargetSummary(targets),
            created: 0,
            skipped: 0,
            wouldCreate: 0,
            failed: 0,
            reason: 'NO_PROVIDER_TARGET',
          };
        }

        const result = await this.binancePriceIngestionService.ingestPrices({
          dryRun: false,
          requestedBy: input.requestedBy ?? undefined,
          symbols: targets.binanceSymbols,
        });

        const response = {
          state: result.success ? 'completed' : 'failed',
          provider: result,
          targetSummary: this.buildTargetSummary(targets),
          created: result.created,
          skipped: result.skipped,
          wouldCreate: result.wouldCreate,
          failed: result.failed,
        };

        if (response.state === 'failed') {
          this.throwProviderJobFailed(
            'PROVIDER_BINANCE_INGEST_FAILED',
            'Provider Binance ingestion failed.',
            response,
          );
        }

        return response;
      },
    );
  }

  runProviderKisIngestJob(input: OpsJobRunnerInput = {}) {
    const mode =
      input.kisPriceIngestionMode ??
      getOpsSchedulerConfig().providerKisPriceIngestionMode;

    return mode === 'rest_current_price'
      ? this.runProviderKisRestCurrentPriceIngestJob(input)
      : this.runProviderKisWebSocketTradeIngestJob(input);
  }

  runProviderKisRestCurrentPriceIngestJob(input: OpsJobRunnerInput = {}) {
    return this.runLockedOpsJob(
      OpsJobName.provider_kis_ingest,
      input,
      'provider_kis_ingest:rest_current_price',
      async () => {
        const targets =
          await this.providerTargetResolver.resolveProviderTargets({
            targetSource: input.targetSource,
          });
        const marketPlan = this.buildKisMarketCollectionPlan(
          targets,
          this.parseOptionalDate(input.now) ?? new Date(),
        );
        if (
          marketPlan.targets.kisDomesticSymbols.length === 0 &&
          marketPlan.targets.kisUsSymbols.length === 0
        ) {
          const noConfiguredTargets =
            targets.kisDomesticSymbols.length === 0 &&
            targets.kisUsSymbols.length === 0;
          return {
            state: noConfiguredTargets
              ? 'no_targets'
              : marketPlan.calendarUnavailable
                ? 'degraded'
                : 'no_data',
            provider: 'kis',
            targetSummary: this.buildTargetSummary(targets),
            created: 0,
            skipped: 0,
            wouldCreate: 0,
            failed: 0,
            reason: noConfiguredTargets
              ? 'NO_PROVIDER_TARGET'
              : marketPlan.calendarUnavailable
                ? 'MARKET_CALENDAR_COVERAGE_MISSING'
                : 'MARKET_CLOSED_EXPECTED_NO_DATA',
          };
        }

        const result =
          await this.kisRestCurrentPriceIngestionService.ingestCurrentPrices({
            dryRun: false,
            requestedBy: input.requestedBy ?? undefined,
            domesticSymbols: marketPlan.targets.kisDomesticSymbols,
            usSymbols: marketPlan.targets.kisUsSymbols,
            maxSnapshots: input.maxSnapshots,
          });

        const response = {
          state: result.success ? 'completed' : 'failed',
          provider: result,
          targetSummary: this.buildTargetSummary(targets),
          created: result.created,
          skipped: result.skipped,
          wouldCreate: result.wouldCreate,
          failed: result.failed,
        };

        if (response.state === 'failed') {
          this.throwProviderJobFailed(
            'PROVIDER_KIS_INGEST_FAILED',
            'Provider KIS REST current price ingestion failed.',
            response,
          );
        }

        return response;
      },
    );
  }

  runProviderKisWebSocketTradeIngestJob(input: OpsJobRunnerInput = {}) {
    return this.runLockedOpsJob(
      OpsJobName.provider_kis_ingest,
      input,
      'provider_kis_ingest:websocket_trade',
      async () => {
        const targets =
          await this.providerTargetResolver.resolveProviderTargets({
            targetSource: input.targetSource,
          });
        const marketPlan = this.buildKisMarketCollectionPlan(
          targets,
          this.parseOptionalDate(input.now) ?? new Date(),
        );
        if (
          marketPlan.targets.kisDomesticSymbols.length === 0 &&
          marketPlan.targets.kisUsSymbols.length === 0
        ) {
          const noConfiguredTargets =
            targets.kisDomesticSymbols.length === 0 &&
            targets.kisUsSymbols.length === 0;
          return {
            state: noConfiguredTargets
              ? 'no_targets'
              : marketPlan.calendarUnavailable
                ? 'degraded'
                : 'no_data',
            provider: 'kis',
            ingestionMode: 'websocket_trade',
            targetSummary: this.buildTargetSummary(targets),
            created: 0,
            skipped: 0,
            wouldCreate: 0,
            failed: 0,
            reason: noConfiguredTargets
              ? 'NO_PROVIDER_TARGET'
              : marketPlan.calendarUnavailable
                ? 'MARKET_CALENDAR_COVERAGE_MISSING'
                : 'MARKET_CLOSED_EXPECTED_NO_DATA',
          };
        }

        const result = await this.kisWebSocketClient.runTradePriceIngestion({
          dryRun: false,
          requestedBy: input.requestedBy ?? undefined,
          domesticSymbols: marketPlan.targets.kisDomesticSymbols,
          usSymbols: marketPlan.targets.kisUsSymbols,
          maxSnapshots: input.maxSnapshots,
        });

        const response = {
          state: result.success
            ? result.receivedFrames === 0
              ? 'no_data'
              : 'completed'
            : 'failed',
          provider: result,
          ingestionMode: 'websocket_trade',
          targetSummary: this.buildTargetSummary(targets),
          subscriptions: result.subscriptions,
          receivedFrames: result.receivedFrames,
          acknowledged: result.acknowledged,
          created: result.created,
          skipped: result.skipped,
          wouldCreate: result.wouldCreate,
          failed: result.failed,
          reason:
            result.success && result.receivedFrames === 0
              ? 'NO_WEBSOCKET_FRAMES_RECEIVED'
              : undefined,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage,
        };

        if (response.state === 'failed') {
          this.throwProviderJobFailed(
            'PROVIDER_KIS_INGEST_FAILED',
            'Provider KIS WebSocket trade ingestion failed.',
            response,
          );
        }

        return response;
      },
    );
  }

  runSeasonRankingGenerationJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_ranking_generation,
      input,
      'season_ranking_generation:current',
      async () =>
        this.rankingRefreshService.refreshCurrentRankingsForActiveSeasons(now, {
          createEquitySnapshots: input.createEquitySnapshots === true,
        }),
    );
  }

  runSeasonLifecycleTransitionJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_lifecycle_transition,
      input,
      'season_lifecycle_transition:current',
      async () =>
        this.seasonLifecycleTransitionJobService.run({
          now: now.toISOString(),
          dryRun: input.dryRun === true,
          requestedBy: input.requestedBy ?? undefined,
          idempotencyKey:
            input.idempotencyKey ??
            `season-lifecycle-transition:${now.toISOString()}`,
        }),
    );
  }

  runSeasonSettlementJob(input: TimedOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();

    return this.runLockedOpsJob(
      OpsJobName.season_settlement,
      input,
      'season_settlement:ended',
      async () => {
        const seasons = await this.prisma.season.findMany({
          where: {
            status: SeasonStatus.ended,
          },
          orderBy: [{ endAt: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            endAt: true,
          },
        });
        const settled: Array<{
          seasonId: string;
          settlementDate: string;
          batchRunId: string;
          batchStatus: string;
        }> = [];

        for (const season of seasons) {
          const settlementDate = this.formatDateOnly(season.endAt);
          const batchResponse = await this.seasonSettlementJobService.run({
            seasonId: season.id,
            settlementDate,
            dryRun: input.dryRun === true,
            requestedBy: input.requestedBy ?? undefined,
            idempotencyKey: `${SEASON_SETTLEMENT_JOB_NAME}:${season.id}:${settlementDate}:${now.toISOString()}`,
          });
          settled.push({
            seasonId: season.id,
            settlementDate,
            batchRunId: batchResponse.data.run.id,
            batchStatus: batchResponse.data.run.status,
          });
        }

        return {
          seasonsProcessed: seasons.length,
          settled,
        };
      },
    );
  }

  runRewardMarkerJob(input: OpsJobRunnerInput = {}) {
    return this.recordNotImplemented(
      OpsJobName.reward_marker,
      input,
      'Scheduler-driven reward marker automation is not implemented in this gate.',
    );
  }

  runMarketCandleRetentionJob(input: MarketCandleRetentionOpsJobInput = {}) {
    const now = this.parseOptionalDate(input.now) ?? new Date();
    const config = readMarketCandleRetentionConfig();
    const validated = readMarketCandleRetentionConfig({
      MARKET_CANDLE_5M_RETENTION_DAYS: String(
        input.retentionDays ?? config.retentionDays,
      ),
      MARKET_CANDLE_RETENTION_BATCH_SIZE: String(
        input.batchSize ?? config.batchSize,
      ),
    });
    const retentionDays = validated.retentionDays;
    const batchSize = validated.batchSize;
    const cutoff = new Date(
      now.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    );
    return this.runLockedOpsJob(
      OpsJobName.market_candle_retention,
      input,
      'market_candle_retention:5m',
      async (context) => {
        const result = await this.marketCandleRetentionService.run({
          now,
          retentionDays,
          batchSize,
          isLockOwned: context.isLockOwned,
        });
        return {
          cutoff: result.cutoff.toISOString(),
          retentionDays: result.retentionDays,
          deletedCount: result.deletedCount,
          batchCount: result.batchCount,
          startedAt: result.startedAt.toISOString(),
          finishedAt: result.finishedAt.toISOString(),
        };
      },
      {
        renewLock: true,
        dryRunResult: {
          cutoff: cutoff.toISOString(),
          retentionDays,
          deletedCount: 0,
          batchCount: 0,
          dryRun: true,
        },
      },
    );
  }

  /**
   * Manual/operator execution path for checkpointed candle sync
   * (initial/incremental/repair of the persisted 5m/1d/1w feeds). No
   * scheduler triggers this job in this phase. The job-level Ops DB lock
   * serializes whole runs; per-asset/feed mutual exclusion is enforced
   * inside MarketCandleSyncService with Redis backfill locks.
   */
  async runMarketCandleSyncJob(
    input: MarketCandleSyncOpsJobInput = {},
  ): Promise<OpsJobRunnerResponse> {
    let syncInput: ParsedMarketCandleSyncInput = {};
    let dryRunResult: Record<string, unknown> | undefined;
    try {
      syncInput = this.parseMarketCandleSyncInput(input);
      // runLockedOpsJob short-circuits dryRun before the handler, so the plan
      // (no provider calls, no candle/checkpoint writes) is computed here.
      if (input.dryRun === true) {
        dryRunResult = this.serializeMarketCandleSyncSummary(
          await this.marketCandleSyncService.syncAssets({
            ...syncInput,
            dryRun: true,
          }),
        );
      }
    } catch (error) {
      if (error instanceof MarketCandleSyncInputError) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'MARKET_CANDLE_SYNC_INVALID_INPUT',
              message: error.message,
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      throw error;
    }

    return this.runLockedOpsJob(
      OpsJobName.market_candle_sync,
      input,
      'market_candle_sync:manual',
      async () => {
        const summary = await this.marketCandleSyncService.syncAssets({
          ...syncInput,
          dryRun: false,
        });
        const serialized = this.serializeMarketCandleSyncSummary(summary);
        if (summary.failedFeeds > 0) {
          this.throwProviderJobFailed(
            'MARKET_CANDLE_SYNC_FAILED',
            'Market candle sync finished with failed feeds.',
            serialized,
          );
        }
        return serialized;
      },
      { renewLock: true, dryRunResult },
    );
  }

  async runMarketCandleReconciliationJob(
    input: MarketCandleReconciliationOpsJobInput = {},
  ): Promise<OpsJobRunnerResponse> {
    if (!this.marketCandleReconciliationService) {
      throw new Error('Market candle reconciliation service is unavailable.');
    }
    const parsed = this.parseMarketCandleReconciliationInput(input);
    const market = parsed.market ?? 'ALL';
    const jobInput: OpsJobRunnerInput = {
      ...input,
      metadataJson:
        input.metadataJson ?? ({ reconciliationMarket: market } as const),
    };
    const dryRunResult =
      input.dryRun === true
        ? serializeJson(
            await this.marketCandleReconciliationService.reconcile({
              ...parsed,
              dryRun: true,
            }),
          )
        : undefined;
    return this.runLockedOpsJob(
      OpsJobName.market_candle_reconciliation,
      jobInput,
      `market_candle_reconciliation:${market.toLowerCase()}`,
      async () => {
        const summary = await this.marketCandleReconciliationService?.reconcile(
          {
            ...parsed,
            dryRun: false,
          },
        );
        if (!summary) throw new Error('Reconciliation service disappeared.');
        const serialized = serializeJson(summary);
        if (summary.failedAssets > 0) {
          this.throwProviderJobFailed(
            'MARKET_CANDLE_RECONCILIATION_FAILED',
            'Market candle reconciliation finished with failed assets.',
            serialized,
          );
        }
        return serialized;
      },
      { renewLock: true, dryRunResult },
    );
  }

  private parseMarketCandleReconciliationInput(
    input: MarketCandleReconciliationOpsJobInput,
  ): MarketCandleReconciliationInput {
    const market = input.market?.trim().toUpperCase();
    if (
      market &&
      !(['KRX', 'US', 'CRYPTO', 'ALL'] as const).includes(
        market as ReconciliationMarket,
      )
    ) {
      throw new HttpException(
        {
          success: false,
          error: {
            code: 'MARKET_CANDLE_RECONCILIATION_INVALID_INPUT',
            message: 'market must be KRX, US, CRYPTO, or ALL.',
          },
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    const parseDate = (value: string | null | undefined, name: string) => {
      if (!value?.trim()) return undefined;
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'MARKET_CANDLE_RECONCILIATION_INVALID_INPUT',
              message: `${name} must be an ISO-8601 datetime.`,
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      return parsed;
    };
    const targets = input.targets?.map((target) => {
      if (!(MARKET_CANDLE_SYNC_FEEDS as readonly string[]).includes(target)) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'MARKET_CANDLE_RECONCILIATION_INVALID_INPUT',
              message: `targets entries must be one of ${MARKET_CANDLE_SYNC_FEEDS.join(', ')}.`,
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      return target as MarketCandleFeed;
    });
    if (targets?.length === 0) {
      throw reconciliationInputError('targets must not be empty.');
    }
    const assetTypes = input.assetTypes?.map((assetType) => {
      if (!Object.values(AssetType).includes(assetType as AssetType)) {
        throw new HttpException(
          {
            success: false,
            error: {
              code: 'MARKET_CANDLE_RECONCILIATION_INVALID_INPUT',
              message: `assetTypes entries must be one of ${Object.values(AssetType).join(', ')}.`,
            },
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      return assetType as AssetType;
    });
    const assetIds = input.assetIds?.map((assetId, index) => {
      const value = typeof assetId === 'string' ? assetId.trim() : '';
      if (!value) {
        throw reconciliationInputError(
          `assetIds[${index}] must be a non-empty string.`,
        );
      }
      return value;
    });
    const from = parseDate(input.from, 'from');
    const to = parseDate(input.to, 'to');
    if ((from && !to) || (!from && to) || (from && to && from >= to)) {
      throw reconciliationInputError(
        'from and to must be supplied together with from earlier than to.',
      );
    }
    const maxAssets = positiveInteger(input.maxAssets, 'maxAssets');
    const maxPages = positiveInteger(input.maxPages, 'maxPages');
    return {
      assetIds,
      assetTypes,
      market: (market as ReconciliationMarket | undefined) ?? undefined,
      from,
      to,
      targets,
      maxAssets,
      maxPages,
      continueOnError: input.continueOnError,
      now: parseDate(input.now, 'now'),
    };
  }

  private parseMarketCandleSyncInput(
    input: MarketCandleSyncOpsJobInput,
  ): ParsedMarketCandleSyncInput {
    const assetIds = input.assetIds?.map((assetId, index) => {
      const trimmed = typeof assetId === 'string' ? assetId.trim() : '';
      if (trimmed === '') {
        throw new MarketCandleSyncInputError(
          `assetIds[${index}] must be a non-empty string.`,
        );
      }
      return trimmed;
    });
    const assetTypes = input.assetTypes?.map((assetType) => {
      if (!Object.values(AssetType).includes(assetType as AssetType)) {
        throw new MarketCandleSyncInputError(
          `assetTypes entries must be one of ${Object.values(AssetType).join(', ')}.`,
        );
      }
      return assetType as AssetType;
    });
    const mode =
      input.mode === undefined
        ? undefined
        : Object.values(MarketCandleSyncMode).includes(
              input.mode as MarketCandleSyncMode,
            )
          ? (input.mode as MarketCandleSyncMode)
          : (() => {
              throw new MarketCandleSyncInputError(
                'mode must be initial, incremental, or repair.',
              );
            })();
    const parseDate = (value: string | null | undefined, name: string) => {
      const text = this.optionalString(value);
      if (!text) return undefined;
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) {
        throw new MarketCandleSyncInputError(
          `${name} must be an ISO-8601 datetime.`,
        );
      }
      return date;
    };
    const targets = input.targets?.map((target) => {
      if (!(MARKET_CANDLE_SYNC_FEEDS as readonly string[]).includes(target)) {
        throw new MarketCandleSyncInputError(
          `targets entries must be one of ${MARKET_CANDLE_SYNC_FEEDS.join(', ')}.`,
        );
      }
      return target as MarketCandleFeed;
    });
    return {
      assetIds,
      assetTypes,
      targets,
      mode,
      from: parseDate(input.from, 'from'),
      to: parseDate(input.to, 'to'),
      resume: input.resume,
      continueOnError: input.continueOnError,
      maxAssets: input.maxAssets,
      now: parseDate(input.now, 'now'),
    };
  }

  private serializeMarketCandleSyncSummary(summary: MarketCandleSyncSummary) {
    // Dates serialize to ISO strings; the summary contains only counters,
    // codes, ids, and dates — never credentials or raw provider payloads.
    return JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
  }

  async runDailyPortfolioSnapshotJob(
    input: DailySnapshotOpsJobInput,
  ): Promise<OpsJobRunnerResponse> {
    const jobName = OpsJobName.daily_portfolio_snapshot;
    const trigger = input.trigger ?? OpsJobTrigger.manual_script;
    const dryRun = input.dryRun === true;
    const seasonId = this.optionalString(input.seasonId);
    const snapshotDate = this.optionalString(input.snapshotDate);

    if (!seasonId || !snapshotDate) {
      const skipped = await this.runService.recordSkipped({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'NOT_CONFIGURED',
          message:
            'seasonId and snapshotDate are required for daily snapshot ops job.',
        },
      });

      return this.successResponse(skipped, { skipped: true });
    }

    const lockKey = this.buildDailySnapshotLockKey(seasonId, snapshotDate);
    const lock = await this.lockService.acquireLock({
      jobName,
      lockKey,
      ttlSeconds: input.lockTtlSeconds ?? this.defaultLockTtlSeconds(),
    });

    if (!lock.acquired) {
      const locked = await this.runService.recordLocked({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'LOCKED',
          activeOwnerId: lock.activeOwnerId,
          expiresAt: lock.expiresAt?.toISOString() ?? null,
        },
      });

      return this.successResponse(locked, { locked: true, skipped: true });
    }

    let run: OpsJobRun;
    try {
      run = await this.runService.createRunning({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
      });
    } catch (error) {
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
      throw error;
    }

    try {
      const batchResponse = await this.dailyPortfolioSnapshotJobService.run({
        seasonId,
        snapshotDate,
        dryRun,
        requestedBy: input.requestedBy ?? undefined,
      });
      const succeeded = await this.runService.recordSucceeded(run, {
        resultJson: {
          batchRunId: batchResponse.data.run.id,
          batchStatus: batchResponse.data.run.status,
          dryRun: batchResponse.data.run.dryRun,
          resultPayloadJson: batchResponse.data.run.resultPayloadJson,
          deduplicated: batchResponse.data.deduplicated,
          skipped: batchResponse.data.skipped,
        },
      });

      return this.successResponse(succeeded);
    } catch (error) {
      const failure = this.extractFailure(error);
      const failed = await this.runService.recordFailed(run, {
        errorCode: failure.code,
        errorMessage: failure.message,
        resultJson: failure.resultJson,
      });

      return {
        success: false,
        error: {
          code: failure.code,
          message: failure.message,
        },
        data: {
          run: this.runService.serializeRun(failed),
        },
      };
    } finally {
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
    }
  }

  buildDailySnapshotLockKey(seasonId: string, snapshotDate: string) {
    return `daily_portfolio_snapshot:${seasonId}:${snapshotDate}`;
  }

  private async runLockedOpsJob(
    jobName: OpsJobName,
    input: OpsJobRunnerInput,
    lockKey: string,
    handler: (context: { isLockOwned: () => boolean }) => Promise<unknown>,
    options: { renewLock?: boolean; dryRunResult?: unknown } = {},
  ): Promise<OpsJobRunnerResponse> {
    const trigger = input.trigger ?? OpsJobTrigger.manual_script;
    const dryRun = input.dryRun === true;
    const lock = await this.lockService.acquireLock({
      jobName,
      lockKey,
      ttlSeconds: input.lockTtlSeconds ?? this.defaultLockTtlSeconds(),
    });

    if (!lock.acquired) {
      const locked = await this.runService.recordLocked({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
        resultJson: {
          reason: 'LOCKED',
          activeOwnerId: lock.activeOwnerId,
          expiresAt: lock.expiresAt?.toISOString() ?? null,
        },
      });

      return this.successResponse(locked, { locked: true, skipped: true });
    }

    let run: OpsJobRun;
    try {
      run = await this.runService.createRunning({
        jobName,
        trigger,
        requestedBy: input.requestedBy,
        lockKey,
        dryRun,
        idempotencyKey: input.idempotencyKey,
        maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
        metadataJson: input.metadataJson,
      });
    } catch (error) {
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
      throw error;
    }

    let lockOwned = true;
    let renewalRunning = false;
    let renewalPromise: Promise<void> | null = null;
    const ttlSeconds = input.lockTtlSeconds ?? this.defaultLockTtlSeconds();
    const renewal = options.renewLock
      ? setInterval(
          () => {
            if (renewalRunning || !lockOwned) return;
            renewalRunning = true;
            renewalPromise = this.lockService
              .extendLock({
                lockKey,
                ownerId: lock.ownerId,
                ttlSeconds,
              })
              .then((extended) => {
                if (!extended) lockOwned = false;
              })
              .catch(() => {
                lockOwned = false;
              })
              .finally(() => {
                renewalRunning = false;
              });
          },
          Math.max(100, Math.floor((ttlSeconds * 1000) / 3)),
        )
      : null;

    try {
      const resultJson = dryRun
        ? (options.dryRunResult ?? {
            dryRun: true,
            message: `${jobName} would run when dryRun is false.`,
          })
        : await handler({ isLockOwned: () => lockOwned });
      if (renewalPromise) await renewalPromise;
      if (!lockOwned) {
        throw new Error(`${jobName} lock ownership was lost.`);
      }
      const succeeded = await this.runService.recordSucceeded(run, {
        resultJson,
      });

      return this.successResponse(succeeded);
    } catch (error) {
      const failure = this.extractFailure(error);
      const failed = await this.runService.recordFailed(run, {
        errorCode: failure.code,
        errorMessage: failure.message,
        resultJson: failure.resultJson,
      });

      return {
        success: false,
        error: {
          code: failure.code,
          message: failure.message,
        },
        data: {
          run: this.runService.serializeRun(failed),
        },
      };
    } finally {
      if (renewal) clearInterval(renewal);
      if (renewalPromise) await renewalPromise;
      await this.lockService.releaseLock({
        lockKey,
        ownerId: lock.ownerId,
      });
    }
  }

  private async recordNotImplemented(
    jobName: OpsJobName,
    input: OpsJobRunnerInput,
    message: string,
  ): Promise<OpsJobRunnerResponse> {
    const skipped = await this.runService.recordSkipped({
      jobName,
      trigger: input.trigger ?? OpsJobTrigger.manual_script,
      requestedBy: input.requestedBy,
      dryRun: input.dryRun === true,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts(),
      metadataJson: input.metadataJson,
      resultJson: {
        reason: 'NOT_IMPLEMENTED',
        message,
      },
    });

    return this.successResponse(skipped, { skipped: true });
  }

  private throwProviderJobFailed(
    code: string,
    message: string,
    resultPayloadJson: unknown,
  ): never {
    throw new HttpException(
      {
        success: false,
        error: {
          code,
          message,
        },
        data: {
          resultPayloadJson,
        },
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private buildTargetSummary(targets: ProviderTargets) {
    return {
      targetSource: targets.targetSource,
      activeAssetCount: targets.activeAssetCount,
      binanceSymbolCount: targets.binanceSymbols.length,
      kisDomesticSymbolCount: targets.kisDomesticSymbols.length,
      kisUsSymbolCount: targets.kisUsSymbols.length,
      unsupportedAssets: targets.unsupportedAssets,
    };
  }

  private buildKisMarketCollectionPlan(
    targets: ProviderTargets,
    now: Date,
  ): {
    targets: ProviderTargets;
    calendarUnavailable: boolean;
  } {
    const krxState = resolveStockMarketSessionState(
      { assetType: 'domestic_stock' as AssetType, market: 'KRX' },
      now,
    );
    const usState = resolveStockMarketSessionState(
      { assetType: 'us_stock' as AssetType, market: 'NAS' },
      now,
    );
    const normalizeState = (
      state: ReturnType<typeof resolveStockMarketSessionState>,
    ): 'open' | 'closed' | 'calendar_unavailable' =>
      state?.state ?? 'calendar_unavailable';
    const krxDecision = normalizeState(krxState);
    const usDecision = normalizeState(usState);

    return {
      targets: {
        ...targets,
        kisDomesticSymbols:
          krxDecision === 'open' ? targets.kisDomesticSymbols : [],
        kisUsSymbols: usDecision === 'open' ? targets.kisUsSymbols : [],
      },
      calendarUnavailable:
        (targets.kisDomesticSymbols.length > 0 &&
          krxDecision === 'calendar_unavailable') ||
        (targets.kisUsSymbols.length > 0 &&
          usDecision === 'calendar_unavailable'),
    };
  }

  private successResponse(
    run: OpsJobRun,
    flags: { locked?: boolean; skipped?: boolean } = {},
  ): OpsJobRunnerResponse {
    return {
      success: true,
      data: {
        run: this.runService.serializeRun(run),
        locked: flags.locked === true,
        skipped: flags.skipped === true,
      },
    };
  }

  private extractFailure(error: unknown): {
    code: string;
    message: string;
    resultJson?: unknown;
  } {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      return {
        code: this.extractHttpErrorField(response, 'code') ?? 'OPS_JOB_FAILED',
        message:
          this.extractHttpErrorField(response, 'message') ?? 'Ops job failed.',
        resultJson: this.extractHttpResultPayload(response),
      };
    }

    if (error instanceof Error && error.message.trim() !== '') {
      return {
        code: 'OPS_JOB_FAILED',
        message: error.message,
      };
    }

    return {
      code: 'OPS_JOB_FAILED',
      message: 'Ops job failed.',
    };
  }

  private extractHttpErrorField(
    response: string | object,
    fieldName: 'code' | 'message',
  ) {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('error' in response) ||
      typeof response.error !== 'object' ||
      response.error === null ||
      !(fieldName in response.error)
    ) {
      return undefined;
    }

    const value = response.error[fieldName];
    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : undefined;
  }

  private extractHttpResultPayload(response: string | object): unknown {
    if (
      typeof response !== 'object' ||
      response === null ||
      !('data' in response) ||
      typeof response.data !== 'object' ||
      response.data === null ||
      !('resultPayloadJson' in response.data)
    ) {
      return undefined;
    }

    return response.data.resultPayloadJson;
  }

  private optionalString(value: string | null | undefined) {
    if (value === null || value === undefined) {
      return null;
    }

    const normalized = value.trim();
    return normalized === '' ? null : normalized;
  }

  private defaultLockTtlSeconds() {
    return getOpsSchedulerConfig().lockTtlSeconds;
  }

  private defaultMaxAttempts() {
    return getOpsSchedulerConfig().maxAttempts;
  }

  private parseOptionalDate(value: string | null | undefined) {
    const text = this.optionalString(value);
    if (!text) {
      return undefined;
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  private formatDateOnly(date: Date) {
    return date.toISOString().slice(0, 10);
  }
}

function serializeJson(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function positiveInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw reconciliationInputError(`${name} must be a positive integer.`);
  }
  return value;
}

function reconciliationInputError(message: string): HttpException {
  return new HttpException(
    {
      success: false,
      error: {
        code: 'MARKET_CANDLE_RECONCILIATION_INVALID_INPUT',
        message,
      },
    },
    HttpStatus.BAD_REQUEST,
  );
}
