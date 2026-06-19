import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { FxController } from './fx.controller';
import { FxService } from './fx.service';

@Module({
  imports: [RankingModule],
  controllers: [FxController],
  providers: [FxService],
})
export class FxModule {}
