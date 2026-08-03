import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { GeneralPerformanceModule } from './general-performance.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';
import { PortfolioValuationService } from './portfolio-valuation.service';
import { TradingAccountPortfolioController } from './trading-account-portfolio.controller';
import { TradingAccountPortfolioService } from './trading-account-portfolio.service';

@Module({
  imports: [GeneralPerformanceModule, TradingAccountsModule],
  controllers: [PortfolioController, TradingAccountPortfolioController],
  providers: [
    PortfolioService,
    PortfolioValuationService,
    TradingAccountPortfolioService,
  ],
  exports: [PortfolioValuationService],
})
export class PortfolioModule {}
