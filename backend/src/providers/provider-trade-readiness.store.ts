import { Injectable, Logger, Optional } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import type {
  AssetTradeReadiness,
  ProviderSubscribedAsset,
  ProviderSubscriptionState,
  ProviderTradeSource,
  TradeRouteProvider,
} from './provider-trade-route.registry';

/**
 * Cross-instance mirror of the canonical provider trade-route readiness.
 *
 * WHY
 * ---
 * `ProviderTradeRouteRegistry` is per-process memory that mirrors the socket
 * THIS process owns. In a multi-instance deployment the live-candle supervisor
 * runs on one instance while HTTP requests land on any of them, so an API
 * instance that does not own the Binance/KIS connection would answer
 * "unavailable" for an asset that is in fact perfectly subscribed — the same
 * user request would succeed or fail depending on which pod served it.
 *
 * The owner publishes its readiness here; every other instance reads it. The
 * answer is then identical everywhere.
 *
 * WHAT IS NEVER PUBLISHED
 * -----------------------
 * Only routing/liveness metadata: provider, generation, subscription state,
 * timestamps, the provider symbol, and the normalized source NAME. Never a
 * credential, never an approval key, never an access token, never a raw
 * provider frame.
 *
 * KEY SCHEMA. Every readiness key embeds the PROVIDER OWNER LEASE KEY as its
 * cluster hash tag (`{<leaseKey>}`), so on a clustered Redis the lease and
 * every readiness key land on ONE slot and each mutating script can read the
 * live lease in the same atomic call it writes with:
 *
 *   limit-order:trade-readiness:v2:{<leaseKey>}:meta
 *       JSON provider record, TTL = heartbeatTtlSeconds. Its expiry IS the
 *       owner heartbeat: an owner that stops publishing disappears.
 *
 *   limit-order:trade-readiness:v2:{<leaseKey>}:gen:<generation>:assets
 *       HASH assetId -> JSON asset record, TTL = heartbeatTtlSeconds.
 *       Generation-scoped, so a reconnect writes a NEW key and every asset
 *       readiness of the previous generation is unreachable the instant the
 *       new meta is published; the orphaned key then expires on its own.
 *
 *   limit-order:trade-readiness:v2:{<leaseKey>}:epoch
 *       Monotonic INCR fencing-epoch counter. NEVER expires and is never
 *       reset: it is the ordering authority across owner successions and
 *       must outlive every owner.
 *
 *   limit-order:trade-readiness:v2:{<leaseKey>}:epoch-holder
 *       The lease token the current epoch was issued to. Never expires; it
 *       only ever changes inside the acquire script.
 *
 * `<leaseKey>` is the live-candle supervisor's Redis owner lease key for the
 * provider (`buildLiveCandleOwnerLeaseKey`), deterministic from the provider
 * name, so readers construct the same keys without holding any lease.
 *
 * OWNERSHIP = THE REAL PROVIDER LEASE, NOT A PARALLEL TOKEN
 * ---------------------------------------------------------
 * A readiness-only token (the previous design) proved that a process had once
 * won a race for a readiness key — it proved NOTHING about who actually holds
 * the provider socket. A process whose local registry looked like an owner
 * could still publish; a process that had lost the real socket lease could
 * keep publishing until its own token was superseded.
 *
 * Publishing rights are now derived from the SAME Redis lease the supervisor
 * holds while it owns the socket:
 *
 *   - `acquireOwnership` hands out a fencing epoch ONLY while the caller's
 *     lease token is the live value of the provider owner lease key. No
 *     lease, no epoch, no publish. A local registry claim alone can never
 *     acquire anything.
 *   - every mutating script re-reads the lease key INSIDE Redis and refuses
 *     the write unless the caller's token is still the live lease value AND
 *     the caller's epoch is still the current epoch. Losing the lease
 *     therefore revokes publish rights at the very next write, atomically.
 *   - the epoch is a Redis INCR, strictly monotonic across successions, so a
 *     replaced owner can never win with a bigger wall-clock timestamp, a
 *     paused-then-resumed callback, or any clock at all. No timestamp is
 *     compared anywhere in the ownership decision.
 *   - releases compare epoch + generation + owner against the STORED meta, so
 *     a late release from a replaced owner is a no-op.
 *
 * FAIL-CLOSED
 * -----------
 * Every failure mode — Redis down, missing meta, expired TTL, stale frame,
 * unknown asset, generation mismatch — resolves to "not ready". There is no
 * fail-open path: accepting a limit order whose asset is not actually
 * subscribed reserves the user's cash against a fill that can never happen.
 */

