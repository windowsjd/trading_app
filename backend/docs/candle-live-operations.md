# Live candle pipeline operations

This document describes candle pipeline unit 3-3/3-4. All HTTP and WebSocket paths remain under `/api/v1`; there is no `/api/v2` candle route. Every live-stream and reconciliation scheduler gate is disabled by default.

## Data ownership and flow

PostgreSQL stores canonical closed `5m`, provider-native `1d`, and provider-native `1w` rows. Redis stores the current provisional 5-minute state, the provider-shard owner lease, a bounded dedupe key per provider event, the finalization index, and Pub/Sub fanout. REST is the initialization/repair/final-consistency path. WebSocket carries low-latency current snapshots and never writes every trade to PostgreSQL.

```text
provider WebSocket -> typed parser/normalizer -> owner-checked Redis Lua
                   -> Redis Pub/Sub -> authenticated /api/v1/ws gateways
                   -> subscribed chart clients

Binance @ticker  -> immediate provider-price Redis Pub/Sub
                 -> existing asset_ticker subscribers (no DB wait)
                 -> (separately) throttled asset_price_snapshots write

bucket close + grace -> PostgreSQL MarketCandle upsert
                     -> response-cache generation invalidation
                     -> final snapshot publish

provider REST repair -> canonical PostgreSQL correction
                     -> cache invalidation/live-state cleanup
```

The persisted intervals remain `5m`, `1d`, and `1w`. Current `15m`, `30m`, `1h`, and `4h` snapshots combine closed PostgreSQL 5-minute rows with the Redis live 5-minute row through `MarketCandleAggregationService`; they are never stored. Provider-native daily/weekly rows are not replaced by 5-minute synthesis.

## Provider feeds

- Binance uses native Spot `@kline_5m`. Each frame is an absolute OHLC/base-volume/quote-volume snapshot; volume is replaced, not added. The supervisor answers ping, reconnects with bounded exponential backoff/jitter, restores subscriptions, and rolls the connection before Binance's 24-hour limit.
- The owned Binance connection ALSO subscribes `<symbol>@ticker` for every active crypto asset (2 streams per symbol on the one socket, one owner lease). Frames are routed by event type (`e`): `kline` events drive the candle pipeline; `24hrTicker` events start TWO independent jobs, neither waiting on the other:
  1. **App fanout (immediate).** The ticker is published to the shared provider-price Redis Pub/Sub (`ProviderPricePubSubService`, the same topic the kline path uses) as soon as the frame is parsed, with `assetId`, the ticker's `c` (last trade price) as `price`, `changeRate` (`P`), `bidPrice` (`b`), `askPrice` (`a`), `effectiveAt`/`capturedAt` and `sourceName=binance_spot_ws_ticker`. `snapshotState` is `null` because the DB write has not been decided yet. The screen price is therefore NOT gated on a DB write or on the gateway's 3s snapshot polling. A failed publish increments `pubSubPublishFailure`.
  2. **DB snapshot (throttled, background).** The same ticker goes to the shared `BinanceWebSocketIngestionService` (`sourceName=binance_spot_ws_ticker`), keeping the existing per-asset throttle (`BINANCE_WS_SNAPSHOT_THROTTLE_MS`, default 5000) and dedup, so write volume is unchanged. This keeps the REST market list (which reads `asset_price_snapshots`) fresh in live-candle mode, where the standalone ticker streaming service is disabled. A thrown error or a `success: false` result is recorded on the Binance provider's `lastErrorCode` — a failed write never blocks the fanout, but it is never silent either.

  Ticker frames never touch the candle trade-freshness (`lastEventAt`) readiness signal, which stays kline-only, and a ticker frame is never fed to the kline parser (no rejected-event inflation). All active crypto symbols are covered — not just BTC/ETH.
- **Gateway fanout does no per-event DB work.** `AssetTickerGateway` builds the realtime `asset_ticker` payload from the provider event itself plus two in-memory caches — it never calls the snapshot-based `buildSnapshotTickerMessage()` (full REST price selection) on the realtime path:
  1. `RealtimeAssetMetadataCacheService` — assetId → {symbol, name, assetType, market, priceCurrency} with a 5-minute TTL (30s negative TTL for unknown/inactive ids, which are rejected). Only a cache miss touches the `assets` table; a DB failure serves the last known entry and never takes the stream down. `displayPriceDecimals` is resolved per read from the in-memory Binance tickSize cache, so precision refreshes propagate without a flush.
  2. A 2-second USD/KRW selection cache inside `AssetsService.convertRealtimePriceToKrw` — one FX read per burst (available AND unavailable results are cached), same source-eligibility policy; REST paths keep their per-request reads. KRW-priced assets convert without touching FX.
  Realtime events therefore carry `assetPriceSnapshotId: null` (the DB write is decoupled/throttled, no stored row is claimed); clients order them by `priceCapturedAt`/`priceEffectiveAt`, which every realtime event carries. The 3s snapshot poller may re-send a row the throttled writer created moments earlier — the shared frontend accept policy dedupes/orders it away.
- **Ticker backpressure (latest-only coalescing).** Both the poller and the realtime path deliver through one send helper: when a client socket's buffered bytes exceed the shared threshold (`CANDLE_LIVE_WEBSOCKET_BACKPRESSURE_BYTES` config value, same knob as candles, default 1MB), the ticker is coalesced into a per-asset latest-only queue instead of being written; the 100ms flush timer (shared with candles, separate map) drains it once the socket catches up. A slow client skips straight to the newest price per asset and never accumulates a ticker backlog. Bounds and cleanup: the queue is keyed by assetId and additionally capped at 64 entries per client (oldest asset evicted first), queued tickers for rows that unsubscribed are dropped at flush time, and disconnect removes the client state entirely. The counters are observable at `GET /readiness` → `data.assetTicker` (`sent`, `coalesced`, `dropped`, `pendingTickers`, `clientsWithPendingTickers`, `maxPendingTickersPerClient`, `pendingTickerLimitPerClient`); readiness reads them through the `TICKER_FANOUT_METRICS` token, never the gateway class.
- Exactly one Binance ticker fanout path is live at a time: `BinanceWebSocketStreamingService.start()` stands down (`state=disabled`) when `CANDLE_LIVE_STREAMING_ENABLED=true` and `CANDLE_LIVE_BINANCE_ENABLED=true`, so the standalone socket and the live-candle owner connection can never publish the same ticker twice. With live-candle Binance off, the standalone service owns the fanout as before. Both paths use the same `binance_spot_ws_ticker` source name and the same event payload contract.
- KIS domestic uses the official `H0STCNT0` regular-session trade fields. Trade quantity is a delta; session cumulative volume/amount are parsed for identity/diagnostics but are not treated as a 5-minute delta.
- KIS US uses `HDFSCNT0`, which is a delayed trade feed. It is exposed as `delayed=true`, uses exchange `XYMD/XHMS` for the candle bucket, and is never described as real-time. It remains disabled unless `CANDLE_LIVE_KIS_US_DELAYED_ENABLED=true`. No unsupported real-time US entitlement is silently substituted.

