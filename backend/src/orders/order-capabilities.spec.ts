jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});
import { HttpException, HttpStatus } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { readOrderCapabilities } from './order-capabilities';
import { TradingAccountOrderCapabilitiesController } from './trading-account-order-capabilities.controller';
import { TradingAccountAccessService } from '../trading-accounts/trading-account-access.service';

const env = (values: Record<string, string>) =>
  values as unknown as NodeJS.ProcessEnv;
/** US LOC flags need the Tiingo provider (its close-evidence source). */
const tiingo = { US_STOCK_PRICE_PROVIDER: 'tiingo' };

describe('readOrderCapabilities', () => {
  it('reports every gate off by default', () => {
    expect(readOrderCapabilities(env({}))).toEqual({
      limitOrder: { enabled: false, autoExecutionEnabled: false },
      limitOnClose: {
        enabled: false,
        markets: [],
        sides: ['buy'],
        attachedProtection: false,
      },
      limitOnCloseSell: { enabled: false, markets: [] },
    });
  });

  it('lists each market only behind its own side flag (US 2026-10-17)', () => {
    const usOnly = readOrderCapabilities(
      env({
        ...tiingo,
        LIMIT_ORDER_ENABLED: 'true',
        LOC_US_ORDERS_ENABLED: 'true',
      }),
    );
    expect(usOnly.limitOnClose).toEqual({
      enabled: true,
      markets: ['US'],
      sides: ['buy'],
      attachedProtection: false,
    });
    expect(usOnly.limitOnCloseSell).toEqual({ enabled: false, markets: [] });
    const both = readOrderCapabilities(
      env({
        ...tiingo,
        LIMIT_ORDER_ENABLED: 'true',
        LOC_ORDERS_ENABLED: 'true',
        LOC_US_ORDERS_ENABLED: 'true',
        LOC_SELL_ORDERS_ENABLED: 'true',
        LOC_US_SELL_ORDERS_ENABLED: 'true',
      }),
    );
    expect(both.limitOnClose.markets).toEqual(['KRX', 'US']);
    expect(both.limitOnCloseSell).toEqual({
      enabled: true,
      markets: ['KRX', 'US'],
    });
    // KRX only: an old client keeps its exact KRX answer.
    const krxOnly = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'true', LOC_ORDERS_ENABLED: 'true' }),
    );
    expect(krxOnly.limitOnClose.markets).toEqual(['KRX']);
    // US SELL only; never without the limit-order gate.
    expect(
      readOrderCapabilities(
        env({
          ...tiingo,
          LIMIT_ORDER_ENABLED: 'true',
          LOC_US_SELL_ORDERS_ENABLED: 'true',
        }),
      ).limitOnCloseSell,
    ).toEqual({ enabled: true, markets: ['US'] });
    expect(
      readOrderCapabilities(
        env({
          ...tiingo,
          LIMIT_ORDER_ENABLED: 'false',
          LOC_US_ORDERS_ENABLED: 'true',
        }),
      ).limitOnClose,
    ).toMatchObject({ enabled: false, markets: [] });
    expect(() =>
      readOrderCapabilities(
        env({ LIMIT_ORDER_ENABLED: 'true', LOC_US_ORDERS_ENABLED: 'on' }),
      ),
    ).toThrow('LOC_US_ORDERS_ENABLED must be true or false');
    // A US flag without the Tiingo provider is a startup error, never a
    // market that could only expire.
    expect(() =>
      readOrderCapabilities(
        env({ LIMIT_ORDER_ENABLED: 'true', LOC_US_ORDERS_ENABLED: 'true' }),
      ),
    ).toThrow('require US_STOCK_PRICE_PROVIDER=tiingo');
  });

  it('gates LOC SELL by its own flag, never by the BUY flag', () => {
    const buyOnly = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'true', LOC_ORDERS_ENABLED: 'true' }),
    );
    expect(buyOnly.limitOnClose.enabled).toBe(true);
    expect(buyOnly.limitOnCloseSell.enabled).toBe(false);
    const sellOnly = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'true', LOC_SELL_ORDERS_ENABLED: 'true' }),
    );
    expect(sellOnly.limitOnClose.enabled).toBe(false);
    expect(sellOnly.limitOnCloseSell.enabled).toBe(true);
    expect(
      readOrderCapabilities(
        env({ LIMIT_ORDER_ENABLED: 'false', LOC_SELL_ORDERS_ENABLED: 'true' }),
      ).limitOnCloseSell.enabled,
    ).toBe(false);
    expect(() =>
      readOrderCapabilities(
        env({ LIMIT_ORDER_ENABLED: 'true', LOC_SELL_ORDERS_ENABLED: 'on' }),
      ),
    ).toThrow('LOC_SELL_ORDERS_ENABLED must be true or false');
  });

  it('never reports LOC without the limit-order gate the create checks first', () => {
    const capabilities = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'false', LOC_ORDERS_ENABLED: 'true' }),
    );
    expect(capabilities.limitOrder.enabled).toBe(false);
    expect(capabilities.limitOnClose.enabled).toBe(false);
  });

  it('keeps LOC off when only limit orders are enabled', () => {
    const capabilities = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'true', LOC_ORDERS_ENABLED: 'false' }),
    );
    expect(capabilities.limitOrder.enabled).toBe(true);
    expect(capabilities.limitOnClose.enabled).toBe(false);
  });

  it('reports LOC when both create gates are on, independent of the matcher', () => {
    const capabilities = readOrderCapabilities(
      env({ LIMIT_ORDER_ENABLED: 'true', LOC_ORDERS_ENABLED: 'true' }),
    );
    expect(capabilities.limitOnClose.enabled).toBe(true);
    expect(capabilities.limitOrder.autoExecutionEnabled).toBe(false);
  });

  it('reports automatic execution only with limit orders and the matcher on', () => {
    expect(
      readOrderCapabilities(
        env({
          LIMIT_ORDER_ENABLED: 'true',
          SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED: 'true',
        }),
      ).limitOrder.autoExecutionEnabled,
    ).toBe(true);
    expect(
      readOrderCapabilities(
        env({
          LIMIT_ORDER_ENABLED: 'false',
          SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED: 'true',
        }),
      ).limitOrder.autoExecutionEnabled,
    ).toBe(false);
  });

  it('fails like startup validation on an invalid flag instead of reading it as off', () => {
    expect(() =>
      readOrderCapabilities(
        env({ LIMIT_ORDER_ENABLED: 'true', LOC_ORDERS_ENABLED: 'yes' }),
      ),
    ).toThrow('LOC_ORDERS_ENABLED must be true or false');
  });
});

