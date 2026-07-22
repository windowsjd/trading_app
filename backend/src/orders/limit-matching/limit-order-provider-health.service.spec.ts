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
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
} from '../../providers/provider-trade-route.registry';
import { LimitOrderProviderHealthService } from './limit-order-provider-health.service';

const CRYPTO = {
  assetId: 'asset-btc',
  symbol: 'BTC',
  market: 'BINANCE',
  assetType: AssetType.crypto,
};
const DOMESTIC = {
  assetId: 'asset-005930',
  symbol: '005930',
  market: 'KRX',
  assetType: AssetType.domestic_stock,
};

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
      new LimitOrderProviderHealthService(
        new ProviderTradeRouteRegistry(),
      ).assertAvailable(CRYPTO),
    ).not.toThrow();
  });

  it('fails closed when the normalized publisher is inactive', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const service = new LimitOrderProviderHealthService(
      new ProviderTradeRouteRegistry(),
      { isActive: () => false } as never,
      undefined,
      { getStatus: () => connectedStatus() } as never,
    );
    expectCode(() => service.assertAvailable(CRYPTO));
  });

  it.each([
    [CRYPTO, undefined, disconnectedStatus()],
    [DOMESTIC, disconnectedStatus(), undefined],
  ] as const)(
    'falls back to the legacy stream status when no route is claimed (%#)',
    (asset, kis, binance) => {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
      const service = new LimitOrderProviderHealthService(
        new ProviderTradeRouteRegistry(),
        { isActive: () => true } as never,
        kis ? ({ getStatus: () => kis } as never) : undefined,
        binance ? ({ getStatus: () => binance } as never) : undefined,
      );
      expectCode(() => service.assertAvailable(asset));
    },
  );

  it.each([
    [CRYPTO, undefined, connectedStatus()],
    [DOMESTIC, connectedStatus(), undefined],
  ] as const)(
    'accepts a connected legacy %# provider when no route is claimed',
    (asset, kis, binance) => {
      process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
      const service = new LimitOrderProviderHealthService(
        new ProviderTradeRouteRegistry(),
        { isActive: () => true } as never,
        kis ? ({ getStatus: () => kis } as never) : undefined,
        binance ? ({ getStatus: () => binance } as never) : undefined,
      );
      expect(() => service.assertAvailable(asset)).not.toThrow();
    },
  );

  it('accepts only the assets subscribed on the claimed route', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
      capped: [subscribed('asset-eth', 'ETHUSDT')],
    });
    const service = healthService(routes);

    expect(() => service.assertAvailable(CRYPTO)).not.toThrow();
    expectCode(
      () => service.assertAvailable({ ...CRYPTO, assetId: 'asset-eth' }),
      'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    );
    expectCode(
      () => service.assertAvailable({ ...CRYPTO, assetId: 'asset-unknown' }),
      'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    );
  });

  it('blocks an asset whose subscription was rejected', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    routes.markSubscriptionsFailed({
      provider: 'binance',
      generation: 'gen-1',
    });
    expectCode(
      () => healthService(routes).assertAvailable(CRYPTO),
      'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED',
    );
  });

  it('blocks every asset until an unacknowledged subscription is confirmed', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const routes = new ProviderTradeRouteRegistry();
    routes.claimProvider('binance', 'live_candle_supervisor');
    routes.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-1',
    });
    routes.markConnectionOpen({
      provider: 'binance',
      generation: 'gen-1',
      at: Date.now(),
    });
    routes.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    expectCode(
      () => healthService(routes).assertAvailable(CRYPTO),
      'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    );
  });

  it('invalidates readiness when a reconnect starts a new generation', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    const service = healthService(routes);
    expect(() => service.assertAvailable(CRYPTO)).not.toThrow();

    routes.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-2',
    });
    expectCode(() => service.assertAvailable(CRYPTO));

    routes.markConnectionOpen({
      provider: 'binance',
      generation: 'gen-2',
      at: Date.now(),
    });
    routes.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-2',
      assets: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    expectCode(
      () => service.assertAvailable(CRYPTO),
      'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    );

    routes.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-2',
    });
    expect(() => service.assertAvailable(CRYPTO)).not.toThrow();
  });

  it('fails closed when the claimed connection has no recent frame', () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
      at: Date.now() - 10 * 60_000,
    });
    expectCode(() => healthService(routes).assertAvailable(CRYPTO));
  });
});

function healthService(
  routes: ProviderTradeRouteRegistry,
): LimitOrderProviderHealthService {
  return new LimitOrderProviderHealthService(routes, {
    isActive: () => true,
  } as never);
}

function claimedRoutes(input: {
  active: ProviderSubscribedAsset[];
  capped?: ProviderSubscribedAsset[];
  at?: number;
}): ProviderTradeRouteRegistry {
  const routes = new ProviderTradeRouteRegistry();
  routes.claimProvider('binance', 'live_candle_supervisor');
  routes.beginConnection({
    provider: 'binance',
    source: 'live_candle_supervisor',
    generation: 'gen-1',
  });
  routes.markConnectionOpen({
    provider: 'binance',
    generation: 'gen-1',
    at: input.at ?? Date.now(),
  });
  routes.registerSubscriptionTargets({
    provider: 'binance',
    generation: 'gen-1',
    assets: input.active,
    cappedAssets: input.capped,
  });
  routes.markSubscriptionsActive({
    provider: 'binance',
    generation: 'gen-1',
  });
  return routes;
}

function subscribed(
  assetId: string,
  providerSymbol: string,
): ProviderSubscribedAsset {
  return {
    assetId,
    symbol: providerSymbol.replace('USDT', ''),
    providerSymbol,
    market: 'BINANCE',
    assetType: AssetType.crypto,
    settlementCurrency: 'USD' as never,
    sourceName: 'binance_spot_ws_trade',
  };
}

function connectedStatus() {
  return { enabled: true, running: true, connected: true };
}

function disconnectedStatus() {
  return { enabled: true, running: true, connected: false };
}

function expectCode(
  action: () => void,
  code = 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
): void {
  try {
    action();
    throw new Error('Expected provider health to fail closed.');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({
      error: { code },
    });
  }
}