/**
 * Version 3: fencing is derived from the REAL provider owner lease. A v2
 * record carried a standalone token that proved nothing about the socket; a
 * v1 record carried no fencing at all. Readers reject every earlier version
 * outright — during a rolling deploy readiness is unavailable (fail-closed)
 * rather than decided from a record whose ownership cannot be established.
 * The key prefix moved to v2 at the same time, so mixed-version instances do
 * not even share keys.
 */
export const PROVIDER_TRADE_READINESS_SCHEMA_VERSION = 3;
export const PROVIDER_TRADE_READINESS_KEY_PREFIX =
  'limit-order:trade-readiness:v2';

export type SharedProviderMeta = {
  schemaVersion: number;
  provider: TradeRouteProvider;
  ownerInstance: string;
  source: ProviderTradeSource;
  generation: string;
  /**
   * Redis-generated, strictly monotonic succession counter, issued only to a
   * caller holding the live provider owner lease. The ordering authority
   * between owners — never a timestamp, which two hosts can disagree about.
   */
  fencingEpoch: number;
  /**
   * Non-secret digest of the lease token the record was published under.
   * Diagnostics only; every write is verified against the RAW token inside
   * Redis, never against this digest.
   */
  leaseTokenDigest: string;
  connected: boolean;
  connectedAt: number | null;
  lastFrameAt: number | null;
  lastUpdatedAt: number;
  degradedReason: string | null;
};

export type SharedAssetRecord = {
  schemaVersion: number;
  assetId: string;
  providerSymbol: string;
  symbol: string;
  market: string;
  assetType: string;
  settlementCurrency: string;
  sourceName: string;
  state: ProviderSubscriptionState;
  generation: string;
  acknowledgedAt: number | null;
  updatedAt: number;
};

/**
 * The provider owner lease key readiness fencing is derived from. Kept in
 * sync with `buildLiveCandleOwnerLeaseKey` by a unit test rather than an
 * import, so the store stays free of a dependency on the candle layer.
 */
export function providerOwnerLeaseKey(provider: TradeRouteProvider): string {
  return `candles:live:v1:owner:${provider}:0`;
}

/**
 * `{<leaseKey>}` as the hash tag: the readiness keys and the lease key itself
 * hash to the SAME cluster slot, which is what allows every mutating script
 * to read the live lease atomically. Verified by `assertReadinessKeySlots`.
 */
function readinessKeyPrefix(provider: TradeRouteProvider): string {
  return `${PROVIDER_TRADE_READINESS_KEY_PREFIX}:{${providerOwnerLeaseKey(provider)}}`;
}

export function providerMetaKey(provider: TradeRouteProvider): string {
  return `${readinessKeyPrefix(provider)}:meta`;
}

export function providerAssetsKey(
  provider: TradeRouteProvider,
  generation: string,
): string {
  return `${readinessKeyPrefix(provider)}:gen:${generation}:assets`;
}

export function providerEpochKey(provider: TradeRouteProvider): string {
  return `${readinessKeyPrefix(provider)}:epoch`;
}

export function providerEpochHolderKey(provider: TradeRouteProvider): string {
  return `${readinessKeyPrefix(provider)}:epoch-holder`;
}

/**
 * Cluster-slot invariant: on a clustered Redis a multi-key Lua call is only
 * legal when every key hashes to one slot. Slot assignment is decided by the
 * `{…}` hash tag, so "every readiness key's hash tag IS the lease key" makes
 * them all hash exactly like the lease key itself — no CRC16 computation is
 * needed to prove it, only that the tag is byte-identical. Fails fast at
 * publisher startup instead of failing the first publish on a cluster.
 */
export function assertReadinessKeySlots(provider: TradeRouteProvider): void {
  const lease = providerOwnerLeaseKey(provider);
  for (const key of [
    providerMetaKey(provider),
    providerAssetsKey(provider, 'gen'),
    providerEpochKey(provider),
    providerEpochHolderKey(provider),
  ]) {
    const tag = /\{([^}]*)\}/u.exec(key)?.[1];
    if (tag !== lease) {
      throw new Error(
        `Readiness key ${key} does not carry the provider owner lease key as its hash tag; a clustered Redis would reject the fenced publish script.`,
      );
    }
  }
}

/**
 * Hands out a fencing epoch, and ONLY to the caller that currently holds the
 * REAL provider owner lease: the caller's lease token must be the live value
 * of the lease key, read inside this same atomic call.
 *
 * The current holder re-acquiring keeps the epoch it already holds:
 * renumbering a live owner on every publish-loop restart would make the epoch
 * meaningless as a succession identity. A NEW lease token (a new ownership,
 * even by the same process) always INCRs.
 *
 * No lease -> no epoch. There is no path to publishing rights that does not
 * run through the socket owner lease.
 */
