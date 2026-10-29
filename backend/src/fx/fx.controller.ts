import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { GuestFuturesMarketDataRead } from '../assets/guest-market-data.guard';
import { FxService } from './fx.service';
import type {
  FxCurrentRateQuery,
  FxExchangesQuery,
  FxExecuteRequestBody,
  FxQuoteRequestBody,
} from './fx.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/fx')
export class FxController {
  constructor(private readonly fxService: FxService) {}

  // The USD/KRW display rate is market data, not account data: guest browsing
  // reads it for a futures contract's won figure (crypto_futures guest scope,
  // 2026-10-30). An anonymous read never asks for a provider refresh.
  @GuestFuturesMarketDataRead()
  @Get('rates/current')
  currentRate(
    @Query(
      new ScalarQueryPipe({
        baseCurrency: 'UNSUPPORTED_FX_PAIR',
        quoteCurrency: 'UNSUPPORTED_FX_PAIR',
        refresh: 'INVALID_REFRESH',
      } satisfies Record<keyof FxCurrentRateQuery, string>),
    )
    query: FxCurrentRateQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.currentRate(query, {
      allowRefresh: !!this.extractUserId(request),
    });
  }

  @Get('exchanges')
  exchanges(
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof FxExchangesQuery, string>),
    )
    query: FxExchangesQuery,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.getExchanges(this.extractUserId(request), query);
  }

  @Post('quote')
  quote(
    @Body() body: FxQuoteRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.quote(this.extractUserId(request), body);
  }

  @Post('execute')
  execute(
    @Body() body: FxExecuteRequestBody,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.fxService.execute(this.extractUserId(request), body);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
