import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { PendingOrderEventsController } from './pending-order-events.controller';
import { PendingOrderEventsService } from './pending-order-events.service';

@Module({
  imports: [TradingAccountsModule],
  controllers: [PendingOrderEventsController],
  providers: [PendingOrderEventsService],
})
export class PendingOrderEventsModule {}