const ACQUIRE_OWNERSHIP_SCRIPT = `
local held = redis.call('GET', KEYS[1])
if not held or held ~= ARGV[1] then
  return { 0, '', held and 'lease_held_by_other' or 'lease_absent' }
end
local holder = redis.call('GET', KEYS[3])
if holder == ARGV[1] then
  local epoch = redis.call('GET', KEYS[2])
  if epoch then
    return { 1, epoch, '' }
  end
end
local epoch = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[3], ARGV[1])
return { 1, string.format('%d', epoch), '' }
`;

/**
 * Lease-and-epoch-guarded publish. The write happens only while:
 *   1. the caller's lease token is STILL the live provider owner lease, and
 *   2. the caller's fencing epoch is STILL the current epoch.
 *
 * A replaced owner fails (1) the moment its lease expires or is taken over —
 * no clock, callback timing, or larger timestamp can help it. (2) closes the
 * sliver where a lease token could be reused verbatim.
 */
const PUBLISH_META_SCRIPT = `
local held = redis.call('GET', KEYS[2])
if not held or held ~= ARGV[2] then
  return 0
end
local epoch = redis.call('GET', KEYS[3])
if not epoch or epoch ~= ARGV[3] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[4]))
return 1
`;

/**
 * Writes asset records into the generation-scoped hash and refreshes its TTL
 * in the same round trip, so a hash can never outlive its heartbeat window
 * because an EXPIRE was lost between two calls.
 *
 * Guarded by the SAME lease+epoch rule as the meta publish. Assets are
 * written BEFORE the meta of a new generation, which is safe precisely
 * because the guard does not depend on the meta at all.
 */
const PUBLISH_ASSETS_SCRIPT = `
local held = redis.call('GET', KEYS[2])
if not held or held ~= ARGV[2] then
  return 0
end
local epoch = redis.call('GET', KEYS[3])
if not epoch or epoch ~= ARGV[3] then
  return 0
end
local ttl = tonumber(ARGV[1])
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ttl)
return 1
`;

/**
 * Single-round-trip readiness read: resolves the current generation from the
 * meta record and reads the asset field of THAT generation's hash. Doing both
 * in one script removes the window where a reconnect lands between the two
 * reads and the caller mixes a new meta with an old asset record.
 */
const READ_READINESS_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if not meta then
  return { 'no_meta' }
end
local ok, decoded = pcall(cjson.decode, meta)
if not ok or not decoded or not decoded.generation then
  return { 'no_meta' }
end
local assetsKey = ARGV[1] .. ':gen:' .. decoded.generation .. ':assets'
local record = redis.call('HGET', assetsKey, ARGV[2])
if not record then
  return { 'no_asset', meta }
end
return { 'ok', meta, record }
`;

/**
 * Deletes only when generation, owner AND fencing epoch all still match the
 * STORED meta. A release does not require the live lease (shutdown releases
 * run after the supervisor has already given the lease up); it only requires
 * that the record being deleted is provably the caller's own. A new owner has
 * republished with a higher epoch by then, so a late release is a no-op.
 */
const RELEASE_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if not meta then
  return 0
end
local ok, decoded = pcall(cjson.decode, meta)
if not ok or type(decoded) ~= 'table' then
  return 0
end
if decoded.generation ~= ARGV[1] or decoded.ownerInstance ~= ARGV[2] then
  return 0
end
if (tonumber(decoded.fencingEpoch) or -1) ~= tonumber(ARGV[3]) then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

/**
 * Drops a SUPERSEDED generation's asset hash. Guarded so it can only ever
 * delete a hash the current meta no longer points at, and only while this
 * instance still holds the meta under the same fencing epoch — a late call
 * from a replaced owner is a no-op.
 */
const RELEASE_SUPERSEDED_ASSETS_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if not meta then
  return 0
end
local ok, decoded = pcall(cjson.decode, meta)
if not ok or type(decoded) ~= 'table' then
  return 0
end
if decoded.ownerInstance ~= ARGV[2] then
  return 0
end
if (tonumber(decoded.fencingEpoch) or -1) ~= tonumber(ARGV[3]) then
  return 0
end
if decoded.generation == ARGV[1] then
  return 0
end
redis.call('DEL', KEYS[2])
return 1
`;

export type SharedReadinessConfig = {
  enabled: boolean;
  heartbeatTtlSeconds: number;
  livenessMaxAgeMs: number;
};

@Injectable()
export class ProviderTradeReadinessStore {
  private readonly logger = new Logger(ProviderTradeReadinessStore.name);

