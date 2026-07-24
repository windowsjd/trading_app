import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { RankingModule } from '../ranking/ranking.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ProvidersModule } from '../providers/providers.module';
import { RedisModule } from '../redis/redis.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderReservationService } from './order-reservation.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';

@Module({
  imports: [
    AssetsModule,
    RankingModule,
    PortfolioModule,
    ProvidersModule,
    RedisModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderReservationService,
    LimitOrderCreateService,
    LimitOrderCancelService,
  ],
  exports: [LimitOrderCancelService],
})
export class OrdersModule {}
