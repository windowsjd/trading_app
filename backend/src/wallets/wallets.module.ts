import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { TradingAccountWalletTransferService } from './trading-account-wallet-transfer.service';
import { TradingAccountWalletsController } from './trading-account-wallets.controller';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [TradingAccountsModule, GeneralPerformanceModule],
  controllers: [WalletsController, TradingAccountWalletsController],
  providers: [WalletsService, TradingAccountWalletTransferService],
  exports: [WalletsService],
})
export class WalletsModule {}
