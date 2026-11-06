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
import { FuturesLeverageService } from './futures-leverage.service';
import type { FuturesExecuteBody } from './futures-input';

type AuthenticatedRequest = Request & { user?: { userId?: string } };

@Controller('api/v1/trading-accounts/:accountId/futures')
export class FuturesController {
  constructor(
    private readonly futures: FuturesService,
    private readonly leverage: FuturesLeverageService,
  ) {}

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
  /** Leverage change of an open lifetime, confirmed by the user (2026-11-06). */
  @Post('positions/:positionId/leverage')
  @HttpCode(200)
  changeLeverage(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Param('positionId') positionId: string,
    @Body() body: unknown,
  ) {
    return this.leverage.change(req.user?.userId, id, positionId, body);
  }
  @Get('positions/:positionId/leverage-preview')
  leveragePreview(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Param('positionId') positionId: string,
    @Query(
      new ScalarQueryPipe({
        leverage: 'INVALID_FUTURES_LEVERAGE_PREVIEW',
        quantity: 'INVALID_FUTURES_LEVERAGE_PREVIEW',
        price: 'INVALID_FUTURES_LEVERAGE_PREVIEW',
      }),
    )
    query: { leverage?: string; quantity?: string; price?: string },
  ) {
    return this.leverage.preview(req.user?.userId, id, positionId, query);
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
  /** 거래 내역 › 선물: 포지션 진입 (entry) or 포지션 종료 (exit) records. */
  @Get('position-history')
  positionHistory(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        phase: 'INVALID_FUTURES_HISTORY_PHASE',
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
      }),
    )
    query: { phase?: string; limit?: string; offset?: string },
  ) {
    return this.futures.positionHistory(req.user?.userId, id, query);
  }
  @Get('final-settlement')
  finalSettlement(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
  ) {
    return this.futures.finalSettlement(req.user?.userId, id);
  }
}
