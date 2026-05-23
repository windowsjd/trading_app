import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RewardsService } from './rewards.service';
import type { RewardsQuery } from './rewards.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1')
export class RewardsController {
  constructor(private readonly rewardsService: RewardsService) {}

  @Get('rewards/me')
  getMyRewards(
    @Req() request: AuthenticatedRequest,
    @Query() query: RewardsQuery,
  ) {
    return this.rewardsService.getMyRewards(this.extractUserId(request), query);
  }

  @Get('badges/me')
  getMyBadges(
    @Req() request: AuthenticatedRequest,
    @Query() query: RewardsQuery,
  ) {
    return this.rewardsService.getMyBadges(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
