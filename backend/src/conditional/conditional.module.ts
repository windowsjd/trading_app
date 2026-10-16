import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { FuturesModule } from '../futures/futures.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { OpsJobLockService } from '../ops/ops-job-lock.service';
import { OpsJobRunService } from '../ops/ops-job-run.service';
import { ConditionalService } from './conditional.service';
import { ConditionalController } from './conditional.controller';
import { ConditionalWorker } from './conditional-worker.service';
import { ConditionalBuyService } from './conditional-buy.service';
import { ConditionalBuyController } from './conditional-buy.controller';
import { ConditionalBuyWorker } from './conditional-buy-worker.service';
import { ConditionalSellService } from './conditional-sell.service';
import { ConditionalSellController } from './conditional-sell.controller';
import { ConditionalSellWorker } from './conditional-sell-worker.service';
import { EntryTpSlService } from './entry-tp-sl.service';
import { EntryTpSlController } from './entry-tp-sl.controller';
import { EntryTpSlSweeper } from './entry-tp-sl-sweeper.service';
@Module({
  imports: [OrdersModule, FuturesModule, TradingAccountsModule],
  controllers: [
    ConditionalController,
    ConditionalBuyController,
    ConditionalSellController,
    EntryTpSlController,
  ],
  providers: [
    ConditionalService,
    ConditionalWorker,
    ConditionalBuyService,
    ConditionalBuyWorker,
    ConditionalSellService,
    ConditionalSellWorker,
    EntryTpSlService,
    EntryTpSlSweeper,
    OpsJobLockService,
    OpsJobRunService,
  ],
})
export class ConditionalModule {}