Stock sessions come only from the shared market-calendar policy: the regular defaults are KRX 09:00-15:30 `Asia/Seoul` and US 09:30-16:00 `America/New_York`, while holiday, delayed-open, early-close, and delayed-close overrides replace those defaults. Crypto remains continuous UTC. Pre-market/after-hours trades are rejected from stock candles, and a full-day holiday never creates or copies a candle.

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

For stocks, reconciliation runs after the actual calendar session close plus grace, selects the latest completed session, repairs `5m`, refreshes provider-native `1d`, and includes `1w` when that session is the week's last real session. A Friday holiday therefore closes/reconciles the weekly candle after Thursday's session. A full-day holiday schedules no stock reconciliation. Startup catch-up and manual safety bounds are unchanged. Crypto verifies a bounded recent 5-minute window; daily/weekly targets are added at UTC day/week transitions. The result records missing rows and OHLC, volume, amount, close-state, and source-time drift per asset. A provider failure can continue to other assets; rerunning is idempotent.

Provider ranges are calendar-bounded before a stock request: while open, `to=now`; after today's close, `to` is the actual close; on weekends, full-day holidays, or before open, `to` is the latest completed session close. KIS domestic backward pagination starts from this bound instead of a holiday `input.to`. A calendar-confirmed holiday empty is `confirmed_empty`/expected no-data; an empty response for a range containing an open session remains incomplete/provider-degraded. Network, authentication, and server errors remain provider failures regardless of calendar state.

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

## Sync coverage completeness (stabilization)

`MarketCandleSyncState.status = completed` records only that a run terminated
normally. Whether the provider cursor actually confirmed the whole target
range is persisted separately:

- `coverageComplete` — true only when the provider cursor swept the entire
  half-open `[targetFrom, targetTo)` range (`target_reached`) or the provider
  authoritatively confirmed emptiness (`confirmed_empty`, currently only the
  endTime-bounded Binance klines API qualifies).
- `coveredFrom` / `coveredTo` — the half-open instant range actually
  confirmed so far; it grows monotonically while a run pages and survives
  resume.
- `completionReason` — `target_reached`, `confirmed_empty`,
  `empty_page_before_target`, `provider_exhausted_before_target`, or
  `data_incomplete` (the provider sweep reached its target, but the stored
  data is incomplete — e.g. KIS 5m incomplete buckets survived strict
  validation; provider-sweep completion and stored-data completeness are
  distinct, and such a run never claims coverage).

The checkpoint repository (`markCompleted`) enforces the full completion
invariant BEFORE the row is written, so a bad claim can never be persisted:

- `coverageComplete=true` requires `completionReason` of `target_reached` or
  `confirmed_empty`, a well-formed covered range (`coveredFrom < coveredTo`),
  `coveredFrom <= targetFrom`, **and** `coveredTo >= requiredCoveredTo`,
  where `requiredCoveredTo = min(targetTo, sync-time now)` is passed by the
  sync service — a `targetTo` in the future can only ever be confirmed up to
  `now`, and `requiredCoveredTo` itself must lie inside
  `[targetFrom, targetTo]`.
- `coverageComplete=false` requires an incomplete reason
  (`empty_page_before_target`, `provider_exhausted_before_target`,
  `data_incomplete`, `cursor_not_advanced`, `aborted`) and a covered range
  that is either fully absent or well-formed — never one-sided.
- Violations throw `MarketCandleSyncStateInvariantError` (a programmer
  error) without touching the row. No new migration/column is involved; this
  is an application invariant plus tests.

Sync summaries make the same distinction explicit: `completedFeeds` counts
runs that TERMINATED normally — it is **not** a coverage count — while
`coverageCompleteFeeds` and `completedWithIncompleteCoverageFeeds` split the
completed runs by confirmed coverage.

Serving (`findCompletedCovering`) accepts a checkpoint as coverage evidence
only when `status=completed`, `coverageComplete=true`, and
`[coveredFrom, coveredTo)` spans the requested range clamped at the request
clock. A KIS run that stopped at the provider's minute-retention edge stays
`completed` + `coverageComplete=false`; the range is repaired on demand
(within the repair budget) or, for large cold ranges, stays on the
cold-baseline provider path until an operator seeds it. It is never mistaken
for confirmed-empty data.

**Legacy checkpoints:** rows completed before the
`20260713200000_add_market_candle_sync_coverage` migration keep
`coverageComplete=false` and are no longer used as serving coverage. Re-run
the initial/incremental sync (or an explicit repair) per asset/feed to
restore database serving for those ranges; until then requests fall back to
the provider-direct path. Do not backfill coverage from candle min/max.

## Stale Redis fallback on database outages

The serving order is: fresh Redis → return; stale Redis present → try the
database, and on an operational failure return the stale response; no stale →
propagate the original error. The initial `database.load` is inside the
fallback (not only the refresh path). Only operational failures qualify —
connection refused/reset, timeouts, pool exhaustion, transient Prisma driver
errors (`P1xxx`, `P2024`, `P2028`, `P2034`), Redis single-flight wait
timeouts, and operational provider-refresh failures (see
`src/assets/candle-operational-error.ts`). Validation, configuration, schema
invariant, and programmer errors always propagate. Each fallback logs
`{"event":"candle_delivery","state":"stale_cache_fallback","reason":...}`.

## Managed serving never falls back provider-direct

