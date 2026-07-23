/**
 * Multi-instance provider trade-readiness runner (real PostgreSQL + Redis).
 *
 * Two defect families are pinned here:
 *
 * 1. `ProviderTradeRouteRegistry` is per-process memory. In a multi-instance
 *    deployment the live-candle supervisor owns the Binance/KIS socket on ONE
 *    instance while HTTP requests land on any of them, so the same limit
 *    quote/create used to succeed on the owner and fail with
 *    LIMIT_ORDER_PROVIDER_UNAVAILABLE on every other pod.
 *
 * 2. Publishing the shared view used to be fenced by a readiness-only token
 *    that proved nothing about the actual socket: a process that merely
 *    LOOKED like an owner locally could publish, and a replaced owner could
 *    keep publishing until its token happened to be superseded. Publishing
 *    rights are now derived from the REAL provider owner lease — the same
 *    Redis lock the supervisor holds for the socket — checked inside Redis on
 *    every write.
 *
 * Everything below uses TWO INDEPENDENT service/registry instances talking to
 * one real Redis, plus a real PostgreSQL for the full non-owner Quote→Create
 * financial flow — a single-process unit test cannot demonstrate either.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  OrderStatus,
  ParticipantStatus,
  SeasonStatus,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import {
  RedisLockService,
  type RedisLock,
} from '../src/redis/redis-lock.service';
import { ProviderTradeReadinessPublisher } from '../src/providers/provider-trade-readiness.publisher';
import {
  assertReadinessKeySlots,
  providerAssetsKey,
  providerEpochHolderKey,
  providerEpochKey,
  providerMetaKey,
  providerOwnerLeaseKey,
  PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
  ProviderTradeReadinessStore,
  type SharedProviderMeta,
} from '../src/providers/provider-trade-readiness.store';
import {
  ProviderTradeRouteRegistry,
  type ProviderSubscribedAsset,
} from '../src/providers/provider-trade-route.registry';
import { readProviderTradeReadinessConfig } from '../src/providers/provider-trade-readiness.config';
import { LimitOrderProviderHealthService } from '../src/orders/limit-matching/limit-order-provider-health.service';
import { LimitOrderMatchBoundaryService } from '../src/orders/limit-matching/limit-order-match-boundary.service';
import { LimitOrderMatcherHealthService } from '../src/orders/limit-matching/limit-order-matcher-health.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { OrdersService } from '../src/orders/orders.service';

const PREFIX = `lo-shared-${process.pid}-${Date.now()}`;
const LIVENESS_MAX_AGE_MS = 60_000;
const TTL_SECONDS = 30;
const ZERO = '0.00000000';

/** Instance A: owns the socket lease and publishes. */
const ownerRedis = new RedisService();
/** Instance B: a completely separate API pod. Its own client, its own state. */
const readerRedis = new RedisService();

const ownerLocks = new RedisLockService(ownerRedis);
const ownerRegistry = new ProviderTradeRouteRegistry();
const ownerStore = new ProviderTradeReadinessStore(ownerRedis);
const readerStore = new ProviderTradeReadinessStore(readerRedis);
const prisma = new PrismaService();

const OWNER_INSTANCE = `owner-${process.pid}-${randomUUID()}`;
const RIVAL_INSTANCE = `rival-${process.pid}-${randomUUID()}`;
const LEASE_KEY = providerOwnerLeaseKey('binance');

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
let ownerLease: RedisLock | null = null;

async function main(): Promise<void> {
  assert.ok(process.env.REDIS_URL, 'REDIS_URL must be configured.');
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL must be configured.');
  // The create-path scenarios drive the real gates, which are inert unless
  // the flags are on.
  assert.equal(process.env.LIMIT_ORDER_ENABLED, 'true');
  assert.equal(process.env.LIMIT_ORDER_AUTO_EXECUTION_ENABLED, 'true');
  await ownerRedis.connect();
  await readerRedis.connect();
  await prisma.$connect();

  try {
    await run(
      'readiness keys share the owner lease cluster slot',
      testKeySlotInvariant,
    );
    await run(
      'instance B sees the readiness instance A published under the live lease',
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
      'a publisher without the Redis lease cannot publish despite a local owner claim',
      testLeaselessPublisherCannotPublish,
    );
    await run(
      'a wrong lease token is refused even with the current epoch',
      testWrongLeaseTokenRefused,
    );
    await run(
      'a stale fencing epoch is refused even with the live lease token',
      testStaleEpochRefused,
    );
    await run(
      'an old owner cannot republish after takeover even with a newer clock',
      testOldOwnerCannotRepublishAfterTakeover,
    );
    await run(
      'an old-generation subscription ack cannot ready the current generation',
      testOldGenerationAckIgnored,
    );
    await run(
      'a late release from the replaced owner cannot delete the new state',
      testLateReleaseCannotDeleteNewOwner,
    );
    await run(
      'losing ONLY the lease fails the very next read, TTL notwithstanding',
      testLeaseLossFailsReadImmediately,
    );
    await run(
      'a lease held under a different token than the epoch-holder fails the read',
      testLeaseHolderMismatchFailsRead,
    );
    await run(
      'a superseded fencing epoch fails the read',
      testEpochMismatchFailsRead,
    );
    await run(
      'the publisher deletes its own stale record the tick after losing the lease',
      testPublisherReleasesStaleMetaOnLeaseLoss,
    );
    await run(
      'a non-owner instance completes the whole Quote and Create financial flow',
      testNonOwnerFullQuoteCreateFlow,
    );
    await run(
      'a non-owner create fails closed with no reservation once the owner disappears',
      testNonOwnerCreateFailsClosedWithoutOwner,
    );
    await run(
      'a non-owner create fails closed when ONLY the lease is lost',
      testNonOwnerCreateFailsClosedOnLeaseLoss,
    );
    await run(
      'an already-committed create replays BEFORE every gate, through any failure',
      testIdempotentReplayBypassesGates,
    );
    await run('a Redis failure fails closed', testRedisFailureFailsClosed);
    await run(
      'no credential or raw provider frame reaches Redis',
      testNoSecretsPublished,
    );
    console.log('limit order shared readiness integration ok');
  } finally {
    await cleanupDatabase().catch((error: unknown) => {
      console.error('db cleanup failed', error);
    });
    await cleanupRedis().catch(() => undefined);
    await ownerRedis.onModuleDestroy().catch(() => undefined);
    await readerRedis.onModuleDestroy().catch(() => undefined);
    await prisma.$disconnect();
  }
}

