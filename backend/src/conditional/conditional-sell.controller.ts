import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { ConditionalSellService } from './conditional-sell.service';
import type { ConditionalSellBody } from './conditional-sell-policy';
type AuthRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/conditional-sell-orders')
export class ConditionalSellController {
  constructor(private readonly service: ConditionalSellService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
        assetId: 'INVALID_CONDITIONAL_SELL',
        history: 'INVALID_PAGINATION',
        state: 'INVALID_PAGINATION',
        kind: 'INVALID_PAGINATION',
      }),
    )
    query: {
      limit?: string;
      offset?: string;
      assetId?: string;
      history?: string;
      state?: string;
      kind?: string;
    },
  ) {
    return this.service.list(req.user?.userId, id, query);
  }
  @Get(':conditionalOrderId')
  get(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Param('conditionalOrderId') conditionalOrderId: string,
  ) {
    return this.service.get(req.user?.userId, id, conditionalOrderId);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Body() body: ConditionalSellBody,
  ) {
    return this.service.create(req.user?.userId, id, body);
  }
  @Post(':conditionalOrderId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Param('conditionalOrderId') conditionalOrderId: string,
  ) {
    return this.service.cancel(req.user?.userId, id, conditionalOrderId);
  }
}
