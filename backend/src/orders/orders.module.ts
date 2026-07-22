import { Module } from '@nestjs/common';
import { RankingModule } from '../ranking/ranking.module';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { ProvidersModule } from '../providers/providers.module';
import { RedisModule } from '../redis/redis.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderReservationService } from './order-reservation.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import { LimitOrderCandidateRepository } from './limit-matching/limit-order-candidate.repository';
import { LimitOrderEventPollerService } from './limit-matching/limit-order-event-poller.service';
import { LimitOrderEventStreamService } from './limit-matching/limit-order-event-stream.service';
import { LimitOrderExecutionService } from './limit-matching/limit-order-execution.service';
import { LimitOrderMatcherHealthService } from './limit-matching/limit-order-matcher-health.service';
import { LimitOrderMatcherLeaderService } from './limit-matching/limit-order-matcher-leader.service';
import { LimitOrderPriceEventPublisher } from './limit-matching/limit-order-price-event.publisher';
import { LimitOrderProviderHealthService } from './limit-matching/limit-order-provider-health.service';

@Module({
  imports: [RankingModule, PortfolioModule, ProvidersModule, RedisModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderReservationService,
    LimitOrderCreateService,
    LimitOrderCancelService,
    LimitOrderCandidateRepository,
    LimitOrderEventStreamService,
    LimitOrderExecutionService,
    LimitOrderMatcherHealthService,
    LimitOrderMatcherLeaderService,
    LimitOrderPriceEventPublisher,
    LimitOrderProviderHealthService,
    LimitOrderEventPollerService,
  ],
  exports: [LimitOrderCancelService],
})
export class OrdersModule {}
