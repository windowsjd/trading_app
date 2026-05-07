import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RankingService } from './ranking.service';
import type { RankingQuery } from './ranking.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/ranking')
export class RankingController {
  constructor(private readonly rankingService: RankingService) {}

  @Get()
  getRanking(
    @Req() request: AuthenticatedRequest,
    @Query() query: RankingQuery,
  ) {
    return this.rankingService.getRanking(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