Once a request is managed (mode=database and a managed read plan), the ONLY
serving order is: fresh Redis → PostgreSQL → bounded sync → PostgreSQL
requery → stale Redis → strict PostgreSQL last-known-good → the existing
provider-compatible error (`ASSET_CANDLES_PROVIDER_ERROR` 502 for crypto,
`ASSET_CANDLES_PROVIDER_UNAVAILABLE` 503 for stocks; no internal operational
detail or credential leaks into the response, and the provider is NOT called
again). The failure is logged as
`{"event":"candle_delivery_failed","state":"managed_unresolved"}`.

Provider-direct (`legacyLoader`) is reachable only through:

1. `CANDLE_SERVING_MODE=legacy` — the explicit, whole-endpoint rollback;
2. read plans with `managedByPersistence=false` (out-of-policy requests);
3. the cold-baseline policy for NON-aggregated feeds (`5m`, `1d`, `1w`) — no
   completed baseline coverage AND a requested range beyond
   `CANDLE_SERVING_ON_DEMAND_REPAIR_MAX_RANGE_MS`, logged as
   `{"event":"candle_delivery","state":"legacy_provider","reason":"cold_baseline_required"}`.
   Operators seed these baselines with the manual `market_candle_sync` job.

**Aggregated intervals are excluded from (3).** `15m`/`30m`/`1h`/`4h` exist
only as read-time aggregates of the stored `5m` feed, so a provider-direct
answer is ONE truncated minute page (KIS caps a page at 120 rows) bucketed
with no constituent check — a 30-day `4h` request came back as a single
fabricated candle (`candles=1 · req=120 · ret=1 · 30d/4h`). Without baseline
coverage those requests now fail with
`ASSET_CANDLES_BASELINE_NOT_READY` (503, logged as
`{"event":"candle_delivery_failed","state":"baseline_not_ready","reason":"cold_baseline_required"}`)
and the client shows "차트 데이터를 준비 중입니다." with a retry. The legacy
`bucketStockCandles` path therefore never serves a managed request.

The cold-baseline path is a deliberate PRE-refresh routing decision for
ranges the managed path is not allowed to own yet; it is not a failure
fallback. After a managed refresh has started, no catch/fallback path calls
`legacyLoader`.

One exception keeps a real chart usable: when coverage IS confirmed for the
whole range but individual historical buckets are missing constituents even
after the bounded repair, the incomplete buckets stay dropped and the complete
ones are served (`{"state":"database_fallback","reason":"incomplete_buckets_dropped"}`).
An incomplete bucket is never promoted to a normal candle, and a range without
coverage evidence still fails.

## Chart windows and the 5m baseline

| Chart tab | range | limit | source | window |
| --- | --- | --- | --- | --- |
| `5m` | `prev_open` | 600 | stored `5m` | ~2 sessions |
| `15m` | `prev_open` | 200 | aggregated from stored `5m` | ~2 sessions |
| `30m` | `14d` | 672 | aggregated from stored `5m` | rolling 14 days |
| `1h` | `14d` | 336 | aggregated from stored `5m` | rolling 14 days |
| `4h` | `30d` | 200 | aggregated from stored `5m` | rolling 30 days |
| `1d` | `1y` | 400 | stored `1d` | rolling 365 days |
| `1w` | `1y` | 60 | stored `1w` | rolling 365 days |

Stored `5m` retention is 35 days (`MARKET_CANDLE_5M_RETENTION_DAYS`), which
holds both the 14-day and the 30-day window including the 4h source padding
(`30d + 4h < 35d`), so those requests stay `managedByPersistence=true`. The
`30m`/`1h` limits are the crypto (24/7) upper bounds — 14 × 48 and 14 × 24;
stocks legitimately return fewer because they only trade during the regular
session. No 15m/30m/1h/4h table exists and none should be added.

**Coverage evidence is the UNION of coverage-audited checkpoints**
(`findCompletedCoverageUnion`). One run can never keep a 14-day window
covered up to "now": the seeded baseline confirms `[now-35d, its finish time)`
and each later incremental run confirms its own tail. Rows are merged only
when they are individually `status=completed` + `coverageComplete=true` with a
well-formed `[coveredFrom, coveredTo)`; one hole between them means "not
covered".

### Seeding and keeping the baseline

```bash
cd backend
# What can the database serve today? (PostgreSQL only, no provider calls.)
pnpm candle:baseline -- --report

# Plan the 35-day 5m baseline (no provider call, no write).
pnpm candle:baseline -- --dry-run

# Seed it for every active asset. Resumable: re-run after an interruption.
pnpm candle:baseline -- --apply
pnpm candle:baseline -- --apply --asset-type domestic_stock   # or us_stock / crypto

# Keep the tail fresh afterwards (cheap; run on a schedule).
pnpm candle:baseline -- --apply --mode incremental
```

`scripts/candle-baseline-sync.ts` is a thin wrapper around the SAME
`MarketCandleSyncService.syncAssets` the Ops `market_candle_sync` job runs —
no second sync implementation. `--report` prints `READY`/`MISSING` per asset
plus the newest coverage completion time, which is exactly the evidence the
serving path uses. `--apply` needs the real provider credentials (KIS for
stocks, Binance for crypto) and Redis (backfill locks).

Live 5m rows also keep arriving through the live-candle pipeline
(`LIVE_CANDLE_*`) and the disabled-by-default reconciliation job; those
paths write candles but do NOT write coverage checkpoints, so the incremental
sync above is what keeps a long-window chart coverage-complete.

## Market calendar (versioned, audited)

`src/orders/market-calendar/` holds per-market per-year datasets with
`sourceName`, `sourceReference`, `verifiedAt`, and `version` metadata:

- `US 2025` (audited, historical): NYSE Group 2025/2026/2027 holiday press
  release plus the NYSE 2025 trading-calendar PDF. Includes the unscheduled
  2025-01-09 full closure (National Day of Mourning for President Jimmy
  Carter, per the NYSE/Nasdaq closure notices) and the three 13:00 ET early
  closes (Jul 3, Nov 28, Dec 24).
- `US 2026/2027`: NYSE official "Holidays & Trading Hours" (Nasdaq equities
  follow the same schedule). Includes 13:00 ET early closes (day after
  Thanksgiving; Christmas Eve 2026) and observed holidays.
