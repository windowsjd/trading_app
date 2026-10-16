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
import { EntryTpSlService } from './entry-tp-sl.service';
type AuthRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/entry-tp-sl-plans')
export class EntryTpSlController {
  constructor(private readonly service: EntryTpSlService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        entryType: 'INVALID_ENTRY_TP_SL',
        entryId: 'INVALID_ENTRY_TP_SL',
        state: 'INVALID_PAGINATION',
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
      }),
    )
    query: {
      entryType?: string;
      entryId?: string;
      state?: string;
      limit?: string;
      offset?: string;
    },
  ) {
    return this.service.list(req.user?.userId, id, query);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Body() body: unknown,
  ) {
    return this.service.create(req.user?.userId, id, body);
  }
  @Post(':planId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Param('planId') planId: string,
  ) {
    return this.service.cancel(req.user?.userId, id, planId);
  }
}