  constructor(@Optional() private readonly redis?: RedisService) {}

  isAvailable(): boolean {
    return this.redis !== undefined;
  }

  /**
   * Exchanges the caller's PROVIDER OWNER LEASE for a fencing epoch.
   *
   * `acquired: false` means the caller does not hold the live lease — either
   * nobody does, or another process does. That is NOT an error and must not
   * be retried in a tight loop: a process without the socket lease simply has
   * nothing it is entitled to publish.
   */
  async acquireOwnership(input: {
    provider: TradeRouteProvider;
    leaseToken: string;
  }): Promise<{
    acquired: boolean;
    fencingEpoch: number | null;
    reason: string | null;
  }> {
    if (!this.redis) {
      return { acquired: false, fencingEpoch: null, reason: 'redis_unwired' };
    }
    const raw = await this.redis.eval(
      ACQUIRE_OWNERSHIP_SCRIPT,
      [
        providerOwnerLeaseKey(input.provider),
        providerEpochKey(input.provider),
        providerEpochHolderKey(input.provider),
      ],
      [input.leaseToken],
    );
    const reply = Array.isArray(raw) ? raw : [];
    const acquired = toNumber(reply[0]) === 1;
    const fencingEpoch = toNumber(reply[1]);
    const reason =
      typeof reply[2] === 'string' && reply[2] !== '' ? reply[2] : null;
    if (!acquired || fencingEpoch === null || !Number.isFinite(fencingEpoch)) {
      return { acquired: false, fencingEpoch: null, reason };
    }
    return { acquired: true, fencingEpoch, reason: null };
  }

  /**
   * Publishes (or refreshes) the provider record. Returns false when the
   * caller no longer holds the live lease or its epoch was superseded — the
   * caller treats that as "fenced out" and stops publishing rather than
   * retrying.
   */
  async publishProvider(input: {
    meta: SharedProviderMeta;
    leaseToken: string;
    ttlSeconds: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      PUBLISH_META_SCRIPT,
      [
        providerMetaKey(input.meta.provider),
        providerOwnerLeaseKey(input.meta.provider),
        providerEpochKey(input.meta.provider),
      ],
      [
        JSON.stringify(input.meta),
        input.leaseToken,
        String(input.meta.fencingEpoch),
        String(input.ttlSeconds),
      ],
    );
    return toNumber(result) === 1;
  }

