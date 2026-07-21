import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderReservationService } from './order-reservation.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';

@Module({
  imports: [RankingModule],
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
