import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  IS_OPTIONAL_AUTH_ROUTE_KEY,
  IS_PUBLIC_ROUTE_KEY,
} from './auth.decorators';
import type { AccessTokenPayload, AuthenticatedRequest } from './auth.types';

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const isOptionalAuth = this.reflector.getAllAndOverride<boolean>(
      IS_OPTIONAL_AUTH_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = this.getAuthorizationHeader(request);

    if (!authorization) {
      if (isOptionalAuth) {
        return true;
      }

      this.throwUnauthorized();
    }

    const token = this.parseBearerToken(authorization);
    if (!token) {
      this.throwUnauthorized();
    }

    const payload = await this.verifyToken(token);
    const userId = this.extractSubject(payload);
    if (!userId) {
      this.throwUnauthorized();
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      this.throwUnauthorized();
    }

    if (user.status !== UserStatus.active) {
      this.throwUserNotActive();
    }

    request.user = {
      userId: user.id,
      role: user.role,
    };

    return true;
  }

  private getAuthorizationHeader(request: AuthenticatedRequest) {
    const authorization = request.headers.authorization;
    return Array.isArray(authorization) ? undefined : authorization;
  }

  private parseBearerToken(authorization: string) {
    const parts = authorization.trim().split(/\s+/);
    if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) {
      return null;
    }

    return parts[1];
  }

  private async verifyToken(token: string): Promise<AccessTokenPayload> {
    const secret = this.getAccessSecret();

    try {
      return await this.jwtService.verifyAsync<AccessTokenPayload>(token, {
        secret,
      });
    } catch {
      this.throwUnauthorized();
    }
  }

  private extractSubject(payload: AccessTokenPayload) {
    return typeof payload.sub === 'string' && payload.sub.trim()
      ? payload.sub
      : null;
  }

  private getAccessSecret() {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET')?.trim();
    if (!secret) {
      throw new InternalServerErrorException(
        this.createErrorBody(
          'AUTH_CONFIGURATION_ERROR',
          'Auth configuration is missing.',
        ),
      );
    }

    return secret;
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

  private throwUnauthorized(): never {
    throw new UnauthorizedException(
      this.createErrorBody('UNAUTHORIZED', 'Unauthorized'),
    );
  }

  private throwUserNotActive(): never {
    throw new ForbiddenException(
      this.createErrorBody('USER_NOT_ACTIVE', 'User is not active.'),
    );
  }
}
