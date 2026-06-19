import { Module } from '@nestjs/common';
import { ProvidersModule } from '../providers/providers.module';
import { RankingModule } from '../ranking/ranking.module';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

@Module({
  imports: [ProvidersModule, RankingModule],
  controllers: [FxController],
  providers: [FxService],
})
export class FxModule {}
