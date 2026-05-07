import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import type { OrdersQuery } from './orders.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  getOrders(
    @Req() request: AuthenticatedRequest,
    @Query() query: OrdersQuery,
  ) {
    return this.ordersService.getOrders(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
