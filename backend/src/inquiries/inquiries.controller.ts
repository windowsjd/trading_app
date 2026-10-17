import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { OperatorGuard } from '../operator/operator.guard';
import { InquiriesService } from './inquiries.service';
import type { InquiriesQuery, InquiryBody } from './inquiries.service';
import { OperatorInquiriesService } from './operator-inquiries.service';
import type { OperatorInquiriesQuery } from './operator-inquiries.service';

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

const operatorPagePipe = new ScalarQueryPipe({
  status: 'INVALID_INQUIRY_STATUS',
  limit: 'INVALID_PAGINATION',
  offset: 'INVALID_PAGINATION',
} satisfies Record<keyof OperatorInquiriesQuery, string>);

/** Operator/admin only (current DB role via OperatorGuard): read every
 * inquiry and post its one official answer. */
@Controller('api/v1/operator/inquiries')
@UseGuards(OperatorGuard)
export class OperatorInquiriesController {
  constructor(private readonly inquiries: OperatorInquiriesService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query(operatorPagePipe) query: OperatorInquiriesQuery,
  ) {
    return this.inquiries.list(request.user, query, this.context(request));
  }

  @Get(':inquiryId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('inquiryId') inquiryId: string,
  ) {
    return this.inquiries.get(request.user, inquiryId, this.context(request));
  }

  @Post(':inquiryId/answer')
  @HttpCode(HttpStatus.CREATED)
  answer(
    @Req() request: AuthenticatedRequest,
    @Param('inquiryId') inquiryId: string,
    @Body() body: unknown,
  ) {
    return this.inquiries.answer(
      request.user,
      inquiryId,
      body,
      this.context(request),
    );
  }

  private context(request: AuthenticatedRequest) {
    const header = (name: string) => {
      const value = request.headers[name];
      const first = Array.isArray(value) ? value[0] : value;
      return typeof first === 'string' && first.trim() ? first.trim() : null;
    };
    return {
      requestId: header('x-request-id'),
      ipAddress: request.ip ?? null,
      userAgent: header('user-agent'),
    };
  }
}