async function run(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`ok ${name}`);
}

// ---------------------------------------------------------------------------
// Owner simulation
// ---------------------------------------------------------------------------

/**
 * Drives instance A exactly as the live-candle supervisor does: acquire the
 * REAL Redis owner lease -> claim the route -> register the lease -> new
 * generation -> socket open -> subscription targets (with a shard-capped
 * asset) -> optional acknowledgement -> publish.
 */
async function connectOwner(input: { acknowledge: boolean }): Promise<string> {
  await ensureOwnerLease();
  const generation = randomUUID();
  ownerRegistry.claimProvider('binance', 'live_candle_supervisor');
  ownerRegistry.setOwnerLease('binance', 'live_candle_supervisor', {
    key: LEASE_KEY,
    token: (ownerLease as RedisLock).token,
  });
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

async function ensureOwnerLease(): Promise<RedisLock> {
  if (ownerLease) {
    const held = await ownerRedis.get(LEASE_KEY);
    if (held === ownerLease.token) return ownerLease;
    ownerLease = null;
  }
  const acquired = await ownerLocks.acquire(LEASE_KEY, 60_000);
  assert.equal(acquired.status, 'acquired', 'the owner lease must be free');
  ownerLease = (acquired as { status: 'acquired'; lock: RedisLock }).lock;
  return ownerLease;
}

async function dropOwnerLease(): Promise<void> {
  if (ownerLease) {
    await ownerLocks.release(ownerLease).catch(() => undefined);
    ownerLease = null;
  } else {
    await ownerRedis.delete(LEASE_KEY).catch(() => undefined);
  }
}

function requireOwnerEpoch(): number {
  const epoch = publisher.ownershipSnapshot().binance.fencingEpoch;
  assert.ok(
    typeof epoch === 'number',
    'the fixture publisher must hold a fencing epoch',
  );
  return epoch;
}

// ---------------------------------------------------------------------------
// Fencing scenarios
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/require-await -- uniform runner signature
async function testKeySlotInvariant(): Promise<void> {
  // On a clustered Redis a multi-key Lua call is only legal when every key
  // hashes to one slot, and the slot is decided by the {…} hash tag. Every
  // readiness key carries the LEASE KEY ITSELF as its tag, so it hashes
  // exactly like the lease — proven by tag identity, no CRC16 needed.
  assert.doesNotThrow(() => assertReadinessKeySlots('binance'));
  assert.doesNotThrow(() => assertReadinessKeySlots('kis'));
  for (const key of [
    providerMetaKey('binance'),
    providerAssetsKey('binance', 'gen'),
    providerEpochKey('binance'),
    providerEpochHolderKey('binance'),
  ]) {
    assert.ok(
      key.includes(`{${LEASE_KEY}}`),
      `${key} must embed the lease key`,
    );
  }
}

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

  // The published meta names the epoch and a token DIGEST, never the token.
  const meta = await readerStore.readProviderMeta('binance');
  assert.ok(meta && typeof meta.fencingEpoch === 'number');
  assert.ok(meta.leaseTokenDigest.length > 0);
  const rawMeta = (await ownerRedis.get(providerMetaKey('binance'))) ?? '';
  assert.ok(
    !rawMeta.includes((ownerLease as RedisLock).token),
    'the raw lease token must never be published',
  );
}

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
 * THE core fencing invariant: a local registry that LOOKS like an owner is
 * not enough. Publishing requires the live Redis lease, checked inside Redis
 * at write time.
 */
async function testLeaselessPublisherCannotPublish(): Promise<void> {
  await connectOwner({ acknowledge: true });
  // The lease disappears (expiry/takeover) while the local registry still
  // believes it owns everything.
  await dropOwnerLease();
  await ownerRedis.delete(providerMetaKey('binance'));

  await publisher.publishOnce();

  assert.equal(
    await ownerRedis.get(providerMetaKey('binance')),
    null,
    'a lease-less publisher must not be able to publish readiness',
  );
  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false, 'every reader must fail closed');

  // A registry claim with NO lease registered at all is refused even earlier,
  // without touching Redis (the legacy-streaming shape).
  ownerRegistry.clearOwnerLease('binance', 'live_candle_supervisor');
  await publisher.publishOnce();
  assert.equal(await ownerRedis.get(providerMetaKey('binance')), null);
}

