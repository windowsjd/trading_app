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

Instead the growth is measured and reported on the matcher heartbeat every
60 seconds: row count, oldest/newest `processedAt`, last-hour and last-day
insert counts, table size and index size. A BRIN index on `processed_at` keeps
those aggregates cheap on an append-only, time-correlated table.

Capacity planning: one row is roughly 120–200 bytes including index overhead.
At a sustained 100 events/s that is ~8.6M rows/day (~1–2 GB/day), so operators
should alert on `lastDayCount` and `tableBytes` and plan a `processed_at`
range partition before enabling high-rate assets. Partitioning (dropping whole
old partitions only once an equivalent bound on order lifetime and provider id
reuse exists) is the intended future step; ad-hoc TTL deletion is not.

## Flags and rollout

Both booleans accept only trimmed, case-insensitive `true/false/1/0`; all other
values fail startup. Defaults are false.

- `LIMIT_ORDER_ENABLED=false`: no new limit Quote/Create. Existing submitted
  orders may still auto-execute when the auto flag is true; Cancel and cleanup
  always work.
- limit enabled, auto disabled: reservation-only phase-1 behavior and UI copy.
- both enabled: path A plus health-gated new limit registration.

Before production enablement:

1. apply and verify migrations without resetting data;
2. provision durable Redis retention and alerting;
3. deploy with auto=false and verify provider streams, calendar readiness and
   `/health/ready` dependencies;
4. start at least two app instances and confirm one running matcher Ops row;
5. set auto=true, verify heartbeats/pending/lag/stream IDs, then enable new
   limit registration if it was disabled;
6. monitor DLQ, gap errors, wallet-invariant errors, provider reconnects and
   ranking refresh failures.

For a transient Redis/DB outage, restore the dependency and let the elected
leader reclaim pending events. For a gap, keep auto execution disabled, keep
Cancel/cleanup available, preserve the stream and Ops evidence, inspect the
missing ID range and affected submitted orders, and require an explicit
operator decision. Do not infer fills from current prices or candles.

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

`limit-order-phase3.integration.spec.ts` proves the event-boundary mutex in
both interleavings plus dedicated-session crash release (verified through
`pg_locks`, never through sleep), path-B matching end to end, the
first-eligible-candle boundary, path A vs path B, cancel/exclusion/season-end
races, processed-candle idempotence and crashed-sweep re-run, the health gate
thresholds, and a synthetic 50-asset throughput sweep that asserts ZERO
per-event asset database queries.

Measured on the reference developer machine (PostgreSQL 16 + Redis 7,
localhost, 50 assets x 20 events): 1000 events in 298ms — 3356 events/s,
XADD latency avg 0.30ms / p95 1ms / max 2ms, 0 asset database queries,
70 MB heap. CI runs the same sweep as a reduced smoke; `pnpm run
soak:limit-order-throughput` runs it standalone.

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
  needs monitoring and eventually partitioning (see above);
- Redis Stream retention/outage can preserve pending entries but cannot
  recreate provider events that were never successfully XADDed, so a detected
  gap requires operator intervention rather than a price/candle estimate; and
- KIS/Binance provide market data only; no real exchange order is submitted.