describe('TradingAccountOrderCapabilitiesController', () => {
  const previous = { ...process.env };
  afterEach(() => {
    process.env = { ...previous };
  });

  it('answers for an owned account only after the ownership check', async () => {
    process.env.LIMIT_ORDER_ENABLED = 'true';
    process.env.LOC_ORDERS_ENABLED = 'true';
    const getOwnedAccountOrThrow = jest.fn().mockResolvedValue({ id: 'a1' });
    const controller = new TradingAccountOrderCapabilitiesController({
      getOwnedAccountOrThrow,
    } as unknown as TradingAccountAccessService);

    const response = await controller.get(
      { user: { userId: 'u1' } } as never,
      'a1',
    );

    expect(getOwnedAccountOrThrow).toHaveBeenCalledWith('u1', 'a1');
    expect(response).toEqual({
      success: true,
      data: {
        tradingAccountId: 'a1',
        limitOrder: { enabled: true, autoExecutionEnabled: false },
        limitOnClose: {
          enabled: true,
          markets: ['KRX'],
          sides: ['buy'],
          attachedProtection: false,
        },
        limitOnCloseSell: { enabled: false, markets: [] },
      },
    });
  });

  it('propagates the existing not-found answer for a foreign account', async () => {
    const notFound = new HttpException(
      { success: false, error: { code: 'TRADING_ACCOUNT_NOT_FOUND' } },
      HttpStatus.NOT_FOUND,
    );
    const controller = new TradingAccountOrderCapabilitiesController({
      getOwnedAccountOrThrow: jest.fn().mockRejectedValue(notFound),
    } as unknown as TradingAccountAccessService);

    await expect(
      controller.get({ user: { userId: 'u1' } } as never, 'other'),
    ).rejects.toBe(notFound);
  });

  it('refuses an unauthenticated request before any read', async () => {
    const getOwnedAccountOrThrow = jest.fn();
    const controller = new TradingAccountOrderCapabilitiesController({
      getOwnedAccountOrThrow,
    } as unknown as TradingAccountAccessService);

    await expect(controller.get({} as never, 'a1')).rejects.toMatchObject({
      status: 401,
    });
    expect(getOwnedAccountOrThrow).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/trading-accounts/:accountId/order-capabilities (HTTP)', () => {
  const previous = { ...process.env };
  afterEach(() => {
    process.env = { ...previous };
  });

  async function app(getOwnedAccountOrThrow: jest.Mock) {
    const moduleRef = await Test.createTestingModule({
      controllers: [TradingAccountOrderCapabilitiesController],
      providers: [
        {
          provide: TradingAccountAccessService,
          useValue: { getOwnedAccountOrThrow },
        },
      ],
    }).compile();
    const nest = moduleRef.createNestApplication();
    // Stands in for the global auth guard, which sets the request user.
    nest.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { userId: 'u1' };
      next();
    });
    await nest.init();
    return nest;
  }

  it('routes to the read and never to an order id', async () => {
    process.env.LIMIT_ORDER_ENABLED = 'true';
    process.env.LOC_ORDERS_ENABLED = 'true';
    const getOwnedAccountOrThrow = jest.fn().mockResolvedValue({ id: 'a1' });
    const nest = await app(getOwnedAccountOrThrow);
    try {
      const response = await request(nest.getHttpServer() as App)
        .get('/api/v1/trading-accounts/a1/order-capabilities')
        .expect(200);
      expect(response.body).toEqual({
        success: true,
        data: {
          tradingAccountId: 'a1',
          limitOrder: { enabled: true, autoExecutionEnabled: false },
          limitOnClose: {
            enabled: true,
            markets: ['KRX'],
            sides: ['buy'],
            attachedProtection: false,
          },
          limitOnCloseSell: { enabled: false, markets: [] },
        },
      });
      expect(getOwnedAccountOrThrow).toHaveBeenCalledWith('u1', 'a1');
    } finally {
      await nest.close();
    }
  });

  it('answers a foreign account with the existing 404', async () => {
    const nest = await app(
      jest.fn().mockRejectedValue(
        new HttpException(
          {
            success: false,
            error: { code: 'TRADING_ACCOUNT_NOT_FOUND', message: 'x' },
          },
          HttpStatus.NOT_FOUND,
        ),
      ),
    );
    try {
      const response = await request(nest.getHttpServer() as App)
        .get('/api/v1/trading-accounts/other/order-capabilities')
        .expect(404);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        'TRADING_ACCOUNT_NOT_FOUND',
      );
    } finally {
      await nest.close();
    }
  });
});
