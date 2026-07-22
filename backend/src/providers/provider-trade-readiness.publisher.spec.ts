jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import type { ProviderTradeReadinessConfig } from './provider-trade-readiness.config';
import { ProviderTradeReadinessPublisher } from './provider-trade-readiness.publisher';
import type { ProviderTradeReadinessStore } from './provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
  type TradeRouteProvider,
} from './provider-trade-route.registry';

const OWNER = 'instance-a';
const GENERATION = 'gen-1';

const ASSET: ProviderSubscribedAsset = {
  assetId: 'asset-btc',
  symbol: 'BTC',
  providerSymbol: 'BTCUSDT',
  market: 'BINANCE',
  assetType: 'crypto' as never,
  settlementCurrency: 'USD' as never,
  sourceName: 'binance_spot_ws_trade',
};

function config(
  overrides: Partial<ProviderTradeReadinessConfig> = {},
): ProviderTradeReadinessConfig {
  return {
    enabled: true,
    ttlSeconds: 30,
    publishIntervalMs: 5000,
    instanceId: OWNER,
    ...overrides,
  };
}

/**
 * Records every store call so the ORDER and the ARGUMENTS can be asserted, not
 * merely the end state: "assets before meta" and "never publish without a
 * token" are both sequencing properties.
 */
function storeStub(
  behaviour: {
    acquire?: () => {
      acquired: boolean;
      fenceToken: number | null;
      heldBy: string | null;
    };
    publishMeta?: () => boolean;
    publishAssets?: () => boolean;
  } = {},
) {
  const calls: string[] = [];
  const acquired: number[] = [];
  const assetWrites: Array<{ fenceToken: number; generation: string }> = [];
  const published: Array<{ fenceToken: number; generation: string }> = [];
  const released: Array<{ fenceToken: number; generation: string }> = [];
  const store = {
    isAvailable: () => true,
    acquireOwnership: (input: { ownerInstance: string }) => {
      calls.push('acquire');
      const result = behaviour.acquire?.() ?? {
        acquired: true,
        fenceToken: 1,
        heldBy: input.ownerInstance,
      };
      if (result.fenceToken !== null) acquired.push(result.fenceToken);
      return Promise.resolve(result);
    },
    publishAssets: (input: { fenceToken: number; generation: string }) => {
      calls.push('publishAssets');
      assetWrites.push({
        fenceToken: input.fenceToken,
        generation: input.generation,
      });
      const accepted = behaviour.publishAssets?.() ?? true;
      return Promise.resolve(accepted);
    },
    publishProvider: (input: {
      meta: { fenceToken: number; generation: string };
    }) => {
      calls.push('publishProvider');
      const accepted = behaviour.publishMeta?.() ?? true;
      if (accepted) {
        published.push({
          fenceToken: input.meta.fenceToken,
          generation: input.meta.generation,
        });
      }
      return Promise.resolve(accepted);
    },
    releaseSupersededAssets: () => {
      calls.push('releaseSupersededAssets');
      return Promise.resolve(true);
    },
    release: (input: { fenceToken: number; generation: string }) => {
      calls.push('release');
      released.push({
        fenceToken: input.fenceToken,
        generation: input.generation,
      });
      return Promise.resolve(true);
    },
  };
  return {
    store: store as unknown as ProviderTradeReadinessStore,
    calls,
    acquired,
    assetWrites,
    published,
    released,
  };
}

function connectedRoutes(
  provider: TradeRouteProvider = 'binance',
  generation = GENERATION,
): ProviderTradeRouteRegistry {
  const routes = new ProviderTradeRouteRegistry();
  routes.claimProvider(provider, 'live_candle_supervisor');
  routes.beginConnection({
    provider,
    source: 'live_candle_supervisor',
    generation,
  });
  routes.markConnectionOpen({ provider, generation, at: Date.now() });
  routes.registerSubscriptionTargets({
    provider,
    generation,
    assets: [ASSET],
  });
  routes.markSubscriptionsActive({ provider, generation });
  return routes;
}

describe('ProviderTradeReadinessPublisher owner fencing', () => {
  it('acquires a fence token before publishing anything', async () => {
    const routes = connectedRoutes();
    const { store, calls, published, assetWrites } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );

    await publisher.publishOnce(1000);

    // Acquire first, then assets, then meta. Assets before meta so a reader
    // that resolves the new generation finds its hash already populated.
    expect(calls.slice(0, 3)).toEqual([
      'acquire',
      'publishAssets',
      'publishProvider',
    ]);
    // Assets and meta must go out under the SAME token, or a fenced-out
    // writer could still poison one half of the record.
    expect(assetWrites).toEqual([{ fenceToken: 1, generation: GENERATION }]);
    expect(published).toEqual([{ fenceToken: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fenceToken: 1,
      generation: GENERATION,
    });
  });

  it('publishes nothing at all while another instance holds the provider', async () => {
    const { store, calls, published } = storeStub({
      acquire: () => ({
        acquired: false,
        fenceToken: null,
        heldBy: 'instance-b',
      }),
    });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    await publisher.publishOnce(2000);

    expect(published).toEqual([]);
    expect(calls.filter((call) => call.startsWith('publish'))).toEqual([]);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fenceToken: null,
      fencedOutBy: 'instance-b',
    });
  });

  it('reuses the token it already holds instead of re-acquiring every tick', async () => {
    const { store, calls } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    await publisher.publishOnce(2000);
    await publisher.publishOnce(3000);

    expect(calls.filter((call) => call === 'acquire')).toHaveLength(1);
  });

  it('surrenders the claim when a publish is fenced out', async () => {
    let accept = true;
    const { store, calls } = storeStub({ publishMeta: () => accept });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    expect(publisher.ownershipSnapshot().binance.fenceToken).toBe(1);

    // A newer owner exists: the write is refused.
    accept = false;
    await publisher.publishOnce(2000);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fenceToken: null,
      generation: null,
    });

    // The next tick re-attempts acquisition rather than republishing under the
    // surrendered token.
    calls.length = 0;
    await publisher.publishOnce(3000);
    expect(calls[0]).toBe('acquire');
  });

  it('surrenders when the ASSET write is fenced out, before touching the meta', async () => {
    const { store, calls } = storeStub({ publishAssets: () => false });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );

    await publisher.publishOnce(1000);

    expect(calls).toEqual(['acquire', 'publishAssets']);
    expect(publisher.ownershipSnapshot().binance.fenceToken).toBeNull();
  });

  it('gives the claim up when it stops owning a connected socket', async () => {
    const routes = connectedRoutes();
    const { store, released } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );
    await publisher.publishOnce(1000);

    routes.endConnection({ provider: 'binance', generation: GENERATION });
    await publisher.publishOnce(2000);

    expect(released).toEqual([{ fenceToken: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance).toEqual({
      fenceToken: null,
      generation: null,
    });
  });

  it('releases its own generation with its own token on shutdown', async () => {
    const { store, released } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );
    await publisher.publishOnce(1000);
    await publisher.onModuleDestroy();

    expect(released).toEqual([{ fenceToken: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance.fenceToken).toBeNull();
  });

  it('does not release anything it never proved it owned', async () => {
    const { store, released } = storeStub({
      acquire: () => ({
        acquired: false,
        fenceToken: null,
        heldBy: 'instance-b',
      }),
    });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );
    await publisher.publishOnce(1000);
    await publisher.onModuleDestroy();

    expect(released).toEqual([]);
  });
});
