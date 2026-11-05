import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { PendingOrderEventsService } from './pending-order-events.service';

type AuthRequest = Request & { user?: { userId?: string } };

/** Read-only: the account's confirmed trigger and fill events after a cursor. */
@Controller('api/v1/trading-accounts/:accountId/pending-order-events')
export class PendingOrderEventsController {
  constructor(private readonly events: PendingOrderEventsService) {}

  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('accountId') accountId: string,
    @Query(new ScalarQueryPipe({ after: 'INVALID_EVENT_CURSOR' }))
    query: { after?: string },
  ) {
    return this.events.list(req.user?.userId, accountId, query);
  }
}