async function testWrongLeaseTokenRefused(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const epoch = requireOwnerEpoch();

  const accepted = await ownerStore.publishProvider({
    meta: buildMeta({
      generation,
      ownerInstance: OWNER_INSTANCE,
      fencingEpoch: epoch,
      lastUpdatedAt: Date.now(),
    }),
    // Correct epoch, WRONG token: must be refused atomically inside Redis.
    leaseToken: `not-the-lease-${randomUUID()}`,
    ttlSeconds: TTL_SECONDS,
  });
  assert.equal(accepted, false, 'a wrong lease token must be refused');
}

async function testStaleEpochRefused(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const epoch = requireOwnerEpoch();

  const accepted = await ownerStore.publishProvider({
    meta: buildMeta({
      generation,
      ownerInstance: OWNER_INSTANCE,
      // The live token but an EPOCH from a previous succession.
      fencingEpoch: epoch - 1,
      lastUpdatedAt: Date.now(),
    }),
    leaseToken: (ownerLease as RedisLock).token,
    ttlSeconds: TTL_SECONDS,
  });
  assert.equal(accepted, false, 'a stale fencing epoch must be refused');
}

/**
 * THE regression owner fencing exists for, now against the REAL lease.
 *
 * A's lease lapses; B acquires the SAME lease key and publishes. A comes back
 * with its old token, its old epoch, and a wall clock an hour AHEAD — and
 * must be refused on every write path. Then the mirror image: B's records
 * carry timestamps far BEHIND A's, and are accepted anyway, because ownership
 * is the lease, never the clock.
 */
