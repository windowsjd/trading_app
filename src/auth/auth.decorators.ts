import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE_KEY = 'auth:is-public-route';
export const IS_OPTIONAL_AUTH_ROUTE_KEY = 'auth:is-optional-auth-route';

export const Public = () => SetMetadata(IS_PUBLIC_ROUTE_KEY, true);
export const OptionalAuth = () =>
  SetMetadata(IS_OPTIONAL_AUTH_ROUTE_KEY, true);
