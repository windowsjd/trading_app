# Limit-buy path B — confirmed 5-minute candle safety net

Phase 3, path B. All HTTP endpoints remain under `/api/v1`; there is no
`/api/v2` route and no public limit-order execute route. Path A is documented
in [limit-order-live-matching-operations.md](limit-order-live-matching-operations.md).

## Why it exists, and what it is not

Path A fills a limit buy from an exact live trade event. If that event never
reaches the Redis Stream — a provider gap, a publisher restart, a failed XADD —
the price really was touched but the order stays unfilled forever.

Path B is the safety net for exactly that case:

```
canonical closed 5m candle
  -> low <= limitPrice
  -> candle strictly after the order's first eligible window
  -> still-submitted order
  -> full fill AT THE LIMIT PRICE
  -> candle evidence
```

It is **not** a replacement for path A, not a faster path, and not a
better-price path. Priority is always: (1) live trade event, (2) confirmed 5m
candle. Path B cannot be enabled alone — see *Feature flags* below.

## Execution price: always the limit price

```
executedPrice = order.limitPrice
grossAmount   = round(executedPrice x quantity)
feeAmount     = round(grossAmount x Order.reservationFeeRate)
actualDebit   = round(grossAmount + feeAmount)
```

With `limitPrice = 100` and `candle.low = 90`, the fill is at **100**, not 90.

A 5-minute bar records only that the price traded down to 90 somewhere inside
the window. It says nothing about when, for how long, at what size, or whether
a resting order would have been reached. Paying out the low would hand the user
an advantage no real book offers, so the low is used solely as proof that the
limit was touched. There is no price improvement on path B.

Because the reservation was computed from the same limit price with the same
pinned `Order.reservationFeeRate` and the same rounding, the recomputed debit
MUST equal `Order.reservedAmount` exactly. The code recomputes and compares:

- equal — settle;
- different — no extra debit, no correction, no fill. The order stays
  submitted, the reservation stays put, and
  `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH` is raised for operator
  intervention.

The current season's `tradeFeeRate` is never read here; only the order's pinned
`reservationFeeRate` is.

## Which candles qualify

A candle may trigger a fill only when ALL of these hold:

- `interval = '5m'` and `isClosed = true`;
- written by the canonical finalizer into `market_candles`;
- `closeTime - openTime = 5 minutes` and `openTime` is 5-minute aligned;
- `open/high/low/close` all positive, `low <= open/close/high`,
  `high >= open/close`;
- `sourceProvider` present and a known provider prefix (`binance`/`kis`);
- `candle.low > 0` and `candle.low <= order.limitPrice`;
- `candle.openTime >= order.candleMatchingEligibleFrom`;
- `candle.closeTime <= Season.endAt`;
- for stocks, the whole window lies inside a valid market session;
- calendar coverage available — otherwise fail-closed and retry.

`checkCanonicalClosedCandle` deliberately mirrors the finalizer's own
acceptance rules rather than inventing a second notion of "canonical". The
finalizer never persists an incomplete or discontinuous 5m row (it defers those
buckets to REST repair), so a row that is present, closed and structurally
consistent IS the canonical candle. Two of the structural rules
(`market_candles_interval_check`, `market_candles_ohlc_bounds_check`) are
additionally enforced by the database.

Path B never reads live Redis candle state, an open candle, a REST preview, a
chart fallback, a stale cache, or a candle preview. Only committed
`market_candles` rows.

## First eligible candle

The candle that was already running when the order was submitted is NOT usable:
its low may have printed before the order existed, and a 5m bar carries no
information about when inside the window the low happened.

`Order.candleMatchingEligibleFrom` is the submit instant rounded UP to a
5-minute boundary:

| submittedAt | candleMatchingEligibleFrom |
| --- | --- |
| `10:00:00.000` | `10:00` |
| `10:00:00.001` | `10:05` |
| `10:02:30.000` | `10:05` |
| `10:04:59.999` | `10:05` |

Candidate condition: `candle.openTime >= order.candleMatchingEligibleFrom`.
So an order submitted at 10:02 is never filled from the 10:00–10:05 window, and
is eligible from 10:05–10:10 onwards.

A DB CHECK constraint enforces that the stored value is always an exact
5-minute boundary (numeric modulo, not an integer cast, so `10:00:00.001`
cannot round down into acceptance).

### Orders with a NULL boundary

