jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import type { RedisService } from '../redis/redis.service';
import {
  PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
  providerAssetsKey,
  providerFenceKey,
  providerMetaKey,
  ProviderTradeReadinessStore,
  type SharedAssetRecord,
  type SharedProviderMeta,
} from './provider-trade-readiness.store';

const NOW = 1_700_000_000_000;
const LIVENESS_MAX_AGE_MS = 60_000;
const GENERATION = 'gen-1';

function meta(overrides: Partial<SharedProviderMeta> = {}): SharedProviderMeta {
  return {
    schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
    provider: 'binance',
    ownerInstance: 'owner-a',
    source: 'live_candle_supervisor',
    generation: GENERATION,
    fenceToken: 7,
    connected: true,
    connectedAt: NOW - 1000,
    lastFrameAt: NOW - 500,
    lastUpdatedAt: NOW - 500,
    degradedReason: null,
    ...overrides,
  };
}

function record(overrides: Partial<SharedAssetRecord> = {}): SharedAssetRecord {
  return {
    schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
    assetId: 'asset-1',
    providerSymbol: 'BTCUSDT',
    symbol: 'BTC',
    market: 'BINANCE',
    assetType: 'crypto',
    settlementCurrency: 'USD',
    sourceName: 'binance_spot_ws_trade',
    state: 'active',
    generation: GENERATION,
    acknowledgedAt: NOW - 800,
    updatedAt: NOW - 800,
    ...overrides,
  };
}

/** Minimal Redis stand-in that answers the readiness script only. */
function redisReturning(reply: unknown): RedisService {
  return {
    eval: () => Promise.resolve(reply),
    get: () => Promise.resolve(null),
  } as unknown as RedisService;
}

function readiness(reply: unknown) {
  return new ProviderTradeReadinessStore(
    redisReturning(reply),
  ).checkAssetReadiness({
    assetId: 'asset-1',
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
    now: NOW,
  });
}

describe('ProviderTradeReadinessStore key schema', () => {
  it('hash-tags every key on the provider so one script can touch them all', () => {
    // A clustered Redis routes by the {…} tag; without it the readiness script
    // could not read the meta and the asset hash in a single atomic call.
    expect(providerMetaKey('binance')).toContain('{binance}');
    expect(providerAssetsKey('binance', GENERATION)).toContain('{binance}');
    expect(providerAssetsKey('binance', GENERATION)).toContain(GENERATION);
  });

  it('scopes the asset hash to the connection generation', () => {
    // A reconnect must land on a DIFFERENT key so old readiness is unreachable
    // the instant the new meta is published, not when its TTL expires.
    expect(providerAssetsKey('binance', 'a')).not.toBe(
      providerAssetsKey('binance', 'b'),
    );
  });
});

