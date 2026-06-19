import { Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { OptionalAuth } from '../auth/auth.decorators';
import { SeasonsService } from './seasons.service';
import type { SeasonsListQuery } from './seasons.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/seasons')
export class SeasonsController {
  constructor(private readonly seasonsService: SeasonsService) {}

  @Get()
  getSeasons(@Query() query: SeasonsListQuery) {
    return this.seasonsService.getSeasons(query);
  }

  @OptionalAuth()
  @Get('current')
  getCurrentSeason(@Req() request: AuthenticatedRequest) {
    const userId = this.extractUserId(request);

    return this.seasonsService.getCurrentSeason(userId);
  }

  @Post(':seasonId/join')
  joinSeason(
    @Param('seasonId') seasonId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    const userId = this.extractUserId(request);

    return this.seasonsService.joinSeason(seasonId, userId);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