Orders created before path B existed — and orders created while automatic
matching was off — keep `candleMatchingEligibleFrom = NULL` and are **never**
retroactively activated against historical candles. The migration backfills
nothing. Such orders remain path-A only (or reservation-only). Activating them
would require a deliberate, operator-approved migration; there is no automatic
backfill.

## Season boundary

- the execution transaction requires `Season.status = active` and
  `startAt <= clock_timestamp() < endAt`;
- `candle.closeTime <= Season.endAt` — a window that closed after the season
  ended never fills anything;
- season-end cleanup cancels open orders; a cancelled order is skipped;
- there is **no final-match grace period and no final drain**.

Consequence, stated plainly: if a touch happens inside the last, still-running
5-minute candle before a season ends, path B cannot recover it — that candle
closes after `Season.endAt`. Season-end ordering was NOT delayed to
accommodate path B. A final drain is deliberately left as separate future work.

## Worker

Path B is an ordinary Ops scheduler job, not a new polling loop:

- job name `limit_order_candle_reconciliation`;
- runs on the existing 60-second `OpsScheduler` tick;
- serialized by the PostgreSQL `OpsJobLock`
  (`limit_order_candle_reconciliation:5m`);
- bounded batches, re-runnable, idempotent;
- default OFF.

A 5-minute safety net needs no sub-second cadence, and the processed-candle
table — not a timer — is what stops repeated ticks from re-processing windows.

The sweep holds the SAME event-boundary advisory mutex Create and the path-A
poller use, on a dedicated PostgreSQL session, so a create cannot commit
between the candidate query and the fill.

Per-candle failures are isolated: one asset's transient error (a missing
valuation price, a lock timeout) is logged, that candle is placed in the
DURABLE retry queue, and the sweep continues with the other assets.

## Durable scan position

The sweep used to read `now - lookbackMs .. now` on every tick. A candle that
stayed unprocessed longer than the lookback — a provider outage, a repeatedly
failing dependency, a scheduler stopped over a weekend — simply fell out of the
window and was **never examined again**. The safety net silently developed a
hole exactly in the situations it exists for.

The scan is now anchored on a durable **watermark** plus a durable **deferred
queue**.

### `limit_order_reconciliation_checkpoints`

One row per interval scope (`scope = '5m'`). The watermark is a POSITION in the
canonical `(openTime, id)` ordering of closed 5m candles, not a timestamp
cursor. Its invariant:

> every closed 5m candle at or before the watermark either has a
> processed-candle row, or has a deferred-candle row, or provably had no order
> that could ever match it.

"Provably no order" is sound because `candleMatchingEligibleFrom` is rounded UP
to the next 5-minute boundary at Create time: an order can never become
eligible for a window that had already closed when it was submitted. So a
window the sweep stepped over with no eligible order can never acquire one
later.

Columns: `watermarkOpenTime` / `watermarkCandleId`, `lastScannedOpenTime` /
`lastScannedCloseTime`, `lastRunAt`, `lastSuccessfulRunAt`, `degradedReason`,
`gapDetectedAt` / `gapFromOpenTime` / `gapToOpenTime`,
`reservationMismatchCount` / `lastReservationMismatchAt`.

### Watermark advance rules

The position moves forward only over work that became DURABLE. Two bounds
apply and the **smaller wins**:

1. the last candle this run actually made durable — processed row written, or
   deferred row written. Never past a candle whose outcome is unknown.
2. the **safety lag** (`..._WATERMARK_SAFETY_LAG_MS`, default 15 min). The
   finalizer writes a canonical closed row some time AFTER the window ends;
   stepping the position over a window whose row has not landed yet would skip
   it forever. Recent candles are still PROCESSED immediately — only the
   position lags.

When a batch is NOT truncated (`scanned < candleBatchSize`) the run
demonstrably reached the end of the eligible range, so the position may skip
ahead to the newest closed candle within the safety lag, including windows with
no matching order. A truncated batch stops at bound 1.

The update is conditional and monotonic: a concurrent runner that already moved
the position further is never pulled back.

### `limit_order_deferred_candles`

A candle that fails is enqueued here **before** the watermark is allowed to
pass it, so a transient failure delays exactly one candle instead of blocking
every later candle behind it (head-of-line) or losing it once the window slid
past.

Columns: `marketCandleId` (primary key), `assetId`, `interval`, window,
`status` (`deferred` | `permanent`), `firstDeferredAt`, `lastDeferredAt`,
`attemptCount`, `lastErrorCode`, `lastErrorMessage`, `nextRetryAt`.

