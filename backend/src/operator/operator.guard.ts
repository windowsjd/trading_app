import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UserRole } from '../generated/prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';

export function hasOperatorRole(role: UserRole | undefined): boolean {
  return role === UserRole.operator || role === UserRole.admin;
}

export function hasAdminRole(role: UserRole | undefined): boolean {
  return role === UserRole.admin;
}

@Injectable()
export class OperatorGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException(
        this.createErrorBody('UNAUTHORIZED', 'Unauthorized'),
      );
    }

    if (!hasOperatorRole(user.role)) {
      throw new ForbiddenException(
        this.createErrorBody(
          'OPERATOR_FORBIDDEN',
          'Operator role is required.',
        ),
      );
    }

    return true;
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException(
        this.createErrorBody('UNAUTHORIZED', 'Unauthorized'),
      );
    }

    if (!hasAdminRole(user.role)) {
      throw new ForbiddenException(
        this.createErrorBody('ADMIN_FORBIDDEN', 'Admin role is required.'),
      );
    }

    return true;
  }

  private createErrorBody(code: string, message: string) {
    return {
      success: false,
      error: {
        code,
        message,
      },
    };
  }
}
