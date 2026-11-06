import { Controller, Get, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CompletedTradesService } from './completed-trades.service';

type AuthRequest = Request & { user?: { userId?: string } };

/** Read-only: the owner's completed trades with their share-card evidence. */
@Controller('api/v1/trading-accounts/:accountId/completed-trades')
export class CompletedTradesController {
  constructor(private readonly trades: CompletedTradesService) {}

  @Get()
  list(@Req() req: AuthRequest, @Param('accountId') accountId: string) {
    return this.trades.list(req.user?.userId, accountId);
  }
}
