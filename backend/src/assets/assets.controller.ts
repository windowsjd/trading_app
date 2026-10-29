import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { GuestMarketDataRead } from './guest-market-data.guard';
import { AssetCandlesService } from './asset-candles.service';
import type { AssetCandlesQuery } from './asset-candles.service';
import { AssetsService } from './assets.service';
import type { AssetsQuery } from './assets.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/assets')
export class AssetsController {
  constructor(
    private readonly assetsService: AssetsService,
    private readonly assetCandlesService: AssetCandlesService,
  ) {}

  // Guest-readable market data (2026-10-30): with GUEST_MARKET_DATA_ASSET_TYPES
  // configured, a request without a token reaches the service, which serves
  // only that scope; otherwise it stops at the existing 401 before any pipe.
  // A token that is sent is still verified by the global guard. The price
  // route stays signed-in only.
  @GuestMarketDataRead()
  @Get()
  getAssets(
    @Req() request: AuthenticatedRequest,
    @Query(
      new ScalarQueryPipe({
        assetType: 'INVALID_ASSET_TYPE',
        currencyCode: 'INVALID_CURRENCY_CODE',
        market: 'VALIDATION_ERROR',
        search: 'VALIDATION_ERROR',
        includeInactive: 'INVALID_INCLUDE_INACTIVE',
        withPrice: 'INVALID_WITH_PRICE',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
        sortBy: 'INVALID_ASSET_SORT',
        sortOrder: 'INVALID_ASSET_SORT',
        sortSnapshot: 'INVALID_SORT_SNAPSHOT',
        sortRefresh: 'INVALID_ASSET_SORT',
      } satisfies Record<keyof AssetsQuery, string>),
    )
    query: AssetsQuery,
  ) {
    return this.assetsService.getAssets(this.extractUserId(request), query);
  }

  @GuestMarketDataRead()
  @Get(':assetId/candles')
  getAssetCandles(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Query(
      new ScalarQueryPipe({
        interval: 'ASSET_CANDLES_INVALID_INTERVAL',
        range: 'ASSET_CANDLES_INVALID_RANGE',
        limit: 'INVALID_CANDLE_LIMIT',
        date: 'INVALID_CANDLE_DATE',
        to: 'INVALID_CANDLE_TO',
        includePrevious: 'INVALID_CANDLE_INCLUDE_PREVIOUS',
      } satisfies Record<keyof AssetCandlesQuery, string>),
    )
    query: AssetCandlesQuery,
  ) {
    return this.assetCandlesService.getAssetCandles(
      this.extractUserId(request),
      assetId,
      query,
    );
  }

  @Get(':assetId/price')
  getAssetPrice(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAssetPrice(
      this.extractUserId(request),
      assetId,
    );
  }

  @GuestMarketDataRead()
  @Get(':assetId')
  getAsset(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.getAsset(this.extractUserId(request), assetId);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