Retry is bounded exponential backoff from
`..._DEFERRED_RETRY_BASE_DELAY_MS` doubling to `..._DEFERRED_RETRY_MAX_DELAY_MS`,
and after `..._DEFERRED_MAX_ATTEMPTS` the row is parked as `permanent` — still
visible as backlog, no longer consuming retry budget. Rows are never deleted
automatically; a successful retry removes its own row.

`marketCandleId` deliberately has **no foreign key** to `market_candles`: a
deferred candle that retention removes must be detectable as a gap, and an FK
would instead make the retention job fail — a worse operational outcome that
does not make the loss any less real.

### Bootstrap

With no checkpoint row, the anchor is the earliest window any currently
activated path-B order could still need:
`MIN(candle_matching_eligible_from)` over submitted limit buys, minus 1 ms so
that window itself is included. Orders with
`candleMatchingEligibleFrom IS NULL` are excluded — they are pre-path-B rows
and are never retroactively activated against historical candles.

With no such order there is nothing path B could owe anyone, so the position
starts at `now - safetyLag` instead of scanning the entire candle history.

`lookbackMs` is **not** a floor here. Clamping the anchor forward to
`now - lookbackMs` would silently re-create the exact loss this design removes.
A first run whose catch-up exceeds the lookback logs
`limit_order_candle_bootstrap_long_catchup` as an operational warning; per-run
work stays bounded by `candleBatchSize`, so a long catch-up is spread over
ticks instead of being dropped.

### Retention gap

Two independent, exact signals:

1. **The watermark is older than the candle retention horizon**
   (`MARKET_CANDLE_5M_RETENTION_DAYS`, consumed from the retention job's own
   variable so the two cannot drift apart). Past that point retention is
   provably deleting windows the sweep never examined.

   The comparison is against the retention POLICY, not against the oldest
   surviving row. "The oldest retained candle starts after the watermark" is
   also true, entirely harmlessly, whenever candle history simply begins later
   than the watermark — a newly stored asset, a market with no trades in the
   window, a freshly provisioned database — and turning that into a
   fail-closed alarm would block every new limit order on a healthy system.

2. **A deferred candle whose `market_candles` row has disappeared.** The same
   loss seen from the other side.

A gap is **sticky**: `gapDetectedAt` keeps its first detection and the sweep
never clears it. Candles that retention removed before path B examined them
cannot be recovered, so only an operator can decide the exposure is settled.
While it is set, new limit Quote/Create fail closed with
`LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED`; Cancel, season-end and
exclusion cleanup, market orders and FX are untouched.

### What `lookbackMs` is still for

Only three things, none of which may drop an unprocessed candle:

- bounding how much catch-up a first run is about to do (warning only),
- an operational alerting threshold,
- a bootstrap auxiliary value.

It is never a reason to ignore or delete an old unprocessed candle.

## Processed candles

`limit_order_processed_candles` (primary key `market_candle_id`) records that a
candle's sweep completed.

- the row is written ONLY after every candidate batch for that candle
  committed;
- a crash mid-sweep writes nothing, so the candle is re-run on the next tick —
  already-executed orders are skipped by the status guard, so the re-run is
  idempotent and never double-fills;
- a candle with a processed row is never re-examined;
- a permanently invalid candle is recorded as `result='skipped'` with a
  `skipReason` (so it is not re-examined every 60s) and logged as a warning;
- a transient failure (calendar unavailable, missing valuation price, lock
  timeout) writes NO processed row and is instead enqueued in
  `limit_order_deferred_candles` for bounded retry, so it survives a restart
  and can no longer be lost to a moving scan window.

## Evidence

`limit_order_candle_evidences` holds one row per canonical candle, shared by
every order that candle fills:

`marketCandleId` (unique), `assetId`, `interval`, `openTime`, `closeTime`,
`triggerLowPrice`, `executionPricePolicy` (`'limit_price'`), `provider`,
`sourceName`, `sourceUpdatedAt`, `finalizedAt`, `policyVersion`.

Path B creates **no** `AssetPriceSnapshot`. There is no synthetic price row.

Evidence is mutually exclusive per fill, enforced by a DB CHECK constraint:

| | path A | path B |
| --- | --- | --- |
| `matchingSource` | `live_trade_event` | `closed_5m_candle` |
| `triggerEventId` | non-null | null |
| `triggerEventAt` | provider event time | candle `closeTime` |
| `assetPriceSnapshotId` | non-null | null |
| `limitOrderCandleEvidenceId` | null | non-null |
| `executedPrice` | event price | order limit price |

