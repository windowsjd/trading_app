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
 * KEY SCHEMA (all keys share a `{provider}` hash tag so a clustered Redis maps
 * them to one slot and the readiness read can stay a single atomic script):
 *
 *   limit-order:trade-readiness:v1:{<provider>}:meta
 *       JSON provider record, TTL = heartbeatTtlSeconds. Its expiry IS the
 *       owner heartbeat: an owner that stops publishing disappears.
 *
 *   limit-order:trade-readiness:v1:{<provider>}:gen:<generation>:assets
 *       HASH assetId -> JSON asset record, TTL = heartbeatTtlSeconds.
 *       Generation-scoped, so a reconnect writes a NEW key and every asset
 *       readiness of the previous generation is unreachable the instant the
 *       new meta is published; the orphaned key then expires on its own.
 *
 *   limit-order:trade-readiness:v1:{<provider>}:fence
 *       Monotonic INCR counter. NEVER expires and is never reset: it is the
 *       ordering authority for ownership and must outlive every owner.
 *
 * OWNER FENCING
 * -------------
 * A previous owner can be slow: its release — or worse, its next heartbeat —
 * can arrive AFTER a new owner has already published. Ownership therefore is
 * NOT decided by wall-clock `lastUpdatedAt` comparisons. Two instances that
 * disagree about the time would each consider its own record "newer", and a
 * paused-then-resumed old owner with a fast clock could overwrite the record
 * of the owner that legitimately replaced it — publishing a subscription set
 * for a socket that no longer exists, which is the one thing a fail-closed
 * readiness view must never do.
 *
 * Instead, an owner must first ACQUIRE a fence token: a value from the
 * per-provider INCR counter, handed out only while nobody else holds the meta
 * key. Every mutating script then compares fence tokens, which are generated
 * by Redis itself and are strictly monotonic by construction:
 *
 *   - a publish is refused when the stored fence token is strictly greater
 *     (a newer owner exists), or equal but held by a different instance;
 *   - a release deletes ONLY when generation, owner AND fence token all match,
 *     so a late release from a superseded owner is a no-op.
 *
 * A fenced-out owner is told so by the return value and stops publishing; it
 * cannot claw the shared view back while the current owner keeps heartbeating.
 *
 * FAIL-CLOSED
 * -----------
 * Every failure mode — Redis down, missing meta, expired TTL, stale frame,
 * unknown asset, generation mismatch — resolves to "not ready". There is no
 * fail-open path: accepting a limit order whose asset is not actually
 * subscribed reserves the user's cash against a fill that can never happen.
 */

/**
 * Bumped from 1 to 2 by owner fencing: a v1 record carries no fence token, so
 * it cannot be ordered against a v2 one. Both directions reject the other
 * version outright, which during a rolling deploy means readiness is
 * unavailable (fail-closed) rather than decided from a record whose ownership
 * cannot be established.
 */
export const PROVIDER_TRADE_READINESS_SCHEMA_VERSION = 2;
export const PROVIDER_TRADE_READINESS_KEY_PREFIX =
  'limit-order:trade-readiness:v1';

export type SharedProviderMeta = {
  schemaVersion: number;
  provider: TradeRouteProvider;
  ownerInstance: string;
  source: ProviderTradeSource;
  generation: string;
  /**
   * Redis-generated, strictly monotonic ownership token. The ONLY ordering
   * authority between competing owners — never a timestamp, which two hosts
   * can disagree about.
   */
  fenceToken: number;
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

export function providerMetaKey(provider: TradeRouteProvider): string {
  return `${PROVIDER_TRADE_READINESS_KEY_PREFIX}:{${provider}}:meta`;
}

export function providerAssetsKey(
  provider: TradeRouteProvider,
  generation: string,
): string {
  return `${PROVIDER_TRADE_READINESS_KEY_PREFIX}:{${provider}}:gen:${generation}:assets`;
}

export function providerFenceKey(provider: TradeRouteProvider): string {
  return `${PROVIDER_TRADE_READINESS_KEY_PREFIX}:{${provider}}:fence`;
}

/**
 * Hands out a fence token, and ONLY while nobody else holds the provider.
 *
 * The current owner re-acquiring keeps the token it already holds: renumbering
 * a live owner on every restart of its publish loop would let it leapfrog
 * itself and would make the token meaningless as an identity.
 *
 * A different owner holding a readable meta record is refused outright. The
 * ONLY way to take over is for that record to expire, which is exactly the
 * heartbeat semantics — an owner that stopped publishing releases the provider
 * after at most one TTL.
 *
 * A meta record that cannot be decoded, or that carries no owner, is treated
 * as absent: it can never be proven to belong to a live owner, and leaving the
 * provider permanently unclaimable would fail every limit order closed.
 */
const ACQUIRE_OWNERSHIP_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if meta then
  local ok, decoded = pcall(cjson.decode, meta)
  if ok and type(decoded) == 'table' and decoded.ownerInstance then
    if decoded.ownerInstance ~= ARGV[1] then
      return { 0, tostring(decoded.fenceToken or 0), tostring(decoded.ownerInstance) }
    end
    local held = tonumber(decoded.fenceToken)
    if held then
      return { 1, string.format('%d', held), ARGV[1] }
    end
  end
end
local token = redis.call('INCR', KEYS[2])
return { 1, string.format('%d', token), ARGV[1] }
`;

/**
 * Fence-guarded publish. Refused when a strictly newer owner exists, or when
 * the same token is claimed by a different instance (which can only happen if
 * an operator duplicated LIMIT_ORDER_SHARED_READINESS_INSTANCE_ID).
 *
 * No timestamp is compared anywhere: the token is the only ordering.
 */
const PUBLISH_META_SCRIPT = `
local incoming = tonumber(ARGV[3])
if not incoming then
  return 0
end
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and type(decoded) == 'table' then
    local stored = tonumber(decoded.fenceToken) or 0
    if stored > incoming then
      return 0
    end
    if stored == incoming and decoded.ownerInstance ~= ARGV[2] then
      return 0
    end
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[4]))
return 1
`;

/**
 * Writes asset records into the generation-scoped hash and refreshes its TTL
 * in the same round trip, so a hash can never outlive its heartbeat window
 * because an EXPIRE was lost between two calls.
 *
 * Fence-guarded under the SAME rule as the meta publish. Assets are written
 * BEFORE the meta of a new generation, so the guard deliberately tolerates a
 * meta that does not mention this generation yet — it only ever refuses a
 * writer that a newer fence token has already superseded.
 */
const PUBLISH_ASSETS_SCRIPT = `
local incoming = tonumber(ARGV[2])
if not incoming then
  return 0
