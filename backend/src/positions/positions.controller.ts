import { Controller, Get, Query, Req } from '@nestjs/common';
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
    @Query() query: PositionsQuery,
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
