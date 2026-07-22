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
 * GENERATION / OWNER SAFETY
 * -------------------------
 * A previous owner can be slow: its release can arrive AFTER a new owner has
 * already published. Every mutating script is therefore a compare-and-swap on
 * (generation, ownerInstance) executed inside Redis:
 *   - a write is refused when the stored record belongs to a different owner
 *     and is strictly newer;
 *   - a release deletes ONLY when the stored generation and owner both match,
 *     so a late release from the old owner is a no-op.
 *
 * FAIL-CLOSED
 * -----------
 * Every failure mode — Redis down, missing meta, expired TTL, stale frame,
 * unknown asset, generation mismatch — resolves to "not ready". There is no
 * fail-open path: accepting a limit order whose asset is not actually
 * subscribed reserves the user's cash against a fill that can never happen.
 */

export const PROVIDER_TRADE_READINESS_SCHEMA_VERSION = 1;
export const PROVIDER_TRADE_READINESS_KEY_PREFIX =
  'limit-order:trade-readiness:v1';

export type SharedProviderMeta = {
  schemaVersion: number;
  provider: TradeRouteProvider;
  ownerInstance: string;
  source: ProviderTradeSource;
  generation: string;
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

/**
 * Refuses a write whose owner differs from the stored one AND whose
 * `lastUpdatedAt` is not newer. A zombie old owner therefore cannot overwrite
 * the record of the owner that replaced it.
 */
const PUBLISH_META_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and decoded and decoded.ownerInstance ~= ARGV[2] then
    local storedAt = tonumber(decoded.lastUpdatedAt) or 0
    local incomingAt = tonumber(ARGV[3]) or 0
    if storedAt > incomingAt then
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
 */
const PUBLISH_ASSETS_SCRIPT = `
local ttl = tonumber(ARGV[1])
for i = 2, #ARGV, 2 do
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

/** Deletes only when BOTH the generation and the owner still match. */
const RELEASE_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if not meta then
  return 0
end
local ok, decoded = pcall(cjson.decode, meta)
if not ok or not decoded then
  return 0
end
if decoded.generation ~= ARGV[1] or decoded.ownerInstance ~= ARGV[2] then
  return 0
end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

/**
 * Drops a SUPERSEDED generation's asset hash. Guarded so it can only ever
 * delete a hash the current meta no longer points at, and only while this
 * instance still owns the meta — a late call from a replaced owner is a no-op.
 */
const RELEASE_SUPERSEDED_ASSETS_SCRIPT = `
local meta = redis.call('GET', KEYS[1])
if not meta then
  return 0
end
local ok, decoded = pcall(cjson.decode, meta)
if not ok or not decoded then
  return 0
end
if decoded.ownerInstance ~= ARGV[2] then
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
   * Publishes (or refreshes) the provider record. Returns false when a newer
   * owner already holds the key, which the caller treats as "I am no longer
   * the owner" rather than retrying.
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
        String(input.meta.lastUpdatedAt),
        String(input.ttlSeconds),
      ],
    );
    return toNumber(result) === 1;
  }

  async publishAssets(input: {
    provider: TradeRouteProvider;
    generation: string;
    records: readonly SharedAssetRecord[];
    ttlSeconds: number;
  }): Promise<void> {
    if (!this.redis || input.records.length === 0) return;
    const key = providerAssetsKey(input.provider, input.generation);
    const args: string[] = [String(input.ttlSeconds)];
    for (const record of input.records) {
      args.push(record.assetId, JSON.stringify(record));
    }
    await this.redis.eval(PUBLISH_ASSETS_SCRIPT, [key], args);
  }

  /**
   * Compare-and-delete release. A late release from a superseded owner leaves
   * the current owner's keys untouched.
   */
  async release(input: {
    provider: TradeRouteProvider;
    generation: string;
    ownerInstance: string;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      [
        providerMetaKey(input.provider),
        providerAssetsKey(input.provider, input.generation),
      ],
      [input.generation, input.ownerInstance],
    );
    return toNumber(result) === 1;
  }

  async releaseSupersededAssets(input: {
    provider: TradeRouteProvider;
    supersededGeneration: string;
    ownerInstance: string;
  }): Promise<boolean> {
    if (!this.redis) return false;
    const result = await this.redis.eval(
      RELEASE_SUPERSEDED_ASSETS_SCRIPT,
      [
        providerMetaKey(input.provider),
        providerAssetsKey(input.provider, input.supersededGeneration),
      ],
      [input.supersededGeneration, input.ownerInstance],
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
      meta.schemaVersion !== PROVIDER_TRADE_READINESS_SCHEMA_VERSION
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
