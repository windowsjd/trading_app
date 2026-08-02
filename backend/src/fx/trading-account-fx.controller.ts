import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { FxService } from './fx.service';
import type {
  FxExchangesQuery,
  FxExecuteRequestBody,
  FxQuoteRequestBody,
} from './fx.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Account-scoped FX: the accountId is explicit in the path, ownership is
 * re-verified per request, and the fee/rate/ledger/idempotency rules are the
 * SAME service code paths as the legacy /api/v1/fx endpoints (which stay
 * unchanged). Market-rate reads stay on the public /api/v1/fx/rates/current.
 */
@Controller('api/v1/trading-accounts/:accountId/fx')
export class TradingAccountFxController {
  constructor(private readonly fxService: FxService) {}

  @Post('quote')
  quote(
    @Param('accountId') accountId: string,
    @Body() body: FxQuoteRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.quoteForTradingAccount(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Post('execute')
  execute(
    @Param('accountId') accountId: string,
    @Body() body: FxExecuteRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.executeForTradingAccount(
      this.extractUserId(request),
      accountId,
      body,
    );
  }

  @Get('transactions')
  transactions(
    @Param('accountId') accountId: string,
    @Query() query: FxExchangesQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.getExchangesForTradingAccount(
      this.extractUserId(request),
      accountId,
      query,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
