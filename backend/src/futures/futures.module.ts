import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { GeneralPerformanceModule } from '../portfolio/general-performance.module';
import { FuturesController } from './futures.controller';
import { FuturesService } from './futures.service';

@Module({
  imports: [TradingAccountsModule, GeneralPerformanceModule],
  controllers: [FuturesController],
  providers: [FuturesService],
})
export class FuturesModule {}
