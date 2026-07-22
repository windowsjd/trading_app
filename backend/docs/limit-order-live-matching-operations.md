# Limit-buy live-trade matching operations

This document covers phase 2 path A and the phase-3 hardening that goes with
it. Path B (the confirmed 5-minute candle safety net) has its own document,
[limit-order-candle-reconciliation.md](limit-order-candle-reconciliation.md).
All HTTP endpoints remain under `/api/v1`; there is no `/api/v2` route and no
public limit-order execute route.

## Scope and execution policy

The primary automatic execution path is:

`normalized KIS/Binance trade tick -> Redis Stream -> dedicated Poller -> PostgreSQL transaction`

It is not a latest-price database poll, REST quote poll, candle-low match, or
candle reconciliation. A valid live trade whose price is at or below a
submitted limit-buy price fills the whole simulated order at the event price.
Price improvement is allowed. Exchange order-book liquidity and provider volume
are not allocated; one event may fully fill all eligible orders. KIS and
Binance supply market data only—no provider order API is called.

Path A always has priority. Path B exists only for the case where a real trade
did touch the limit but its event never reached the Redis Stream, and it never
improves on the limit price. Path B cannot be enabled without path A;
`LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=true` with
`LIMIT_ORDER_AUTO_EXECUTION_ENABLED=false` aborts startup.

Supported orders are buy/limit/full-fill only and behave as GTC until the
season ends. Limit sells, partial fills, IOC/FOK/DAY/stop orders and historical
missed-touch recovery are out of scope.

## Phase 1 transaction-time hardening

Limit create locks `Quote FOR UPDATE -> SeasonParticipant FOR SHARE -> Season
FOR SHARE`, reads the optional Redis activation cursor, then reads `SELECT
clock_timestamp()`. PostgreSQL `now()` and
`CURRENT_TIMESTAMP` are transaction-start timestamps and therefore exclude
time spent waiting for a lock. The post-lock `clock_timestamp()` is the final
authority for:

- Quote TTL (`transactionNow > expiresAt` preserves the existing boundary),
- `Season.startAt <= transactionNow < Season.endAt`, and
- stock calendar/session checks, which fail closed when calendar data is
  unavailable.

`Order.submittedAt`, `createdAt`, and `updatedAt` use that same DB timestamp.
Pre-transaction checks are latency optimizations only. Integration tests use
real row locks and confirm the waiting query in `pg_stat_activity`; they do not
infer an interleaving from sleep duration or outcome counts.

The frontend snapshots the successful quote separately from the editable
quote state before resetting the form. Limit quote/success UI says “estimated”
for gross and fee and shows the reservation; market-only execution-price,
max-change-bps, and post-fill-position wording is hidden.

## Event-boundary mutex (phase 3)

Create records "every stream entry after ID X activates this order" but
publishes nothing itself. Without a mutex this interleaving loses an event
permanently:

1. Create reads the Redis tail = `A`
2. price event `B` is XADDed
3. the poller reads `B`, finds no candidates (the order is uncommitted)
4. the poller records `B` as processed and ACKs it
5. Create commits the order with `matchingActivationStreamId = A`

`B` is strictly after activation, so it should have filled the order, but it is
already durably processed and can never be re-delivered.

`LimitOrderMatchBoundaryService` closes this with a PostgreSQL advisory lock
(namespace `1244660901`, key `2` — distinct from the matcher leader key `1`).
Redis locks and in-process mutexes are deliberately not used: a Redis lock
cannot be tied to a PostgreSQL transaction's commit, and a process-local mutex
does not span instances.

- **Create** takes `pg_advisory_xact_lock` as the FIRST statement of its
  transaction, so it is released exactly at commit — the same instant the
  order row becomes visible to the candidate query.
- **The path-A poller and the path-B candle worker** take `pg_advisory_lock`
  on a DEDICATED PostgreSQL connection (never a Prisma pool connection). If
  the worker process dies, PostgreSQL tears the session down and releases the
  lock server-side. There is no lease and no TTL.

### One session per lease

The poller and the path-B candle worker are injected with the SAME Nest
provider instance and can call `acquireSession()` concurrently. A single shared
`pg.Client` guarded by a `held` boolean was **not** safe:

1. both callers pass the `held === false` check,
2. both issue `pg_advisory_lock` on the SAME session,
3. PostgreSQL session advisory locks are **re-entrant within one session**, so
   BOTH are granted and both callers believe they own the boundary,
4. the session's lock counter is now 2, but `release()` decrements the boolean
   once and unlocks once,
5. the advisory lock leaks for the lifetime of the connection, and every later
   Create, poll and sweep blocks forever.

`LimitOrderMatchBoundaryService` therefore owns a dedicated `pg.Pool`
(`LIMIT_ORDER_MATCH_BOUNDARY_MAX_SESSIONS = 4`, capped so a runaway caller
cannot exhaust PostgreSQL connections and never competing with the Prisma
pool). Every `acquireSession()`:

- checks out its OWN `PoolClient`, i.e. its own PostgreSQL session,
- takes `pg_advisory_lock` on that private session,
- returns a lease that owns exactly that session.

Mutual exclusion is then enforced by PostgreSQL across sessions — the same
guarantee Create already relied on — so two in-process workers serialize
exactly like two separate pods.

