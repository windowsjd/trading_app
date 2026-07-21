import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { OperatorGuard } from './operator.guard';
import {
  OperatorMarketSessionOverrideService,
  type MarketSessionOverrideStatusBody,
  type MarketSessionOverrideUpdateBody,
  type MarketSessionOverrideUpsertBody,
} from './operator-market-session-override.service';

@Controller('api/v1/operator')
@UseGuards(OperatorGuard)
export class OperatorMarketSessionOverrideController {
  constructor(
    private readonly overrideService: OperatorMarketSessionOverrideService,
  ) {}

  @Get('market-session-overrides')
  listOverrides(
    @Req() request: AuthenticatedRequest,
    @Query('market') market?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.overrideService.listOverrides(request.user, {
      market,
      from,
      to,
      includeInactive,
    });
  }

  @Get('market-session-overrides/:overrideId')
  getOverride(
    @Req() request: AuthenticatedRequest,
    @Param('overrideId') overrideId: string,
  ) {
    return this.overrideService.getOverride(request.user, overrideId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('market-session-overrides')
  upsertOverride(
    @Req() request: AuthenticatedRequest,
    @Body() body: MarketSessionOverrideUpsertBody,
  ) {
    return this.overrideService.upsertOverride(
      request.user,
      body,
      this.getRequestContext(request),
    );
  }

  @Patch('market-session-overrides/:overrideId')
  updateOverride(
    @Req() request: AuthenticatedRequest,
    @Param('overrideId') overrideId: string,
    @Body() body: MarketSessionOverrideUpdateBody,
  ) {
    return this.overrideService.updateOverride(
      request.user,
      overrideId,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('market-session-overrides/:overrideId/deactivate')
  deactivateOverride(
    @Req() request: AuthenticatedRequest,
    @Param('overrideId') overrideId: string,
    @Body() body: MarketSessionOverrideStatusBody,
  ) {
    return this.overrideService.deactivateOverride(
      request.user,
      overrideId,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('market-session-overrides/:overrideId/reactivate')
  reactivateOverride(
    @Req() request: AuthenticatedRequest,
    @Param('overrideId') overrideId: string,
    @Body() body: MarketSessionOverrideStatusBody,
  ) {
    return this.overrideService.reactivateOverride(
      request.user,
      overrideId,
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
