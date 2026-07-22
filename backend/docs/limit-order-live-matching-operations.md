# Limit-buy live-trade matching operations

This document covers phase 2 path A. All HTTP endpoints remain under
`/api/v1`; there is no `/api/v2` route and no public limit-order execute route.

## Scope and execution policy

The only automatic execution path is:

`normalized KIS/Binance trade tick -> Redis Stream -> dedicated Poller -> PostgreSQL transaction`

It is not a latest-price database poll, REST quote poll, candle-low match, or
candle reconciliation. Path B is not implemented. A valid live trade whose
price is at or below a submitted limit-buy price fills the whole simulated
order at the event price. Price improvement is allowed. Exchange order-book
liquidity and provider volume are not allocated; one event may fully fill all
eligible orders. KIS and Binance supply market data only—no provider order API
is called.

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

## Event source and schema

No extra provider connection is opened. KIS publishes after its validated
trade has resolved to an asset in `KisWebSocketStreamingService`. Binance adds
the exact `@trade` subscription beside the existing `@ticker` subscriptions on
the same WebSocket and publishes after asset resolution in
`BinanceWebSocketStreamingService`. Each provider serializes its trade work in
frame-arrival order, and the common Publisher serializes asset validation plus
XADD, so asynchronous DB responses cannot reverse two events before Redis.
Bid, ask, book, candle, REST-current-price, admin and batch values never enter
this stream.

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
leader instance, last Redis read/success/ACK, pending count, lag, first/last
stream IDs and degraded reason. When auto execution is on, new limit Quote and
Create require a fresh running DB heartbeat, an active normalized-event
Publisher subscription, and a connected KIS/Binance stream for the requested
asset type. Redis activation-cursor failure also blocks Create. Existing order
reads and Cancel, participant/season cleanup, market orders, and FX do not use
this gate.

Relevant errors include `LIMIT_ORDER_MATCHER_UNAVAILABLE`,
`LIMIT_ORDER_EVENT_STREAM_UNAVAILABLE`, `LIMIT_ORDER_EVENT_INVALID`,
`LIMIT_ORDER_EVENT_GAP_DETECTED`, `LIMIT_ORDER_EXECUTION_CONFLICT`,
`LIMIT_ORDER_EXECUTION_RESERVATION_INSUFFICIENT`,
`LIMIT_ORDER_EXECUTION_WALLET_INCONSISTENT`, and
`LIMIT_ORDER_EXECUTION_PATH_NOT_SUPPORTED`.

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
reservation/race/time-boundary tests, and
`limit-order-auto-execution.integration.spec.ts`. The latter proves advisory
leader takeover, XAUTOCLAIM pending recovery, normal execution, price
improvement accounting, above-limit non-fill, evidence sharing, durable event
dedupe, pre-submission event exclusion, protection of later orders from
duplicate events, both transaction-order outcomes for Cancel/exclusion/season
end, Redis outage degradation, and retention-gap fail-closed behavior.
External KIS or Binance credentials are not used.

The record screen polls every four seconds only while focused, foregrounded,
and holding a submitted limit order. A terminal transition invalidates order,
record, wallet, position, home, portfolio and ranking queries. There is no
user-specific order WebSocket.

## Known limitations

- limit sells and partial fills are unsupported;
- exchange order-book liquidity and actual trade volume are not allocated;
- path B candle matching and historical missed-touch reconstruction are not
  implemented;
- Cancel versus execution is decided by the PostgreSQL order-row lock winner;
- events are not retroactively filled after season end, and there is no final
  season drain;
- order-state updates have no user-specific WebSocket and rely on conditional
  foreground polling;
- automatic matching currently depends on the existing KIS/Binance price
  streaming services; configurations that disable those services in favor of
  a separate live-candle connection fail new limit Quote/Create closed rather
  than silently accepting unmatchable orders;
- Redis Stream retention/outage can preserve pending entries but cannot
  recreate provider events that were never successfully XADDed, so a detected
  gap requires operator intervention rather than a price/candle estimate; and
- KIS/Binance provide market data only; no real exchange order is submitted.
