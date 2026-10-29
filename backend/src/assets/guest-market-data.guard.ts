import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { OptionalAuth } from '../auth/auth.decorators';
import { createApiError } from '../common/api-error';
import { readGuestMarketDataAssetTypes } from './guest-market-data.config';

/**
 * Runs after the global AccessTokenGuard and before any pipe. With no guest
 * scope configured, an anonymous request stops here with the guard's own 401,
 * exactly where it stopped before guest browsing (authentication still comes
 * before query validation). A signed-in request, or a configured scope, goes
 * on; the services then serve an anonymous caller its scope only.
 */
@Injectable()
export class GuestMarketDataGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: unknown }>();
    if (request.user || readGuestMarketDataAssetTypes().length) return true;
    // The global guard's own body: { code: 'UNAUTHORIZED', message: 'Unauthorized' }.
    throw createApiError(
      'UNAUTHORIZED',
      'Unauthorized',
      HttpStatus.UNAUTHORIZED,
    );
  }
}

/** An account-free market read that guest browsing may reach (2026-10-30). */
export const GuestMarketDataRead = () =>
  applyDecorators(OptionalAuth(), UseGuards(GuestMarketDataGuard));
