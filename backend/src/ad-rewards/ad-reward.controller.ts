import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  AdRewardService,
  type AdRewardClaimRequestBody,
  type AdRewardClaimsQuery,
} from './ad-reward.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped rewarded-ad endpoints. The accountId is always explicit in
 * the path and ownership is re-verified per request; the server keeps no
 * "current account" state. All three routes require authentication and are
 * general-account only (a season accountId is 409
 * AD_REWARD_GENERAL_ACCOUNT_ONLY).
 *
 * GET never grants anything and never creates an account, wallet, or claim.
 */
@Controller('api/v1/trading-accounts/:accountId/ad-rewards')
export class AdRewardController {
  constructor(private readonly adRewardService: AdRewardService) {}

  @Get('eligibility')
  getEligibility(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
  ) {
    return this.adRewardService.getEligibility(
      this.extractUserId(request),
      accountId,
    );
  }

  /**
   * Body carries ONLY the provider key and an opaque proof. Reward amount,
   * provider event id, user, account, granted time, and balances are all
   * server-decided.
   */
  @Post('claim')
  claim(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Body() body: AdRewardClaimRequestBody,
  ) {
    return this.adRewardService.claim(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Get('claims')
  listClaims(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Query() query: AdRewardClaimsQuery,
  ) {
    return this.adRewardService.listClaims(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