async function testOldOwnerCannotRepublishAfterTakeover(): Promise<void> {
  const staleGeneration = await connectOwner({ acknowledge: true });
  const staleEpoch = requireOwnerEpoch();
  const staleToken = (ownerLease as RedisLock).token;

  // A dies: its lease lapses and its heartbeat record expires.
  await dropOwnerLease();
  await ownerRedis.delete(providerMetaKey('binance'));

  // B takes the lease over and publishes — with a timestamp far in the PAST.
  const rivalLocks = new RedisLockService(readerRedis);
  const rivalAcquired = await rivalLocks.acquire(LEASE_KEY, 60_000);
  assert.equal(rivalAcquired.status, 'acquired');
  const rivalLease = (rivalAcquired as { status: 'acquired'; lock: RedisLock })
    .lock;
  try {
    const rivalClaim = await readerStore.acquireOwnership({
      provider: 'binance',
      leaseToken: rivalLease.token,
    });
    assert.equal(rivalClaim.acquired, true, 'the lease holder must acquire');
    const rivalEpoch = rivalClaim.fencingEpoch as number;
    assert.ok(rivalEpoch > staleEpoch, 'the epoch must be strictly newer');

    const takeoverGeneration = randomUUID();
    publishedGenerations.push(takeoverGeneration);
    const clockSkewedPast = Date.now() - 3_600_000;
    const rivalAccepted = await readerStore.publishProvider({
      meta: buildMeta({
        generation: takeoverGeneration,
        ownerInstance: RIVAL_INSTANCE,
        fencingEpoch: rivalEpoch,
        // An hour BEHIND the zombie's clock: must not matter.
        lastUpdatedAt: clockSkewedPast,
      }),
      leaseToken: rivalLease.token,
      ttlSeconds: TTL_SECONDS,
    });
    assert.equal(
      rivalAccepted,
      true,
      'the real lease holder must publish regardless of clock skew',
    );

    // The zombie returns with a clock an hour AHEAD. Meta write refused.
    const zombieMeta = await ownerStore.publishProvider({
      meta: buildMeta({
        generation: staleGeneration,
        ownerInstance: OWNER_INSTANCE,
        fencingEpoch: staleEpoch,
        lastUpdatedAt: Date.now() + 3_600_000,
      }),
      leaseToken: staleToken,
      ttlSeconds: TTL_SECONDS,
    });
    assert.equal(zombieMeta, false, 'a replaced owner must not win on a clock');

    // Asset write refused under the same rule.
    const zombieAssets = await ownerStore.publishAssets({
      provider: 'binance',
      generation: takeoverGeneration,
      leaseToken: staleToken,
      fencingEpoch: staleEpoch,
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
    assert.equal(zombieAssets, false);

    // And the publisher-level zombie (stale local registry + old lease token)
    // surrenders instead of publishing.
    await publisher.publishOnce();
    const meta = await readerStore.readProviderMeta('binance');
    assert.equal(meta?.ownerInstance, RIVAL_INSTANCE);
    assert.equal(meta?.generation, takeoverGeneration);

    await readerStore.release({
      provider: 'binance',
      generation: takeoverGeneration,
      ownerInstance: RIVAL_INSTANCE,
      fencingEpoch: rivalEpoch,
    });
  } finally {
    await rivalLocks.release(rivalLease).catch(() => undefined);
  }
}

/**
 * Old-socket callback fencing, observed through the registry contract the
 * supervisor relies on: after a reconnect, an ACK carrying the OLD generation
 * must not flip the CURRENT generation's subscriptions to active.
 */
async function testOldGenerationAckIgnored(): Promise<void> {
  const first = await connectOwner({ acknowledge: true });
  // Reconnect: new generation, subscription sent but NOT acknowledged yet.
  const second = await connectOwner({ acknowledge: false });
  assert.notEqual(second, first);

  // The old socket's ACK callback fires late, carrying its CAPTURED (old)
  // generation — exactly what the supervisor's per-connection capture does.
  ownerRegistry.markSubscriptionsActive({
    provider: 'binance',
    generation: first,
  });
  await publisher.publishOnce();

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(
    readiness.ready,
    false,
    'an old-generation ack must not ready the current generation',
  );
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
  );
}

async function testLateReleaseCannotDeleteNewOwner(): Promise<void> {
  const current = await connectOwner({ acknowledge: true });
  const ownerEpoch = requireOwnerEpoch();

  // A replaced owner releasing late: stale generation, stale epoch, or a
  // guessed owner identity — every combination is a no-op.
  const rivalStore = new ProviderTradeReadinessStore(readerRedis);
  assert.equal(
    await rivalStore.release({
      provider: 'binance',
      generation: `stale-${randomUUID()}`,
      ownerInstance: RIVAL_INSTANCE,
      fencingEpoch: ownerEpoch,
    }),
    false,
  );
  assert.equal(
    await rivalStore.release({
      provider: 'binance',
      generation: current,
      ownerInstance: RIVAL_INSTANCE,
      fencingEpoch: ownerEpoch,
    }),
    false,
  );
  assert.equal(
    await rivalStore.release({
      provider: 'binance',
      generation: current,
      ownerInstance: OWNER_INSTANCE,
      fencingEpoch: ownerEpoch - 1,
    }),
    false,
  );

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
      fencingEpoch: ownerEpoch,
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

// ---------------------------------------------------------------------------
// Read-side lease verification: stale readiness dies WITH the lease
// ---------------------------------------------------------------------------

/**
 * THE read-side regression: the owner publishes, then its REAL socket lease
 * disappears (expiry, crash, takeover in progress). The meta/assets keys are
 * still within their TTL — and must be worthless anyway. The read verifies
 * the live lease atomically, so the very next read fails closed; nothing
 * waits for the TTL.
 */
async function testLeaseLossFailsReadImmediately(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const before = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(before.ready, true);

  // ONLY the lease vanishes. Meta and assets stay, TTL intact.
  await dropOwnerLease();
  assert.ok(
    await ownerRedis.get(providerMetaKey('binance')),
    'the fixture must keep the meta record alive — the TTL is the point',
  );

  const after = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(after.ready, false, 'no live lease, no readiness — instantly');
  assert.equal(
    !after.ready && after.code,
    'LIMIT_ORDER_PROVIDER_OWNER_LEASE_LOST',
  );

  // And no proof can be issued from it either.
  const b = buildInstanceB();
  try {
    await assert.rejects(
      () =>
        b.providerHealth.assertAvailableAsync({
          assetId: ASSET.assetId,
          symbol: ASSET.symbol,
          market: ASSET.market,
          assetType: ASSET.assetType,
        }),
      (error: unknown) => {
        const body = (error as { getResponse?: () => unknown }).getResponse?.();
        return JSON.stringify(body ?? '').includes(
          'LIMIT_ORDER_PROVIDER_OWNER_LEASE_LOST',
        );
      },
    );
  } finally {
    await b.destroy();
  }
}

/**
 * The lease key exists but is held under a DIFFERENT token than the one the
 * current epoch was issued to: a takeover in progress (successor holds the
 * lease, has not acquired an epoch yet). The old record must not be readable
 * during that window.
 */
async function testLeaseHolderMismatchFailsRead(): Promise<void> {
  await connectOwner({ acknowledge: true });
  // Replace the live lease value with a stranger's token, bypassing the lock
  // service — exactly what a successor's acquire produces before it exchanges
  // the lease for an epoch.
  await ownerRedis.setWithTtl(LEASE_KEY, `stranger-${randomUUID()}`, 60);

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_OWNER_LEASE_LOST',
  );

  // Hand the lease back so the fixture chain stays deterministic.
  await ownerRedis.delete(LEASE_KEY);
  ownerLease = null;
}

/**
 * The record's fencing epoch is no longer the CURRENT epoch (a successor
 * already advanced it). The record is stale-by-succession regardless of every
 * timestamp and every TTL.
 */
async function testEpochMismatchFailsRead(): Promise<void> {
  await connectOwner({ acknowledge: true });
  // A successor advances the epoch counter; the stored meta still carries the
  // previous one.
  await readerRedis.increment(providerEpochKey('binance'));

  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
  assert.equal(
    !readiness.ready && readiness.code,
    'LIMIT_ORDER_PROVIDER_READINESS_EPOCH_MISMATCH',
  );

  // Drive one fenced-out tick so the publisher surrenders its now-stale epoch
  // and the next scenario's publish re-acquires cleanly.
  await publisher.publishOnce();
}

/**
 * Publisher self-cleanup: when the supervisor clears the owner lease (lost
 * mid-connection), the next publish tick must compare-and-delete the record
 * THIS process published — not merely stop republishing and leave the stale
 * record to its TTL.
 */
async function testPublisherReleasesStaleMetaOnLeaseLoss(): Promise<void> {
  await connectOwner({ acknowledge: true });
  assert.ok(await ownerRedis.get(providerMetaKey('binance')));

  ownerRegistry.clearOwnerLease('binance', 'live_candle_supervisor');
  await publisher.publishOnce();

  assert.equal(
    await ownerRedis.get(providerMetaKey('binance')),
    null,
    'the publisher must remove its own stale record immediately',
  );
  const readiness = await readerStore.checkAssetReadiness({
    assetId: ASSET.assetId,
    provider: 'binance',
    livenessMaxAgeMs: LIVENESS_MAX_AGE_MS,
  });
  assert.equal(readiness.ready, false);
}

// ---------------------------------------------------------------------------
// Non-owner Quote -> Create: the REAL financial flow
// ---------------------------------------------------------------------------

type DbFixtures = {
  userId: string;
  seasonId: string;
  participantId: string;
  walletId: string;
  assetId: string;
  fxRateSnapshotId: string;
  matcherRunId: string;
};

/**
 * Instance B as a REAL API pod: its own OrdersService with the full limit
 * stack, its own EMPTY registry, no legacy streaming service, and the shared
 * readiness store over its own Redis connection. The provider asset row in
 * PostgreSQL matches what instance A publishes to Redis.
 */
async function testNonOwnerFullQuoteCreateFlow(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const fixtures = await createDbFixtures();
  const b = buildInstanceB();
  try {
    // 1) QUOTE on instance B: the real quote path, including the shared
    //    readiness gate and the matcher health gate, producing a durable row.
    const quote = await b.orders.quoteOrder(fixtures.userId, {
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
    });
    assert.equal(quote.success, true);
    const quoteId = quote.data.quoteId;
    assert.ok(quoteId, 'the limit quote must be durable');
    const durableQuote = await prisma.quote.findUniqueOrThrow({
      where: { id: quoteId },
      select: { status: true, quotedReservedAmount: true },
    });
    assert.equal(durableQuote.status, 'active');
    assert.ok(durableQuote.quotedReservedAmount);

    // 2) CREATE on instance B. Inside the transaction there is no local
    //    authority and no legacy stream; the readiness PROOF from the shared
    //    view is what carries the verdict. No Redis call happens inside the
    //    transaction — proven by cutting the reader connection for the
    //    duration of the transaction being impossible to interleave here, so
    //    instead asserted structurally: the in-transaction verifier is the
    //    synchronous assertReadinessProof (unit-pinned) and instance B's only
    //    Redis client is used before the transaction opens.
    const idempotencyKey = `${PREFIX}-create-1`;
    const created = await b.orders.createOrder(fixtures.userId, {
      quoteId,
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
      idempotencyKey,
    });
    assert.equal(created.success, true);
    assert.ok(
      'order' in created.data,
      'a limit create returns the order payload',
    );
    const orderId = created.data.order.orderId;

    // 3) Financial assertions: reservation moved, balance untouched, order
    //    submitted, nothing executed.
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: fixtures.walletId },
      select: { balanceAmount: true, reservedAmount: true },
    });
    // 2 x 100 = 200 gross + 0.1% fee 0.20 = 200.20 reserved.
    assert.equal(wallet.reservedAmount.toFixed(8), '200.20000000');
    assert.equal(wallet.balanceAmount.toFixed(8), '1000.00000000');
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        status: true,
        reservedAmount: true,
        matchingActivatedAt: true,
        matchingActivationStreamId: true,
        executedAt: true,
      },
    });
    assert.equal(order.status, OrderStatus.submitted);
    assert.equal(order.reservedAmount?.toFixed(8), '200.20000000');
    assert.ok(
      order.matchingActivatedAt,
      'auto-execution on means the order must be activation-stamped',
    );
    assert.ok(order.matchingActivationStreamId);
    assert.equal(order.executedAt, null);
    assert.equal(
      await prisma.walletTransaction.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      0,
      'a submitted limit buy must not create wallet transactions',
    );
    assert.equal(
      await prisma.position.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      0,
      'a submitted limit buy must not create a position',
    );
    // The create transaction bootstraps the asset's window-completion
    // checkpoint, so the asset-scoped path-B gate never sees "submitted
    // order, no checkpoint" between the first order and the first sweep.
    const completionCheckpoint =
      await prisma.marketCandleFinalizationCheckpoint.findUnique({
        where: {
          assetId_interval: { assetId: fixtures.assetId, interval: '5m' },
        },
        select: { finalizedThroughCloseTime: true },
      });
    assert.ok(
      completionCheckpoint,
      'the create transaction must bootstrap the completion checkpoint',
    );

    // 4) Idempotent replay returns the SAME order without a second
    //    reservation.
    const replay = await b.orders.createOrder(fixtures.userId, {
      quoteId,
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
      idempotencyKey,
    });
    assert.equal(replay.success, true);
    assert.ok('order' in replay.data);
    assert.equal(replay.data.order.orderId, orderId);
    const walletAfterReplay = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: fixtures.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(walletAfterReplay.reservedAmount.toFixed(8), '200.20000000');

    // 5) Proof discipline on the same REAL shared view: the proof covers ONE
    //    asset and expires.
    const proof = await b.providerHealth.assertAvailableAsync({
      assetId: fixtures.assetId,
      symbol: ASSET.symbol,
      market: ASSET.market,
      assetType: ASSET.assetType,
    });
    assert.ok(proof && proof.ownerMode === 'shared');
    assert.throws(() =>
      b.providerHealth.assertReadinessProof(
        proof,
        {
          assetId: `${fixtures.assetId}-other`,
          symbol: ASSET.symbol,
          market: ASSET.market,
          assetType: ASSET.assetType,
        },
        Date.now(),
      ),
    );
    assert.throws(() =>
      b.providerHealth.assertReadinessProof(
        proof,
        {
          assetId: fixtures.assetId,
          symbol: ASSET.symbol,
          market: ASSET.market,
          assetType: ASSET.assetType,
        },
        proof.expiresAt + 1,
      ),
    );
  } finally {
    await b.destroy();
    await cleanupDbFixtures(fixtures);
  }
}

