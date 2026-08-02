import { Module } from '@nestjs/common';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { PositionsController } from './positions.controller';
import { PositionsService } from './positions.service';
import { TradingAccountPositionsController } from './trading-account-positions.controller';

@Module({
  imports: [TradingAccountsModule],
  controllers: [PositionsController, TradingAccountPositionsController],
  providers: [PositionsService],
})
export class PositionsModule {}
