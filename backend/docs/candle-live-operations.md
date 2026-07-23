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
3. the cold-baseline policy — no completed baseline coverage AND a requested
   range beyond `CANDLE_SERVING_ON_DEMAND_REPAIR_MAX_RANGE_MS`, logged as
   `{"event":"candle_delivery","state":"legacy_provider","reason":"cold_baseline_required"}`.
   Operators seed these baselines with the manual `market_candle_sync` job.

The cold-baseline path is a deliberate PRE-refresh routing decision for
ranges the managed path is not allowed to own yet; it is not a failure
fallback. After a managed refresh has started, no catch/fallback path calls
`legacyLoader`.

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
`useAssetTicker`/`useAssetCandle` only register subscriptions and release
them on unmount (the socket closes when the last subscription is released).
Auth failures (1008/UNAUTHORIZED) stop reconnection; candle subscriptions get
a `restored` event after every reconnect which triggers the HTTP baseline
refetch, and `resync_required` handling is unchanged.

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
Three jobs:

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

3. **Candle fixture integration** — PostgreSQL 16 + Redis 7 service
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

## Canonical trade route and the limit-order matcher (phase 3)

When `CANDLE_LIVE_STREAMING_ENABLED=true` and a provider's live-candle flag is
on, `LiveCandleStreamSupervisorService` owns that provider's socket AND its
exact-trade route (`ProviderTradeRouteRegistry`). The legacy
KIS/Binance streaming service then neither connects nor publishes normalized
trades, so there is exactly one socket and exactly one publisher per provider.

- **KIS**: the SAME parsed trade record feeds the candle pipeline, the
  price-display pub/sub, and the limit-order matcher. The frame is parsed once.
- **Binance**: when `LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true` the supervisor
  subscribes `<symbol>@trade` alongside `<symbol>@kline_5m` on the SAME
  connection. Klines go to the candle pipeline; trades go to the matcher. No
  second Binance WebSocket is opened. With matching off, only klines are
  subscribed and no trade is published.

This makes live candles and automatic limit-order matching compatible: they are
no longer mutually exclusive deployments.

Each connection attempt mints a new connection generation. Asset subscription
readiness is recorded per generation and discarded on reconnect, so limit
Quote/Create for an asset stays fail-closed until the new socket has
re-subscribed and been acknowledged (KIS per `tr_key`, Binance per SUBSCRIBE
batch ack). Assets dropped by the subscription cap are recorded as capped and
are never tradable by limit order.

### Subscription cap is counted in STREAMS

Binance limits **streams per connection (1024)**, not assets. With the matcher
off an asset costs one stream (`<symbol>@kline_5m`); with it on it costs two
(`<symbol>@kline_5m` + `<symbol>@trade`, deliberately on the SAME socket). An
asset-count cap of 1024 would therefore request 2048 streams, Binance would
reject the whole SUBSCRIBE, and the result is a connected socket carrying no
market data at all — the worst possible failure shape, because liveness checks
still pass.

The effective asset budget is:

```
min(CANDLE_LIVE_MAX_PROVIDER_SUBSCRIPTIONS_PER_SHARD,
    floor(CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD / streams-per-asset))
```

`CANDLE_LIVE_MAX_PROVIDER_SUBSCRIPTIONS_PER_SHARD` keeps its meaning (ASSETS)
for backward compatibility and is still enforced;
`CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD` (default and maximum 1024, minimum
1, validated at startup) is the provider's real unit. The actually-built
`streams` array is asserted against 1024 immediately before SUBSCRIBE, so a
future change to the stream families fails loudly instead of producing a silent
data-less connection.

KIS is unaffected: its exact-trade feed is the SAME parsed frame as the candle
feed, so one subscription target remains one stream.

A reconnect re-derives the budget from scratch under a new connection
generation, so a cap change takes effect on the next connection and no
readiness survives from the previous one.

The subscription build is also where each asset's
`id/symbol/market/assetType/settlementCurrency` is read — once per generation.
Those values ride on the normalized trade event, so the limit-order publisher
performs no per-trade database query.

### Shared limit-order readiness is lease-backed on read and write

When shared readiness is enabled, the shard-0 live-candle owner lease
(`candles:live:v1:owner:<provider>:0`) is the authority for the cross-instance
limit-order route. Publishing first exchanges the live lease token for a
monotonic fencing epoch, and every meta/asset write rechecks lease and epoch in
Redis. Reading performs a separate atomic proof: meta, actual owner lease,
epoch-holder, current epoch, and the current generation's asset record must all
agree. Lease expiry therefore invalidates readiness immediately; the readiness
TTL is not an authorization grace period and wall clocks do not decide owner.

On renewal failure the supervisor clears the registry's `ownerLease` before
closing the socket. The next publisher pass compare-and-deletes only its own
stored owner/generation/epoch. Token rotation and fenced writes use the same
cleanup; a late old-owner cleanup cannot remove a takeover's newer epoch.
Operationally, `LIMIT_ORDER_PROVIDER_OWNER_LEASE_LOST` means verify the real
owner lease/renewal path, while `_READINESS_EPOCH_MISMATCH` means verify the
epoch-holder/current-epoch chain. Do not extend TTLs to mask either failure.

### Path B dependency

The confirmed 5-minute candle safety net
(`docs/limit-order-candle-reconciliation.md`) consumes only committed
`market_candles` rows written by the finalizer. If the finalizer defers a
bucket to REST repair, path B simply does not see that window until
reconciliation restores it — it never reads live Redis candle state, an open
bucket, or a REST preview. Its missing-window completion heartbeat is separate
from the existing-row scan heartbeat, and a latest completion failure blocks
new limit orders immediately. Deferred rows are revision-aware through
`MarketCandle.ingestSeq`; a corrected candle can reactivate a permanent entry
without deleting immutable evidence from the earlier revision.