`release()` is **idempotent**: only the first call unlocks and returns the
client to the pool. A second call must not issue another
`pg_advisory_unlock`, because by then the session may already have been handed
to the next caller and unlocking there would give two workers the boundary at
once. A failed unlock or a broken connection **destroys** the client instead of
returning it: a session whose unlock status is unknown must never serve the
next acquisition.

On shutdown `onModuleDestroy` ends the pool; any session still holding the lock
is torn down by PostgreSQL when its backend exits, which preserves the existing
crash-recovery property.

### `lockInTransaction` uses `$executeRaw`

`pg_advisory_xact_lock` returns `void`. The Prisma 7 pg driver adapter cannot
decode a `void` result column, so reading it through `$queryRaw` raises
`P2010 / UnsupportedNativeDataType`. Because the boundary is the FIRST
statement of the create transaction, that failure would make **every**
limit-order create fail the moment automatic matching is enabled — while every
unit test that mocks `$queryRaw` still passes. The call therefore uses
`$executeRaw`, and
`scripts/limit-order-boundary-concurrency-integration.ts` exercises it through
the real Prisma client so a mock can never hide the regression again.

Only two orderings remain, and both are correct:

| Interleaving | Result |
| --- | --- |
| Create first | The poller cannot observe `B` until the order row is committed and visible, so `B` fills it. |
| Poller first | `B` is fully processed before Create reads the tail, so Create's cursor already includes `B` and `B` can never fill the new order. |

**Lock order is not negotiable.** Every participant takes the boundary BEFORE
any row lock: `boundary -> Quote -> SeasonParticipant -> Season -> Wallet` for
Create, `boundary -> SeasonParticipant -> Season -> Order -> Wallet` for both
workers. Acquiring the boundary after a row lock would create a cycle that
PostgreSQL's deadlock detector cannot even see, because the worker holds its
boundary lock on a different session than the one doing the row work.

The Redis ACK happens strictly AFTER the durable processed-event row and
strictly OUTSIDE the mutex, so a crash re-delivers the event instead of losing
it, and a create never waits on a Redis round trip.

### Boundary verification

`scripts/limit-order-boundary-concurrency-integration.ts`
(`LIMIT_ORDER_BOUNDARY_CONCURRENCY_INTEGRATION=1`) proves, against a real
database and with every ordering read from `pg_locks` / `pg_stat_activity`
rather than a sleep:

| Check | What it proves |
| --- | --- |
| concurrent acquire serializes | exactly one holder and exactly one WAITER appear in `pg_locks`; the waiter is granted only after the first lease releases; the two leases hold different backend PIDs |
| poller vs candle worker | the two real callers' critical sections strictly alternate, never overlap |
| create after worker leases | `pg_try_advisory_xact_lock` succeeds immediately, so the session counter really reached zero |
| killed worker session | a terminated backend releases the lock server-side; a queued worker and a Create both proceed |
| double release | releasing twice never unlocks a lock the lease no longer owns, and the recycled session grants exactly once |
| residual lock | 12 acquire/release cycles through the small pool leave zero granted and zero waiting locks |
| real Prisma adapter | `lockInTransaction` works through the actual driver, and the transaction-scoped lock is released at commit |

## Stream-ID ordering and clock skew (phase 3)

Activation ordering is decided by the Redis Stream ID alone:

```
event.streamId > order.matchingActivationStreamId
```

The former `order.submittedAt <= event.receivedAt` rule was REMOVED.
`Order.submittedAt` is a PostgreSQL `clock_timestamp()` while
`event.receivedAt` is a Node process clock; comparing them across two hosts
dropped perfectly valid events purely from clock skew. A Redis Stream ID is a
single-writer monotonic sequence produced by one Redis instance and needs no
clock agreement at all.

Timestamps remain for audit, display, anomaly detection and operational
analysis. The validator still rejects obviously broken values — a
provider/received/published timestamp more than 60s in the future, or
`publishedAt < receivedAt` — but that is a sanity bound on corrupt payloads,
NOT a skew tolerance used to decide eligibility, and it is deliberately not
widened to paper over a mis-set clock.

## Event source and schema

No extra provider connection is opened, and exactly one source publishes per
provider. `ProviderTradeRouteRegistry` holds that claim.

- **When the live-candle supervisor owns a provider** (live candles enabled for
  it), that connection is the canonical exact-trade source. For KIS the SAME
  parsed trade record feeds the candle pipeline, the price-display pub/sub and
  the limit-order matcher — the frame is parsed exactly once. For Binance the
  supervisor subscribes `<symbol>@trade` alongside `<symbol>@kline_5m` on the
  SAME socket when automatic matching is on; klines go to the candle pipeline
  and trades to the matcher, with no second Binance WebSocket.
- **When the supervisor is inactive** for a provider, the legacy streaming
  service claims the route and remains the fallback canonical source: KIS
  publishes after its validated trade resolves to an asset, Binance publishes
  from its `@trade` subscription beside `@ticker`.
- The non-owning source neither connects nor publishes, so a duplicate socket
  and a duplicate exact-trade event are both impossible.

Each provider serializes its trade work in frame-arrival order, and the common
Publisher serializes XADD, so asynchronous responses cannot reverse two events
before Redis. Bid, ask, book, candle, REST-current-price, admin and batch
values never enter this stream.

## Per-asset subscription readiness (phase 3)

"The provider socket is connected" does not mean the asset a user is trading is
subscribed. `assertAvailable({ assetId, symbol, market, assetType })` now
requires, for the asset itself:

- a claimed canonical route and an established connection,
- the asset present in the CURRENT connection generation's subscription set,
- the subscribe request sent AND acknowledged (KIS acknowledges per `tr_key`;
  Binance acknowledges one SUBSCRIBE batch with one result frame),
- not dropped by `maxProviderSubscriptionsPerShard`,
- a frame seen within `LIMIT_ORDER_PROVIDER_LIVENESS_MAX_AGE_MS`.

A reconnect mints a new connection generation, which discards every previous
readiness: nothing is tradable again until the new socket re-subscribes and is
re-acknowledged. Failures are distinguished by code —
`LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED`,
`LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED`,
`LIMIT_ORDER_PROVIDER_UNAVAILABLE` — all HTTP 503. When
`LIMIT_ORDER_AUTO_EXECUTION_ENABLED=false` the reservation-only policy applies
and none of this gates anything.

### Multi-instance shared readiness

`ProviderTradeRouteRegistry` is per-process memory that mirrors the socket THIS
process owns. In a multi-instance deployment the live-candle supervisor owns
the Binance/KIS connection on ONE instance while HTTP requests land on any of
them, so the same quote/create used to succeed on the owner and fail with
`LIMIT_ORDER_PROVIDER_UNAVAILABLE` on every other pod — a user-visible
coin-flip decided by the load balancer.

`LIMIT_ORDER_SHARED_READINESS_ENABLED=true` (default off) makes the owner
publish its readiness to Redis and every other instance read it.

**Resolution order** (`LimitOrderProviderHealthService.assertAvailableAsync`):

1. this process owns the route -> the local registry is the authority,
2. otherwise, shared readiness enabled -> the Redis view is authoritative and
   FINAL (no fallback afterwards; falling back would reintroduce the
   inconsistency),
3. otherwise -> the legacy per-provider streaming status.

Every unresolved case is fail-closed. There is no fail-open branch.

The shared check runs OUTSIDE the create transaction (a Redis round trip must
never happen while the event boundary is held); the in-transaction check stays
purely in-memory.

**Redis key schema.** All keys carry a `{provider}` hash tag so a clustered
Redis maps them to one slot and the readiness read stays a single atomic
script.

| Key | Type | TTL | Contents |
| --- | --- | --- | --- |
| `limit-order:trade-readiness:v1:{<provider>}:meta` | string (JSON) | `LIMIT_ORDER_SHARED_READINESS_TTL_SECONDS` | schemaVersion, provider, ownerInstance, source, generation, connected, connectedAt, lastFrameAt, lastUpdatedAt, degradedReason |
| `limit-order:trade-readiness:v1:{<provider>}:gen:<generation>:assets` | hash | same | per assetId: providerSymbol, symbol, market, assetType, settlementCurrency, sourceName, subscription state, generation, acknowledgedAt, updatedAt |

Only routing/liveness metadata is published. **Never** a credential, an
approval key, an access token, or a raw provider frame — asserted by the
integration runner, which scans the published payload for both JSON key names
and bare secret substrings.

**Generation and owner safety.** The asset hash is generation-scoped, so a
reconnect writes a NEW key and every previous asset readiness is unreachable
the instant the new meta is published — not when its TTL expires. The
superseded hash is then dropped explicitly (guarded so it can only delete a
hash the current meta no longer points at, and only while this instance still
owns the meta).

Every mutating script is a compare-and-swap executed inside Redis:

- a meta write is refused when the stored record belongs to a DIFFERENT owner
  and is strictly newer (`lastUpdatedAt`),
- `release` deletes ONLY when the stored generation AND ownerInstance both
  match, so a **late release from a replaced owner is a no-op** and cannot
  delete the new owner's state.

**Publishing cadence.** `ProviderTradeReadinessPublisher` mirrors the registry
on a timer rather than write-through, because the TTL is the owner heartbeat
and has to be refreshed regardless of change, and because registry mutations
sit on the socket hot path (`markFrame` fires on EVERY frame) and must never
await a Redis round trip. Assets are written BEFORE the meta, so a reader that
resolves the new generation always finds its hash populated.

**Readiness rules on the reader side** (identical to the local registry's, so
the two can never disagree): no meta or expired TTL -> unavailable; degraded or
not connected -> unavailable; `lastFrameAt` older than
`LIMIT_ORDER_PROVIDER_LIVENESS_MAX_AGE_MS` -> unavailable; asset absent from
the current generation -> not subscribed; `requested` -> not acknowledged;
`failed` -> subscription failed; `capped` -> not subscribed; generation
mismatch -> unavailable; Redis error or unknown schema version -> unavailable.

Verified by `scripts/limit-order-shared-readiness-integration.ts`
(`LIMIT_ORDER_SHARED_READINESS_INTEGRATION=1`) using TWO independent
service/registry instances against one real Redis — a single-process unit test
cannot demonstrate cross-instance agreement.

## No per-event database lookups (phase 3)

