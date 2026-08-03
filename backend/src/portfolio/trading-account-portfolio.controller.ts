import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  TradingAccountPortfolioService,
  type TradingAccountEquityQuery,
} from './trading-account-portfolio.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped portfolio reads (작업 7). The accountId is explicit in the
 * path and ownership is re-verified per request; the server stores no
 * "current account". Legacy `/api/v1/portfolio` and `/api/v1/portfolio/equity`
 * are unchanged.
 *
 * Both routes are pure reads: they never create an account, wallet, grant,
 * claim, snapshot, or position.
 */
@Controller('api/v1/trading-accounts/:accountId/portfolio')
export class TradingAccountPortfolioController {
  constructor(
    private readonly portfolioService: TradingAccountPortfolioService,
  ) {}

  @Get()
  getPortfolio(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
  ) {
    return this.portfolioService.getPortfolio(
      this.extractUserId(request),
      accountId,
    );
  }

  @Get('equity')
  getEquity(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Query() query: TradingAccountEquityQuery,
  ) {
    return this.portfolioService.getEquity(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
