import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { PositionsService } from './positions.service';
import type { PositionsQuery } from './positions.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped positions (read-only). The accountId is explicit in the
 * path and ownership is re-verified per request; rows are selected by the
 * position's own tradingAccountId. The legacy /api/v1/positions endpoint
 * stays unchanged, and both return the same positions for the same season
 * account. No single-position detail route exists on the legacy API, so
 * none is invented here.
 */
@Controller('api/v1/trading-accounts/:accountId/positions')
export class TradingAccountPositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  getPositions(
    @Param('accountId') accountId: string,
    @Query() query: PositionsQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.positionsService.getPositionsForTradingAccount(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
