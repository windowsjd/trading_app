import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import { GuestFuturesMarketDataRead } from '../assets/guest-market-data.guard';
import { FuturesService } from './futures.service';

type AuthenticatedRequest = Request & { user?: { userId?: string } };

/**
 * Futures contract market data that no account owns (guest browsing,
 * 2026-10-30): the contract list with Futures Last, Mark and 24h statistics.
 * Signed in or (with the `crypto_futures` guest scope) not; positions,
 * collateral, capabilities and every command stay under
 * /trading-accounts/:accountId/futures.
 */
@Controller('api/v1/futures/instruments')
export class FuturesMarketController {
  constructor(private readonly futures: FuturesService) {}

  @GuestFuturesMarketDataRead()
  @Get()
  instruments(@Req() req: AuthenticatedRequest) {
    return this.futures.marketInstruments(req.user?.userId);
  }
}