## Path A vs path B, and lifecycle races

All paths take `Participant SHARE -> Season SHARE -> Order UPDATE -> Wallet ->
Position` and finalize with `updateMany(where status='submitted')`. Exactly one
can win:

| Interleaving | Outcome |
| --- | --- |
| path A commits first | fill at the event price; path B skips; no candle evidence |
| path B commits first | fill at the limit price; path A skips; no live evidence |
| cancel commits first | order canceled; both paths skip; balance unchanged; reservation released once |
| a fill commits first | cancel fails `ORDER_NOT_CANCELABLE`; reservation consumed once |
| exclusion cleanup first | order canceled; both paths skip |
| a fill commits first | cleanup leaves the executed order alone |
| season-end cleanup first | order canceled; both paths skip |

No double debit, no double reservation release, no duplicate position increase,
no duplicate `WalletTransaction`, and never both evidence links.

## Feature flags

| `LIMIT_ORDER_AUTO_EXECUTION_ENABLED` | `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED` | Behaviour |
| --- | --- | --- |
| false | false | reservation only |
| true | false | path A only |
| true | true | path A + path B |
| false | true | **startup error** |

Path B alone is refused at startup rather than silently downgraded: it would
mean every fill happens minutes late at the limit price even when exact trade
evidence was available.

Environment (all strictly validated; defaults shown):

```
LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=false
# Catch-up / warning bound ONLY — never a correctness bound.
LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS=3600000
LIMIT_ORDER_CANDLE_RECONCILIATION_CANDLE_BATCH_SIZE=200
LIMIT_ORDER_CANDLE_RECONCILIATION_ORDER_BATCH_SIZE=100
LIMIT_ORDER_CANDLE_RECONCILIATION_WATERMARK_SAFETY_LAG_MS=900000
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BATCH_SIZE=50
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BASE_DELAY_MS=60000
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_MAX_DELAY_MS=1800000
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_MAX_ATTEMPTS=50
LIMIT_ORDER_CANDLE_RECONCILIATION_HEALTH_MAX_AGE_MS=300000
LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG=50
LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_AGE_MS=3600000
LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_RESERVATION_MISMATCH=1
```

Startup additionally verifies that path B has a RUNNER: the Ops scheduler must
be enabled and the `limit_order_candle_reconciliation` job must be enabled,
checked against the resolved Ops config rather than the flag. An
enabled-but-unscheduled safety net is the worst of both states — its own health
gate would report a stale sweep and block every new limit order while nothing
was wrong with the market.

## Health gate (new Quote/Create only)

Path-B state gates NEW limit quotes and creates with codes distinct from the
path-A matcher gate, so an operator can tell "live fills stopped" from "the
safety net under live fills stopped" without reading logs.

| Code | Condition |
| --- | --- |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_UNAVAILABLE` | no checkpoint established, no completed run yet, or a non-gap degraded reason |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_STALE` | `lastSuccessfulRunAt` older than `..._HEALTH_MAX_AGE_MS` |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED` | deferred backlog over `..._MAX_DEFERRED_BACKLOG`, any `permanent` row, or oldest deferral older than `..._MAX_DEFERRED_AGE_MS` |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED` | `gapDetectedAt` set |
| `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH` | `reservationMismatchCount` over `..._MAX_RESERVATION_MISMATCH` |

All are HTTP 503 in the standard `{ success: false, error: { code, message } }`
envelope.

**Never blocked by this gate:** a deployment with path B disabled (the gate is
inert), a quiet market, a sweep with no candle to process, market orders, FX,
Cancel, and season-end / participant-exclusion cleanup.

`lastSuccessfulRunAt` is written on every completed sweep including one that
found nothing to do, so a quiet market never trips the staleness check — only a
scheduler that stopped ticking does.

## Monitoring

- `OpsJobRun(limit_order_candle_reconciliation)` per tick, with
  `scannedCandles / processedCandles / skippedCandles / matchedOrders /
  deferredCandles / retriedCandles / recoveredCandles / permanentCandles`, the
  swept window, the current `watermarkOpenTime` / `watermarkCandleId`, and
  `gapDetected` / `degradedReason`;
- **watermark progress** is the primary liveness signal: a watermark that stops
  advancing while candles keep closing means the sweep is stuck, even if the
  job keeps reporting success;
- **deferred backlog size and oldest deferral age** from
  `limit_order_deferred_candles`; any row with `status='permanent'` needs an
  operator;
