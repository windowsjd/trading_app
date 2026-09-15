import { Controller, Get, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { PositionsService } from './positions.service';
import type { PositionsQuery } from './positions.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/positions')
export class PositionsController {
  constructor(private readonly positionsService: PositionsService) {}

  @Get()
  getPositions(
    @Req() request: AuthenticatedRequest,
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
  ) {
    return this.positionsService.getPositions(
      this.extractUserId(request),
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
