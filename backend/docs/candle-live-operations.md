# Live candle pipeline operations

This document describes candle pipeline unit 3-3/3-4. All HTTP and WebSocket paths remain under `/api/v1`; there is no `/api/v2` candle route. Every live-stream and reconciliation scheduler gate is disabled by default.

## Data ownership and flow

PostgreSQL stores canonical closed `5m`, provider-native `1d`, and provider-native `1w` rows. Redis stores the current provisional 5-minute state, the provider-shard owner lease, a bounded dedupe key per provider event, the finalization index, and Pub/Sub fanout. REST is the initialization/repair/final-consistency path. WebSocket carries low-latency current snapshots and never writes every trade to PostgreSQL.

```text
provider WebSocket -> typed parser/normalizer -> owner-checked Redis Lua
                   -> Redis Pub/Sub -> authenticated /api/v1/ws gateways
                   -> subscribed chart clients

validated latest price -> separate Redis provider-price Pub/Sub
                       -> existing asset_ticker subscribers

bucket close + grace -> PostgreSQL MarketCandle upsert
                     -> response-cache generation invalidation
                     -> final snapshot publish

provider REST repair -> canonical PostgreSQL correction
                     -> cache invalidation/live-state cleanup
```

The persisted intervals remain `5m`, `1d`, and `1w`. Current `15m`, `30m`, `1h`, and `4h` snapshots combine closed PostgreSQL 5-minute rows with the Redis live 5-minute row through `MarketCandleAggregationService`; they are never stored. Provider-native daily/weekly rows are not replaced by 5-minute synthesis.

## Provider feeds

- Binance uses native Spot `@kline_5m`. Each frame is an absolute OHLC/base-volume/quote-volume snapshot; volume is replaced, not added. The supervisor answers ping, reconnects with bounded exponential backoff/jitter, restores subscriptions, and rolls the connection before Binance's 24-hour limit.
- KIS domestic uses the official `H0STCNT0` regular-session trade fields. Trade quantity is a delta; session cumulative volume/amount are parsed for identity/diagnostics but are not treated as a 5-minute delta.
- KIS US uses `HDFSCNT0`, which is a delayed trade feed. It is exposed as `delayed=true`, uses exchange `XYMD/XHMS` for the candle bucket, and is never described as real-time. It remains disabled unless `CANDLE_LIVE_KIS_US_DELAYED_ENABLED=true`. No unsupported real-time US entitlement is silently substituted.

Regular-session policy is KRX 09:00-15:30 `Asia/Seoul`, US 09:30-16:00 `America/New_York`, and crypto continuous UTC. Weekend, configured holiday, and early-close overrides come from the shared market-calendar policy. Pre-market/after-hours trades are rejected from regular-session candles.

## Ownership, state, and recovery

Each provider shard has one Redis lease owner. Only that owner opens the provider socket. Lease renewal is token-checked; loss closes the socket, stops processing, and prevents old-generation Lua updates/finalization. A separate renewed finalizer lease permits only one instance to scan/write due buckets while still checking the provider generation lease before each finalization. Gateway instances only consume Redis Pub/Sub and never create per-user provider subscriptions.

The current implementation operates shard `0` per provider and enforces `CANDLE_LIVE_MAX_PROVIDER_SUBSCRIPTIONS_PER_SHARD`. Assets beyond that bounded capacity are not silently claimed as active: readiness reports `SUBSCRIPTION_SHARD_CAP` and failed-subscription counts. Increase the reviewed provider-safe cap or deploy a future explicit shard assignment before enabling a larger universe.

The live Redis key includes schema version, asset, `5m`, bucket open time, and hashed owner generation. One Lua operation verifies lease ownership, bucket/generation, and event dedupe; it then applies fixed-scale decimal comparisons/addition. A first valid event sets open, high never falls, low never rises, and an older event cannot regress close. Binance absolute frames replace OHLCV. KIS event identity prevents duplicate delta volume; when provider identity is weak, REST reconciliation remains the final authority. No `KEYS`, `SCAN`, `FLUSHDB`, or `FLUSHALL` operation is used.

At startup/reconnect, a same-owner current state is inherited. Otherwise the hydrator checks the bucket in PostgreSQL and performs one bounded existing repair sync. A current REST/DB baseline is complete-capable only when its `sourceUpdatedAt` overlaps the valid provider-event continuity window; a possible gap between baseline and stream keeps the bucket incomplete. If no safe baseline is available, a KIS bucket entered mid-bucket stays `complete=false`; its first trade is not promoted to an official open. A continuous connection may mark only a later bucket, whose open boundary it observed, complete-capable. Connection loss marks only bounded current asset states incomplete; final/provider-final rows cannot regress.

After close plus `CANDLE_LIVE_FINALIZE_GRACE_MS`, a complete owner-generation state is idempotently upserted as closed `5m`. The database commit happens before cache-generation invalidation and final publication. Incomplete/continuity-lost states are not made closed and are left for reconciliation. A database failure leaves Redis state/index intact for retry.

## Application WebSocket and chart behavior

The existing authenticated `/api/v1/ws` supports:

```json
{
  "type": "subscribe",
  "channel": "asset_candle",
  "assetId": "...",
  "interval": "5m"
}
```

