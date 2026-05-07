import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { RecordsService } from './records.service';
import type { RecordsQuery } from './records.service';

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string;
  };
};

@Controller('api/v1/records')
export class RecordsController {
  constructor(private readonly recordsService: RecordsService) {}

  @Get()
  getRecords(
    @Req() request: AuthenticatedRequest,
    @Query() query: RecordsQuery,
  ) {
    return this.recordsService.getRecords(this.extractUserId(request), query);
  }

  private extractUserId(request: AuthenticatedRequest) {
    return request.user?.userId;
  }
}
