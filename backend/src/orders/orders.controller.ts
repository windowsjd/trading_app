import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import type { OrderRequestBody, OrdersQuery } from './orders.service';

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
    @Query(
      new ScalarQueryPipe({
        seasonId: 'VALIDATION_ERROR',
        status: 'INVALID_ORDER_STATUS',
        side: 'INVALID_ORDER_SIDE',
        assetId: 'VALIDATION_ERROR',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof OrdersQuery, string>),
    )
    query: OrdersQuery,
  ) {
    return this.ordersService.getOrders(this.extractUserId(request), query);
  }

  @Get(':orderId')
  getOrder(
    @Req() request: AuthenticatedRequest,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.getOrder(this.extractUserId(request), orderId);
  }

  @Post('quote')
  quoteOrder(
    @Req() request: AuthenticatedRequest,
    @Body() body: OrderRequestBody,
  ) {
    return this.ordersService.quoteOrder(this.extractUserId(request), body);
  }

  @Post()
  createOrder(
    @Req() request: AuthenticatedRequest,
    @Body() body: OrderRequestBody,
  ) {
    return this.ordersService.createOrder(this.extractUserId(request), body);
  }

  @Post(':orderId/cancel')
  cancelOrder(
    @Req() request: AuthenticatedRequest,
    @Param('orderId') orderId: string,
  ) {
    return this.ordersService.cancelOrder(this.extractUserId(request), orderId);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
