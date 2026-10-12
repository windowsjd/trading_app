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
import { ConditionalBuyService } from './conditional-buy.service';
import type { ConditionalBuyBody } from './conditional-buy-policy';
type AuthRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/conditional-buy-orders')
export class ConditionalBuyController {
  constructor(private readonly service: ConditionalBuyService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
        assetId: 'INVALID_CONDITIONAL_BUY',
        history: 'INVALID_PAGINATION',
      }),
    )
    query: {
      limit?: string;
      offset?: string;
      assetId?: string;
      history?: string;
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
    @Body() body: ConditionalBuyBody,
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
