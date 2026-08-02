import { Module } from '@nestjs/common';
import { TradingAccountAccessService } from './trading-account-access.service';
import { TradingAccountsController } from './trading-accounts.controller';
import { TradingAccountsService } from './trading-accounts.service';

@Module({
  controllers: [TradingAccountsController],
  providers: [TradingAccountsService, TradingAccountAccessService],
  // Future accountId-based wallet/order/position/portfolio modules reuse the
  // ownership check through this export instead of re-implementing it.
  exports: [TradingAccountAccessService],
})
export class TradingAccountsModule {}
