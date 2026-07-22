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

/**
 * The create path's two halves: a pre-transaction check that may talk to Redis
 * and issues a PROOF, and an in-transaction re-verification that may not.
 *
 * The defect these pin down: on an API instance that owns no provider socket,
 * the in-transaction step used to fall back to the LEGACY streaming status,
 * which on such an instance is not connected. The shared pre-check accepted the
 * create and the transaction then rejected it with 503 — the same request
 * succeeding or failing purely by which pod served it.
 */
describe('LimitOrderProviderHealthService readiness proof', () => {
  const originalFlags = {
    auto: process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED,
    shared: process.env.LIMIT_ORDER_SHARED_READINESS_ENABLED,
  };

  beforeEach(() => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'true';
  });

  afterEach(() => {
    restore('LIMIT_ORDER_AUTO_EXECUTION_ENABLED', originalFlags.auto);
    restore('LIMIT_ORDER_SHARED_READINESS_ENABLED', originalFlags.shared);
  });

  it('issues a shared proof on an instance that owns no route', async () => {
    const service = sharedReadinessService({ ready: true });
    const proof = await service.assertAvailableAsync(CRYPTO, 1000);

    expect(proof).toMatchObject({
      provider: 'binance',
      assetId: CRYPTO.assetId,
      ownerMode: 'shared',
      generation: 'gen-shared',
      checkedAt: 1000,
    });
    expect(proof?.expiresAt).toBeGreaterThan(1000);
  });

  it('accepts the shared proof inside the transaction on a non-owner instance', async () => {
    // The regression: this instance has NO local route and NO legacy stream, so
    // every local authority says "unavailable". The proof must still stand.
    const service = sharedReadinessService({ ready: true });
    const proof = await service.assertAvailableAsync(CRYPTO, 1000);

    expect(() =>
      service.assertReadinessProof(proof, CRYPTO, 1500),
    ).not.toThrow();
    // ...while the local-only check on the very same instance still fails,
    // which is exactly what used to run here.
    expectCode(() => service.assertAvailable(CRYPTO));
  });

  it('rejects a shared readiness verdict of not-ready before any proof exists', async () => {
    const service = sharedReadinessService({ ready: false });
    await expect(service.assertAvailableAsync(CRYPTO)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('fails closed on a missing, foreign or expired proof', () => {
    const service = sharedReadinessService({ ready: true });
    const proof = {
      provider: 'binance' as const,
      assetId: CRYPTO.assetId,
      source: 'live_candle_supervisor' as const,
      generation: 'gen-shared',
      ownerMode: 'shared' as const,
      checkedAt: 1000,
      expiresAt: 2000,
    };

    expectCode(() => service.assertReadinessProof(null, CRYPTO, 1500));
    expectCode(() =>
      service.assertReadinessProof(
        { ...proof, assetId: 'asset-other' },
        CRYPTO,
        1500,
      ),
    );
    // A KIS-routed asset can never be covered by a Binance proof.
    expectCode(() => service.assertReadinessProof(proof, DOMESTIC, 1500));
    expectCode(() => service.assertReadinessProof(proof, CRYPTO, 2001));
  });

  it('lets the local registry overrule a proof once this instance owns the route', async () => {
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    const service = new LimitOrderProviderHealthService(
      routes,
      { isActive: () => true } as never,
      undefined,
      undefined,
      undefined,
      { enabled: false } as never,
    );
    const proof = await service.assertAvailableAsync(CRYPTO, 1000);
    expect(proof?.ownerMode).toBe('local');
    expect(() =>
      service.assertReadinessProof(proof, CRYPTO, 1100),
    ).not.toThrow();

    // A reconnect between the two checks invalidates the subscription, and the
    // local registry — which is fresher than any proof — must win.
    routes.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-2',
    });
    expectCode(() => service.assertReadinessProof(proof, CRYPTO, 1200));
  });

  it('fails closed when this instance released the route it proved against', async () => {
    const routes = claimedRoutes({
      active: [subscribed(CRYPTO.assetId, 'BTCUSDT')],
    });
    const service = new LimitOrderProviderHealthService(
      routes,
      { isActive: () => true } as never,
      undefined,
      undefined,
      undefined,
      { enabled: false } as never,
    );
    const proof = await service.assertAvailableAsync(CRYPTO, 1000);
    routes.releaseProvider('binance', 'live_candle_supervisor');
    expectCode(() => service.assertReadinessProof(proof, CRYPTO, 1100));
  });

  it('re-checks the legacy stream for a legacy proof', async () => {
    let connected = true;
    const service = new LimitOrderProviderHealthService(
      new ProviderTradeRouteRegistry(),
      { isActive: () => true } as never,
      undefined,
      {
        getStatus: () => (connected ? connectedStatus() : disconnectedStatus()),
      } as never,
      undefined,
      { enabled: false } as never,
    );
    const proof = await service.assertAvailableAsync(CRYPTO, 1000);
    expect(proof?.ownerMode).toBe('legacy');
    expect(() =>
      service.assertReadinessProof(proof, CRYPTO, 1100),
    ).not.toThrow();

    connected = false;
    expectCode(() => service.assertReadinessProof(proof, CRYPTO, 1200));
  });

  it('is inert while automatic matching is disabled', async () => {
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED = 'false';
    const service = new LimitOrderProviderHealthService(
      new ProviderTradeRouteRegistry(),
    );
    await expect(service.assertAvailableAsync(CRYPTO)).resolves.toBeNull();
    expect(() => service.assertReadinessProof(null, CRYPTO)).not.toThrow();
  });
});

/**
 * An instance with no local route, no legacy stream, and shared readiness on.
 * That is a plain API pod in a multi-instance deployment.
 */
function sharedReadinessService(input: {
  ready: boolean;
}): LimitOrderProviderHealthService {
  return new LimitOrderProviderHealthService(
    new ProviderTradeRouteRegistry(),
    { isActive: () => true } as never,
    undefined,
    undefined,
    {
      isAvailable: () => true,
      checkAssetReadiness: () =>
        Promise.resolve(
          input.ready
            ? {
                ready: true,
                provider: 'binance',
                source: 'live_candle_supervisor',
                generation: 'gen-shared',
                asset: subscribed(CRYPTO.assetId, 'BTCUSDT'),
              }
            : {
                ready: false,
                code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
                reason: 'not subscribed',
              },
        ),
    } as never,
    { enabled: true } as never,
  );
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