The canonical connection reads each asset's `id/symbol/market/assetType/
settlementCurrency` once, when it builds the subscription for the current
connection generation, and registers it. Those values ride on the normalized
tick, so the Publisher performs ZERO database queries per trade. The poller
serves its route/session validation from a bounded, short-TTL cache
(`LIMIT_ORDER_ASSET_CACHE_TTL_MS`, `LIMIT_ORDER_ASSET_CACHE_MAX_ENTRIES`)
keyed by asset id.

Both are routing optimisations only. The candidate query joins `assets` and
the execution transaction re-reads and re-validates the asset under its row
locks, so a stale cache entry can never authorise a fill.

Redis stores a secret-free JSON payload plus `eventId`. Schema version 1 has:

- `eventId`, `eventType=trade`, `provider`, `assetId`, `symbol`, `market`,
  `assetType`, `currencyCode`, and decimal-string `price`;
- UTC ISO `providerEventAt`, `receivedAt`, and `publishedAt`;
- optional non-secret provider connection generation, sequence, session code,
  and normalized source name.

Raw provider payloads, tokens, app keys and authorization headers are absent.
When the provider supplies a trade ID, the stable key is
`provider:assetId:providerTradeId`. Otherwise SHA-256 covers schema, provider,
asset, provider timestamp, normalized price, sequence and connection
generation. `limit_order_processed_events.event_id` records completed events,
so a duplicate XADD cannot fill an order created after the original event.

Submission ordering uses both a conservative receiver-time check and the Redis
cursor rather than trusting cross-host clocks alone. Candidates require
`Order.submittedAt <= event.receivedAt`; no arbitrary clock-skew tolerance is
added. In addition, Create reads the stream's last ID after its DB locks and
stores it as
`matchingActivationStreamId`; candidates require an event stream ID strictly
greater than that cursor. Existing phase-1 orders have a null cursor and are
not retroactively matched. The two independent fences favor a safe missed fill
over an incorrect pre-submission fill if clocks disagree.

## Stream, leader, recovery, and ACK

Defaults:

- stream: `limit-order:price-events:v1`
- consumer group: `limit-order-matchers:v1`
- instance-specific consumer name: hostname, PID, UUID
- approximate MAXLEN: 100,000
- blocking read: 3 seconds, event/candidate batch: 100
- pending idle/reclaim: 30 seconds
- heartbeat/max age: 5/15 seconds
- DLQ: `<stream-key>:dlq`

The Poller is a long-running blocking reader, not a 60-second scheduler job.
Only the process holding a session-scoped PostgreSQL advisory lock is active.
A standby retries. The leader re-proves that its dedicated PostgreSQL session
is alive before and after every blocking Redis read; loss of that session
releases the lock and stops the old leader before financial mutation.

Startup creates the group idempotently with `0-0 MKSTREAM`, checks retention
gaps, reclaims stale pending entries with XAUTOCLAIM, drains its pending work,
then reads new events in stream order. If another consumer still owns pending
work that has not reached the reclaim idle threshold, the new leader waits; it
does not overtake that entry with a newer event. ACK happens only after all bounded
candidate batches finish and the durable processed-event row exists. A crash
before ACK leaves pending work for the next leader. Malformed/unsupported
events go to the DLQ with only source stream ID, stable event ID, error code and
failure time, then are ACKed so a poison event cannot halt the stream.

If pending entries were trimmed or the retained first ID is ahead of the
consumer cursor, matching stops with `LIMIT_ORDER_EVENT_GAP_DETECTED`. There is
no latest-price or candle fallback.

## Candidate SQL and transaction

The bounded FIFO query joins active participant, active in-time season, and
active asset, and filters asset/currency, submitted buy/limit, non-null
reservation basis, `limit_price >= event.price`, and activation cursor. It
orders by `submitted_at, id`. Migration
`20260722120000_add_limit_order_live_trade_matching` adds a price-selective
partial index. The additive
`20260722130000_add_limit_order_candidate_fifo_index` adds the FIFO covering
index used by the bounded query:

```sql
CREATE INDEX orders_live_limit_buy_fifo_idx
ON orders (asset_id, submitted_at, id)
INCLUDE (
  limit_price, currency_code, reserved_amount,
  reservation_fee_rate, matching_activation_stream_id
)
WHERE status='submitted' AND order_type='limit' AND side='buy';
```

On the empty local integration database, PostgreSQL's default cost model chose
a sequential scan because the table fit below one page. With sequential scans
disabled to prove index eligibility, `EXPLAIN` selected
`orders_live_limit_buy_fifo_idx` with `asset_id` as the index condition and no
explicit sort. Production selection still depends on live table statistics and
data distribution.

Every candidate is revalidated under locks in this order:

`SeasonParticipant SHARE -> Season SHARE -> Order UPDATE -> CashWallet UPDATE -> Position UPDATE`

This is compatible with participant exclusion (`Participant -> Order ->
Wallet`), lifecycle/settlement participant-first locking, and cancel
(`Order -> Wallet`). There is no cycle in which cancel waits for participant
or season. Exactly one order-state transaction wins. After the wallet and any
existing position lock have been acquired, the execution transaction reads
`clock_timestamp()` and rechecks the season time window; a lock wait therefore
cannot carry a fill past `Season.endAt` under a stale timestamp.

Execution uses the event price and the order's pinned
`reservationFeeRate`—never the current season fee:

```text
gross       = round(eventPrice * quantity)
fee         = round(gross * reservationFeeRate)
actualDebit = round(gross + fee)
```

`actualDebit` must not exceed the original reservation. One parameterized,
guarded wallet UPDATE subtracts only `actualDebit` from balance while releasing
the whole order reservation, and proves the post-update balance still covers
all other reservations. Price-improvement cash therefore returns to available
cash without touching another order's reservation.

The same transaction writes the canonical `order_buy` debit ledger row,
creates/updates the buy Position using net cost (including fee), links one
deduplicated provider-event `AssetPriceSnapshot`, marks the Order executed with
actual gross/fee/net and trigger evidence, increments participant fill state,
and writes `SnapshotReason.order_executed` equity. Ranking refresh is scheduled
after commit and cannot roll back execution.

Create's `responsePayloadJson` remains the original submitted response for
idempotent POST replay. Current order/record GET endpoints read the current
executed state.

## Races and late events

- Cancel first: the Poller sees canceled and skips. Execution first: cancel
  reports not cancelable. Balance, reservation, ledger and position change
  once. Event reception alone does not outrank a committed cancel.
- Exclusion/season end first: participant/season revalidation prevents a fill.
  Execution first: cleanup ignores the executed order.
- A delayed event is not filled after the season is no longer active. There is
  no season-end historical replay or final drain in this version.
- Settlement remains blocked while submitted orders or reserved wallets exist.

## Health and fail-closed behavior

The leader writes an `OpsJobRun(limit_order_matcher)` heartbeat containing the
leader instance, leader start time, last Redis read/success/ACK plus the ACK
timestamp, pending count, oldest pending age, lag, first/last stream IDs,
stream length, retention headroom ratio, processed-event growth statistics and
degraded reason.

Phase 3 replaced the "a heartbeat exists" gate with an explicit set of
fail-closed conditions. New limit Quote/Create are refused when:

| Condition | Env | Error code |
| --- | --- | --- |
| no fresh running heartbeat | `LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS` | `LIMIT_ORDER_MATCHER_UNAVAILABLE` |
| leader reported a degraded reason | — | `LIMIT_ORDER_MATCHER_DEGRADED` |
| consumer lag too high | `LIMIT_ORDER_MATCHER_MAX_LAG` | `LIMIT_ORDER_MATCHER_LAG_EXCEEDED` |
| un-ACKed backlog too large | `LIMIT_ORDER_MATCHER_MAX_PENDING` | `LIMIT_ORDER_MATCHER_PENDING_EXCEEDED` |
| oldest pending entry too old | `LIMIT_ORDER_MATCHER_MAX_OLDEST_PENDING_AGE_MS` | `LIMIT_ORDER_MATCHER_PENDING_STALE` |
| backlog exists and last ACK is stale | `LIMIT_ORDER_MATCHER_MAX_ACK_AGE_MS` | `LIMIT_ORDER_MATCHER_ACK_STALE` |
| stream grew into its trim window | `LIMIT_ORDER_EVENT_RETENTION_HEADROOM_RATIO` | `LIMIT_ORDER_EVENT_RETENTION_HEADROOM_LOW` |
| no active publisher / provider route | — | `LIMIT_ORDER_PROVIDER_UNAVAILABLE` |
| requested asset not subscribed | — | `LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED` |
| requested asset's subscription rejected | — | `LIMIT_ORDER_PROVIDER_SUBSCRIPTION_FAILED` |

**A quiet market is not a failure.** ACK staleness is only judged when there is
actually a backlog (`pendingCount > 0` or `lag > 0`); an idle matcher with an
hours-old last ACK passes. Before a newly elected leader's first ACK the age is
measured from its start time, so a cold start into a backlog is not reported as
a stall.

Redis activation-cursor failure also blocks Create. Existing order reads and
Cancel, participant/season cleanup, market orders, and FX never use this gate.

Relevant errors include `LIMIT_ORDER_MATCHER_UNAVAILABLE`,
`LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE`, `LIMIT_ORDER_EVENT_INVALID`,
`LIMIT_ORDER_EVENT_GAP_DETECTED`, `LIMIT_ORDER_EXECUTION_CONFLICT`,
`LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT`,
`LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT`,
`LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED`, and (path B)
`LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH`.

## Processed-event growth policy

`limit_order_processed_events` is append-only and is what stops a duplicate
XADD from filling an order created after the original event was processed.

**No retention deletion is implemented, deliberately.** Deleting an event id
would allow a later re-delivery of that same id to be treated as new and fill
orders created after the original processing. Ruling that out would require
proving all of: the reuse window of every provider's trade id (KIS supplies no
documented global uniqueness guarantee for its realtime trade keys, and our
fallback ids are content hashes that repeat for identical prints), the maximum
Redis Stream retention, and the maximum lifetime of a submitted order (GTC —
bounded only by season end, which operators can extend). Those cannot be
bounded today, so the correctness proof cannot be written and the rows stay.

### Observation cost

The growth used to be measured on the matcher heartbeat **every 60 seconds**
with `COUNT(*)` plus two filtered counts over the WHOLE table. On an
append-only table that grows monotonically that is a sequential scan whose cost
rises forever, paid by the matcher's own event loop, purely to print a number
that changes on a scale of hours.

The heartbeat sample is now **approximate** and runs on
`LIMIT_ORDER_PROCESSED_EVENT_STATS_INTERVAL_MS` (default 300 000 ms, minimum
60 000 ms):

| Field | Source |
| --- | --- |
| `rowCount` | `pg_stat_user_tables.n_live_tup` (planner statistics) |
| `oldestProcessedAt` / `newestProcessedAt` | ordered index probe, not a heap aggregate |
| `lastHourCount` / `lastDayCount` | bounded index range scans |
| `tableBytes` / `indexBytes` | `pg_table_size` / `pg_indexes_size` catalog functions |

The payload carries `approximate: true` and `sampledAt`, so an operator never
reads an estimate as a ledger figure. A BRIN index on `processed_at` keeps the
range scans cheap on an append-only, time-correlated table. A sampling failure
is logged and the previous sample is reused — capacity observability must never
stop the matcher — and it does not retry on the very next heartbeat, so a
failing sample cannot become a per-tick query storm on an already unhealthy
database.

**Exact figures on demand:** `pnpm run diagnose:limit-order-processed-events`
prints exact counts, sizes, a growth projection derived from the observed
last-24h rate, and the drift between the planner estimate and reality (a large
drift means autovacuum/ANALYZE is not keeping up).

The matcher additionally logs
`limit_order_processed_events_capacity_warning` once a sample crosses
`LIMIT_ORDER_PROCESSED_EVENT_WARN_BYTES` (default 10 GiB) or
`LIMIT_ORDER_PROCESSED_EVENT_WARN_ROW_COUNT` (default 500 M).

### Capacity model

One row is roughly 120–200 bytes including index overhead. With `E` events per
second sustained:

```
rows/day    = E * 86_400
rows/month  = E * 86_400 * 30
bytes/day   = rows/day   * bytesPerRow      (bytesPerRow measured, not assumed)
bytes/month = rows/month * bytesPerRow
```

| Sustained rate | Rows/day | Rows/month | ≈ Bytes/month @160 B |
| --- | --- | --- | --- |
| 10 events/s | 864 K | 25.9 M | ~4 GB |
| 100 events/s | 8.64 M | 259 M | ~41 GB |
| 500 events/s | 43.2 M | 1.30 B | ~207 GB |

`bytesPerRow` is measured for THIS deployment by the diagnostic script rather
than assumed; use its `projection` block for the real numbers.

### Partition migration plan (future work, NOT in this change)

Converting the existing table in place is deliberately out of scope here.
The intended path when the numbers justify it:

1. Prove the retention bound first (see below). Without it, dropping a
   partition is exactly the deletion this policy forbids.
2. Create `limit_order_processed_events_partitioned`, `PARTITION BY RANGE
   (processed_at)`, with monthly partitions plus a default partition.
3. Backfill in batches by `processed_at`, oldest first, with the matcher
   running — the table is append-only, so a backfill never contends with an
   UPDATE.
4. Attach the current table as the oldest partition, or keep backfilling until
   the row counts match.
5. Swap in one transaction: `ALTER TABLE ... RENAME` both tables. The dedupe
   read is by primary key, so the swap is invisible to the matcher beyond a
   momentary lock.
6. Only then enable partition retention.

**Rollback:** until step 5 the original table is untouched and the migration is
abandoned by dropping the partitioned table. After step 5, rename back — the
original table still holds every row because nothing was deleted.

**What must be proven before any partition retention is enabled**, i.e. before
a whole old partition may be dropped:

- an upper bound on provider trade-id reuse for EVERY provider in use (KIS
  publishes no global uniqueness guarantee for realtime trade keys, and our
  fallback ids are content hashes that repeat for identical prints),
- an upper bound on Redis Stream retention, so a re-delivery older than the
  retention window is impossible,
- an upper bound on submitted-order lifetime (currently GTC, bounded only by
  season end, which operators can extend).

The retention window must exceed the maximum of those three. Until all three
are bounded, rows stay.

## Flags and rollout

Every boolean accepts only trimmed, case-insensitive `true/false/1/0`; all
other values fail startup. **All defaults are false**, and nothing in this
change turns any of them on.

| Flag | Default | Meaning |
| --- | --- | --- |
| `LIMIT_ORDER_ENABLED` | false | new limit Quote/Create accepted |
| `LIMIT_ORDER_AUTO_EXECUTION_ENABLED` | false | path A live-trade matcher |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED` | false | path B closed-candle safety net |
| `LIMIT_ORDER_SHARED_READINESS_ENABLED` | false | cross-instance readiness in Redis |

