import { Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { FxService } from './fx.service';
import type { FxExecuteRequestBody, FxQuoteRequestBody } from './fx.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/fx')
export class FxController {
  constructor(private readonly fxService: FxService) {}

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
