import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import {
  OperatorUserStatusService,
  type UserRestoreBody,
  type UserStatusChangeBody,
} from './operator-user-status.service';

@Controller('api/v1/operator')
export class AdminUserStatusController {
  constructor(
    private readonly userStatusService: OperatorUserStatusService,
  ) {}

  @Patch('users/:userId/status')
  updateUserStatus(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: UserStatusChangeBody,
  ) {
    return this.userStatusService.updateUserStatus(
      request.user,
      userId,
      body,
      this.getRequestContext(request),
    );
  }

  @HttpCode(HttpStatus.OK)
  @Post('users/:userId/restore')
  restoreUser(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: UserRestoreBody,
  ) {
    return this.userStatusService.restoreUser(
      request.user,
      userId,
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
