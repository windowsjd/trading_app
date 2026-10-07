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
import { FuturesService } from './futures.service';
import type { FuturesExecuteBody } from './futures-input';

type AuthenticatedRequest = Request & { user?: { userId?: string } };

@Controller('api/v1/trading-accounts/:accountId/futures')
export class FuturesController {
  constructor(private readonly futures: FuturesService) {}

  @Post('execute')
  @HttpCode(200)
  execute(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Body() body: FuturesExecuteBody,
  ) {
    return this.futures.execute(req.user?.userId, id, body);
  }
  @Get('instruments')
  instruments(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
  ) {
    return this.futures.instruments(req.user?.userId, id);
  }
  @Get('positions')
  positions(@Req() req: AuthenticatedRequest, @Param('accountId') id: string) {
    return this.futures.positions(req.user?.userId, id);
  }
  @Get('liquidations')
  liquidations(
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
    return this.futures.liquidations(req.user?.userId, id, query);
  }
  @Get('executions')
  executions(
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
    return this.futures.executions(req.user?.userId, id, query);
  }
  @Get('final-settlement')
  finalSettlement(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
  ) {
    return this.futures.finalSettlement(req.user?.userId, id);
  }
}
