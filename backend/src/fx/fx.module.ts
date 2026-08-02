import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { RankingModule } from '../ranking/ranking.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';
import { TradingAccountFxController } from './trading-account-fx.controller';

@Module({
  imports: [ProvidersModule, RankingModule, TradingAccountsModule],
  controllers: [FxController, TradingAccountFxController],
  providers: [FxService],
})
export class FxModule {}
