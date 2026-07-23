jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import type { ProviderTradeReadinessConfig } from './provider-trade-readiness.config';
import {
  digestLeaseToken,
  ProviderTradeReadinessPublisher,
} from './provider-trade-readiness.publisher';
import type { ProviderTradeReadinessStore } from './provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
  type TradeRouteProvider,
} from './provider-trade-route.registry';

const OWNER = 'instance-a';
const GENERATION = 'gen-1';
const LEASE_KEY = 'candles:live:v1:owner:binance:0';
const LEASE_TOKEN = 'lease-token-a';

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
 * Records every store call so the ORDER and the ARGUMENTS can be asserted,
 * not merely the end state: "assets before meta", "acquire only with the
 * lease token" and "never publish without an epoch" are all sequencing
 * properties.
 */
function storeStub(
  behaviour: {
    acquire?: (leaseToken: string) => {
      acquired: boolean;
      fencingEpoch: number | null;
      reason: string | null;
    };
    publishMeta?: () => boolean;
    publishAssets?: () => boolean;
  } = {},
) {
  const calls: string[] = [];
  const acquiredWith: string[] = [];
  const assetWrites: Array<{
    fencingEpoch: number;
    leaseToken: string;
    generation: string;
  }> = [];
  const published: Array<{
    fencingEpoch: number;
    leaseToken: string;
    generation: string;
  }> = [];
  const released: Array<{ fencingEpoch: number; generation: string }> = [];
  const store = {
    isAvailable: () => true,
    acquireOwnership: (input: { leaseToken: string }) => {
      calls.push('acquire');
      acquiredWith.push(input.leaseToken);
      const result = behaviour.acquire?.(input.leaseToken) ?? {
        acquired: true,
        fencingEpoch: 1,
        reason: null,
      };
      return Promise.resolve(result);
    },
    publishAssets: (input: {
      fencingEpoch: number;
      leaseToken: string;
      generation: string;
    }) => {
      calls.push('publishAssets');
      assetWrites.push({
        fencingEpoch: input.fencingEpoch,
        leaseToken: input.leaseToken,
        generation: input.generation,
      });
      const accepted = behaviour.publishAssets?.() ?? true;
      return Promise.resolve(accepted);
    },
    publishProvider: (input: {
      meta: { fencingEpoch: number; generation: string };
      leaseToken: string;
    }) => {
      calls.push('publishProvider');
      const accepted = behaviour.publishMeta?.() ?? true;
      if (accepted) {
        published.push({
          fencingEpoch: input.meta.fencingEpoch,
          leaseToken: input.leaseToken,
          generation: input.meta.generation,
        });
      }
      return Promise.resolve(accepted);
    },
    releaseSupersededAssets: () => {
      calls.push('releaseSupersededAssets');
      return Promise.resolve(true);
    },
    release: (input: { fencingEpoch: number; generation: string }) => {
      calls.push('release');
      released.push({
        fencingEpoch: input.fencingEpoch,
        generation: input.generation,
      });
      return Promise.resolve(true);
    },
  };
  return {
    store: store as unknown as ProviderTradeReadinessStore,
    calls,
    acquiredWith,
    assetWrites,
    published,
    released,
  };
}

