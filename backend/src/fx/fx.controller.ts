import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
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

  @Get('rates/current')
  currentRate(@Query() query: FxCurrentRateQuery) {
    return this.fxService.currentRate(query);
  }

  @Get('exchanges')
  exchanges(
    @Query() query: FxExchangesQuery,
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