- `KRX 2025` (audited, historical): KRX market-operation notices as relayed
  by member firms (Samsung POP #21797/#21925, Korea Investment #45644) plus
  KRX year-end coverage. Includes the 2025-01-02 delayed 10:00 open (close
  15:30 unchanged), the 2025-01-27 government temporary holiday, the
  2025-06-03 presidential-election closure, the Chuseok block Oct 6–9
  (incl. the Oct 8 substitute holiday), the CSAT-day (2025-11-13)
  10:00–16:30 session, and the 2025-12-31 year-end closure. 2025-10-10 was
  NOT designated a temporary holiday and stays a trading day.
- `KRX 2026`: the KRX year-end market-operation notice plus the 2026-05-20
  KRX closure notice (June 3 local elections; July 17 Constitution Day,
  re-designated a statutory holiday effective 2026-05-11). Includes the
  Jan 2 delayed 10:00 open and the CSAT-day (2026-11-19) 10:00–16:30 session.
- `KRX 2027`: **provisional** (`version: 2027.1-provisional`), derived from
  the announced 2027 statutory holiday schedule and standing KRX rules. It
  MUST be re-verified against the official KRX notice (published ~Dec 2026);
  bump the version and drop the suffix then.

The PREVIOUS calendar year is a hard requirement, not an archive: the 1d/1w
candle sync default range is a 365-day lookback, so from any date the target
range reaches into the prior year, and `prev_open`/`prev2_open` cross the
year boundary during the first sessions of January. Without the prior-year
dataset those paths fail closed (`calendar_unavailable`) by design.

Unscheduled changes (temporary holidays such as the 2025-01-27 designation
or the US 2025-01-09 mourning day, and session-time shifts) are reflected by
editing the affected year dataset from the official/exchange notice, bumping
its `version`, updating `verifiedAt`/`sourceReference`, and extending the
dataset tests. There is NO runtime external calendar API fallback — the
in-repo audited datasets are the only source, and uncovered dates stay
fail-closed until the dataset ships.

Calendar state per market/year is three-level, and readiness reflects it:

1. **missing** — no dataset. Readiness reason
   `MARKET_CALENDAR_COVERAGE_MISSING` (degraded).
2. **provisional** — a dataset exists but has NOT been verified against the
   exchange's official/final notice (`version` carries `-provisional`, e.g.
   KRX 2027 `2027.1-provisional`). Readiness reason
   `MARKET_CALENDAR_PROVISIONAL` (degraded). Provisional data is never
   displayed as audited.
3. **audited** — verified against the official/final source.

`GET /readiness` exposes `marketCalendar` with per-market `coveredYears`,
`auditedYears`, `provisionalYears`, and `missingYears`, plus `complete`
(datasets present for every required year — presence only, its original
meaning) and `productionReady` (no missing AND no provisional year). Both
missing and provisional years degrade readiness — they never make the
service `unavailable` (that is reserved for e.g. database loss) — crypto is
unaffected, and stock session decisions keep failing safe (uncovered dates
are never assumed tradable).

Operational policy: a date in a year without a dataset is never assumed to be
a regular trading day. `MARKET_CALENDAR_REQUIRED_FROM_YEAR` /
`MARKET_CALENDAR_REQUIRED_THROUGH_YEAR` override the default requirement
(previous year through next year — the previous year is required because the
365-day sync lookback and year-boundary previous-session anchors depend on
it). KRX 2027 stays provisional until the
official KRX year-end notice (expected ~Dec 2026) is verified; then bump the
dataset `version` and drop the `-provisional` suffix. If a 2026 release does
not need 2027 coverage, set `MARKET_CALENDAR_REQUIRED_THROUGH_YEAR=2026` —
this narrows the REQUIREMENT; never use environment variables to hide a
provisional dataset or present it as audited. To add a year: create
`market-calendar/data/<market>-<year>.ts` from the primary source, register
it in `market-calendar.registry.ts`, and add tests. At each year rollover,
check the ROLLING side too, not just the upcoming year: on the first day of
year N the default requirement becomes N-1..N+1 and the 365-day lookback
still reads N-1 data all year — retire a year's dataset only after it has
left that window.

Operational reasons distinguish two skip conditions that look alike in
provider traffic: a weekend/full-day holiday is a scheduled empty day
(`MARKET_CLOSED_EXPECTED_NO_DATA` / `confirmed_empty`, silent scheduler
skip), while a date in an uncovered year is
`MARKET_CALENDAR_COVERAGE_MISSING` (readiness degraded; the reconciliation
scheduler emits a structured warning once per market per business date and
still runs no provider job). A holiday must never be logged as missing
coverage, and missing coverage must never be absorbed as a normal holiday.

The same registry is the single source for chart `prev_open`/`prev2_open`, provider cursors, aggregation buckets, daily/weekly close state, and reconciliation. `30d` and `1y` remain rolling calendar durations; holidays simply have no candles. Session aggregation anchors at the actual open and caps partial `1h`/`4h` buckets at the actual close, so delayed opens, KRX 16:30 closes, and US 13:00 closes do not require service-local fixed-hour exceptions.

## Old-generation live bucket recovery

When a process dies or loses its provider lease, its live states are no
longer writable (every Lua write re-checks the lease token) and are recovered
by the finalizer owner:

- **Binance provider-final states**: after close+grace, if the provider lease
  is absent or held by a different generation, the finalizer idempotently
  commits the canonical row, invalidates the cache, finalizes the state via
  the takeover Lua script (which re-checks lease≠generation), publishes the
  final snapshot, and removes the finalize-index entry.
- **KIS delta states** (no provider-final evidence): never closed directly.
  They move to the bounded `candles:live:v1:reconcile-pending` sorted set and
  are repaired by a bounded REST sync (max `CANDLE_LIVE_RECOVERY_MAX_BATCH`
  per tick, retry backoff `CANDLE_LIVE_RECOVERY_RETRY_MS`); success publishes
  the canonical row and cleans the live pointer, failure re-schedules and
  shows up in the `reconcilePendingDue` gauge and
  `recoveryRepairSuccess/Failure` counters.
- Startup recovery runs immediately on boot from the persisted bounded
  indexes (never a Redis SCAN) under the finalizer lease.

