import {
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { WatchlistService } from './watchlist.service';
import type { WatchlistAssetsQuery } from './watchlist.service';

const assetsPipe = new ScalarQueryPipe({
  assetType: 'INVALID_ASSET_TYPE',
} satisfies Record<keyof WatchlistAssetsQuery, string>);

/** Authenticated by the global access-token guard; every route is the
 * caller's own list, identified by the token and never by request input. */
@Controller('api/v1/watchlist')
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.watchlist.list(request.user?.userId);
  }

  @Get('assets')
  listAssets(
    @Req() request: AuthenticatedRequest,
    @Query(assetsPipe) query: WatchlistAssetsQuery,
  ) {
    return this.watchlist.listAssets(request.user?.userId, query);
  }

  @Put(':assetId')
  add(@Req() request: AuthenticatedRequest, @Param('assetId') assetId: string) {
    return this.watchlist.add(request.user?.userId, assetId);
  }

  @Delete(':assetId')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('assetId') assetId: string,
  ) {
    return this.watchlist.remove(request.user?.userId, assetId);
  }
}
