jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import { AssetType, CurrencyCode } from '../generated/prisma/client';
import {
  ProviderTradeRouteRegistry,
  tradeRouteProviderForAssetType,
  type ProviderSubscribedAsset,
} from './provider-trade-route.registry';

const BTC: ProviderSubscribedAsset = {
  assetId: 'asset-btc',
  symbol: 'BTC',
  providerSymbol: 'BTCUSDT',
  market: 'BINANCE',
  assetType: AssetType.crypto,
  settlementCurrency: CurrencyCode.USD,
  sourceName: 'binance_spot_ws_trade',
};
const ETH: ProviderSubscribedAsset = {
  ...BTC,
  assetId: 'asset-eth',
  symbol: 'ETH',
  providerSymbol: 'ETHUSDT',
};

describe('ProviderTradeRouteRegistry ownership', () => {
  it('gives the provider to exactly one source', () => {
    const registry = new ProviderTradeRouteRegistry();
    expect(registry.claimProvider('kis', 'live_candle_supervisor')).toBe(true);
    // The legacy service must not connect or publish while the supervisor owns
    // the route; that is what prevents a duplicate socket AND a duplicate
    // normalized trade for the same provider frame.
    expect(registry.claimProvider('kis', 'legacy_streaming')).toBe(false);
    expect(registry.isOwnedBy('kis', 'legacy_streaming')).toBe(false);
    expect(registry.isOwnedBy('kis', 'live_candle_supervisor')).toBe(true);
    // A different provider is claimed independently.
    expect(registry.claimProvider('binance', 'legacy_streaming')).toBe(true);
  });

  it('re-claiming by the same source is idempotent', () => {
    const registry = new ProviderTradeRouteRegistry();
    expect(registry.claimProvider('kis', 'legacy_streaming')).toBe(true);
    expect(registry.claimProvider('kis', 'legacy_streaming')).toBe(true);
  });

  it('releases only for the owning source', () => {
    const registry = new ProviderTradeRouteRegistry();
    registry.claimProvider('kis', 'live_candle_supervisor');
    registry.releaseProvider('kis', 'legacy_streaming');
    expect(registry.getOwner('kis')).toBe('live_candle_supervisor');
    registry.releaseProvider('kis', 'live_candle_supervisor');
    expect(registry.getOwner('kis')).toBeNull();
  });
});

describe('ProviderTradeRouteRegistry readiness', () => {
  const readiness = (registry: ProviderTradeRouteRegistry, assetId: string) =>
    registry.checkAssetReadiness({
      assetId,
      provider: 'binance',
      livenessMaxAgeMs: 60_000,
      now: 10_000,
    });

  function connected(): ProviderTradeRouteRegistry {
    const registry = new ProviderTradeRouteRegistry();
    registry.claimProvider('binance', 'live_candle_supervisor');
    registry.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-1',
    });
    registry.markConnectionOpen({
      provider: 'binance',
      generation: 'gen-1',
      at: 10_000,
    });
    return registry;
  }

  it('fails closed when the provider has no claimed route', () => {
    expect(
      readiness(new ProviderTradeRouteRegistry(), BTC.assetId),
    ).toMatchObject({ ready: false, code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE' });
  });

  it('fails closed before the socket is open', () => {
    const registry = new ProviderTradeRouteRegistry();
    registry.claimProvider('binance', 'live_candle_supervisor');
    registry.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-1',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });
  });

  it('distinguishes unsubscribed, capped, unacknowledged and rejected assets', () => {
    const registry = connected();
    registry.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [BTC],
      cappedAssets: [ETH],
    });

    expect(readiness(registry, 'asset-unknown')).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });
    expect(readiness(registry, ETH.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });

    registry.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-1',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({ ready: true });
    // A capped asset stays blocked even after a batch ack.
    expect(readiness(registry, ETH.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });

    registry.markSubscriptionsFailed({
      provider: 'binance',
      generation: 'gen-1',
      match: (asset) => asset.assetId === BTC.assetId,
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED',
    });
  });

  it('activates only the acknowledged target key', () => {
    const registry = connected();
    registry.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [BTC, ETH],
    });
    registry.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-1',
      match: (asset) => asset.providerSymbol === 'BTCUSDT',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({ ready: true });
    expect(readiness(registry, ETH.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });
  });

  it('invalidates every readiness when a reconnect starts a new generation', () => {
    const registry = connected();
    registry.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [BTC],
    });
    registry.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-1',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({ ready: true });

    registry.endConnection({ provider: 'binance', generation: 'gen-1' });
    expect(readiness(registry, BTC.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });

    registry.beginConnection({
      provider: 'binance',
      source: 'live_candle_supervisor',
      generation: 'gen-2',
    });
    registry.markConnectionOpen({
      provider: 'binance',
      generation: 'gen-2',
      at: 10_000,
    });
    // A stale-generation update must not resurrect the old readiness.
    registry.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-1',
    });
    expect(readiness(registry, BTC.assetId)).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
    });
  });

  it('fails closed when the connection has produced no recent frame', () => {
    const registry = connected();
    registry.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [BTC],
    });
    registry.markSubscriptionsActive({
      provider: 'binance',
      generation: 'gen-1',
    });
    expect(
      registry.checkAssetReadiness({
        assetId: BTC.assetId,
        provider: 'binance',
        livenessMaxAgeMs: 1000,
        now: 10_000 + 5000,
      }),
    ).toMatchObject({ ready: false, code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE' });

    registry.markFrame({
      provider: 'binance',
      generation: 'gen-1',
      at: 10_000 + 4500,
    });
    expect(
      registry.checkAssetReadiness({
        assetId: BTC.assetId,
        provider: 'binance',
        livenessMaxAgeMs: 1000,
        now: 10_000 + 5000,
      }),
    ).toMatchObject({ ready: true });
  });

  it('resolves subscription metadata without a database read', () => {
    const registry = connected();
    registry.registerSubscriptionTargets({
      provider: 'binance',
      generation: 'gen-1',
      assets: [BTC],
    });
    expect(registry.resolveAsset('binance', BTC.assetId, 'gen-1')).toEqual(BTC);
    // Metadata from a superseded generation is never served.
    expect(registry.resolveAsset('binance', BTC.assetId, 'gen-0')).toBeNull();
  });
});

describe('tradeRouteProviderForAssetType', () => {
  it.each([
    [AssetType.crypto, 'binance'],
    [AssetType.domestic_stock, 'kis'],
    [AssetType.us_stock, 'kis'],
  ])('maps %s to %s', (assetType, provider) => {
    expect(tradeRouteProviderForAssetType(assetType)).toBe(provider);
  });
});
