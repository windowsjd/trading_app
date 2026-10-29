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
import {
  isGuestFuturesMarketDataEnabled,
  readGuestMarketDataAssetTypes,
} from './guest-market-data.config';

function allowAnonymous(context: ExecutionContext, inScope: () => boolean) {
  const request = context.switchToHttp().getRequest<{ user?: unknown }>();
  if (request.user || inScope()) return true;
  // The global guard's own body: { code: 'UNAUTHORIZED', message: 'Unauthorized' }.
  throw createApiError('UNAUTHORIZED', 'Unauthorized', HttpStatus.UNAUTHORIZED);
}

/**
 * Runs after the global AccessTokenGuard and before any pipe. With guest
 * market data off (`none`, or a scope without this route's market), an
 * anonymous request stops here with the guard's own 401, exactly where it
 * stopped before guest browsing (authentication still comes before query
 * validation). A signed-in request, or a scope that serves the route, goes
 * on; the services then serve an anonymous caller its scope only.
 */
@Injectable()
export class GuestMarketDataGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return allowAnonymous(
      context,
      () => readGuestMarketDataAssetTypes().length > 0,
    );
  }
}

/** The same, for futures contract market data: the `crypto_futures` scope. */
@Injectable()
export class GuestFuturesMarketDataGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    return allowAnonymous(context, () => isGuestFuturesMarketDataEnabled());
  }
}

/** An account-free market read that guest browsing may reach (2026-10-30). */
export const GuestMarketDataRead = () =>
  applyDecorators(OptionalAuth(), UseGuards(GuestMarketDataGuard));

/** An account-free futures market read that guest browsing may reach (2026-10-30). */
export const GuestFuturesMarketDataRead = () =>
  applyDecorators(OptionalAuth(), UseGuards(GuestFuturesMarketDataGuard));
