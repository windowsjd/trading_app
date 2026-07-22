/**
 * Multi-instance provider trade-readiness runner (real Redis).
 *
 * The defect this exists to prevent: `ProviderTradeRouteRegistry` is
 * per-process memory. In a multi-instance deployment the live-candle
 * supervisor owns the Binance/KIS socket on ONE instance while HTTP requests
 * land on any of them, so the same limit-order quote/create succeeded on the
 * owner and failed with LIMIT_ORDER_PROVIDER_UNAVAILABLE on every other pod.
 *
 * Everything below uses TWO INDEPENDENT service/registry instances talking to
 * one real Redis — a single-process unit test cannot demonstrate this.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssetType, CurrencyCode } from '../src/generated/prisma/client';
import { RedisService } from '../src/redis/redis.service';
import { ProviderTradeReadinessPublisher } from '../src/providers/provider-trade-readiness.publisher';
import {
  providerAssetsKey,
  providerMetaKey,
  ProviderTradeReadinessStore,
} from '../src/providers/provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
} from '../src/providers/provider-trade-route.registry';
import { readProviderTradeReadinessConfig } from '../src/providers/provider-trade-readiness.config';

const LIVENESS_MAX_AGE_MS = 60_000;
const TTL_SECONDS = 30;

/** Instance A: owns the socket and publishes. */
const ownerRedis = new RedisService();
/** Instance B: a completely separate API pod. Its own client, its own state. */
const readerRedis = new RedisService();

const ownerRegistry = new ProviderTradeRouteRegistry();
const ownerStore = new ProviderTradeReadinessStore(ownerRedis);
const readerStore = new ProviderTradeReadinessStore(readerRedis);

const OWNER_INSTANCE = `owner-${process.pid}-${randomUUID()}`;
const RIVAL_INSTANCE = `rival-${process.pid}-${randomUUID()}`;

const ASSET: ProviderSubscribedAsset = {
  assetId: `asset-${randomUUID()}`,
  symbol: 'BTC',
  providerSymbol: 'BTCUSDT',
  market: 'BINANCE',
  assetType: AssetType.crypto,
  settlementCurrency: CurrencyCode.USD,
  sourceName: 'binance_spot_ws_trade',
};
const CAPPED_ASSET: ProviderSubscribedAsset = {
  ...ASSET,
  assetId: `asset-${randomUUID()}`,
  symbol: 'DOGE',
  providerSymbol: 'DOGEUSDT',
};

const publisher = new ProviderTradeReadinessPublisher(
  ownerRegistry,
  ownerStore,
  {
    ...readProviderTradeReadinessConfig(),
    enabled: true,
    ttlSeconds: TTL_SECONDS,
    instanceId: OWNER_INSTANCE,
  },
);

const publishedGenerations: string[] = [];

async function main(): Promise<void> {
  assert.ok(process.env.REDIS_URL, 'REDIS_URL must be configured.');
  await ownerRedis.connect();
  await readerRedis.connect();

  try {
    await run(
      'instance B sees the readiness instance A published',
      testCrossInstanceReadiness,
    );
    await run(
      'an unacknowledged subscription is rejected on instance B',
      testRequestedRejected,
    );
    await run(
      'a rejected subscription is rejected on instance B',
      testFailedRejected,
    );
    await run(
      'a shard-capped asset is rejected on instance B',
      testCappedRejected,
    );
    await run('a stale heartbeat is rejected', testStaleFrameRejected);
    await run(
      'a reconnect invalidates the previous generation immediately',
      testReconnectGenerationInvalidatesPrevious,
    );
    await run(
      'a late release from a superseded owner cannot delete the new state',
      testLateReleaseCannotDeleteNewOwner,
    );
    await run('a Redis failure fails closed', testRedisFailureFailsClosed);
    await run(
      'no credential or raw provider frame reaches Redis',
      testNoSecretsPublished,
    );
    console.log('limit order shared readiness integration ok');
  } finally {
    await cleanupRedis();
    await ownerRedis.onModuleDestroy().catch(() => undefined);
    await readerRedis.onModuleDestroy().catch(() => undefined);
  }
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

/** Instance A owns and publishes; instance B, which owns nothing, agrees. */
async function testCrossInstanceReadiness(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });

  // Instance B has no local claim at all — it is a plain API pod.
  const readerRegistry = new ProviderTradeRouteRegistry();
  assert.equal(readerRegistry.getOwner('binance'), null);
  assert.equal(
    readerRegistry.checkAssetReadiness({
      assetId: ASSET.assetId,
      provider: 'binance',
      livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
    }).ready,
    false,
    'local-only readiness on a non-owner is the failure being fixed',
  );

  const shared = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(shared.ready, true, 'instance B must see the owner readiness');
  assert.equal(shared.ready && shared.generation, generation);
  assert.equal(shared.ready && shared.asset.providerSymbol, 'BTCUSDT');
  assert.equal(shared.ready && shared.source, 'live_candle_supervisor');
}

