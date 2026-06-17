import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { OperatorAccountManagementService } from './operator-account-management.service';
import type {
  RoleChangeBody,
  UserManagementQuery,
} from './operator-account-management.service';

@Controller('api/v1/operator')
export class AdminUserManagementController {
  constructor(
    private readonly accountManagementService: OperatorAccountManagementService,
  ) {}

  @Get('users')
  listUsers(
    @Req() request: AuthenticatedRequest,
    @Query() query: UserManagementQuery,
  ) {
    return this.accountManagementService.listUsers(
      request.user,
      query,
      this.getRequestContext(request),
    );
  }

  @Get('users/:userId')
  getUser(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
  ) {
    return this.accountManagementService.getUser(
      request.user,
      userId,
      this.getRequestContext(request),
    );
  }

  @Patch('users/:userId/role')
  updateUserRole(
    @Req() request: AuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() body: RoleChangeBody,
  ) {
    return this.accountManagementService.updateUserRole(
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