- `LIMIT_ORDER_ENABLED=false`: no new limit Quote/Create. Existing submitted
  orders may still auto-execute when the auto flag is true; Cancel and cleanup
  always work.
- limit enabled, auto disabled: reservation-only phase-1 behavior and UI copy.
- both enabled: path A plus health-gated new limit registration.

### Startup validation

`validateEnv` rejects the combinations that would boot "successfully" and then
reserve user cash against a matcher that cannot possibly fill it:

| Condition | Requirement |
| --- | --- |
| path B enabled | path A enabled (enforced in the path-B parser) |
| path B enabled | Ops scheduler enabled AND the `limit_order_candle_reconciliation` job enabled — verified against the resolved Ops config, not the flag |
| path B enabled | `DATABASE_URL` configured |
| path A enabled | `REDIS_URL` configured |
| path A enabled | `DATABASE_URL` configured (the boundary pool opens its own sessions) |
| shared readiness enabled | path A enabled AND `REDIS_URL` configured |
| shared readiness enabled | TTL greater than twice the publish interval |
| always | `CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD` within 1..1024 |

Every violation is reported at once, not just the first.

### Rollout order

1. apply and verify migrations without resetting data (all additive);
2. provision durable Redis retention and alerting;
3. deploy with every limit-order flag false and verify provider streams,
   calendar readiness and `/health/ready` dependencies;