/** requested (sent, not acknowledged) must never be treated as subscribed. */
async function testRequestedRejected(): Promise<void> {
  await connectOwner({ acknowledge: false });
  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
  );
}

async function testFailedRejected(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  ownerRegistry.markSubscriptionsFailed({
    provider: 'binance',
    generation,
    match: (asset) => asset.assetId === ASSET.assetId,
  });
  await publisher.publishOnce();

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED',
  );
}

async function testCappedRejected(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const readiness = await readerStore.checkAssetReadiness({
    assetId: CAPPED_ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
  );
  assert.match(
    !readiness.ready ? readiness.reason : '',
    /shard cap/u,
    'a capped asset must say so, not merely "unavailable"',
  );
}

/**
 * Connection liveness is judged from the published lastFrameAt. A socket that
 * stopped producing frames must not keep accepting orders on other instances.
 */
async function testStaleFrameRejected(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
    // Evaluated far in the future: the published frame is now ancient.
    now: Date.now() + LIVENESS_MAX_AGE_MS * 10,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
  );
}

/**
 * A reconnect starts a NEW generation. Readiness published for the previous
 * one must stop being usable the moment the new meta lands — not when its TTL
 * happens to expire.
 */
async function testReconnectGenerationInvalidatesPrevious(): Promise<void> {
  const first = await connectOwner({ acknowledge: true });
  const firstAssetsKey = providerAssetsKey('binance', first);
  // The asset record is a HASH, so existence is probed with TTL (-2 = absent)
  // rather than GET, which would fail WRONGTYPE.
  assert.notEqual(await ownerRedis.ttl(firstAssetsKey), -2);

  // Reconnect: a new generation with the asset NOT yet acknowledged.
  const second = await connectOwner({ acknowledge: false });
  assert.notEqual(second, first);

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(
    readiness.ready,
    false,
    'the previous generation readiness must not survive a reconnect',
  );

  // The superseded hash is dropped immediately rather than lingering until TTL.
  assert.equal(
    await ownerRedis.ttl(firstAssetsKey),
    -2,
    'the superseded generation hash must be removed',
  );
}

/**
 * The late-release race: a replaced owner finally runs its shutdown release
 * AFTER a new owner has published. The compare-and-delete must make it a
 * no-op, otherwise the new owner's readiness would vanish and every instance
 * would fail closed for no reason.
 */
async function testLateReleaseCannotDeleteNewOwner(): Promise<void> {
  const current = await connectOwner({ acknowledge: true });

  // A different instance that used to own the provider, releasing late.
  const rivalStore = new ProviderTradeReadinessStore(readerRedis);
  const deletedByStaleGeneration = await rivalStore.release({
    provider: 'binance',
    generation: `stale-${randomUUID()}`,
    ownerInstance: RIVAL_INSTANCE,
  });
  assert.equal(deletedByStaleGeneration, false);

  // Even guessing the CURRENT generation must not help: the owner identity
  // still has to match.
  const deletedByStaleOwner = await rivalStore.release({
    provider: 'binance',
    generation: current,
    ownerInstance: RIVAL_INSTANCE,
  });
  assert.equal(deletedByStaleOwner, false);

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(
    readiness.ready,
    true,
    'a late release from a superseded owner must not remove live readiness',
  );

  // The real owner CAN release its own record.
  assert.equal(
    await ownerStore.release({
      provider: 'binance',
      generation: current,
      ownerInstance: OWNER_INSTANCE,
    }),
    true,
  );
  const afterRelease = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(afterRelease.ready, false);
}

