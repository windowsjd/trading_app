import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ScalarQueryPipe } from '../common/scalar-query.pipe';
import { ConditionalService, type ProtectionBody } from './conditional.service';
type AuthRequest = Request & { user?: { userId?: string } };
@Controller('api/v1/trading-accounts/:accountId/protections')
export class ConditionalController {
  constructor(private readonly service: ConditionalService) {}
  @Get()
  list(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Query(
      new ScalarQueryPipe({
        limit: 'INVALID_PAGINATION',
        offset: 'INVALID_PAGINATION',
        assetId: 'INVALID_PROTECTION',
        domain: 'INVALID_PROTECTION',
        history: 'INVALID_PROTECTION',
      }),
    )
    query: {
      limit?: string;
      offset?: string;
      assetId?: string;
      domain?: string;
      history?: string;
    },
  ) {
    return this.service.list(req.user?.userId, id, query);
  }
  @Post()
  @HttpCode(200)
  create(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Body() body: ProtectionBody,
  ) {
    return this.service.create(req.user?.userId, id, body);
  }
  @Post(':groupId/cancel')
  @HttpCode(200)
  cancel(
    @Req() req: AuthRequest,
    @Param('accountId') id: string,
    @Param('groupId') groupId: string,
    @Body() body: { idempotencyKey?: unknown },
  ) {
    return this.service.cancelGroup(req.user?.userId, id, groupId, body);
  }
}