4. enable `LIMIT_ORDER_SHARED_READINESS_ENABLED` on the socket owner and the
   API instances, and confirm from a NON-owner instance that readiness for a
   known-subscribed asset resolves ready, and that a known-capped asset does
   not;
5. enable `LIMIT_ORDER_AUTO_EXECUTION_ENABLED`; start at least two app
   instances and confirm exactly one running matcher Ops row;
6. verify path-A health: heartbeats, consumer lag, pending count, oldest
   pending age, ACK age, retention headroom, boundary wait;
7. enable `LIMIT_ORDER_ENABLED` for a small set of TEST assets only;
8. observe event lag / pending / boundary wait / Create latency under real
   traffic;
9. enable `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED`;
10. observe the checkpoint watermark advancing, the deferred backlog staying at
    zero, and no gap;
11. widen the asset set gradually.

### Rollback order

1. set `LIMIT_ORDER_ENABLED=false` first — this blocks NEW Quote/Create while
   leaving everything else running;
2. confirm Cancel still works for existing submitted orders;
3. confirm season-end and participant-exclusion cleanup still release
   reservations;
4. set `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=false`, then
   `LIMIT_ORDER_AUTO_EXECUTION_ENABLED=false`;
5. reconcile `CashWallet.reservedAmount` against still-submitted orders and
   confirm no order is left `submitted` with a released reservation or vice
   versa;
