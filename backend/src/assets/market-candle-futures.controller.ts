import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
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
 */
@Controller('api/v1/futures/instruments')
export class FuturesCandlesController {
  constructor(private readonly candles: FuturesCandlesService) {}

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
