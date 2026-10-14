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
import { FuturesConditionalEntryService } from './futures-conditional-entry.service';
type AuthenticatedRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/futures/conditional-entries')
export class FuturesConditionalEntryController {
  constructor(private readonly entries: FuturesConditionalEntryService) {}
  @Get()
  list(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
        state: 'INVALID_PAGINATION',
        instrumentId: 'INVALID_FUTURES_CONDITIONAL_ENTRY',
      }),
    )
    query: {
      limit?: string;
      offset?: string;
      state?: string;
      instrumentId?: string;
    },
  ) {
    return this.entries.list(req.user?.userId, id, query);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Body() body: unknown,
  ) {
    return this.entries.create(req.user?.userId, id, body);
  }
  @Post(':entryId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthenticatedRequest,
    @Param('accountId') id: string,
    @Param('entryId') entryId: string,
  ) {
    return this.entries.cancel(req.user?.userId, id, entryId);
  }
}