describe('ProviderTradeReadinessStore.checkAssetReadiness', () => {
  it('accepts an acknowledged asset on a live connection', async () => {
    const result = await readiness([
      'ok',
      JSON.stringify(meta()),
      JSON.stringify(record()),
    ]);
    expect(result).toMatchObject({
      ready: true,
      provider: 'binance',
      generation: GENERATION,
    });
    expect(result.ready && result.asset.providerSymbol).toBe('BTCUSDT');
  });

  it.each([
    ['requested', 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED'],
    ['capped', 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED'],
    ['failed', 'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED'],
  ] as const)('rejects a %s subscription', async (state, code) => {
    const result = await readiness([
      'ok',
      JSON.stringify(meta()),
      JSON.stringify(record({ state })),
    ]);
    expect(result).toMatchObject({ ready: false, code });
  });

  it('rejects when no owner is publishing', async () => {
    expect(await readiness(['no_meta'])).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects an asset absent from the current generation', async () => {
    expect(await readiness(['no_asset', JSON.stringify(meta())])).toMatchObject(
      {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
      },
    );
  });

  it('rejects a stale connection frame', async () => {
    const result = await readiness([
      'ok',
      JSON.stringify(meta({ lastFrameAt: NOW - LIVENESS_MAX_AGE_MS * 3 })),
      JSON.stringify(record()),
    ]);
    expect(result).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects a connection that never produced a frame', async () => {
    const result = await readiness([
      'ok',
      JSON.stringify(meta({ lastFrameAt: null })),
      JSON.stringify(record()),
    ]);
    expect(result).toMatchObject({ ready: false });
  });

  it('rejects a disconnected or degraded owner', async () => {
    expect(
      await readiness([
        'ok',
        JSON.stringify(meta({ connected: false })),
        JSON.stringify(record()),
      ]),
    ).toMatchObject({ ready: false });
    expect(
      await readiness([
        'ok',
        JSON.stringify(meta({ degradedReason: 'shard_cap' })),
        JSON.stringify(record()),
      ]),
    ).toMatchObject({ ready: false });
  });

  it('rejects an asset record from a superseded generation', async () => {
    const result = await readiness([
      'ok',
      JSON.stringify(meta({ generation: 'gen-2' })),
      JSON.stringify(record({ generation: 'gen-1' })),
    ]);
    expect(result).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });
  });

  it('rejects an unknown schema version rather than guessing', async () => {
    expect(
      await readiness([
        'ok',
        JSON.stringify(meta({ schemaVersion: 99 })),
        JSON.stringify(record()),
      ]),
    ).toMatchObject({ ready: false });
    expect(
      await readiness([
        'ok',
        JSON.stringify(meta()),
        JSON.stringify(record({ schemaVersion: 99 })),
      ]),
    ).toMatchObject({ ready: false });
  });

  it('fails closed when Redis errors', async () => {
    const store = new ProviderTradeReadinessStore({
      eval: () => Promise.reject(new Error('redis down')),
      get: () => Promise.reject(new Error('redis down')),
    } as unknown as RedisService);
    expect(
      await store.checkAssetReadiness({
        assetId: 'asset-1',
        provider: 'binance',
        livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
        now: NOW,
      }),
    ).toMatchObject({
      ready: false,
      code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
    });
  });

  it('fails closed when no Redis is wired at all', async () => {
    const store = new ProviderTradeReadinessStore();
    expect(store.isAvailable()).toBe(false);
    expect(
      await store.checkAssetReadiness({
        assetId: 'asset-1',
        provider: 'binance',
        livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
        now: NOW,
      }),
    ).toMatchObject({ ready: false });
  });

  it('fails closed on an unreadable reply instead of guessing', async () => {
    for (const reply of [null, [], ['ok', 'not-json', 'not-json'], 'garbage']) {
      expect(await readiness(reply)).toMatchObject({ ready: false });
    }
  });

  it('rejects a record with no usable fence token', async () => {
    // Without a token the record cannot be attributed to a live owner, so it is
    // not evidence of anything — including a v1 record during a rolling deploy.
    for (const fenceToken of [undefined, null, 'seven', Number.NaN]) {
      expect(
        await readiness([
          'ok',
          JSON.stringify(meta({ fenceToken: fenceToken as never })),
          JSON.stringify(record()),
        ]),
      ).toMatchObject({
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
      });
    }
  });
});

/**
 * Owner fencing.
 *
 * Ownership used to be decided by comparing `lastUpdatedAt` between records
 * written on DIFFERENT HOSTS, so a superseded owner with a fast or
 * paused-then-resumed clock could overwrite the live owner's record and
 * publish the subscription set of a socket that no longer existed. The
 * ordering authority is now a Redis-generated token, and these pin down that
 * no timestamp reaches the decision at all.
 */
