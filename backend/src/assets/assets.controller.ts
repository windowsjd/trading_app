import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
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

  @Get()
  getAssets(@Req() request: AuthenticatedRequest, @Query() query: AssetsQuery) {
    return this.assetsService.getAssets(this.extractUserId(request), query);
  }

  @Get(':assetId/candles')
  getAssetCandles(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
    @Query() query: AssetCandlesQuery,
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