6. prefer FLAG rollback over migration rollback. The migrations are additive
   and harmless when the features are off; rolling them back would drop the
   durable checkpoint and deferred queue, which are the only record of what
   path B has and has not examined.

### Monitoring required before enabling

| Signal | Source | Fail-closed code |
| --- | --- | --- |
| matcher leader alive | `OpsJobRun` heartbeat | `LIMIT_ORDER_MATCHER_UNAVAILABLE` |
| consumer lag | heartbeat `consumerLag` | `LIMIT_ORDER_MATCHER_LAG_EXCEEDED` |
| pending backlog / age | heartbeat `pendingCount`, `oldestPendingAgeMs` | `LIMIT_ORDER_MATCHER_PENDING_EXCEEDED` / `_PENDING_STALE` |
| ACK staleness | heartbeat `lastAcknowledgedAt` | `LIMIT_ORDER_MATCHER_ACK_STALE` |
| stream retention headroom | heartbeat `retentionHeadroomRatio` | `LIMIT_ORDER_EVENT_RETENTION_HEADROOM_LOW` |
| processed-event capacity | heartbeat `processedEvents` (approximate) + capacity warning log | none (operational) |
| path-B sweep liveness | checkpoint `lastSuccessfulRunAt` | `LIMIT_ORDER_CANDLE_RECONCILIATION_STALE` |
| path-B deferred backlog | `limit_order_deferred_candles` | `LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED` |
| path-B retention gap | checkpoint `gapDetectedAt` | `LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED` |
| reservation mismatch | checkpoint `reservationMismatchCount` | `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH` |
| shared readiness freshness | provider meta TTL / `lastFrameAt` | `LIMIT_ORDER_PROVIDER_UNAVAILABLE` |
| boundary residual locks | `pg_locks` for (1244660901, 2) | none (alarm) |

### Failure runbook

- **Transient Redis/DB outage:** restore the dependency and let the elected
  leader reclaim pending events. No manual fill.
- **Path-A stream gap:** keep auto execution disabled, keep Cancel/cleanup
  available, preserve the stream and Ops evidence, inspect the missing ID range
  and affected submitted orders, and require an explicit operator decision. Do
  not infer fills from current prices or candles.
- **Path-B retention gap:** `gapDetectedAt` is STICKY and only an operator
  clears it (`UPDATE limit_order_reconciliation_checkpoints SET
  gap_detected_at = NULL, gap_from_open_time = NULL, gap_to_open_time = NULL,
  degraded_reason = NULL WHERE scope = '5m'`), and only after deciding what to
  do about the affected orders. Clearing it without that decision hides a real
  exposure.
- **Residual boundary advisory lock:** identify the holding backend from
  `pg_locks` joined to `pg_stat_activity` and terminate that session;
  PostgreSQL releases session advisory locks when the backend exits. Do NOT
  call `pg_advisory_unlock_all` from an unrelated session — it cannot release
  another session's lock and will silently do nothing.
- **Deferred candle parked as `permanent`:** inspect `lastErrorCode` /
  `lastErrorMessage`, fix the underlying dependency, then reset the row
  (`status = 'deferred'`, `next_retry_at = now()`). The row is never deleted
  automatically.

## Verification

CI runs PostgreSQL 16 and Redis 7 with migrations, migration status,
reservation/race/time-boundary tests, and both integration runners.

`limit-order-auto-execution.integration.spec.ts` proves advisory leader
takeover, XAUTOCLAIM pending recovery, normal execution, price improvement
accounting, above-limit non-fill, evidence sharing, durable event dedupe,
stream-ID ordering under DB/app clock skew (an event stamped BEFORE the order
still fills it), exclusion of events before the activation cursor, protection
of later orders from duplicate events, both transaction-order outcomes for
Cancel/exclusion/season end, Redis outage degradation, and retention-gap
fail-closed behavior.

`limit-order-boundary-concurrency.integration.spec.ts` proves the
session-per-lease boundary: concurrent acquisition on ONE service instance
serializes on a real advisory lock (holder and waiter both read from
`pg_locks`, different backend PIDs), poller vs candle worker never overlap, a
killed worker session releases server-side, `release()` is idempotent, no
residual lock survives, and `lockInTransaction` works through the real Prisma
driver adapter.

