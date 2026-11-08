import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AdRewardPurpose } from '../generated/prisma/client';
import type { AdRewardCommandBody } from './ad-reward-command';
import { AdMobRewardSessionService } from './admob-reward-session.service';
import { GeneralAccountResetService } from './general-account-reset.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * General-account reset (2026-10-20). Account-scoped like every finance
 * route: the accountId is explicit and ownership is re-verified per request.
 * General accounts only (season and beginner accounts are 409
 * AD_REWARD_GENERAL_ACCOUNT_ONLY).
 *
 * GET never writes. POST takes the same ad-command body as the top-up claim
 * (provider, opaque proof, idempotencyKey) — nothing about the reset itself is
 * client-decided. For an AdMob session whose Google event is recorded the
 * server resets (or refuses) it itself; this call then only reads the result,
 * so it can never become a second consent (2026-11-08,
 * AdMobRewardSessionService.memberCommand).
 */
@Controller('api/v1/trading-accounts/:accountId/account-reset')
export class GeneralAccountResetController {
  constructor(
    private readonly resetService: GeneralAccountResetService,
    private readonly sessions: AdMobRewardSessionService,
  ) {}

  @Get('eligibility')
  getEligibility(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
  ) {
    return this.resetService.getEligibility(request.user?.userId, accountId);
  }

  @Post()
  reset(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Body() body: AdRewardCommandBody,
  ) {
    return this.sessions.memberCommand(
      AdRewardPurpose.account_reset,
      request.user?.userId,
      accountId,
      body,
    );
  }
}
