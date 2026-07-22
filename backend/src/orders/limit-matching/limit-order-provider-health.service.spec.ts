jest.mock('../../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
}));
jest.mock(
  '../../providers/binance/binance-websocket-streaming.service',
  () => ({ BinanceWebSocketStreamingService: class {} }),
);
jest.mock('../../providers/kis/kis-websocket-streaming.service', () => ({
  KisWebSocketStreamingService: class {},
}));
jest.mock('./limit-order-price-event.publisher', () => ({
  LimitOrderPriceEventPublisher: class {},
}));

import { HttpException } from '@nestjs/common';
import { AssetType } from '../../generated/prisma/client';
import { LimitOrderProviderHealthService } from './limit-order-provider-health.service';

describe('LimitOrderProviderHealthService', () => {
  const originalFlag = process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED;
    } else {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = originalFlag;
    }
  });

  it('does not gate providers when automatic matching is disabled', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'false';
    expect(() =>
      new LimitOrderProviderHealthService().assertAvailable(AssetType.crypto),
    ).not.toThrow();
  });

  it('fails closed when the normalized publisher is inactive', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const service = new LimitOrderProviderHealthService(
      { isActive: () => false } as never,
      undefined,
      { getStatus: () => connectedStatus() } as never,
    );
    expectCode(() => service.assertAvailable(AssetType.crypto));
  });

  it.each([
    [AssetType.crypto, undefined, disconnectedStatus()],
    [AssetType.domestic_stock, disconnectedStatus(), undefined],
  ] as const)(
    'fails closed for a disconnected %s provider',
    (type, kis, binance) => {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
      const service = new LimitOrderProviderHealthService(
        { isActive: () => true } as never,
        kis ? ({ getStatus: () => kis } as never) : undefined,
        binance ? ({ getStatus: () => binance } as never) : undefined,
      );
      expectCode(() => service.assertAvailable(type));
    },
  );

  it.each([
    [AssetType.crypto, undefined, connectedStatus()],
    [AssetType.us_stock, connectedStatus(), undefined],
  ] as const)('accepts a connected %s provider', (type, kis, binance) => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const service = new LimitOrderProviderHealthService(
      { isActive: () => true } as never,
      kis ? ({ getStatus: () => kis } as never) : undefined,
      binance ? ({ getStatus: () => binance } as never) : undefined,
    );
    expect(() => service.assertAvailable(type)).not.toThrow();
  });
});

function connectedStatus() {
  return { enabled: true, running: true, connected: true };
}

function disconnectedStatus() {
  return { enabled: true, running: true, connected: false };
}

function expectCode(action: () => void): void {
  try {
    action();
    throw new Error('Expected provider health to fail closed.');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code: 'LIMIT_ORDER_MATCHER_UNAVAILABLE' },
    });
  }
}