end
local meta = redis.call('GET', KEYS[2])
if meta then
  local ok, decoded = pcall(cjson.decode, meta)
  if ok and type(decoded) == 'table' then
    local stored = tonumber(decoded.fenceToken) or 0
    if stored > incoming then
      return 0
    end
    if stored == incoming and decoded.ownerInstance ~= ARGV[3] then
      return 0
    end
  end
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

/** Deletes only when generation, owner AND fence token all still match. */
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
if (tonumber(decoded.fenceToken) or -1) ~= tonumber(ARGV[3]) then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

/**
 * Drops a SUPERSEDED generation's asset hash. Guarded so it can only ever
 * delete a hash the current meta no longer points at, and only while this
 * instance still holds the meta under the same fence token — a late call from
 * a replaced owner is a no-op.
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
if (tonumber(decoded.fenceToken) or -1) ~= tonumber(ARGV[3]) then
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
   * Claims the provider and returns the fence token to publish under.
   *
   * `acquired: false` means another instance currently owns the shared view.
   * That is NOT an error and must not be retried in a tight loop: the caller
   * simply publishes nothing until the incumbent's heartbeat lapses.
   */
  async acquireOwnership(input: {
    provider: TradeRouteProvider;
    ownerInstance: string;
  }): Promise<{
    acquired: boolean;
    fenceToken: number | null;
    heldBy: string | null;
  }> {
    if (!this.redis) return { acquired: false, fenceToken: null, heldBy: null };
    const raw = await this.redis.eval(
      ACQUIRE_OWNERSHIP_SCRIPT,
      [providerMetaKey(input.provider), providerFenceKey(input.provider)],
      [input.ownerInstance],
    );
    const reply = Array.isArray(raw) ? raw : [];
    const acquired = toNumber(reply[0]) === 1;
    const fenceToken = toNumber(reply[1]);
    const heldBy = typeof reply[2] === 'string' ? reply[2] : null;
    if (!acquired || fenceToken === null || !Number.isFinite(fenceToken)) {
      return { acquired: false, fenceToken: null, heldBy };
    }
    return { acquired: true, fenceToken, heldBy };
  }

  /**
   * Publishes (or refreshes) the provider record. Returns false when a newer
   * fence token already holds the key, which the caller treats as "I have been
   * fenced out" — it must stop publishing rather than retry.
   */
  async publishProvider(input: {
    meta: SharedProviderMeta;
    ttlSeconds: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const key = providerMetaKey(input.meta.provider);
    const result = await this.redis.eval(
      PUBLISH_META_SCRIPT,
      [key],
      [
        JSON.stringify(input.meta),
        input.meta.ownerInstance,
        String(input.meta.fenceToken),
        String(input.ttlSeconds),
      ],
    );
    return toNumber(result) === 1;
  }

  /** Returns false when a newer fence token has superseded this writer. */
  async publishAssets(input: {
    provider: TradeRouteProvider;
    generation: string;
    ownerInstance: string;
    fenceToken: number;
    records: readonly SharedAssetRecord[];
    ttlSeconds: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    if (input.records.length === 0) return true;
    const args: string[] = [
      String(input.ttlSeconds),
      String(input.fenceToken),
      input.ownerInstance,
    ];
    for (const record of input.records) {
      args.push(record.assetId, JSON.stringify(record));
    }
    const result = await this.redis.eval(
      PUBLISH_ASSETS_SCRIPT,
      [
        providerAssetsKey(input.provider, input.generation),
        providerMetaKey(input.provider),
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
    fenceToken: number;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      [
        providerMetaKey(input.provider),
        providerAssetsKey(input.provider, input.generation),
      ],
      [input.generation, input.ownerInstance, String(input.fenceToken)],
    );
    return toNumber(result) === 1;
  }

  async releaseSupersededAssets(input: {
    provider: TradeRouteProvider;
    supersededGeneration: string;
    ownerInstance: string;
    fenceToken: number;
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
        String(input.fenceToken),
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
        [
          `${PROVIDER_TRADE_READINESS_KEY_PREFIX}:{${input.provider}}`,
          input.assetId,
        ],
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
      // A record with no usable fence token cannot be attributed to a live
      // owner, so it is not evidence of anything.
      typeof meta.fenceToken !== 'number' ||
      !Number.isFinite(meta.fenceToken)
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