Intervals are `5m`, `15m`, `30m`, `1h`, and `4h`. Messages contain a full current candle snapshot plus revision, global sequence, provisional/complete/final, delayed, and source update time. Controls are `subscribed`, `unsubscribed`, `subscription_error`, `candle_stale`, and `resync_required`. Authentication, active-asset validation, an idempotent socket subscription map, a per-client limit, disconnect cleanup, room filtering, global-sequence dedupe, and latest-snapshot-only backpressure are enforced. `asset_ticker` remains an independent channel: the sole provider owner sends validated prices over a separate Redis topic so every gateway retains the old ticker fanout without opening duplicate provider sockets. KIS US ticker events are marked `delayed=true` and never `realtime=true`.

`AssetDetailScreen` loads HTTP first. It replaces an equal open time, appends a newer open time, sorts ascending, and trims to the query limit. Interval change tears down the old subscription and triggers a separate HTTP query. Reconnect and `resync_required` refetch HTTP before continuing. A prolonged outage shows the stale banner and does not manufacture price animation. `1d`/`1w` stay HTTP-only. KIS US delayed snapshots display an explicit delayed-feed banner.

## REST reconciliation and scheduler

`market_candle_reconciliation` is an additive `OpsJobName`. The runner supports `trigger`, `requestedBy`, `dryRun`, `assetIds`, `assetTypes`, `market`, `from`, `to`, `targets`, `maxAssets`, `maxPages`, and `continueOnError`. It uses a market job lock plus the existing asset/feed sync locks with owner-checked renewal. Dry-run only plans selected assets: it makes no provider request and writes no candle/checkpoint.

For stocks, reconciliation runs after the configured local post-close time/grace, selects the latest completed regular session through the holiday/early-close calendar, repairs `5m`, refreshes provider-native `1d`, and includes `1w` on Friday. Crypto verifies a bounded recent 5-minute window; daily/weekly targets are added at UTC day/week transitions. The result records missing rows and OHLC, volume, amount, close-state, and source-time drift per asset. A provider failure can continue to other assets; rerunning is idempotent.

Scheduler gates:

- `CANDLE_RECONCILIATION_KRX_ENABLED`, `..._TIME`, `..._GRACE_MINUTES`
- `CANDLE_RECONCILIATION_US_ENABLED`, `..._TIME`, `..._GRACE_MINUTES`
- `CANDLE_RECONCILIATION_CRYPTO_ENABLED`, `..._INTERVAL_SECONDS`
- `CANDLE_RECONCILIATION_LOOKBACK_BUCKETS`
- `CANDLE_RECONCILIATION_STARTUP_CATCH_UP_ENABLED`
- `CANDLE_RECONCILIATION_MAX_CATCH_UP_HOURS`, `..._MAX_ASSETS`, `..._MAX_PAGES`

All default to disabled. Startup catch-up checks both the last successful non-dry Ops run and recent closed-5m coverage; it does not run unconditionally. Locked/skipped rows are never treated as successful reconciliation.

## Failures, logging, and readiness

- Redis unavailable: no instance can acquire the provider lease, so instances do not independently promote themselves into duplicate owners. Gateways mark candle subscriptions stale; HTTP/database last-known-good serving continues where available.
- PostgreSQL unavailable: Redis live state remains for retry, finalization does not delete it, and readiness becomes `unavailable` because canonical HTTP storage is unavailable.
- Provider unavailable: the owner reconnects with bounded backoff, current affected buckets become incomplete, gateways keep last HTTP/DB data, and readiness is `degraded` rather than taking the whole HTTP API down.
- Redis Pub/Sub recovery: gateways resubscribe and send `resync_required`, causing frontend HTTP baseline refresh.

`GET /readiness` reports overall `ready`, `degraded`, or `unavailable`, PostgreSQL, Redis, scheduler flags, old ticker stream status, live Pub/Sub, provider connection/owner/subscription/lag/delayed status, live reducer/finalizer counters, and reconciliation freshness. Structured logs contain event codes/asset IDs only; credentials, approval keys, tokens, and raw provider frames are never logged.

## Validation and smokes

Normal verification:

```bash
pnpm test
pnpm build
pnpm exec prisma format
pnpm exec prisma validate
pnpm exec prisma generate
cd ../frontend && npm run typecheck && npm test
```

Fixture/real-service tests are explicit opt-ins and must be reported as skipped when their flags or services are absent:

```bash
CANDLE_LIVE_REDIS_SMOKE=1 pnpm test -- live-candle-store.integration.spec.ts
CANDLE_LIVE_PIPELINE_SMOKE=1 pnpm test -- candle-live-pipeline.integration.spec.ts
KIS_LIVE_CANDLE_SMOKE=1 pnpm test -- kis-live-candle.integration.spec.ts
BINANCE_LIVE_CANDLE_SMOKE=1 pnpm test -- binance-live-candle.integration.spec.ts
```

The synthetic gateway/fanout tests create many in-memory clients without external providers. They verify one shared provider path, room filtering, bounded latest-only queues, sequence dedupe, and disconnect cleanup; CI does not require 10,000 real sockets.
