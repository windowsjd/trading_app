import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { WalletsService } from './wallets.service';
import type { WalletTransactionsQuery } from './wallets.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped wallet reads: the accountId is explicit in the path and
 * ownership is re-verified per request (the server never stores a "current
 * account"). Legacy /api/v1/wallets stays unchanged for the frontend.
 */
@Controller('api/v1/trading-accounts/:accountId')
export class TradingAccountWalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get('wallets')
  getWallets(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
  ) {
    return this.walletsService.getWalletsForTradingAccount(
      this.extractUserId(request),
      accountId,
    );
  }

  @Get('wallet-transactions')
  getWalletTransactions(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Query() query: WalletTransactionsQuery,
  ) {
    return this.walletsService.getWalletTransactionsForTradingAccount(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