/** No owner -> no proof -> no reservation, no order. Fail-closed end to end. */
async function testNonOwnerCreateFailsClosedWithoutOwner(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const fixtures = await createDbFixtures();
  const b = buildInstanceB();
  try {
    const quote = await b.orders.quoteOrder(fixtures.userId, {
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '1.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
    });
    assert.equal(quote.success, true);

    // The owner disappears between quote and create.
    await ownerStore.release({
      provider: 'binance',
      generation,
      ownerInstance: OWNER_INSTANCE,
      fencingEpoch: requireOwnerEpoch(),
    });

    await assert.rejects(
      () =>
        b.orders.createOrder(fixtures.userId, {
          quoteId: quote.data.quoteId,
          assetId: fixtures.assetId,
          side: 'buy',
          orderType: 'limit',
          quantity: '1.000000',
          limitPrice: '100.00000000',
          currencyCode: 'USD',
          idempotencyKey: `${PREFIX}-create-orphan`,
        }),
      (error: unknown) => {
        const body = (error as { getResponse?: () => unknown }).getResponse?.();
        return (
          JSON.stringify(body ?? '').includes('LIMIT_ORDER_PROVIDER') === true
        );
      },
      'with no instance publishing, a create must fail closed',
    );

    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: fixtures.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(
      wallet.reservedAmount.toFixed(8),
      '0.00000000',
      'a refused create must leave no reservation behind',
    );
    assert.equal(
      await prisma.order.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      0,
      'a refused create must leave no order behind',
    );
  } finally {
    await b.destroy();
    await cleanupDbFixtures(fixtures);
  }
}