`limit-order-candle-checkpoint.integration.spec.ts` proves the path-B durable
scan: bootstrap anchors before the earliest activated order, a candle
unprocessed for LONGER than the lookback is still processed, a restarted
process resumes from the checkpoint, a deferred candle does not block later
candles, a retry never double-fills, a retention gap is detected and is sticky,
and the gap fails new quotes/creates closed.

`provider-trade-readiness.integration.spec.ts` proves cross-instance readiness
with two independent registry/service instances against one real Redis:
instance B sees instance A's readiness, requested/failed/capped/stale are all
rejected, a reconnect invalidates the previous generation immediately, a late
release from a superseded owner cannot delete the new state, Redis failure
fails closed, and no credential or raw frame reaches Redis.

`limit-order-matcher-e2e.integration.spec.ts` proves the whole consumer path
end to end under load with concurrent path-B and Create contention.

`limit-order-phase3.integration.spec.ts` proves the event-boundary mutex in
both interleavings plus dedicated-session crash release (verified through
`pg_locks`, never through sleep), path-B matching end to end, the
first-eligible-candle boundary, path A vs path B, cancel/exclusion/season-end
races, processed-candle idempotence and crashed-sweep re-run, the health gate
thresholds, and a synthetic 50-asset throughput sweep that asserts ZERO
per-event asset database queries.

### Two throughput numbers, never interchangeable

There are TWO measurements and they differ by roughly an order of magnitude.
Quoting one for the other overstates matching capacity by ~20x.

| Measurement | Log event | Covers |
| --- | --- | --- |
| **Publisher / XADD** | `limit_order_publisher_throughput` | normalize + validate + XADD only |
| **End-to-end matcher** | `limit_order_matcher_e2e_throughput` (`"measured":"xadd_to_xack"`) | XADD -> consumer-group read -> validation -> boundary -> dedupe -> candidate query -> execution transaction -> processed-event insert -> XACK |

**Publisher / XADD** (reference developer machine, PostgreSQL 16 + Redis 7,
localhost, 50 assets x 20 events): 1000 events in 298 ms — **3356 events/s**,
XADD latency avg 0.30 ms / p95 1 ms / max 2 ms, 0 asset database queries,
70 MB heap. Standalone run:
`pnpm run soak:limit-order-publisher-throughput`.

**End-to-end matcher**, same machine, mixed no-order / single-order /
multi-order assets, with a path-B sweep and a boundary-waiting Create running
CONCURRENTLY. Standalone run: `pnpm run soak:limit-order-matcher-e2e`.

| Shape | CI smoke (6 assets x 25) | Soak (30 assets x 60) |
| --- | --- | --- |
| total events | 150 | 1800 |
| publish elapsed | 100 ms | 729 ms |
| drain elapsed | 903 ms | 6 203 ms |
| end-to-end events/s | 150 | **260** |
| drain events/s | 166 | 290 |
| latency avg | 375 ms | 3 228 ms |
| latency p50 / p95 / p99 / max | 380 / 560 / 579 / 582 ms | 3 257 / 5 643 / 5 859 / 5 911 ms |
| peak pending | 45 | 42 |
| peak consumer lag | 104 | 1 757 |
| Create boundary wait | 6 ms | **5 ms** |
| PostgreSQL connections | 4 | 4 |
| heap | 60 MB | 99 MB |

Two things are worth reading off that table. First, end-to-end throughput is
~260 events/s against ~3 300 events/s for the publisher — a ~13x gap, which is
exactly why the two numbers must never be quoted for each other. Second, the
Create boundary wait stays at ~5 ms even while the matcher is saturated and
consumer lag is in the thousands: the event boundary is held only for the
duration of one event's durable work, so a user placing an order is not made to
wait behind the backlog.

The end-to-end figure is the one that bounds how fast limit orders can actually
be filled. It is deliberately NOT asserted in CI — a GitHub runner's rate says
nothing about production capacity. CI asserts only hardware-independent
invariants: every event processed and ACKed within the deadline, consumer lag
back to zero, pending back to zero, no duplicate fill, a duplicate eventId not
re-processed, a reclaimed pending entry drained, a new leader draining the
backlog after takeover, no residual advisory lock, and no degraded state.

External KIS or Binance credentials are not used anywhere.

The record screen polls every four seconds only while focused, foregrounded,
and holding a submitted limit order. A terminal transition invalidates order,
record, wallet, position, home, portfolio and ranking queries. There is no
user-specific order WebSocket.

## Known limitations

- limit sells and partial fills are unsupported;
- exchange order-book liquidity and actual trade volume are not allocated;
- Cancel versus execution is decided by the PostgreSQL order-row lock winner;
- events are not retroactively filled after season end, and there is no final
  season drain;
- order-state updates have no user-specific WebSocket and rely on conditional
  foreground polling;
- automatic matching requires a canonical provider connection that has the
  requested asset subscribed and acknowledged; the live-candle supervisor and
  the legacy streaming service can each be that source, but never both for one
  provider, and an unsubscribed asset fails new limit Quote/Create closed
  rather than silently accepting an unmatchable order;
- `limit_order_processed_events` has no retention deletion; long-term capacity
  needs monitoring and eventually partitioning (see above), and this change
  deliberately does NOT convert it to a partitioned table;
- Redis Stream retention/outage can preserve pending entries but cannot
  recreate provider events that were never successfully XADDed, so a detected
  gap requires operator intervention rather than a price/candle estimate; and
- KIS/Binance provide market data only; no real exchange order is submitted.
