import { Controller, Get, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { WalletsService } from './wallets.service';
import type { WalletTransactionsQuery } from './wallets.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get('transactions')
  getWalletTransactions(
    @Req() request: AuthenticatedRequest,
    @Query(
      new ScalarQueryPipe({
        currency: 'INVALID_CURRENCY',
        direction: 'INVALID_DIRECTION',
        txType: 'INVALID_TX_TYPE',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof WalletTransactionsQuery, string>),
    )
    query: WalletTransactionsQuery,
  ) {
    return this.walletsService.getWalletTransactions(
      this.extractUserId(request),
      query,
    );
  }

  @Get()
  getWallets(@Req() request: AuthenticatedRequest) {
    return this.walletsService.getWallets(this.extractUserId(request));
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