/**
 * Spec scenario: Quote succeeds, then ONLY the real owner lease disappears
 * between quote and create. The stale meta/assets are still within TTL; the
 * create's fresh readiness read must fail closed on the lease check, leaving
 * no reservation and no order.
 */
async function testNonOwnerCreateFailsClosedOnLeaseLoss(): Promise<void> {
  await connectOwner({ acknowledge: true });
  const fixtures = await createDbFixtures();
  const b = buildInstanceB();
  try {
    const quote = await b.orders.quoteOrder(fixtures.userId, {
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '1.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
    });
    assert.equal(quote.success, true);

    // ONLY the lease is lost. Meta and assets stay within their TTL.
    await dropOwnerLease();
    assert.ok(
      await ownerRedis.get(providerMetaKey('binance')),
      'the stale record must still be in Redis for this scenario to bite',
    );

    await assert.rejects(
      () =>
        b.orders.createOrder(fixtures.userId, {
          quoteId: quote.data.quoteId,
          assetId: fixtures.assetId,
          side: 'buy',
          orderType: 'limit',
          quantity: '1.000000',
          limitPrice: '100.00000000',
          currencyCode: 'USD',
          idempotencyKey: `${PREFIX}-create-lease-lost`,
        }),
      (error: unknown) => {
        const body = (error as { getResponse?: () => unknown }).getResponse?.();
        return JSON.stringify(body ?? '').includes(
          'LIMIT_ORDER_PROVIDER_OWNER_LEASE_LOST',
        );
      },
      'a create against a leaseless record must fail closed with the lease code',
    );

    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: fixtures.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(wallet.reservedAmount.toFixed(8), '0.00000000');
    assert.equal(
      await prisma.order.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      0,
    );
  } finally {
    await b.destroy();
    await cleanupDbFixtures(fixtures);
  }
}

/**
 * IDEMPOTENT REPLAY FIRST. A create that already committed must replay its
 * stored first response BEFORE the provider gate, the matcher gate and the
 * season checks — through a provider outage AND after the season ended —
 * with the same order id and not one extra cent reserved. A NEW key under the
 * same outage keeps failing closed.
 */
