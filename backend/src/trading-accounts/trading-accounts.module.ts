import { Module } from '@nestjs/common';
import { GeneralAccountsService } from './general-accounts.service';
import { TradingAccountAccessService } from './trading-account-access.service';
import { TradingAccountsController } from './trading-accounts.controller';
import { TradingAccountsService } from './trading-accounts.service';

@Module({
  controllers: [TradingAccountsController],
  providers: [
    TradingAccountsService,
    TradingAccountAccessService,
    GeneralAccountsService,
  ],
  // Future accountId-based wallet/order/position/portfolio modules reuse the
  // ownership check through this export instead of re-implementing it.
  exports: [TradingAccountAccessService],
})
export class TradingAccountsModule {}
