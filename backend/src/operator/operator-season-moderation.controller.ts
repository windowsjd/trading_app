import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { OperatorGuard } from './operator.guard';
import {
  OperatorSeasonModerationService,
  type SeasonParticipantExcludeBody,
  type SeasonParticipantFinalResultBody,
  type SeasonParticipantRankingVisibilityBody,
} from './operator-season-moderation.service';

@Controller('api/v1/operator')
@UseGuards(OperatorGuard)
export class OperatorSeasonModerationController {
  constructor(
    private readonly moderationService: OperatorSeasonModerationService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('seasons/:seasonId/participants/:seasonParticipantId/exclude')
  excludeParticipant(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Param('seasonParticipantId') seasonParticipantId: string,
    @Body() body: SeasonParticipantExcludeBody,
  ) {
    return this.moderationService.excludeParticipant(
      request.user,
      seasonId,
      seasonParticipantId,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('seasons/:seasonId/participants/:seasonParticipantId/hide-ranking')
  setRankingVisibility(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Param('seasonParticipantId') seasonParticipantId: string,
    @Body() body: SeasonParticipantRankingVisibilityBody,
  ) {
    return this.moderationService.setRankingVisibility(
      request.user,
      seasonId,
      seasonParticipantId,
      body,
      this.getRequestContext(request),
    );
  }

  @Patch('seasons/:seasonId/participants/:seasonParticipantId/final-result')
  correctFinalResult(
    @Req() request: AuthenticatedRequest,
    @Param('seasonId') seasonId: string,
    @Param('seasonParticipantId') seasonParticipantId: string,
    @Body() body: SeasonParticipantFinalResultBody,
  ) {
    return this.moderationService.correctFinalResult(
      request.user,
      seasonId,
      seasonParticipantId,
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
