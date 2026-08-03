import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { GeneralAccountsService } from './general-accounts.service';
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
    private readonly generalAccountsService: GeneralAccountsService,
  ) {}

  @Get()
  listTradingAccounts(@Req() request: AuthenticatedRequest) {
    return this.tradingAccountsService.listTradingAccounts(
      this.extractUserId(request),
    );
  }

  /**
   * General-mode entry. Takes no body, is idempotent, and always answers 200:
   * `data.created` distinguishes the first open from a replay. Deliberately
   * NOT a GET — a read must never create an account, a wallet, or a grant.
   *
   * The status is PINNED to 200 (Nest would default a POST to 201) so a
   * client never has to tell "created" from "replayed" by status code; the
   * boolean is the single source of that truth.
   */
  @Post('general')
  @HttpCode(HttpStatus.OK)
  openGeneralAccount(@Req() request: AuthenticatedRequest) {
    return this.generalAccountsService.openGeneralAccount(
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
