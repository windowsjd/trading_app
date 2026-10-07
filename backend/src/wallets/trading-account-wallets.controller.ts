import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  TradingAccountWalletTransferService,
  type WalletTransferRequest,
} from './trading-account-wallet-transfer.service';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { WalletsService } from './wallets.service';
import type { WalletTransactionsQuery } from './wallets.service';
import {
  TradingAccountWalletFxTransferService,
  type WalletFxTransferQuoteRequest,
  type WalletFxTransferExecuteRequest,
} from './trading-account-wallet-fx-transfer.service';

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
  constructor(
    private readonly walletsService: WalletsService,
    private readonly transfers: TradingAccountWalletTransferService,
    private readonly fxTransfers: TradingAccountWalletFxTransferService,
  ) {}

  @Post('wallet-transfers/quote')
  @HttpCode(200)
  quoteTransfer(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Body() body: WalletFxTransferQuoteRequest,
  ) {
    return this.fxTransfers.quote(this.extractUserId(request), accountId, body);
  }

  @Post('wallet-transfers/execute')
  @HttpCode(200)
  executeTransfer(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Body() body: WalletFxTransferExecuteRequest,
  ) {
    return this.fxTransfers.execute(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Post('wallet-transfers')
  @HttpCode(200)
  transferWallets(
    @Req() request: AuthenticatedRequest,
    @Param('accountId') accountId: string,
    @Body() body: WalletTransferRequest,
  ) {
    return this.transfers.transfer(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

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