function connectedRoutes(
  input: {
    provider?: TradeRouteProvider;
    generation?: string;
    lease?: { key: string; token: string } | null;
  } = {},
): ProviderTradeRouteRegistry {
  const provider = input.provider ?? 'binance';
  const generation = input.generation ?? GENERATION;
  const routes = new ProviderTradeRouteRegistry();
  routes.claimProvider(provider, 'live_candle_supervisor');
  const lease =
    input.lease === undefined
      ? { key: LEASE_KEY, token: LEASE_TOKEN }
      : input.lease;
  if (lease) {
    routes.setOwnerLease(provider, 'live_candle_supervisor', lease);
  }
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

describe('ProviderTradeReadinessPublisher owner-lease fencing', () => {
  it('exchanges the REGISTERED lease for an epoch before publishing anything', async () => {
    const routes = connectedRoutes();
    const { store, calls, acquiredWith, published, assetWrites } = storeStub();
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
    expect(acquiredWith).toEqual([LEASE_TOKEN]);
    // Assets and meta go out under the SAME lease token and epoch, or a
    // fenced-out writer could still poison one half of the record.
    expect(assetWrites).toEqual([
      { fencingEpoch: 1, leaseToken: LEASE_TOKEN, generation: GENERATION },
    ]);
    expect(published).toEqual([
      { fencingEpoch: 1, leaseToken: LEASE_TOKEN, generation: GENERATION },
    ]);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fencingEpoch: 1,
      generation: GENERATION,
    });
  });

  it('publishes NOTHING when the local claim carries no Redis lease', async () => {
    // The legacy streaming service claims routes without any Redis lease. A
    // local claim proves nothing to another instance, so it must not publish.
    const routes = connectedRoutes({ lease: null });
    const { store, calls } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    await publisher.publishOnce(2000);

    expect(calls).toEqual([]);
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBeNull();
  });

  it('publishes nothing while the real lease belongs to another process', async () => {
    const { store, calls } = storeStub({
      acquire: () => ({
        acquired: false,
        fencingEpoch: null,
        reason: 'lease_held_by_other',
      }),
    });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    await publisher.publishOnce(2000);

    expect(calls.filter((call) => call.startsWith('publish'))).toEqual([]);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fencingEpoch: null,
      refusedBecause: 'lease_held_by_other',
    });
  });

  it('reuses the epoch while the lease token is unchanged, re-acquires on a new lease', async () => {
    let epoch = 0;
    const { store, calls, acquiredWith } = storeStub({
      acquire: () => ({ acquired: true, fencingEpoch: ++epoch, reason: null }),
    });
    const routes = connectedRoutes();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );

    await publisher.publishOnce(1000);
    await publisher.publishOnce(2000);
    expect(calls.filter((call) => call === 'acquire')).toHaveLength(1);

    // A NEW ownership (new lease token) must never reuse the old epoch.
    routes.setOwnerLease('binance', 'live_candle_supervisor', {
      key: LEASE_KEY,
      token: 'lease-token-b',
    });
    await publisher.publishOnce(3000);
    expect(acquiredWith).toEqual([LEASE_TOKEN, 'lease-token-b']);
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBe(2);
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
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBe(1);

    // The lease or epoch no longer belongs to this process: refused.
    accept = false;
    await publisher.publishOnce(2000);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fencingEpoch: null,
      generation: null,
      refusedBecause: 'fenced_out_meta',
    });

    // The next tick re-attempts acquisition rather than republishing under
    // the surrendered epoch.
    calls.length = 0;
    accept = true;
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
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBeNull();
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

    expect(released).toEqual([{ fencingEpoch: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance).toEqual({
      fencingEpoch: null,
      generation: null,
    });
  });

  it('releases its own stale record the tick after the owner lease is cleared', async () => {
    // `clearOwnerLease` is what the supervisor calls the instant it loses the
    // socket lease mid-connection. The record this process already published
    // must not sit in Redis until its TTL: the next tick compare-and-deletes
    // it, so even a reader on the OLD read path fails closed immediately.
    const routes = connectedRoutes();
    const { store, released } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );
    await publisher.publishOnce(1000);
    expect(released).toEqual([]);

    routes.clearOwnerLease('binance', 'live_candle_supervisor');
    await publisher.publishOnce(2000);

    expect(released).toEqual([{ fencingEpoch: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance).toMatchObject({
      fencingEpoch: null,
      generation: null,
    });
  });

  it('releases the old-token record before acquiring under a rotated lease token', async () => {
    let epoch = 0;
    const { store, calls, released } = storeStub({
      acquire: () => ({ acquired: true, fencingEpoch: ++epoch, reason: null }),
    });
    const routes = connectedRoutes();
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );
    await publisher.publishOnce(1000);

    // A NEW ownership (same process, new token): the record published under
    // the OLD token is stale-by-authority and is released before anything is
    // published under the new epoch.
    routes.setOwnerLease('binance', 'live_candle_supervisor', {
      key: LEASE_KEY,
      token: 'lease-token-b',
    });
    calls.length = 0;
    await publisher.publishOnce(2000);

    expect(released).toEqual([{ fencingEpoch: 1, generation: GENERATION }]);
    expect(calls.indexOf('release')).toBeLessThan(calls.indexOf('acquire'));
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBe(2);
  });

  it('attempts a guarded release of its own record when fenced out', async () => {
    let accept = true;
    const { store, released } = storeStub({ publishMeta: () => accept });
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );
    await publisher.publishOnce(1000);

    accept = false;
    await publisher.publishOnce(2000);

    // The release is COMPARE-AND-DELETE inside the store (owner + generation
    // + epoch against the stored meta), so when a successor already
    // republished this is a harmless no-op — and when the lease merely
    // EXPIRED with no successor, it removes this process's unprovable record
    // instead of leaving it to its TTL.
    expect(released).toEqual([{ fencingEpoch: 1, generation: GENERATION }]);
  });

  it('releases its own generation with its own epoch on shutdown', async () => {
    const { store, released } = storeStub();
    const publisher = new ProviderTradeReadinessPublisher(
      connectedRoutes(),
      store,
      config(),
    );
    await publisher.publishOnce(1000);
    await publisher.onModuleDestroy();

    expect(released).toEqual([{ fencingEpoch: 1, generation: GENERATION }]);
    expect(publisher.ownershipSnapshot().binance.fencingEpoch).toBeNull();
  });

  it('does not release anything it never proved it owned', async () => {
    const { store, released } = storeStub({
      acquire: () => ({
        acquired: false,
        fencingEpoch: null,
        reason: 'lease_absent',
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

  it('publishes a lease token DIGEST in the meta, never the raw token', async () => {
    const seen: string[] = [];
    const routes = connectedRoutes();
    const store = {
      isAvailable: () => true,
      acquireOwnership: () =>
        Promise.resolve({ acquired: true, fencingEpoch: 1, reason: null }),
      publishAssets: () => Promise.resolve(true),
      publishProvider: (input: { meta: unknown }) => {
        seen.push(JSON.stringify(input.meta));
        return Promise.resolve(true);
      },
      releaseSupersededAssets: () => Promise.resolve(true),
      release: () => Promise.resolve(true),
    } as unknown as ProviderTradeReadinessStore;
    const publisher = new ProviderTradeReadinessPublisher(
      routes,
      store,
      config(),
    );

    await publisher.publishOnce(1000);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(digestLeaseToken(LEASE_TOKEN));
    expect(seen[0]).not.toContain(LEASE_TOKEN);
  });
});
