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
  assertReadinessKeySlots,
  providerAssetsKey,
  providerEpochHolderKey,
  providerEpochKey,
  providerMetaKey,
  providerOwnerLeaseKey,
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
    fencingEpoch: 7,
    leaseTokenDigest: 'ab12cd34ef56ab12',
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
  it('hash-tags every key on the PROVIDER OWNER LEASE KEY so the fenced scripts stay single-slot', () => {
    // A clustered Redis routes by the {…} tag. The tag is the lease key
    // itself, so the lease and every readiness key land on ONE slot and each
    // mutating script can read the live lease in the same atomic call.
    const lease = providerOwnerLeaseKey('binance');
    expect(lease).toBe('candles:live:v1:owner:binance:0');
    for (const key of [
      providerMetaKey('binance'),
      providerAssetsKey('binance', GENERATION),
      providerEpochKey('binance'),
      providerEpochHolderKey('binance'),
    ]) {
      expect(key).toContain(`{${lease}}`);
    }
    expect(providerAssetsKey('binance', GENERATION)).toContain(GENERATION);
    expect(() => assertReadinessKeySlots('binance')).not.toThrow();
    expect(() => assertReadinessKeySlots('kis')).not.toThrow();
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

  it('rejects a record with no usable fencing epoch', async () => {
    // Without an epoch the record cannot be attributed to a live owner, so it
    // is not evidence of anything — including an earlier-version record
    // during a rolling deploy.
    for (const fencingEpoch of [undefined, null, 'seven', Number.NaN]) {
      expect(
        await readiness([
          'ok',
          JSON.stringify(meta({ fencingEpoch: fencingEpoch as never })),
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
 * Owner-lease fencing.
 *
 * Publishing rights derive from the REAL provider owner lease — the Redis
 * lock the live-candle supervisor holds while it owns the socket — never from
 * a parallel readiness-only token and never from a timestamp. These pin down
 * the store-side contract: which keys each script touches, that the lease
 * token and fencing epoch are the only ordering arguments, and that no clock
 * value reaches any comparison.
 */
describe('ProviderTradeReadinessStore owner-lease fencing', () => {
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

  it('gives the epoch counter its own never-expiring keys', () => {
    expect(providerEpochKey('binance')).not.toBe(providerMetaKey('binance'));
    expect(providerEpochKey('binance')).not.toBe(providerEpochKey('kis'));
    expect(providerEpochHolderKey('binance')).not.toBe(
      providerEpochKey('binance'),
    );
  });

  it('acquires an epoch only against the live lease and reports refusals', async () => {
    const granted = new ProviderTradeReadinessStore(
      recordingRedis(['1', '42', '']).redis,
    );
    expect(
      await granted.acquireOwnership({
        provider: 'binance',
        leaseToken: 'lease-token-a',
      }),
    ).toEqual({ acquired: true, fencingEpoch: 42, reason: null });

    const refused = new ProviderTradeReadinessStore(
      recordingRedis(['0', '', 'lease_held_by_other']).redis,
    );
    expect(
      await refused.acquireOwnership({
        provider: 'binance',
        leaseToken: 'lease-token-a',
      }),
    ).toEqual({
      acquired: false,
      fencingEpoch: null,
      reason: 'lease_held_by_other',
    });
  });

  it('acquires against the LEASE key plus the epoch keys, with INCR inside Redis', async () => {
    const { redis, calls } = recordingRedis(['1', '9', '']);
    await new ProviderTradeReadinessStore(redis).acquireOwnership({
      provider: 'binance',
      leaseToken: 'lease-token-a',
    });
    expect(calls[0].keys).toEqual([
      providerOwnerLeaseKey('binance'),
      providerEpochKey('binance'),
      providerEpochHolderKey('binance'),
    ]);
    expect(calls[0].args).toEqual(['lease-token-a']);
    // The counter is INCRemented inside the script, never read-then-written
    // from the client, or two owners could be handed the same epoch.
    expect(calls[0].script).toContain('INCR');
  });

  it('publishes under the lease token and epoch, never a clock', async () => {
    const { redis, calls } = recordingRedis(1);
    const store = new ProviderTradeReadinessStore(redis);
    const published = meta({ fencingEpoch: 12, lastUpdatedAt: NOW });
    expect(
      await store.publishProvider({
        meta: published,
        leaseToken: 'lease-token-a',
        ttlSeconds: 30,
      }),
    ).toBe(true);

    expect(calls[0].keys).toEqual([
      providerMetaKey('binance'),
      providerOwnerLeaseKey('binance'),
      providerEpochKey('binance'),
    ]);
    const [payload, leaseToken, epoch, ttl] = calls[0].args;
    expect(JSON.parse(payload)).toMatchObject({ fencingEpoch: 12 });
    expect(leaseToken).toBe('lease-token-a');
    expect(epoch).toBe('12');
    expect(epoch).not.toBe(String(NOW));
    expect(ttl).toBe('30');
    // The regression guard: no comparison in the script may involve a
    // client-supplied timestamp.
    expect(calls[0].script).not.toContain('lastUpdatedAt');
  });

  it('guards asset writes with the same lease+epoch and epoch-guards releases', async () => {
    const { redis, calls } = recordingRedis(1);
    const store = new ProviderTradeReadinessStore(redis);

    await store.publishAssets({
      provider: 'binance',
      generation: GENERATION,
      leaseToken: 'lease-token-a',
      fencingEpoch: 5,
      records: [record()],
      ttlSeconds: 30,
    });
    expect(calls[0].keys).toEqual([
      providerAssetsKey('binance', GENERATION),
      providerOwnerLeaseKey('binance'),
      providerEpochKey('binance'),
    ]);
    expect(calls[0].args.slice(0, 3)).toEqual([
      '30',
      'lease-token-a',
      '5',
    ]);

    await store.release({
      provider: 'binance',
      generation: GENERATION,
      ownerInstance: 'owner-a',
      fencingEpoch: 5,
    });
    expect(calls[1].args).toEqual([GENERATION, 'owner-a', '5']);

    await store.releaseSupersededAssets({
      provider: 'binance',
      supersededGeneration: 'gen-0',
      ownerInstance: 'owner-a',
      fencingEpoch: 5,
    });
    expect(calls[2].args).toEqual(['gen-0', 'owner-a', '5']);
  });

  it('reports a refused publish rather than swallowing it', async () => {
    const store = new ProviderTradeReadinessStore(recordingRedis(0).redis);
    expect(
      await store.publishProvider({
        meta: meta({ fencingEpoch: 3 }),
        leaseToken: 'lease-token-a',
        ttlSeconds: 30,
      }),
    ).toBe(false);
    expect(
      await store.publishAssets({
        provider: 'binance',
        generation: GENERATION,
        leaseToken: 'lease-token-a',
        fencingEpoch: 3,
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
        leaseToken: 'lease-token-a',
      }),
    ).toEqual({
      acquired: false,
      fencingEpoch: null,
      reason: 'redis_unwired',
    });
  });
});
