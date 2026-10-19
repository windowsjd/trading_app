import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import type { AdRewardCommandBody } from './ad-reward-command';
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
 * client-decided.
 */
@Controller('api/v1/trading-accounts/:accountId/account-reset')
export class GeneralAccountResetController {
  constructor(private readonly resetService: GeneralAccountResetService) {}

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
    return this.resetService.reset(request.user?.userId, accountId, body);
  }
}
