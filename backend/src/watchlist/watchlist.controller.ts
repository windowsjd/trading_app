import { Controller, Delete, Get, Param, Put, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { WatchlistService } from './watchlist.service';

@Controller('api/v1/watchlist')
export class WatchlistController {
  constructor(private readonly watchlist: WatchlistService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.watchlist.list(request.user?.userId);
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
