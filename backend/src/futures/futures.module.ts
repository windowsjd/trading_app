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

@Module({
  imports: [TradingAccountsModule, GeneralPerformanceModule],
  controllers: [FuturesController],
  providers: [
    FuturesPerformanceService,
    FuturesService,
    FuturesLiquidationService,
    FuturesRiskWorker,
    FuturesMarkIngestion,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class FuturesModule {}
