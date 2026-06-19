import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [RankingModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
