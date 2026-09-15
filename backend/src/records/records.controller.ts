import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { Request } from 'express';
import { RecordsService } from './records.service';
import type {
  MySeasonEquityQuery,
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
    @Query(
      new ScalarQueryPipe({
        seasonId: 'VALIDATION_ERROR',
        type: 'INVALID_RECORD_TYPE',
        currencyCode: 'INVALID_CURRENCY_CODE',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof RecordsQuery, string>),
    )
    query: RecordsQuery,
  ) {
    return this.recordsService.getRecords(this.extractUserId(request), query);
  }

  @Get('records/me/seasons')
  getMySeasonRecords(
    @Req() request: AuthenticatedRequest,
    @Query(
      new ScalarQueryPipe({
        seasonStatus: 'INVALID_SEASON_STATUS',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof MySeasonRecordsQuery, string>),
    )
    query: MySeasonRecordsQuery,
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

  @Get('records/me/seasons/:seasonId/equity')
  getMySeasonEquity(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof MySeasonEquityQuery, string>),
    )
    query: MySeasonEquityQuery,
  ) {
    return this.recordsService.getMySeasonEquity(
      this.extractUserId(request),
      seasonId,
      query,
    );
  }

  @Get('records/me/seasons/:seasonId/orders')
  getMySeasonOrders(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Query(
      new ScalarQueryPipe({
        status: 'INVALID_ORDER_STATUS',
        side: 'INVALID_ORDER_SIDE',
        assetId: 'VALIDATION_ERROR',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof MySeasonOrdersQuery, string>),
    )
    query: MySeasonOrdersQuery,
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
    @Query(
      new ScalarQueryPipe({
        fromCurrency: 'INVALID_FROM_CURRENCY',
        toCurrency: 'INVALID_TO_CURRENCY',
        limit: 'INVALID_LIMIT',
        offset: 'INVALID_OFFSET',
      } satisfies Record<keyof MySeasonExchangesQuery, string>),
    )
    query: MySeasonExchangesQuery,
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

  @Get('users/:userId/season-summary')
  getUserCurrentSeasonSummary(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
  ) {
    return this.recordsService.getUserCurrentSeasonSummary(
      this.extractUserId(request),
      userId,
    );
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
