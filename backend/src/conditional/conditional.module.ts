import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { FuturesModule } from '../futures/futures.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { ConditionalService } from './conditional.service';
import { ConditionalController } from './conditional.controller';
import { ConditionalWorker } from './conditional-worker.service';
@Module({
  imports: [OrdersModule, FuturesModule, TradingAccountsModule],
  controllers: [ConditionalController],
  providers: [
    ConditionalService,
    ConditionalWorker,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class ConditionalModule {}
