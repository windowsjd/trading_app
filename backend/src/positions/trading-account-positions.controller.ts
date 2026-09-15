import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
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
    @Query(
      new ScalarQueryPipe({
        seasonId: 'VALIDATION_ERROR',
        includeClosed: 'INVALID_INCLUDE_CLOSED',
        assetType: 'INVALID_ASSET_TYPE',
        currencyCode: 'INVALID_CURRENCY_CODE',
        assetId: 'VALIDATION_ERROR',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof PositionsQuery, string>),
    )
    query: PositionsQuery,
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