/**
 * Redis unavailable must be fail-CLOSED. Never assume a subscription is live
 * because the shared view cannot be read.
 */
async function testRedisFailureFailsClosed(): Promise<void> {
  const brokenStore = new ProviderTradeReadinessStore({
    eval: () => Promise.reject(new Error('redis down')),
    get: () => Promise.reject(new Error('redis down')),
  } as unknown as RedisService);

  const readiness = await brokenStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_UNAVAILABLE',
  );

  // A store with no Redis at all is equally closed.
  const unwired = new ProviderTradeReadinessStore();
  const unwiredReadiness = await unwired.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(unwiredReadiness.ready, false);
}

/**
 * The shared view carries routing/liveness metadata ONLY. A credential, an
 * approval key, an access token or a raw provider frame must never be written
 * to Redis.
 */
async function testNoSecretsPublished(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const meta = await ownerRedis.get(providerMetaKey('binance'));
  const assetFields = (await ownerRedis.eval(
    "return redis.call('HGETALL', KEYS[1])",
    [providerAssetsKey('binance', generation)],
  )) as string[];
  const payload = `${meta ?? ''}${assetFields.join('')}`;
  assert.ok(payload.length > 0, 'the fixture must have published something');

  // Matched as JSON KEYS, not as bare substrings: 'iv' as a substring occurs
  // inside perfectly legitimate values such as "live_candle_supervisor".
  for (const forbidden of [
    'appkey',
    'appsecret',
    'approval_key',
    'approvalKey',
    'access_token',
    'accessToken',
    'authorization',
    'password',
    'secret',
    'rawPayload',
    'rawPayloadJson',
    'iv',
    'ekey',
  ]) {
    assert.equal(
      new RegExp(`"${forbidden}"\\s*:`, 'iu').test(payload),
      false,
      `the shared readiness payload must not carry a ${forbidden} field`,
    );
  }
  // Belt and braces on the two KIS secrets that have no innocent homonym.
  for (const forbidden of ['appsecret', 'approval_key', 'access_token']) {
    assert.equal(
      payload.toLowerCase().includes(forbidden),
      false,
      `the shared readiness payload must not contain ${forbidden} anywhere`,
    );
  }
  // What it MUST contain is exactly the routing metadata readiness needs.
  assert.match(payload, /providerSymbol/u);
  assert.match(payload, /binance_spot_ws_trade/u);
}

// ---------------------------------------------------------------------------
// Owner simulation
// ---------------------------------------------------------------------------

/**
 * Drives instance A's registry exactly as the live-candle supervisor does:
 * claim -> new generation -> socket open -> subscription targets (with a
 * shard-capped asset) -> optional acknowledgement -> publish.
 */
async function connectOwner(input: { acknowledge: boolean }): Promise<string> {
  const generation = randomUUID();
  ownerRegistry.claimProvider('binance', 'live_candle_supervisor');
  ownerRegistry.beginConnection({
    provider: 'binance',
    source: 'live_candle_supervisor',
    generation,
  });
  ownerRegistry.markConnectionOpen({
    provider: 'binance',
    generation,
    at: Date.now(),
  });
  ownerRegistry.registerSubscriptionTargets({
    provider: 'binance',
    generation,
    assets: [ASSET],
    cappedAssets: [CAPPED_ASSET],
  });
  if (input.acknowledge) {
    ownerRegistry.markSubscriptionsActive({ provider: 'binance', generation });
  }
  ownerRegistry.markFrame({
    provider: 'binance',
    generation,
    at: Date.now(),
  });
  await publisher.publishOnce();
  publishedGenerations.push(generation);
  return generation;
}

async function cleanupRedis(): Promise<void> {
  await ownerRedis.delete(providerMetaKey('binance')).catch(() => undefined);
  await ownerRedis.delete(providerMetaKey('kis')).catch(() => undefined);
  for (const generation of publishedGenerations) {
    await ownerRedis
      .delete(providerAssetsKey('binance', generation))
      .catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