async function testIdempotentReplayBypassesGates(): Promise<void> {
  const generation = await connectOwner({ acknowledge: true });
  const fixtures = await createDbFixtures();
  const b = buildInstanceB();
  try {
    const quote = await b.orders.quoteOrder(fixtures.userId, {
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
    });
    assert.equal(quote.success, true);
    const request = {
      quoteId: quote.data.quoteId,
      assetId: fixtures.assetId,
      side: 'buy',
      orderType: 'limit',
      quantity: '2.000000',
      limitPrice: '100.00000000',
      currencyCode: 'USD',
      idempotencyKey: `${PREFIX}-replay-1`,
    };
    const created = await b.orders.createOrder(fixtures.userId, request);
    assert.equal(created.success, true);
    assert.ok('order' in created.data);
    const orderId = created.data.order.orderId;
    const reservedAfterCreate = '200.20000000';

    // The provider disappears COMPLETELY: readiness released AND lease gone.
    await ownerStore.release({
      provider: 'binance',
      generation,
      ownerInstance: OWNER_INSTANCE,
      fencingEpoch: requireOwnerEpoch(),
    });
    await dropOwnerLease();

    // Same key, same request: the stored response replays; no gate runs.
    const replay = await b.orders.createOrder(fixtures.userId, request);
    assert.ok('order' in replay.data);
    assert.equal(
      replay.data.order.orderId,
      orderId,
      'the replay must return the ORIGINAL order',
    );
    const wallet = await prisma.cashWallet.findUniqueOrThrow({
      where: { id: fixtures.walletId },
      select: { reservedAmount: true },
    });
    assert.equal(
      wallet.reservedAmount.toFixed(8),
      reservedAfterCreate,
      'a replay must not reserve a second time',
    );
    assert.equal(
      await prisma.order.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      1,
    );

    // Same key, DIFFERENT request: conflict, original order untouched.
    await assert.rejects(
      () =>
        b.orders.createOrder(fixtures.userId, {
          ...request,
          limitPrice: '101.00000000',
        }),
      (error: unknown) => {
        const body = (error as { getResponse?: () => unknown }).getResponse?.();
        return JSON.stringify(body ?? '').includes(
          'ORDER_IDEMPOTENCY_CONFLICT',
        );
      },
    );

    // The season ends. The replay STILL returns the original response —
    // an already-committed create owes its caller the first answer, and the
    // user-scoped lookup does not need an active season to find it.
    await prisma.season.update({
      where: { id: fixtures.seasonId },
      data: { endAt: new Date(Date.now() - 60_000) },
    });
    const afterSeasonEnd = await b.orders.createOrder(fixtures.userId, request);
    assert.ok('order' in afterSeasonEnd.data);
    assert.equal(afterSeasonEnd.data.order.orderId, orderId);
    assert.equal(
      await prisma.order.count({
        where: { seasonParticipantId: fixtures.participantId },
      }),
      1,
      'a season-ended replay must not create anything',
    );

    // A NEW key under the same outage still fails closed — replay is a
    // property of an already-committed create, never a gate bypass for new
    // work. (The season-end check fires first here; both are fail-closed.)
    await assert.rejects(() =>
      b.orders.createOrder(fixtures.userId, {
        ...request,
        idempotencyKey: `${PREFIX}-replay-new-key`,
      }),
    );
  } finally {
    await b.destroy();
    await cleanupDbFixtures(fixtures);
  }
}

function buildInstanceB() {
  const registry = new ProviderTradeRouteRegistry();
  const providerHealth = new LimitOrderProviderHealthService(
    registry,
    { isActive: () => true } as never,
    undefined,
    undefined,
    readerStore,
    { ...readProviderTradeReadinessConfig(), enabled: true },
  );
  const matcherHealth = new LimitOrderMatcherHealthService(prisma);
  const boundary = new LimitOrderMatchBoundaryService();
  const reservation = new OrderReservationService();
  const createService = new LimitOrderCreateService(prisma, reservation);
  const cancelService = new LimitOrderCancelService(prisma, reservation);
  const orders = new OrdersService(
    prisma,
    undefined,
    createService,
    cancelService,
    matcherHealth,
    readerRedis,
    providerHealth,
    boundary,
    undefined,
  );
  return {
    orders,
    providerHealth,
    destroy: async () => {
      await boundary.onModuleDestroy().catch(() => undefined);
    },
  };
}

async function createDbFixtures(): Promise<DbFixtures> {
  const now = new Date();
  const user = await prisma.user.create({
    data: {
      email: `${PREFIX}-${randomUUID()}@example.com`,
      passwordHash: 'integration-test-only',
      nickname: `lo-shared-${randomUUID()}`.slice(0, 40),
    },
    select: { id: true },
  });
  const season = await prisma.season.create({
    data: {
      name: `${PREFIX}-season`,
      status: SeasonStatus.active,
      startAt: new Date(now.getTime() - 12 * 3_600_000),
      endAt: new Date(now.getTime() + 86_400_000),
      initialCapitalKrw: '1300000.00000000',
      tradeFeeRate: '0.001000',
      fxFeeRate: '0.001000',
    },
    select: { id: true },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: user.id,
      joinedAt: now,
      participantStatus: ParticipantStatus.active,
      initialCapitalKrw: '1300000.00000000',
      totalAssetKrw: '1300000.00000000',
      totalReturnRate: ZERO,
      maxDrawdown: ZERO,
    },
    select: { id: true },
  });
  const wallet = await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.USD,
      balanceAmount: '1000.00000000',
      reservedAmount: ZERO,
    },
    select: { id: true },
  });
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: participant.id,
      currencyCode: CurrencyCode.KRW,
      balanceAmount: ZERO,
      reservedAmount: ZERO,
    },
  });
  // The DB asset row IS the asset instance A publishes readiness for.
  const asset = await prisma.asset.create({
    data: {
      id: ASSET.assetId,
      symbol: `${ASSET.symbol}${PREFIX.slice(-6)}`.slice(0, 32),
      name: `${PREFIX}-btc`,
      market: ASSET.market,
      assetType: ASSET.assetType,
      currencyCode: CurrencyCode.USD,
      priceCurrency: CurrencyCode.USD,
      settlementCurrency: CurrencyCode.USD,
      isActive: true,
    },
    select: { id: true },
  });
  const fx = await prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
      rate: '1300.00000000',
      sourceType: FxRateSourceType.provider_api,
      sourceName: 'exchange_rate_api',
      sourceTimestamp: now,
      effectiveAt: now,
      capturedAt: now,
    },
    select: { id: true },
  });
  // A fresh matcher leader heartbeat so the matcher gate passes; the row is
  // failed (not deleted) during cleanup so no fake "running" leader lingers.
  const matcherHealth = new LimitOrderMatcherHealthService(prisma);
  const matcherRunId = await matcherHealth.startLeader({
    consumerName: `${PREFIX}-leader`,
    startedAt: now,
  });
  return {
    userId: user.id,
    seasonId: season.id,
    participantId: participant.id,
    walletId: wallet.id,
    assetId: asset.id,
    fxRateSnapshotId: fx.id,
    matcherRunId,
  };
}

