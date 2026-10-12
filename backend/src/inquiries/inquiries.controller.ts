import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { InquiriesService } from './inquiries.service';
import type { InquiriesQuery, InquiryBody } from './inquiries.service';

const pagePipe = new ScalarQueryPipe({
  limit: 'INVALID_PAGINATION',
  offset: 'INVALID_PAGINATION',
} satisfies Record<keyof InquiriesQuery, string>);

/** Authenticated by the global access-token guard; every route is the caller's own. */
@Controller('api/v1/inquiries')
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Req() request: AuthenticatedRequest, @Body() body: InquiryBody) {
    return this.inquiries.create(request.user?.userId, body);
  }

  @Get('me')
  listMine(
    @Req() request: AuthenticatedRequest,
    @Query(pagePipe) query: InquiriesQuery,
  ) {
    return this.inquiries.listMine(request.user?.userId, query);
  }
}