**Configuration dependency:** live ingestion requires its reconciliation
safety net. In production the app refuses to start with
`CANDLE_LIVE_KIS_ENABLED` without `CANDLE_RECONCILIATION_KRX_ENABLED`,
`CANDLE_LIVE_KIS_US_DELAYED_ENABLED` without `CANDLE_RECONCILIATION_US_ENABLED`,
or `CANDLE_LIVE_BINANCE_ENABLED` without `CANDLE_RECONCILIATION_CRYPTO_ENABLED`
(escape hatch: `LIVE_CANDLE_ALLOW_WITHOUT_RECONCILIATION=true`, never for
normal operation). Elsewhere it logs a warning and readiness reports
`LIVE_RECONCILIATION_REQUIRED`.

## Connection liveness vs trade freshness

Connection liveness and market-data freshness are separate signals with
SEPARATE configuration:

- **Connection liveness** — `CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS`
  (default `90000`, minimum `5000`). `lastFrameAt` tracks any WebSocket frame
  (trade, ack, PINGPONG, WS ping). The supervisor's reconnect watchdog closes
  the socket only when NO frame of any kind arrives within this window; a
  quiet market with heartbeats flowing never triggers a reconnect. This is
  the ONLY setting the watchdog reads.
- **Trade freshness** — `CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS` (default
  `30000`, minimum `1000`). `lastEventAt`/`eventLagMs` track the last
  successfully processed trade/kline event. Readiness reports
  `LIVE_PROVIDER_STALE` only while the market can actually trade: the KIS lag
  check applies only during the KRX regular session, and the delayed US feed
  is excluded from real-time lag checks. This signal NEVER closes a socket;
  it only degrades readiness. This is the ONLY setting readiness reads.
- `lastHeartbeatAt` / `lastControlFrameAt` — official KIS `PINGPONG` frames
  (parsed as a typed control message and echoed back verbatim per the KIS
  WebSocket protocol), subscription acks, and WS pings.

The defaults keep liveness (90s) intentionally longer than trade staleness
(30s): heartbeats arrive on the order of tens of seconds (the pre-existing
provider streaming heartbeat rules use 60s), so market data can be reported
stale long before a healthy-but-quiet socket is torn down. Configuration
validation rejects a liveness timeout shorter than the trade-stale threshold.

**Deprecated:** `CANDLE_LIVE_STALE_THRESHOLD_MS` conflated both meanings. It
is kept only as a fallback for whichever dedicated variable is unset (the
dedicated variables always win), and an invalid value in it still fails
configuration — it is never silently replaced. Migrate to the two dedicated
variables.

Every reconnect logs
`{"event":"live_candle_stream_reconnect","provider":...,"reason":...}` with
frame/heartbeat ages.

## Shared frontend WebSocket

One app session opens ONE authenticated `/api/v1/ws` socket.
`frontend/src/services/ws/realtimeSocketManager.ts` owns connect/reconnect
backoff, token loading, reference-counted `asset_ticker`/`asset_candle`
subscriptions, restoration after reconnects, and message routing;
`useAssetTicker`/`useAssetCandle`/`useMarketTickers` only register
subscriptions and release them on unmount (the socket closes when the last
subscription is released).

The market list is REST baseline + live overlay:
`MarketScreen` renders the paginated REST rows immediately, then
`useMarketTickers` subscribes the currently loaded assetIds on that SAME
shared socket (many `asset_ticker` subscriptions, one connection — never one
socket per symbol, and no batch channel). New pages add only the new ids; a
tab change subscribes the new tab BEFORE releasing the old one so the socket
is never left without subscribers. `mergeMarketAssetTicker` overlays only the
price fields onto the REST row and returns the SAME object for untouched
rows, so the memoized `MarketAssetRow` re-renders only the asset that ticked.

Detail and list share ONE acceptance policy
(`frontend/src/features/asset/assetTickerPolicy.ts`): a repeated
`assetPriceSnapshotId` is ignored, an older event time never overwrites a
newer one, a priced event with no timestamp never overwrites a known price
(an unavailable one still applies), staleness is judged from the accepted
ticker's own event time (> 60s), and a disconnect keeps the last good price
on screen behind a single screen-level reconnect notice. Staleness also
advances with the CLOCK: both screens re-judge the last accepted ticker every
10 seconds (`isTickerStaleAt`), so a feed that simply stops flips to stale
without another message.

Detail-screen display policy (`displayPricePolicy.ts`): the latest ticker is
used AS A SET — its local price with its own KRW state and its own
`priceSource`. A ticker whose KRW is unavailable shows KRW as unavailable
(the old REST KRW never fills in), and the 가격 소스 row captions whichever
price is actually displayed. The market list re-renders only the row whose
ticker changed: `mergeMarketAssetTickersCached` returns identical row objects
for untouched rows, and the ticker's `displayPriceDecimals` travels onto the
row so precision updates reach the list live.

## Candlestick chart viewport

The asset detail chart pans and zooms over the candles the API ALREADY
returned. Files (`frontend/src/components/charts/`):

| File | Role |
| --- | --- |
| `candlestickViewport.ts` | Pure viewport math: `{visibleCount, rightOffset}`, clamps, index ranges, pan/zoom/focal-point, data-change adjustment |
| `candlestickLayout.ts` | Pure pixel geometry: slot/body width for the current zoom, leading empty slots, x → slot → original candle index |
| `candlestickPriceFormat.ts` | The ONE chart price formatter (axis, current price, crosshair, accessibility) — honors the asset's `displayPriceDecimals` |
| `candlestickGesturePolicy.ts` | Pure gesture policy shared by both adapters: horizontal-pan intent, wheel intent (zoom/pan) and drag-aware wheel handling, wheel & pinch scale bounds, chart-bounds test, gesture LIFECYCLE state machine, wheel-burst session |
| `candlestickChartHeight.ts` | Pure layout class (native short side / web width) + responsive chart height (phone ~52% / 380–480, tablet-wide web ~60% / 500–680) |
| `CandlestickChartRenderer.tsx` | The ONE SVG renderer (grid, candles, axes, current-price line, crosshair) — never duplicated per platform |
| `CandlestickGestures.native.tsx` | RNGH adapter: pinch, horizontal pan, long-press crosshair |
| `CandlestickGestures.web.tsx` | DOM adapter: mouse drag pan, hover crosshair, wheel zoom/pan |
| `CandlestickChart.tsx` | Viewport state, geometry, visible slice, responsive height, the single "최신" reset button; assembles renderer + platform adapter |

`CandlestickGestures.tsx` holds the shared props contract and a no-gesture
fallback; Metro resolves `./CandlestickGestures` to the `.native`/`.web` file
per platform (verified in the exported bundles).