  /** Returns false when the lease or epoch no longer belongs to this writer. */
  async publishAssets(input: {
    provider: TradeRouteProvider;
    generation: string;
    leaseToken: string;
    fencingEpoch: number;
    records: readonly SharedAssetRecord[];
    ttlSeconds: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    if (input.records.length === 0) return true;
    const args: string[] = [
      String(input.ttlSeconds),
      input.leaseToken,
      String(input.fencingEpoch),
    ];
    for (const record of input.records) {
      args.push(record.assetId, JSON.stringify(record));
    }
    const result = await this.redis.eval(
      PUBLISH_ASSETS_SCRIPT,
      [
        providerAssetsKey(input.provider, input.generation),
        providerOwnerLeaseKey(input.provider),
        providerEpochKey(input.provider),
      ],
      args,
    );
    return toNumber(result) === 1;
  }

  /**
   * Compare-and-delete release. A late release from a superseded owner leaves
   * the current owner's keys untouched.
   */
  async release(input: {
    provider: TradeRouteProvider;
    generation: string;
    ownerInstance: string;
    fencingEpoch: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      [
        providerMetaKey(input.provider),
        providerAssetsKey(input.provider, input.generation),
      ],
      [input.generation, input.ownerInstance, String(input.fencingEpoch)],
    );
    return toNumber(result) === 1;
  }

  async releaseSupersededAssets(input: {
    provider: TradeRouteProvider;
    supersededGeneration: string;
    ownerInstance: string;
    fencingEpoch: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      RELEASE_SUPERSEDED_ASSETS_SCRIPT,
      [
        providerMetaKey(input.provider),
        providerAssetsKey(input.provider, input.supersededGeneration),
      ],
      [
        input.supersededGeneration,
        input.ownerInstance,
        String(input.fencingEpoch),
      ],
    );
    return toNumber(result) === 1;
  }

  /**
   * Shared readiness decision for one asset. Mirrors
   * `ProviderTradeRouteRegistry.checkAssetReadiness` exactly, so a request
   * answered from Redis and a request answered from local memory can never
   * disagree.
   */
  async checkAssetReadiness(input: {
    assetId: string;
    provider: TradeRouteProvider;
    livenessMaxAgeMs: number;
    now?: number;
  }): Promise<AssetTradeReadiness> {
    if (!this.redis) {
      return unavailable(
        `No shared ${input.provider} trade readiness source is configured.`,
      );
    }

    let raw: unknown;
    try {
      raw = await this.redis.eval(
        READ_READINESS_SCRIPT,
        [providerMetaKey(input.provider)],
        [readinessKeyPrefix(input.provider), input.assetId],
      );
    } catch (error) {
      // Redis unavailable is fail-CLOSED. Never assume the subscription is
      // live just because the shared view cannot be read.
      this.logger.warn(
        `Shared ${input.provider} trade readiness read failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return unavailable(
        `The shared ${input.provider} trade readiness view is unavailable.`,
      );
    }

    const reply = Array.isArray(raw) ? raw : [];
    const status = typeof reply[0] === 'string' ? reply[0] : 'no_meta';
    if (status === 'no_meta') {
      return unavailable(
        `No instance is publishing a ${input.provider} canonical trade connection.`,
      );
    }

    const meta = parseJson<SharedProviderMeta>(reply[1]);
    if (
      !meta ||
      meta.schemaVersion !== PROVIDER_TRADE_READINESS_SCHEMA_VERSION ||
      // A record with no usable fencing epoch cannot be attributed to a live
      // owner, so it is not evidence of anything.
      typeof meta.fencingEpoch !== 'number' ||
      !Number.isFinite(meta.fencingEpoch)
    ) {
      return unavailable(
        `The shared ${input.provider} trade readiness record is not readable.`,
      );
    }
    if (meta.degradedReason) {
      return unavailable(
        `The ${input.provider} canonical trade connection is degraded: ${meta.degradedReason}.`,
      );
    }
    if (!meta.connected || !meta.generation) {
      return unavailable(
        `The ${input.provider} canonical trade connection is not established.`,
      );
    }
    const now = input.now ?? Date.now();
    if (
      meta.lastFrameAt === null ||
      meta.lastFrameAt === undefined ||
      now - meta.lastFrameAt > input.livenessMaxAgeMs
    ) {
      return unavailable(
        `The ${input.provider} canonical trade connection has no recent frame.`,
      );
    }

    if (status !== 'ok') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The asset is not part of the current ${input.provider} subscription target set.`,
      };
    }

    const record = parseJson<SharedAssetRecord>(reply[2]);
    if (
      !record ||
      record.schemaVersion !== PROVIDER_TRADE_READINESS_SCHEMA_VERSION
    ) {
      return unavailable(
        `The shared ${input.provider} asset readiness record is not readable.`,
      );
    }
    // The hash is generation-scoped, so this can only differ if a record was
    // written into the wrong key. Treat the disagreement as unavailable rather
    // than trusting either side.
    if (record.generation !== meta.generation) {
      return unavailable(
        `The shared ${input.provider} asset readiness record belongs to a superseded connection generation.`,
      );
    }
    if (record.state === 'capped') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The asset was excluded from the ${input.provider} subscription by the shard cap.`,
      };
    }
    if (record.state === 'failed') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED',
        reason: `The ${input.provider} subscription for the asset was rejected.`,
      };
    }
    if (record.state === 'requested') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The ${input.provider} subscription for the asset is not acknowledged yet.`,
      };
    }
    if (record.state !== 'active') {
      return {
        ready: false,
        code: 'LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED',
        reason: `The ${input.provider} subscription state for the asset is not usable.`,
      };
    }

    return {
      ready: true,
      provider: input.provider,
      source: meta.source,
      generation: meta.generation,
      asset: toSubscribedAsset(record),
    };
  }

  /** Diagnostics: the raw published provider record, or null. */
  async readProviderMeta(
    provider: TradeRouteProvider,
  ): Promise<SharedProviderMeta | null> {
    if (!this.redis) return null;
    try {
      return parseJson<SharedProviderMeta>(
        await this.redis.get(providerMetaKey(provider)),
      );
    } catch {
      return null;
    }
  }
}

function toSubscribedAsset(record: SharedAssetRecord): ProviderSubscribedAsset {
  return {
    assetId: record.assetId,
    symbol: record.symbol,
    providerSymbol: record.providerSymbol,
    market: record.market,
    assetType: record.assetType as ProviderSubscribedAsset['assetType'],
    settlementCurrency:
      record.settlementCurrency as ProviderSubscribedAsset['settlementCurrency'],
    sourceName: record.sourceName,
  };
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function unavailable(reason: string): AssetTradeReadiness {
  return { ready: false, code: 'LIMIT_ORDER_PROVIDER_UNAVAILABLE', reason };
}