- alert on a sustained non-zero `deferredCandles` (a transient failure that is
  not clearing);
- `limit_order_candle_rejected` warnings identify permanently invalid canonical
  rows — a candle-pipeline problem, not an order problem;
- `limit_order_candle_calendar_unavailable` means a missing calendar dataset
  year; add the dataset, and the candle is retried;
- a rising path-B fill rate relative to path A means live trade events are
  being lost — investigate the provider connection, publisher and Redis before
  treating path B as normal.

### Runbook

| Symptom | Action |
| --- | --- |
| `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH` | Do NOT fill manually. The order keeps its reservation. Compare `limitPrice x quantity`, `reservationFeeRate` and `reservedAmount`; the order was created with an inconsistent basis. Cancel it (releasing the reservation) and have the user re-quote. |
| Many `deferredCandles` on one asset | Check the asset's market price snapshot and USD/KRW FX freshness — the equity snapshot each fill records needs both. Path B writes no price row of its own. |
| Path B filling orders that path A should have caught | Check provider connection generation churn, subscription acks, publisher activity and Redis Stream health. Path B is a safety net, not the intended path. |
| Job stuck `LOCKED` | Another instance holds `limit_order_candle_reconciliation:5m`. Verify the other instance is alive; the lock has a TTL and is renewed while the job runs. |
| Need to disable urgently | Set `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=false` and restart. Path A keeps running; existing orders keep their `candleMatchingEligibleFrom`, and the checkpoint keeps its position, so re-enabling resumes exactly where it stopped without a backfill. |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED` | Candles were retention-deleted before the sweep examined them. Identify the affected window from `gap_from_open_time` / `gap_to_open_time` and the still-submitted orders whose `candle_matching_eligible_from` falls inside it, decide explicitly what to do about them, and only THEN clear the alarm: `UPDATE limit_order_reconciliation_checkpoints SET gap_detected_at = NULL, gap_from_open_time = NULL, gap_to_open_time = NULL, degraded_reason = NULL WHERE scope = '5m';`. Clearing it first hides a real exposure. |
| Deferred candle parked as `permanent` | Inspect `last_error_code` / `last_error_message`, fix the dependency, then `UPDATE limit_order_deferred_candles SET status = 'deferred', next_retry_at = now() WHERE market_candle_id = '...';`. Never delete the row to make the alarm go away. |
| Watermark not advancing | Check the deferred queue first (a full retry batch every tick starves nothing, but a large backlog is the usual cause), then whether closed 5m rows are actually being written for the active assets. |

## Verification

- `limit-order-candle-matching.spec.ts` — eligibility boundary arithmetic,
  canonical-candle checks, limit-price amounts, reservation-mismatch refusal,
  flag combinations, advisory-key identity.
- `limit-order-phase3.integration.spec.ts` — full path-B flow against
  PostgreSQL + Redis, first-eligible-candle boundary, NULL-eligibility orders,
  season-end exclusion, processed-candle idempotence, crashed-sweep re-run,
  and every race above.
- `limit-order-candle-checkpoint.integration.spec.ts`
  (`LIMIT_ORDER_CANDLE_CHECKPOINT_INTEGRATION=1`, DISPOSABLE database) — the
  durable scan: bootstrap anchoring, a candle unprocessed for LONGER than the
  lookback still being processed, checkpoint resume across a restart, a
  deferred candle not blocking later candles, a retry never double-filling,
  retention-gap detection and stickiness, and the gap failing new
  quotes/creates closed.
- `limit-order-candle-reconciliation-health.spec.ts` — every gate code, the
  quiet-market and disabled-deployment non-blocking cases, and the 503
  envelope.
- `pnpm run smoke:limit-order-candle-fixture` — path-B eligibility against rows
  written through the canonical `MarketCandlesRepository` upsert path, with no
  provider credentials.

## Known limitations

- limit sells and partial fills are unsupported;
- order-book liquidity and actual traded volume are not modelled;
- no price improvement from the candle low — by design;
- the partially elapsed candle an order was submitted into cannot be used, so a
  touch inside it is not recoverable;
- a touch inside the last running candle before season end is not recoverable;
  there is no final drain;
- path B recovers nothing if the 5-minute candle itself was never produced;
- a retention gap cannot be repaired, only detected: the alarm is sticky and
  requires an explicit operator decision about the affected orders;
- path B does not reconstruct intra-candle ordering, so simultaneous touches
  across many orders all fill at their own limit prices;
- no user-specific order WebSocket; the client polls conditionally.