async function cleanupDbFixtures(fixtures: DbFixtures): Promise<void> {
  await prisma.opsJobRun
    .updateMany({
      where: { id: fixtures.matcherRunId },
      data: { status: 'failed', finishedAt: new Date() },
    })
    .catch(() => undefined);
  await prisma.opsJobRun.deleteMany({ where: { id: fixtures.matcherRunId } });
  await prisma.order.deleteMany({
    where: { seasonParticipantId: fixtures.participantId },
  });
  await prisma.quote.deleteMany({ where: { userId: fixtures.userId } });
  await prisma.cashWallet.deleteMany({
    where: { seasonParticipantId: fixtures.participantId },
  });
  await prisma.seasonParticipant.deleteMany({
    where: { id: fixtures.participantId },
  });
  await prisma.fxRateSnapshot.deleteMany({
    where: { id: fixtures.fxRateSnapshotId },
  });
  // The create transaction bootstraps the asset's window-completion
  // checkpoint, which references the asset with ON DELETE RESTRICT.
  await prisma.marketCandleFinalizationCheckpoint.deleteMany({
    where: { assetId: fixtures.assetId },
  });
  await prisma.asset.deleteMany({ where: { id: fixtures.assetId } });
  await prisma.season.deleteMany({ where: { id: fixtures.seasonId } });
  await prisma.user.deleteMany({ where: { id: fixtures.userId } });
}

// ---------------------------------------------------------------------------
// Fail-closed and hygiene
// ---------------------------------------------------------------------------

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
  // Belt and braces on the two KIS secrets that have no innocent homonym,
  // plus the RAW owner lease token (only its digest may appear).
  for (const forbidden of ['appsecret', 'approval_key', 'access_token']) {
    assert.equal(
      payload.toLowerCase().includes(forbidden),
      false,
      `the shared readiness payload must not contain ${forbidden} anywhere`,
    );
  }
  assert.ok(ownerLease);
  assert.equal(
    payload.includes(ownerLease.token),
    false,
    'the raw owner lease token must never be published',
  );
  // What it MUST contain is exactly the routing metadata readiness needs.
  assert.match(payload, /providerSymbol/u);
  assert.match(payload, /binance_spot_ws_trade/u);
  assert.match(payload, /fencingEpoch/u);
}

function buildMeta(input: {
  generation: string;
  ownerInstance: string;
  fencingEpoch: number;
  lastUpdatedAt: number;
}): SharedProviderMeta {
  return {
    schemaVersion: PROVIDER_TRADE_READINESS_SCHEMA_VERSION,
    provider: 'binance',
    ownerInstance: input.ownerInstance,
    source: 'live_candle_supervisor',
    generation: input.generation,
    fencingEpoch: input.fencingEpoch,
    leaseTokenDigest: 'test-digest',
    connected: true,
    connectedAt: Date.now(),
    lastFrameAt: Date.now(),
    lastUpdatedAt: input.lastUpdatedAt,
    degradedReason: null,
  };
}

async function cleanupRedis(): Promise<void> {
  await dropOwnerLease();
  await ownerRedis.delete(providerMetaKey('binance')).catch(() => undefined);
  await ownerRedis.delete(providerMetaKey('kis')).catch(() => undefined);
  for (const generation of publishedGenerations) {
    await ownerRedis
      .delete(providerAssetsKey('binance', generation))
      .catch(() => undefined);
  }
  // The epoch counter is deliberately TTL-less in production — it must
  // outlive every owner — so the runner removes its own only at the very
  // end, after every scenario that depends on its monotonicity has finished.
  for (const provider of ['binance', 'kis'] as const) {
    await ownerRedis.delete(providerEpochKey(provider)).catch(() => undefined);
    await ownerRedis
      .delete(providerEpochHolderKey(provider))
      .catch(() => undefined);
  }
}

async function cleanupDatabase(): Promise<void> {
  await prisma.season.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({
    where: { email: { startsWith: PREFIX } },
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
