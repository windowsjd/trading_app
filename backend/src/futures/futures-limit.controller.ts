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
import { FuturesLimitService } from './futures-limit.service';
type AuthenticatedRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/futures/limit-orders')
export class FuturesLimitController {
  constructor(private readonly entries: FuturesLimitService) {}
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Body() body: unknown,
  ) {
    return this.entries.create(req.user?.userId, id, body);
  }
  @Get()
  read(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
      }),
    )
    query: { limit?: string; offset?: string },
  ) {
    return this.entries.read(req.user?.userId, id, query);
  }
  @Post(':orderId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Param('orderId') orderId: string,
  ) {
    return this.entries.cancel(req.user?.userId, id, orderId);
  }
}
