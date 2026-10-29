import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { GuestFuturesMarketDataRead } from './guest-market-data.guard';
import {
  FuturesCandlesService,
  type FuturesCandlesQuery,
} from './market-candle-futures.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

/**
 * Futures contract market data (not account-scoped): the chart of one
 * FuturesInstrument, built only from Binance USDⓈ-M contract klines.
 * Guest-readable with the `crypto_futures` guest scope (2026-10-30).
 */
@Controller('api/v1/futures/instruments')
export class FuturesCandlesController {
  constructor(private readonly candles: FuturesCandlesService) {}

  @GuestFuturesMarketDataRead()
  @Get(':instrumentId/candles')
  getInstrumentCandles(
    @Req() request: AuthenticatedRequest,
    @Param('instrumentId') instrumentId: string,
    @Query(
      new ScalarQueryPipe({
        interval: 'FUTURES_CANDLES_INVALID_QUERY',
        range: 'FUTURES_CANDLES_INVALID_QUERY',
        limit: 'FUTURES_CANDLES_INVALID_QUERY',
      } satisfies Record<keyof FuturesCandlesQuery, string>),
    )
    query: FuturesCandlesQuery,
  ) {
    return this.candles.getInstrumentCandles(
      request.user?.userId,
      instrumentId,
      query,
    );
  }
}
