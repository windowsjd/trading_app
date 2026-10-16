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
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { FuturesTpSlService } from './futures-tp-sl.service';
type AuthenticatedRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/futures/tp-sl-settings')
export class FuturesTpSlController {
  constructor(private readonly settings: FuturesTpSlService) {}
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
        state: 'INVALID_PAGINATION',
        positionId: 'INVALID_FUTURES_TP_SL',
        instrumentId: 'INVALID_FUTURES_TP_SL',
      }),
    )
    query: {
      limit?: string;
      offset?: string;
      state?: string;
      positionId?: string;
      instrumentId?: string;
    },
  ) {
    return this.settings.list(req.user?.userId, id, query);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Body() body: unknown,
  ) {
    return this.settings.create(req.user?.userId, id, body);
  }
  @Post(':settingId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Param('settingId') settingId: string,
  ) {
    return this.settings.cancel(req.user?.userId, id, settingId);
  }
}
