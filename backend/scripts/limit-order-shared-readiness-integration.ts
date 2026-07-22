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
  providerFenceKey,
  providerMetaKey,
  PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
  ProviderTradeReadinessStore,
  type SharedProviderMeta,
} from '../src/providers/provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
} from '../src/providers/provider-trade-route.registry';
import { readProviderTradeReadinessConfig } from '../src/providers/provider-trade-readiness.config';
import {
  LimitOrderProviderHealthService,
  type LimitOrderProviderAssetRequest,
} from '../src/orders/limit-matching/limit-order-provider-health.service';

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
  // The create-path scenarios below exercise the real gate, which is inert
  // unless automatic matching is on.
  assert.equal(
    process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED,
    'true',
    'the runner needs LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true',
  );
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
    await run(
      'a non-owner instance completes the whole create readiness path',
      testNonOwnerCreatePathSucceeds,
    );
    await run(
      'a non-owner create fails closed once the owner disappears',
      testNonOwnerCreatePathFailsClosedWithoutOwner,
    );
    await run(
      'a rival cannot claim ownership while the owner heartbeats',
      testRivalCannotClaimWhileOwnerHeartbeats,
    );
    await run(
      'a fenced-out owner cannot overwrite the new owner even with a newer clock',
      testFencedOutOwnerCannotOverwrite,
    );
    await run(
      'a fenced-out publisher surrenders instead of republishing',
      testFencedOutPublisherSurrenders,
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
  const ownerToken = requireOwnerFenceToken();

  // A different instance that used to own the provider, releasing late.
  const rivalStore = new ProviderTradeReadinessStore(readerRedis);
  const deletedByStaleGeneration = await rivalStore.release({
    provider: 'binance',
    generation: `stale-${randomUUID()}`,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: ownerToken,
  });
  assert.equal(deletedByStaleGeneration, false);

  // Even guessing the CURRENT generation must not help: the owner identity
  // still has to match.
  const deletedByStaleOwner = await rivalStore.release({
    provider: 'binance',
    generation: current,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: ownerToken,
  });
  assert.equal(deletedByStaleOwner, false);

  // Nor does guessing the owner identity without the fence token.
  const deletedByStaleToken = await rivalStore.release({
    provider: 'binance',
    generation: current,
    ownerInstance: OWNER_INSTANCE,
    fenceToken: ownerToken - 1,
  });
  assert.equal(deletedByStaleToken, false);

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
      fenceToken: ownerToken,
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
 * THE create-path regression, exercised across two real instances.
 *
 * A limit create resolves readiness BEFORE its transaction (where a Redis
 * round trip is allowed) and re-verifies it INSIDE the transaction (where one
 * is not, because the event-boundary advisory lock is held). That
 * in-transaction step used to be a synchronous local check which, on an
 * instance owning no provider socket, fell through to the LEGACY per-provider
 * streaming status — not connected on a plain API pod. So the shared pre-check
 * accepted the order and the transaction then rejected it with 503: the same
 * request succeeded or failed purely by which pod served it.
 *
 * Instance B here is exactly that pod: its own Redis client, its own empty
 * registry, no legacy stream at all.
 */
async function testNonOwnerCreatePathSucceeds(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const { health, request } = nonOwnerCreatePath();

  // Step 1 — before the transaction. May talk to Redis; issues the proof.
  const proof = await health.assertAvailableAsync(request);
  assert.ok(proof, 'the pre-transaction check must issue a proof');
  assert.equal(proof.ownerMode, 'shared');
  assert.equal(proof.provider, 'binance');
  assert.equal(proof.assetId, ASSET.assetId);

  // Step 2 — inside the transaction. Memory only; must reach the SAME verdict.
  health.assertReadinessProof(proof, request);

  // The regression itself: the check that used to run here fails on this
  // instance, and would have turned an accepted create into a 503.
  assert.throws(
    () => health.assertAvailable(request),
    /LIMIT_ORDER_PROVIDER_UNAVAILABLE|not connected/u,
    'the local-only check must still fail on a non-owner — that is why the proof exists',
  );

  // A proof does not become a blank cheque: it covers one asset on one
  // provider, and expires.
  assert.throws(() =>
    health.assertReadinessProof(
      proof,
      { ...request, assetId: CAPPED_ASSET.assetId },
      Date.now(),
    ),
  );
  assert.throws(() =>
    health.assertReadinessProof(proof, request, proof.expiresAt + 1),
  );
}

/** No owner, no proof. The non-owner instance must refuse to create. */
async function testNonOwnerCreatePathFailsClosedWithoutOwner(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const { health, request } = nonOwnerCreatePath();
  assert.ok(await health.assertAvailableAsync(request));

  await ownerStore.release({
    provider: 'binance',
    generation,
    ownerInstance: OWNER_INSTANCE,
    fenceToken: requireOwnerFenceToken(),
  });

  await assert.rejects(
    () => health.assertAvailableAsync(request),
    'with no instance publishing, a create must fail closed everywhere',
  );
}

/**
 * A plain API pod: its own Redis client and store, an EMPTY route registry, and
 * no legacy streaming service of any kind.
 */
function nonOwnerCreatePath(): {
  health: LimitOrderProviderHealthService;
  request: LimitOrderProviderAssetRequest;
} {
  const health = new LimitOrderProviderHealthService(
    new ProviderTradeRouteRegistry(),
    { isActive: () => true } as never,
    undefined,
    undefined,
    new ProviderTradeReadinessStore(readerRedis),
    { ...readProviderTradeReadinessConfig(), enabled: true },
  );
  return {
    health,
    request: {
      assetId: ASSET.assetId,
      symbol: ASSET.symbol,
      market: ASSET.market,
      assetType: ASSET.assetType,
    },
  };
}

/**
 * Ownership of the SHARED view is exclusive. A second supervisor — a rolling
 * deploy overlap, a second worker pod started by mistake — must not be handed
 * a fence token while the incumbent is still heartbeating, because the two
 * would then alternate publishing two different subscription sets for two
 * different sockets and every API pod would see whichever landed last.
 */
async function testRivalCannotClaimWhileOwnerHeartbeats(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const ownerToken = requireOwnerFenceToken();

  const rivalStore = new ProviderTradeReadinessStore(readerRedis);
  const claim = await rivalStore.acquireOwnership({
    provider: 'binance',
    ownerInstance: RIVAL_INSTANCE,
  });
  assert.equal(claim.acquired, false, 'the rival must not be given a token');
  assert.equal(claim.heldBy, OWNER_INSTANCE);

  // The incumbent re-acquiring keeps the SAME token: renumbering a live owner
  // would make the token useless as an identity.
  const reacquired = await ownerStore.acquireOwnership({
    provider: 'binance',
    ownerInstance: OWNER_INSTANCE,
  });
  assert.equal(reacquired.acquired, true);
  assert.equal(reacquired.fenceToken, ownerToken);
}

/**
 * THE regression this fencing exists for.
 *
 * Ownership used to be decided by comparing `lastUpdatedAt` between records
 * written by DIFFERENT HOSTS. A superseded owner whose clock ran ahead — or
 * that was simply paused and resumed — therefore wrote a record that looked
 * "newer" and overwrote the live owner's, publishing the subscription set of a
 * socket that no longer existed. Every API instance then accepted limit orders
 * against a connection nobody was listening on.
 *
 * With fencing the old owner's token is strictly lower, so no clock can help
 * it: the write is refused outright.
 */
async function testFencedOutOwnerCannotOverwrite(): Promise<void> {
  const staleGeneration = await connectOwner({ acknowledge: true });
  const staleToken = requireOwnerFenceToken();

  // The incumbent dies: its heartbeat lapses and the record expires.
  await ownerRedis.delete(providerMetaKey('binance'));

  // A new instance takes over and publishes under a strictly newer token.
  const takeoverStore = new ProviderTradeReadinessStore(readerRedis);
  const claim = await takeoverStore.acquireOwnership({
    provider: 'binance',
    ownerInstance: RIVAL_INSTANCE,
  });
  assert.equal(claim.acquired, true, 'the vacant provider must be claimable');
  assert.ok(claim.fenceToken !== null && claim.fenceToken > staleToken);
  const takeoverGeneration = randomUUID();
  publishedGenerations.push(takeoverGeneration);
  await publishRawMeta(takeoverStore, {
    generation: takeoverGeneration,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: claim.fenceToken,
    lastUpdatedAt: Date.now(),
  });

  // The zombie returns, with a clock an hour ahead of everyone else's.
  const zombieAccepted = await ownerStore.publishProvider({
    meta: {
      schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
      provider: 'binance',
      ownerInstance: OWNER_INSTANCE,
      source: 'live_candle_supervisor',
      generation: staleGeneration,
      fenceToken: staleToken,
      connected: true,
      connectedAt: Date.now(),
      lastFrameAt: Date.now(),
      lastUpdatedAt: Date.now() + 3_600_000,
      degradedReason: null,
    },
    ttlSeconds: TTL_SECONDS,
  });
  assert.equal(
    zombieAccepted,
    false,
    'a superseded owner must not win on a newer clock',
  );

  const meta = await readerStore.readProviderMeta('binance');
  assert.equal(meta?.ownerInstance, RIVAL_INSTANCE);
  assert.equal(meta?.generation, takeoverGeneration);

  // Its asset writes are refused under the same rule, so it cannot poison the
  // new owner's generation hash either.
  const zombieAssets = await ownerStore.publishAssets({
    provider: 'binance',
    generation: takeoverGeneration,
    ownerInstance: OWNER_INSTANCE,
    fenceToken: staleToken,
    records: [
      {
        schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
        assetId: ASSET.assetId,
        providerSymbol: ASSET.providerSymbol,
        symbol: ASSET.symbol,
        market: ASSET.market,
        assetType: ASSET.assetType,
        settlementCurrency: ASSET.settlementCurrency,
        sourceName: ASSET.sourceName,
        state: 'active',
        generation: takeoverGeneration,
        acknowledgedAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
    ttlSeconds: TTL_SECONDS,
  });
  assert.equal(zombieAssets, false, 'a superseded owner must not write assets');

  // Clean slate for the remaining scenarios: the takeover owner steps aside.
  await takeoverStore.release({
    provider: 'binance',
    generation: takeoverGeneration,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: claim.fenceToken,
  });
}

/**
 * The publisher's own reaction to being fenced out: it must drop its claim and
 * stay silent, not retry into a publish war with the live owner.
 */
async function testFencedOutPublisherSurrenders(): Promise<void> {
  await connectOwner({ acknowledge: true });
  assert.notEqual(
    publisher.ownershipSnapshot().binance.fenceToken,
    null,
    'the fixture publisher must own the provider first',
  );

  // Someone else takes the provider over while this publisher is between ticks.
  await ownerRedis.delete(providerMetaKey('binance'));
  const takeoverStore = new ProviderTradeReadinessStore(readerRedis);
  const claim = await takeoverStore.acquireOwnership({
    provider: 'binance',
    ownerInstance: RIVAL_INSTANCE,
  });
  assert.equal(claim.acquired, true);
  const takeoverGeneration = randomUUID();
  publishedGenerations.push(takeoverGeneration);
  await publishRawMeta(takeoverStore, {
    generation: takeoverGeneration,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: claim.fenceToken as number,
    lastUpdatedAt: Date.now(),
  });

  // The next tick discovers the refusal and surrenders.
  await publisher.publishOnce();
  assert.equal(
    publisher.ownershipSnapshot().binance.fenceToken,
    null,
    'a fenced-out publisher must drop its token',
  );

  // And a further tick does not claw the provider back.
  await publisher.publishOnce();
  const meta = await readerStore.readProviderMeta('binance');
  assert.equal(
    meta?.ownerInstance,
    RIVAL_INSTANCE,
    'the live owner must keep the shared view',
  );

  await takeoverStore.release({
    provider: 'binance',
    generation: takeoverGeneration,
    ownerInstance: RIVAL_INSTANCE,
    fenceToken: claim.fenceToken as number,
  });
}

/** Publishes a meta record directly, standing in for another instance. */
async function publishRawMeta(
  store: ProviderTradeReadinessStore,
  input: {
    generation: string;
    ownerInstance: string;
    fenceToken: number;
    lastUpdatedAt: number;
  },
): Promise<void> {
  const meta: SharedProviderMeta = {
    schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
    provider: 'binance',
    ownerInstance: input.ownerInstance,
    source: 'live_candle_supervisor',
    generation: input.generation,
    fenceToken: input.fenceToken,
    connected: true,
    connectedAt: Date.now(),
    lastFrameAt: Date.now(),
    lastUpdatedAt: input.lastUpdatedAt,
    degradedReason: null,
  };
  const accepted = await store.publishProvider({
    meta,
    ttlSeconds: TTL_SECONDS,
  });
  assert.equal(accepted, true, 'the takeover publish must be accepted');
}

function requireOwnerFenceToken(): number {
  const token = publisher.ownershipSnapshot().binance.fenceToken;
  assert.ok(
    typeof token === 'number',
    'the fixture publisher must hold a fence token',
  );
  return token;
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
  // The fence counter is deliberately TTL-less in production — it must outlive
  // every owner — so the runner removes its own only at the very end, after
  // every scenario that depends on its monotonicity has finished.
  await ownerRedis.delete(providerFenceKey('binance')).catch(() => undefined);
  await ownerRedis.delete(providerFenceKey('kis')).catch(() => undefined);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
