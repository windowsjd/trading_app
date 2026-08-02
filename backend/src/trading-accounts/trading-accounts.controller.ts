import { Controller, Get, Param, Req } from '@nestjs/common';
import { Request } from 'express';
import { TradingAccountsService } from './trading-accounts.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/trading-accounts')
export class TradingAccountsController {
  constructor(
    private readonly tradingAccountsService: TradingAccountsService,
  ) {}

  @Get()
  listTradingAccounts(@Req() request: AuthenticatedRequest) {
    return this.tradingAccountsService.listTradingAccounts(
      this.extractUserId(request),
    );
  }

  @Get(':accountId')
  getTradingAccount(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
  ) {
    return this.tradingAccountsService.getTradingAccount(
      this.extractUserId(request),
      accountId,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