Policy:

- **Default density.** `visibleCount` counts SCREEN SLOTS, not candles, and is
  independent of how much data exists: every timeframe opens on 60 slots
  (`MIN 20 / DEFAULT 60 / MAX 180`), so 5m and 1w have exactly the same candle
  width for the same chart width. Only an empty data set collapses it to 0.
- **Short data sets are right-aligned.** With fewer candles than slots the
  shortfall becomes EMPTY slots on the left
  (`computeLeadingEmptySlots(visibleCount, endIndex - startIndex)`) and the
  newest candle keeps the right edge — 12 candles render at the normal width,
  not as 12 fat ones. `getVisibleIndexRange` still returns REAL data indices
  only, and `originalCandleIndexForX` snaps a pointer over an empty slot to the
  first real candle, so the crosshair can never address a candle that does not
  exist. Panning is impossible while everything fits (`rightOffset` stays 0).
- **Price precision.** Y-axis labels, the current-price label, the crosshair
  price and the accessibility summary all go through `formatChartPrice`, which
  takes the asset's `displayPriceDecimals` (the same value the detail header
  prices with) — a DOGE chart shows `$0.24560`, not `$0.25`. The chart receives
  it as the `displayPriceDecimals` prop from `AssetDetailScreen`. Display only:
  formatted strings never re-enter price math.
- **Clipping.** The candle layer (wicks + bodies) is wrapped in a `<G>` with a
  per-instance `clipPath` covering the plot rect, so the 2-candle render buffer
  cannot spill over the right price axis. The clip id is derived from React's
  `useId`, so several charts on one page never share it. Axis text, the
  current-price label and the crosshair labels stay outside the clip.
- **Zoom changes `visibleCount`**, never an SVG `scaleX` — axis text is never
  scaled. Zoom is anchored at the pinch/wheel focal point, so the candle under
  the fingers keeps its position and zooming inside history does not jump to
  the latest candle.
- **Pan** converts `translationX / slotWidth` into whole candles against a
  snapshot taken at gesture start (no accumulated float drift) and stops at
  both data edges.
- **No zoom controls on screen.** There are no `+` / `−` buttons, no candle
  count text and no way for the user to pick a candle count: zoom is pinch
  (mobile) and wheel (web) only. `visibleCount` remains an INTERNAL viewport
  value that pinch/wheel convert into — it is never surfaced as UI. The chart's
  one button is a small `최신` overlay (a11y `차트를 최신 구간으로 초기화`)
  that resets to `visibleCount = DEFAULT_VISIBLE_CANDLES`, `rightOffset = 0`
  and clears the crosshair; it renders only when `isDefaultViewport()` is
  false, so an untouched chart shows no chrome at all.
