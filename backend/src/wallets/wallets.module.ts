import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { TradingAccountWalletsController } from './trading-account-wallets.controller';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [TradingAccountsModule],
  controllers: [WalletsController, TradingAccountWalletsController],
  providers: [WalletsService],
  exports: [WalletsService],
})
export class WalletsModule {}
