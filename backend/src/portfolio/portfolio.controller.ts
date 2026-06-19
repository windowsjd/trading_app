import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  PortfolioService,
  type PortfolioEquityQuery,
} from './portfolio.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/portfolio')
export class PortfolioController {
  constructor(private readonly portfolioService: PortfolioService) {}

  @Get()
  getPortfolio(@Req() request: AuthenticatedRequest) {
    return this.portfolioService.getPortfolio(this.extractUserId(request));
  }

  @Get('equity')
  getEquity(
    @Req() request: AuthenticatedRequest,
    @Query() query: PortfolioEquityQuery,
  ) {
    return this.portfolioService.getEquity(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