describe('ProviderTradeReadinessStore owner fencing', () => {
  function recordingRedis(reply: unknown) {
    const calls: Array<{ script: string; keys: string[]; args: string[] }> = [];
    const redis = {
      eval: (script: string, keys: string[], args: string[] = []) => {
        calls.push({ script, keys, args });
        return Promise.resolve(reply);
      },
      get: () => Promise.resolve(null),
    } as unknown as RedisService;
    return { redis, calls };
  }

  it('gives the fence counter its own never-expiring key', () => {
    expect(providerFenceKey('binance')).toContain('{binance}');
    expect(providerFenceKey('binance')).not.toBe(providerMetaKey('binance'));
    expect(providerFenceKey('binance')).not.toBe(providerFenceKey('kis'));
  });

  it('acquires a token and reports the incumbent when refused', async () => {
    const granted = new ProviderTradeReadinessStore(
      recordingRedis(['1', '42', 'owner-a']).redis,
    );
    expect(
      await granted.acquireOwnership({
        provider: 'binance',
        ownerInstance: 'owner-a',
      }),
    ).toEqual({ acquired: true, fenceToken: 42, heldBy: 'owner-a' });

    const refused = new ProviderTradeReadinessStore(
      recordingRedis(['0', '41', 'owner-b']).redis,
    );
    expect(
      await refused.acquireOwnership({
        provider: 'binance',
        ownerInstance: 'owner-a',
      }),
    ).toEqual({ acquired: false, fenceToken: null, heldBy: 'owner-b' });
  });

  it('acquires against BOTH the meta and the fence counter', async () => {
    const { redis, calls } = recordingRedis(['1', '9', 'owner-a']);
    await new ProviderTradeReadinessStore(redis).acquireOwnership({
      provider: 'binance',
      ownerInstance: 'owner-a',
    });
    expect(calls[0].keys).toEqual([
      providerMetaKey('binance'),
      providerFenceKey('binance'),
    ]);
    // The counter is INCRemented inside the script, never read-then-written
    // from the client, or two instances could be handed the same token.
    expect(calls[0].script).toContain('INCR');
  });

  it('publishes the fence token and never a clock as the ordering argument', async () => {
    const { redis, calls } = recordingRedis(1);
    const store = new ProviderTradeReadinessStore(redis);
    const published = meta({ fenceToken: 12, lastUpdatedAt: NOW });
    expect(
      await store.publishProvider({ meta: published, ttlSeconds: 30 }),
    ).toBe(true);

    const [payload, owner, ordering, ttl] = calls[0].args;
    expect(JSON.parse(payload)).toMatchObject({ fenceToken: 12 });
    expect(owner).toBe('owner-a');
    expect(ordering).toBe('12');
    expect(ordering).not.toBe(String(NOW));
    expect(ttl).toBe('30');
    // The regression guard: no comparison in the script may involve a
    // client-supplied timestamp.
    expect(calls[0].script).not.toContain('lastUpdatedAt');
  });

  it('carries the token into asset writes, releases and superseded cleanups', async () => {
    const { redis, calls } = recordingRedis(1);
    const store = new ProviderTradeReadinessStore(redis);

    await store.publishAssets({
      provider: 'binance',
      generation: GENERATION,
      ownerInstance: 'owner-a',
      fenceToken: 5,
      records: [record()],
      ttlSeconds: 30,
    });
    expect(calls[0].keys).toEqual([
      providerAssetsKey('binance', GENERATION),
      providerMetaKey('binance'),
    ]);
    expect(calls[0].args.slice(0, 3)).toEqual(['30', '5', 'owner-a']);

    await store.release({
      provider: 'binance',
      generation: GENERATION,
      ownerInstance: 'owner-a',
      fenceToken: 5,
    });
    expect(calls[1].args).toEqual([GENERATION, 'owner-a', '5']);

    await store.releaseSupersededAssets({
      provider: 'binance',
      supersededGeneration: 'gen-0',
      ownerInstance: 'owner-a',
      fenceToken: 5,
    });
    expect(calls[2].args).toEqual(['gen-0', 'owner-a', '5']);
  });

  it('reports a refused publish rather than swallowing it', async () => {
    const store = new ProviderTradeReadinessStore(recordingRedis(0).redis);
    expect(
      await store.publishProvider({
        meta: meta({ fenceToken: 3 }),
        ttlSeconds: 30,
      }),
    ).toBe(false);
    expect(
      await store.publishAssets({
        provider: 'binance',
        generation: GENERATION,
        ownerInstance: 'owner-a',
        fenceToken: 3,
        records: [record()],
        ttlSeconds: 30,
      }),
    ).toBe(false);
  });

  it('fails closed when no Redis is wired', async () => {
    const store = new ProviderTradeReadinessStore();
    expect(
      await store.acquireOwnership({
        provider: 'binance',
        ownerInstance: 'owner-a',
      }),
    ).toEqual({ acquired: false, fenceToken: null, heldBy: null });
  });
});
