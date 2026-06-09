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
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  RewardFulfillmentService,
  type RewardFulfillmentActionBody,
  type RewardFulfillmentCreateBody,
  type RewardFulfillmentQuery,
} from './reward-fulfillment.service';

@Controller('api/v1/operator/reward-fulfillments')
export class OperatorRewardFulfillmentController {
  constructor(
    private readonly rewardFulfillmentService: RewardFulfillmentService,
  ) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: RewardFulfillmentQuery,
  ) {
    return this.rewardFulfillmentService.listFulfillments(
      request.user,
      query,
      this.getRequestContext(request),
    );
  }

  @Get(':fulfillmentId')
  get(
    @Req() request: AuthenticatedRequest,
    @Param('fulfillmentId') fulfillmentId: string,
  ) {
    return this.rewardFulfillmentService.getFulfillment(
      request.user,
      fulfillmentId,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post()
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: RewardFulfillmentCreateBody,
  ) {
    return this.rewardFulfillmentService.createFulfillment(
      request.user,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post(':fulfillmentId/fulfill')
  fulfill(
    @Req() request: AuthenticatedRequest,
    @Param('fulfillmentId') fulfillmentId: string,
    @Body() body: RewardFulfillmentActionBody,
  ) {
    return this.rewardFulfillmentService.fulfill(
      request.user,
      fulfillmentId,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post(':fulfillmentId/cancel')
  cancel(
    @Req() request: AuthenticatedRequest,
    @Param('fulfillmentId') fulfillmentId: string,
    @Body() body: RewardFulfillmentActionBody,
  ) {
    return this.rewardFulfillmentService.cancel(
      request.user,
      fulfillmentId,
      body,
      this.getRequestContext(request),
    );
  }

  private getRequestContext(request: AuthenticatedRequest) {
    return {
      requestId: this.getHeader(request, 'x-request-id'),
      ipAddress: request.ip ?? null,
      userAgent: this.getHeader(request, 'user-agent'),
    };
  }

  private getHeader(request: AuthenticatedRequest, name: string) {
    const value = request.headers[name];
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }

    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : null;
  }
}
