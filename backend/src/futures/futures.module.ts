import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { FuturesLiquidationService } from './futures-liquidation.service';
import { FuturesRiskWorker } from './futures-risk-worker.service';
import { FuturesMarkIngestion } from './futures-mark-ingestion.service';
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

@Module({
  imports: [TradingAccountsModule, GeneralPerformanceModule],
  controllers: [FuturesController, FuturesLimitController],
  exports: [FuturesService],
  providers: [
    FuturesPerformanceService,
    FuturesService,
    FuturesLimitService,
    FuturesLimitWorker,
    FuturesLiquidationService,
    FuturesRiskWorker,
    FuturesMarkIngestion,
    FuturesMarkRetentionService,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class FuturesModule {}
