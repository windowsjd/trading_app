import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { TradingAccountWalletTransferService } from './trading-account-wallet-transfer.service';
import { TradingAccountWalletsController } from './trading-account-wallets.controller';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';
import { FxModule } from '../fx/fx.module';
import { TradingAccountWalletFxTransferService } from './trading-account-wallet-fx-transfer.service';

@Module({
  imports: [TradingAccountsModule, GeneralPerformanceModule, FxModule],
  controllers: [WalletsController, TradingAccountWalletsController],
  providers: [
    WalletsService,
    TradingAccountWalletTransferService,
    TradingAccountWalletFxTransferService,
  ],
  exports: [WalletsService],
})
export class WalletsModule {}
