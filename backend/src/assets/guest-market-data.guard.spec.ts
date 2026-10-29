import { HttpException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { IS_OPTIONAL_AUTH_ROUTE_KEY } from '../auth/auth.decorators';
import {
  GuestFuturesMarketDataGuard,
  GuestFuturesMarketDataRead,
  GuestMarketDataGuard,
  GuestMarketDataRead,
} from './guest-market-data.guard';

const context = (user?: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as never;

describe('GuestMarketDataGuard', () => {
  const previous = process.env.GUEST_MARKET_DATA_ASSET_TYPES;
  afterEach(() => {
    if (previous === undefined)
      delete process.env.GUEST_MARKET_DATA_ASSET_TYPES;
    else process.env.GUEST_MARKET_DATA_ASSET_TYPES = previous;
  });

  it('stops an anonymous request with the global guard 401 while guest market data is off', () => {
    process.env.GUEST_MARKET_DATA_ASSET_TYPES = 'none';
    const guard = new GuestMarketDataGuard();
    let thrown: unknown;
    try {
      guard.canActivate(context());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(401);
    expect((thrown as HttpException).getResponse()).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Unauthorized' },
    });
    expect(guard.canActivate(context({ userId: 'user-1' }))).toBe(true);
  });

  it('lets an anonymous request through to the scoped services once a type is configured', () => {
    process.env.GUEST_MARKET_DATA_ASSET_TYPES = 'crypto';
    expect(new GuestMarketDataGuard().canActivate(context())).toBe(true);
  });

  it('lets an anonymous request through by default (unset: every market)', () => {
    delete process.env.GUEST_MARKET_DATA_ASSET_TYPES;
    expect(new GuestMarketDataGuard().canActivate(context())).toBe(true);
    expect(new GuestFuturesMarketDataGuard().canActivate(context())).toBe(true);
  });

  it('keeps spot and futures market data apart', () => {
    const status = (guard: { canActivate: (c: never) => boolean }) => {
      try {
        return guard.canActivate(context()) ? 200 : 403;
      } catch (error) {
        return (error as HttpException).getStatus();
      }
    };
    process.env.GUEST_MARKET_DATA_ASSET_TYPES = 'crypto_futures';
    expect(status(new GuestMarketDataGuard())).toBe(401);
    expect(status(new GuestFuturesMarketDataGuard())).toBe(200);
    process.env.GUEST_MARKET_DATA_ASSET_TYPES =
      'domestic_stock,us_stock,crypto';
    expect(status(new GuestMarketDataGuard())).toBe(200);
    expect(status(new GuestFuturesMarketDataGuard())).toBe(401);
    // A signed-in request is never this guard's decision.
    process.env.GUEST_MARKET_DATA_ASSET_TYPES = 'none';
    expect(
      new GuestFuturesMarketDataGuard().canActivate(
        context({ userId: 'user-1' }),
      ),
    ).toBe(true);
  });

  it('marks a route optional-auth and guarded by it', () => {
    class Probe {
      @GuestMarketDataRead()
      read() {}
    }
    // The decorated handler itself, as Nest's reflector reads it.
    const handler = Object.getOwnPropertyDescriptor(Probe.prototype, 'read')
      ?.value as object;
    expect(Reflect.getMetadata(IS_OPTIONAL_AUTH_ROUTE_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([
      GuestMarketDataGuard,
    ]);
    class FuturesProbe {
      @GuestFuturesMarketDataRead()
      read() {}
    }
    const futuresHandler = Object.getOwnPropertyDescriptor(
      FuturesProbe.prototype,
      'read',
    )?.value as object;
    expect(
      Reflect.getMetadata(IS_OPTIONAL_AUTH_ROUTE_KEY, futuresHandler),
    ).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, futuresHandler)).toEqual([
      GuestFuturesMarketDataGuard,
    ]);
  });
});
