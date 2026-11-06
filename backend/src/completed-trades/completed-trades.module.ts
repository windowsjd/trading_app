import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { CompletedTradesController } from './completed-trades.controller';
import { CompletedTradesService } from './completed-trades.service';

@Module({
  imports: [TradingAccountsModule, ProvidersModule],
  controllers: [CompletedTradesController],
  providers: [CompletedTradesService],
})
export class CompletedTradesModule {}
