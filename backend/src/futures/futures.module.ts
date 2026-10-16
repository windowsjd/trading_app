import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { FuturesLiquidationService } from './futures-liquidation.service';
import { FuturesRiskWorker } from './futures-risk-worker.service';
import { FuturesMarkIngestion } from './futures-mark-ingestion.service';
import { FuturesLastPriceIngestion } from './futures-last-price-ingestion.service';
import { FuturesLastPriceRetentionService } from './futures-last-price-retention.service';
import { RedisModule } from '../redis/redis.module';
import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { FuturesController } from './futures.controller';
import { FuturesService } from './futures.service';
import { FuturesPerformanceService } from './futures-performance.service';
import { FuturesMarkRetentionService } from './futures-mark-retention.service';
import { FuturesLimitController } from './futures-limit.controller';
import { FuturesLimitService } from './futures-limit.service';
import { FuturesLimitWorker } from './futures-limit-worker.service';
import { FuturesMarketDataIngestion } from './futures-market-data-ingestion.service';
import { FuturesMarketStatsStore } from './futures-market-stats.store';
import { ProvidersModule } from '../providers/providers.module';
import { FuturesConditionalEntryController } from './futures-conditional-entry.controller';
import { FuturesConditionalEntryService } from './futures-conditional-entry.service';
import { FuturesConditionalEntryWorker } from './futures-conditional-entry-worker.service';
import { FuturesTpSlController } from './futures-tp-sl.controller';
import { FuturesTpSlService } from './futures-tp-sl.service';
import { FuturesTpSlWorker } from './futures-tp-sl-worker.service';

@Module({
  imports: [
    TradingAccountsModule,
    GeneralPerformanceModule,
    RedisModule,
    ProvidersModule,
  ],
  controllers: [
    FuturesController,
    FuturesLimitController,
    FuturesConditionalEntryController,
    FuturesTpSlController,
  ],
  exports: [
    FuturesService,
    FuturesMarkIngestion,
    FuturesMarkRetentionService,
    FuturesLastPriceRetentionService,
  ],
  providers: [
    FuturesPerformanceService,
    FuturesService,
    FuturesLimitService,
    FuturesLimitWorker,
    FuturesConditionalEntryService,
    FuturesConditionalEntryWorker,
    FuturesTpSlService,
    FuturesTpSlWorker,
    FuturesLiquidationService,
    FuturesRiskWorker,
    FuturesMarkIngestion,
    FuturesMarkRetentionService,
    FuturesLastPriceIngestion,
    FuturesLastPriceRetentionService,
    FuturesMarketStatsStore,
    FuturesMarketDataIngestion,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class FuturesModule {}
