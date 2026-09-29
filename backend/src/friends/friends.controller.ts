import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { FriendsService } from './friends.service';
import type { FriendsQuery } from './friends.service';

const pagePipe = new ScalarQueryPipe({
  nickname: 'INVALID_NICKNAME',
  limit: 'INVALID_PAGINATION',
  offset: 'INVALID_PAGINATION',
});

@Controller('api/v1/friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}
  @Get('search')
  search(
    @Req() request: AuthenticatedRequest,
    @Query(pagePipe) query: FriendsQuery,
  ) {
    return this.friends.search(request.user?.userId, query);
  }
  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query(pagePipe) query: FriendsQuery,
  ) {
    return this.friends.list(request.user?.userId, query);
  }
  @Get('requests')
  requests(
    @Req() request: AuthenticatedRequest,
    @Query(pagePipe) query: FriendsQuery,
  ) {
    return this.friends.list(request.user?.userId, query, true);
  }
  @Post('requests')
  send(
    @Req() request: AuthenticatedRequest,
    @Body() body: { userId?: unknown },
  ) {
    return this.friends.request(request.user?.userId, body);
  }
  @Post('requests/:id/accept')
  accept(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.friends.respond(request.user?.userId, id, true);
  }
  @Post('requests/:id/reject')
  reject(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.friends.respond(request.user?.userId, id, false);
  }
  @Delete(':id')
  remove(@Req() request: AuthenticatedRequest, @Param('id') id: string) {
    return this.friends.remove(request.user?.userId, id);
  }
}
