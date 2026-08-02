import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { OrdersService } from './orders.service';
import type { OrderRequestBody, OrdersQuery } from './orders.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped orders: the accountId is explicit in the path, ownership is
 * re-verified per request, and quote/create/cancel run the SAME service
 * cores as the legacy /api/v1/orders endpoints (which stay unchanged) —
 * fees, quote consumption, wallet/ledger/position writes, idempotency, and
 * rollback behavior are identical. There is deliberately NO account-scoped
 * execute endpoint: the legacy API exposes none either (market orders
 * execute inside create; limit orders fill via the scheduler matcher).
 */
@Controller('api/v1/trading-accounts/:accountId/orders')
export class TradingAccountOrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  getOrders(
    @Param('accountId') accountId: string,
    @Query() query: OrdersQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ordersService.getOrdersForTradingAccount(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  @Get(':orderId')
  getOrder(
    @Param('accountId') accountId: string,
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ordersService.getOrderForTradingAccount(
      this.extractUserId(request),
      accountId,
      orderId,
    );
  }

  @Post('quote')
  quoteOrder(
    @Param('accountId') accountId: string,
    @Body() body: OrderRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ordersService.quoteOrderForTradingAccount(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Post()
  createOrder(
    @Param('accountId') accountId: string,
    @Body() body: OrderRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ordersService.createOrderForTradingAccount(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Post(':orderId/cancel')
  cancelOrder(
    @Param('accountId') accountId: string,
    @Param('orderId') orderId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.ordersService.cancelOrderForTradingAccount(
      this.extractUserId(request),
      accountId,
      orderId,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
