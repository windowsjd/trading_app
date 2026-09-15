import { Controller, Get, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
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
    @Query(
      new ScalarQueryPipe({
        seasonId: 'VALIDATION_ERROR',
        rankingDate: 'INVALID_RANKING_DATE',
        rankType: 'INVALID_RANK_TYPE',
        capturedAt: 'INVALID_RANKING_CAPTURED_AT',
        scope: 'INVALID_RANKING_SCOPE',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof RankingQuery, string>),
    )
    query: RankingQuery,
  ) {
    return this.rankingService.getRanking(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