- **Mobile gestures**: two-finger pinch = zoom; one-finger horizontal drag =
  pan (`activeOffsetX` + `failOffsetY`, so vertical swipes stay with the detail
  screen's ScrollView); ~300ms long press = crosshair, scrubbed through a
  manually-activated pan so vertical scrubbing works without stealing normal
  vertical scrolls. A scrub that leaves the chart ends the crosshair —
  `shouldCancelWhenOutside(true)` on both the long press and the crosshair pan,
  plus an explicit `isWithinChartBounds` check on the scrub, and the finished
  session does not revive when the finger comes back in. No
  inertia/fling/rubber-band in this version.
- **Gesture lifecycle**: all four simultaneous recognizers route through
  `createChartGestureSession` (`none | pan | pinch | crosshair`).
  `begin(type)` claims the chart only when nothing owns it, `end(type)` fires
  only for the current owner, and `takeOver(type)` is the explicit hand-off
  (crosshair → pinch: crosshair ends once, pinch starts once). So
  `onGestureStart`/`onGestureEnd` fire exactly once per real gesture even
  though a single lift finalizes several recognizers, and a finalize from a
  recognizer that never owned the chart changes nothing. Chart pan claims the
  session on ACTIVATION (never on touch-down, so it cannot block a long press)
  and measures translation from the activation point, so the activation slop
  does not jump the chart.
- **One gesture owns the viewport on web.** A wheel that arrives DURING a
  left-button drag is CONSUMED (`resolveWheelHandling(event, {dragActive})` →
  `consume`): `preventDefault` still runs, so the page cannot scroll out from
  under the drag, but no zoom, no pan and no wheel session start — otherwise a
  second `onGestureStart` would replace the drag's viewport snapshot mid-drag
  and both would end separately. The drag is never force-ended by a wheel; on
  `mouseup` wheels resume normally. A zero-delta wheel is `skip`ped entirely.
- **Web gestures**: left-drag pans (crosshair suppressed during the drag),
  hover shows the crosshair, and the wheel over the chart is the chart's:
  shift + wheel and horizontal trackpad input pan, every other vertical wheel
  zooms at the pointer — including ctrl/cmd + wheel, which is what browsers
  report for a trackpad pinch. Every wheel the chart receives calls
  `preventDefault` (listener stays `passive: false`), so neither page scroll
  nor browser zoom happens over the chart; wheels outside the chart never
  reach the adapter and scroll the page normally.
- **Wheel bursts are ONE gesture.** A wheel burst arrives faster than React
  re-renders, so per-event start/end pairs would re-zoom the same stale
  snapshot and only one notch would stick. `createWheelGestureSession` opens a
  session on the first event (one viewport snapshot), applies the ACCUMULATED
  scale/pan against it, and closes after a ~120ms idle gap; switching between
  zoom and pan closes and reopens cleanly, a mouse-down/leave closes it, and
  unmount disposes the pending timer without firing.
- **Chart height is responsive**, not a fixed 240px strip:
  `getCandlestickChartHeight({windowWidth, windowHeight, platform})` — phone /
  narrow web → ~52% of the window clamped to 380–480, tablet / wide web → ~60%
  clamped to 500–680, falling back to the class minimum for unusable
  dimensions. It is fed by `useWindowDimensions()` + `Platform.OS`, so rotation
  and browser resize recompute it. An explicit `height` prop still wins
  (`heightOverride ?? …`); `AssetDetailScreen` passes none. The chart is never
  shrunk to fit more content on one screen — the detail screen's existing
  single ScrollView carries the rest.
- **Layout class is NOT width alone** (`getCandlestickChartLayoutClass` →
  `phone | tablet | webNarrow | webWide`). A landscape phone is 844 × 390:
  judged by width it would pass for a tablet and ask for a 500px chart inside a
  390px window. So NATIVE devices are classified by their SHORT side
  (`min(width, height) < 600` → phone), which does not change when the device
  rotates; WEB keeps the window-width rule (`< 768` → narrow), where the window
  width really is the layout. `Platform.OS` reaches the pure function through
  `toChartLayoutPlatform()` — no user-agent sniffing, no device-info library.
- **Y axis** is computed from the candles actually on screen. The
  current-price line is drawn ONLY while `rightOffset === 0`; in history it is
  hidden and excluded from the min/max so it cannot distort the range.
- **Rendering** materializes the visible window + 2 candles of buffer, so a
  1000-candle payload still renders ~60 (max ~182) candle groups. Pan/zoom
  update React state only when the visible index actually changes.
- **Timeframe switch** (`viewportResetKey` = `assetId:interval`) resets to the
  latest 60 slots (`rightOffset = 0`) and clears the crosshair, so a zoom from
  the previous timeframe never carries over. The chart's accessibility label
  reports whether it is the latest or a history window plus the current price
  (no candle count).
- **Live candle append** keeps the right edge pinned while viewing the latest;
  while viewing history the same candles stay on screen (`rightOffset` ages
  with the appended count) so the viewport never jumps to the newest data.
- **Data range**: movement is bounded by the loaded array. There is no
  automatic past-loading, cursor pagination or candle API change; adding it
  later only means growing that array — the viewport/slice split already keeps
  that separate.

`react-native-gesture-handler` is the only native gesture package, and
`GestureHandlerRootView` wraps the app root once in `App.tsx`. Every gesture
callback is `runOnJS(true)`, so there are no worklets:
`react-native-reanimated` / `react-native-worklets` were removed along with the
`react-native-worklets/plugin` Babel entry (`babel.config.js` is now the plain
Expo preset). A dev-client rebuild is still required whenever the native module
set changes; Expo web needs no extra setup.

## Release fixture smoke

Real PostgreSQL + Redis, fixture providers only, isolated namespace assets,
full cleanup, structured JSON summary + artifact:

```bash
cd backend
CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture
# or through Jest:
CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm test -- candle-release-fixture.integration.spec.ts
```

Pass criteria: every scenario `passed`, `"result": "passed"`, exit code 0,
zero incomplete closed candles, zero duplicate canonical rows, AND
`redisKeysRemainingAfterCleanup = 0` / `dbRowsRemainingAfterCleanup = 0`
(these are the post-cleanup leftovers; `redisKeysCreated` counts what the run
tracked and is intentionally a separate number). Artifacts:
`backend/artifacts/candle-smoke/fixture-<ts>.json`. The fixture smoke must
pass before any real-provider smoke is attempted.

Commit traceability: the smoke resolves its git identity before doing any
work (`SMOKE_GIT_COMMIT` override → `git rev-parse HEAD`; if neither yields a
full SHA the run ABORTS — a `gitCommit: null` passed artifact cannot prove
which code was validated, so it is impossible to produce). The artifact
records `gitCommit`, `gitBranch`, and `gitDirty`. A dirty working tree is
refused by default; `SMOKE_ALLOW_DIRTY=1` is a development-only escape hatch,
the artifact keeps `gitDirty: true`, and such a run is never accepted as
release validation. Existing historical artifacts are left untouched as
records; they are never edited or reinterpreted.

## GitHub Actions CI

`.github/workflows/ci.yml` runs on every pull request, on `main` pushes, and
via `workflow_dispatch`, with `contents: read` permissions and per-ref
concurrency cancellation. No provider API key or operational secret is
required, and no CI command rewrites files (`--no-fix` / `--check` only).
Four jobs:

1. **Backend quality** — frozen-lockfile `pnpm install`, `prisma generate`,
   then the candle-layer gates and the backend suite. Local reproduction:

   ```bash
   cd backend
   pnpm run lint:candles:check    # candle-layer ESLint, --no-fix --max-warnings=0
   pnpm run format:candles:check  # candle-layer prettier --check
   pnpm run typecheck             # tsc --noEmit -p tsconfig.build.json
   pnpm run build
   pnpm test
   ```

   The candle layer (candle files under `src/assets`, `providers/kis/candles`,
   candle-related `providers/binance` files, `src/realtime/live-candle-*`,
   and the candle smoke scripts) is the REQUIRED lint/format gate; the rest
   of the repository carries known pre-existing lint debt and is reported
   separately, not gated. `pnpm run lint:candles` is the matching dev-time
   autofix command.

2. **Frontend quality** — `npm ci`, `npm run typecheck`, `npm test`
   (`node --test` with Node 24 type stripping). The Expo app defines no build
   script; `tsc --noEmit` is its compile gate and no placeholder build
   command is fabricated.

3. **Limit order PostgreSQL integration** — PostgreSQL 16 + Redis 7
   service containers, `prisma migrate deploy`, `prisma migrate status`, and a
   `prisma migrate diff --exit-code` drift gate, then the opt-in limit-order
   money-layer suites (reservation atomicity, deterministic create races,
   post-lock time boundaries, no-Redis registration, idempotent create
   replay), plus market execute, FX and the MVP flow. CI pass/fail is judged
   on correctness invariants and migration-drift checks only, never on a
   throughput number.

4. **Candle fixture integration** — PostgreSQL 16 + Redis 7 service
   containers, `prisma migrate deploy`, then
   `CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture`
   (fixture providers only — no provider credentials). The job then verifies
   the artifact's `gitCommit` equals the CI SHA with `gitDirty=false` and
   `result=passed`, and uploads `backend/artifacts/candle-smoke/` as a build
   artifact even when the smoke fails.

The long real-provider smokes (Binance ≥90min, KIS in-session ≥60min) are
NEVER run in CI and are not a CI gate; they remain this manual, opt-in
runbook executed against the final release commit.

## Real-provider long smokes

`scripts/candle-live-smoke.ts` is a standalone harness (not Jest-bound):

```bash
cd backend
set -a; . ./.env; . ./.env.local; set +a
export PROVIDER_INGESTION_ENABLED=true CANDLE_LIVE_LONG_SMOKE=1

# Binance Spot, ≥90 minutes, REST verification + forced reconnect + lease takeover
BINANCE_LIVE_CANDLE_SMOKE=1 pnpm run smoke:candle-live -- \
  --provider binance --durationMinutes 92 --symbols BTCUSDT,ETHUSDT \
  --verifyRest --injectReconnect --output artifacts/candle-smoke

# KIS domestic, ≥60 minutes, run DURING the KRX regular session (09:00–15:30 KST)
KIS_LIVE_CANDLE_SMOKE=1 pnpm run smoke:candle-live -- \
  --provider kis-krx --durationMinutes 60 --symbols 005930,247540 \
  --verifyRest --injectReconnect --output artifacts/candle-smoke

# KIS US delayed, ≥60 minutes, only with entitlement + regular US session
CANDLE_LIVE_KIS_US_DELAYED_ENABLED=true KIS_LIVE_CANDLE_SMOKE=1 \
  pnpm run smoke:candle-live -- --provider kis-us --durationMinutes 60 \
  --symbols AAPL --verifyRest --output artifacts/candle-smoke
```

Pass criteria (per artifact JSON): `subscriptionSucceeded > 0`,
`eventsAccepted > 0`, `duplicateCanonicalRows = 0`,
`incompleteClosedRows = 0`, and with `--verifyRest`
`driftAfterReconciliation = 0`. `--injectReconnect` forces one socket close at
half-time and one owner-lease takeover at two-thirds; the run must show the
subscription restored and old-generation buckets recovered. Do not inject
Redis/PostgreSQL restarts against shared infrastructure.

Every live-smoke artifact carries `schemaVersion`, `gitCommit`, `gitBranch`,
`gitDirty`, and `result: passed | failed | not_run`. The same rules as the
fixture smoke apply: the run aborts without a resolvable commit SHA, refuses
a dirty tree unless `SMOKE_ALLOW_DIRTY=1` (development only, never release
validation), and validation is only executed AFTER the release commit is
final — an artifact for a different commit does not validate this one.

A provider smoke that was not actually executed (missing entitlement, market
closed, missing credentials) must be recorded as NOT RUN — never as passed.
Record it with the report tool (no provider/database/Redis access; includes
the git identity, provider, reason, and `createdAt`; never counted as a
pass):

```bash
pnpm run smoke:candle-report -- \
  --provider kis-us --result not_run \
  --reason "US regular session closed"
# artifact: backend/artifacts/candle-smoke/not-run-kis-us-<ts>.json
```

Artifacts: `backend/artifacts/candle-smoke/{binance,kis-krx,kis-us-delayed,not-run-*}-<ts>.json`
(counters only; no credentials or raw provider frames). Historical failed
artifacts stay as-is: they are records, never reinterpreted as passes.

## Known limitation: HTTP v1 `amount` contract

HTTP v1 serializes a missing quote amount as the string `"0.00000000"`, which
loses the distinction between "zero traded value" and "amount unavailable"
(KIS US delayed buckets legitimately have `amount = null`). This contract is
deliberately NOT changed in this stabilization. A future v2 (or response
metadata) should consider `amountAvailable: boolean` or `amount: string | null`.

## Pre-release operational checklist

1. `pnpm exec prisma migrate status` — all migrations applied, including
   `20260713200000_add_market_candle_sync_coverage`.
2. Re-seed sync coverage: run initial/incremental sync per active asset so
   audited coverage checkpoints exist (legacy checkpoints no longer serve).
   In the sync summary, check `coverageCompleteFeeds` — `completedFeeds`
   alone only counts normal termination, not confirmed coverage.
3. `GET /readiness` shows `ready`; `reasons` is empty; market calendar
   coverage spans the required years with no
   `MARKET_CALENDAR_COVERAGE_MISSING` and no `MARKET_CALENDAR_PROVISIONAL`
   (either the KRX 2027 dataset has been re-verified against the official
   KRX notice, or a 2026-only release pins
   `MARKET_CALENDAR_REQUIRED_THROUGH_YEAR=2026` — never mask provisional
   data).
4. Live gates and reconciliation gates enabled together (startup enforces
   this in production).
5. Fixture smoke passed AT THE FINAL RELEASE COMMIT, from a clean tree
   (`gitDirty: false`, `gitCommit` equals the release SHA;
   `redisKeysRemainingAfterCleanup`/`dbRowsRemainingAfterCleanup` both 0).
   Smokes run against a different or dirty commit do not count.
6. Binance ≥90-minute smoke passed; KIS KRX ≥60-minute in-session smoke
   passed; KIS US delayed smoke passed or explicitly recorded as NOT RUN
   (`pnpm run smoke:candle-report -- --provider kis-us --result not_run
--reason ...`) with the blocking reason. Every artifact must carry the
   release `gitCommit` with `gitDirty: false`. A previously failed artifact
   is a historical record — never reinterpret it as a pass.
7. Lease TTL > renew interval; reconnect min ≤ max; connection liveness ≥
   trade-stale threshold (config validation enforces all three).
8. No credential/raw-frame output in logs (spot-check structured logs).

## Limit-order matching and closed 5m candles (path B)

The EVENT-based matching layer (canonical exact-trade route,
`ProviderTradeRouteRegistry`, shared readiness) was removed: the live-candle
supervisor subscribes provider streams for the candle pipeline only, and the
legacy KIS/Binance streaming services keep their original display/snapshot
behavior. No provider hook publishes to a matcher.

Automatic matching was reimplemented as a SCHEDULER job
(`limit_order_matching`) that READS committed rows, so it depends on this
pipeline only as a consumer:

- Path B reads CLOSED 5-minute `MarketCandle` rows (`isClosed=true`) written by
  the live finalizer / reconciliation here. It never reads live Redis candle
  state, an open bucket, or a REST preview; a candle it hasn't finalized yet is
  simply not a trigger until it lands.
- Crypto and KIS domestic produce closed 5m candles reliably; KIS US only when
  delayed US candles are enabled, so US path B is effective only then —
  otherwise US limit buys fill via path A (fresh snapshot) alone.
- Path B validates each candle's window against the market session
  (`resolveRegularSessionForEvent`) and the calendar, fail-closed on gaps, so a
  holiday / uncovered candle never triggers a fill.

See `docs/scheduler-ops-foundation.md` (`limit_order_matching`) and
`docs/policy-decisions.md` for the matching semantics.
