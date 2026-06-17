import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RecordsService } from './records.service';
import type {
  MySeasonExchangesQuery,
  MySeasonOrdersQuery,
  MySeasonRecordsQuery,
  RecordsQuery,
} from './records.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1')
export class RecordsController {
  constructor(private readonly recordsService: RecordsService) {}

  @Get('records')
  getRecords(
    @Req() request: AuthenticatedRequest,
    @Query() query: RecordsQuery,
  ) {
    return this.recordsService.getRecords(this.extractUserId(request), query);
  }

  @Get('records/me/seasons')
  getMySeasonRecords(
    @Req() request: AuthenticatedRequest,
    @Query() query: MySeasonRecordsQuery,
  ) {
    return this.recordsService.getMySeasonRecords(
      this.extractUserId(request),
      query,
    );
  }

  @Get('records/me/seasons/:seasonId')
  getMySeasonRecordDetail(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
  ) {
    return this.recordsService.getMySeasonRecordDetail(
      this.extractUserId(request),
      seasonId,
    );
  }

  @Get('records/me/seasons/:seasonId/orders')
  getMySeasonOrders(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Query() query: MySeasonOrdersQuery,
  ) {
    return this.recordsService.getMySeasonOrders(
      this.extractUserId(request),
      seasonId,
      query,
    );
  }

  @Get('records/me/seasons/:seasonId/exchanges')
  getMySeasonExchanges(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Query() query: MySeasonExchangesQuery,
  ) {
    return this.recordsService.getMySeasonExchanges(
      this.extractUserId(request),
      seasonId,
      query,
    );
  }

  @Get('users/:userId/records/:seasonId')
  getUserSeasonRecordSummary(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('seasonId') seasonId: string,
  ) {
    return this.recordsService.getUserSeasonRecordSummary(
      this.extractUserId(request),
      userId,
      seasonId,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
