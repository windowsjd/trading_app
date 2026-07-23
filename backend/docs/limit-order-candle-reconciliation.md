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

### Storage order, not market order

The durable position that replaced the lookback was itself a position in the
canonical `(openTime, id)` ordering — MARKET time. Rows, however, appear in
STORAGE time, and one global market-time position shared by every asset left a
second hole, of exactly the same shape:

> asset A's 10:00–10:05 window is written late (a provider gap, a finalizer
> restart, a REST backfill landing minutes or hours afterwards). Meanwhile
> asset B's 10:05–10:10 window is written on time, and the sweep advances the
> single global watermark past 10:05. A's row finally lands with an openTime of
> 10:00, which is now BEFORE the watermark, so the scan — which reads strictly
> after it — never returns that row again.

`..._WATERMARK_SAFETY_LAG_MS` could only shrink that window, never close it: it
bounds how long the sweep waits, not how late a row may be stored.

The forward scan therefore walks **`market_candles.ingest_seq`**, a monotonic
value assigned by the `market_candles_ingest_seq` database trigger:

- on INSERT, always;
- on UPDATE, when the row changed in a way that can change a matching decision
  — it becomes closed, or its `low`, window or asset moves. An unrelated update
  (a `source_updated_at` refresh) does NOT renumber it, so already-processed
  rows are not dragged back in front of the scan forever.

That second rule is what covers the common case of a row INSERTed while its
window is still open and only UPDATEd to closed five minutes later: sequencing
on insert alone would leave it below a position that had since moved on.

It is a database trigger rather than application code because `market_candles`
has several writers — the live finalizer, REST backfills, aggregation and
operational scripts — through a raw bulk `INSERT .. ON CONFLICT DO UPDATE`. A
writer that forgot to maintain the column would silently reintroduce the miss,
and there is no single place in the application where it could be enforced for
all of them.

### `limit_order_reconciliation_checkpoints`

One row per interval scope (`scope = '5m'`), carrying TWO positions with two
different jobs.

**1. The storage-order position** (`watermarkIngestSeq`) — what the forward
scan actually reads from. Its invariant:

> every closed 5m candle whose ingest sequence is at or before the watermark
> either has a processed-candle row, or has a deferred-candle row, or provably
> had no order that could ever match it.

"Provably no order" is sound because `candleMatchingEligibleFrom` is rounded UP
to the next 5-minute boundary at Create time: an order can never become
eligible for a window that had already closed when it was submitted. So a
window the sweep stepped over with no eligible order can never acquire one
later.

**2. The market-time marker** (`watermarkOpenTime` / `watermarkCandleId`) — no
longer a scan gate. It remains the bootstrap anchor and the retention-gap
marker: "how far back in MARKET time is the sweep still responsible for" is the
question retention answers against, and a storage position cannot answer it.

Columns: `watermarkIngestSeq`, `pendingIngestSeq` /
`pendingIngestSeqObservedAt`, `lastScannedIngestSeq`, `watermarkOpenTime` /
`watermarkCandleId`, `lastScannedOpenTime` / `lastScannedCloseTime`,
`lastRunAt`, `lastSuccessfulRunAt`, `degradedReason`, `gapDetectedAt` /
`gapFromOpenTime` / `gapToOpenTime`, `reservationMismatchCount` /
`lastReservationMismatchAt`.

### Storage-position advance rules (two-phase)

A sequence value is assigned when a row is **INSERTed** but only becomes
visible when its transaction **COMMITs**, so the highest value a run can see
may still have uncommitted holes below it. Advancing straight onto it would
step over whatever fills those holes a moment later — the same failure, moved
from market time into storage time.

So the ceiling is never this run's own observation. A run records the highest
value it observed (`pendingIngestSeq`, with the DATABASE clock in
`pendingIngestSeqObservedAt`), and a LATER run may use that as a ceiling only
once BOTH hold:

1. at least `..._INGEST_SETTLE_GRACE_MS` of database time has passed since the
   observation, and
2. no write transaction that was already open at that observation is still
   running. This is checked EXACTLY, via `pg_stat_activity.xact_start`,
   whenever the database role can see it — which it can when the application
   uses one role, the normal case. When it cannot, rule 1 is the bound.

Every transaction in flight at the observation has then resolved, and this
run's scan — which read strictly above the OLD watermark — has already returned
whatever they committed.

Within that ceiling the position advances to:

- the last row actually handled, when the batch was truncated
  (`scanned >= candleBatchSize`) — rows beyond it were never examined;
- the ceiling itself otherwise, which correctly steps over rows the scan
  filtered out because no order could ever match them.

The position therefore lags roughly one run plus the settle grace. That costs
nothing: a lagging position only means rows are re-scanned, and the
processed-candle rows filter them straight back out. The summary reports
`ingestCeilingHeld: true` on any run the guard held back.

The update is conditional and monotonic: a concurrent runner that already moved
the position further is never pulled back.

### Market-time marker advance rules

Unchanged, and now only feeding the retention-gap check. Two bounds apply and
the **smaller wins**:

1. the furthest window (in market order) this run actually made durable —
   processed row written, or deferred row written;
2. the **safety lag** (`..._WATERMARK_SAFETY_LAG_MS`, default 15 min).

When a batch is NOT truncated the run demonstrably reached the end of the
eligible range, so the marker may skip ahead to the newest closed candle within
the safety lag. A truncated batch stops at bound 1. Monotonic, as before.

### Adopting the position on an existing deployment

A checkpoint row written before these columns existed carries NULL. It is
adopted at **0** — deliberately the most conservative value, so the first runs
re-examine the whole sequence and RECOVER any candle the old market-time
watermark had already stepped over. Already-processed rows are excluded by the
scan's own filters, so the catch-up costs an index walk rather than duplicate
work, and each run stays bounded by `candleBatchSize`. A run that finds nothing
to do jumps straight to the ceiling. The adoption is logged once as
`limit_order_candle_ingest_watermark_adopted` and can never pull a live
position backwards.

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

### Window completion: rows that never existed

`ingest_seq` can only order candle rows that EXIST. A window whose row was
never written is invisible to every row scan, and four very different causes
look identical from the database: the finalizer never processed the window, a
feed/continuity gap swallowed it, the DB write failed permanently, or there
were genuinely no trades. The WINDOW COMPLETION protocol
(`market_candle_finalization_checkpoints`, one row per asset with activated
path-B orders) tells them apart, durably:

For each such asset a cursor (`finalizedThroughCloseTime`) advances over the
asset's 5m windows in market-time order — bounded per sweep by
`LIMIT_ORDER_CANDLE_COMPLETION_WINDOW_BATCH_SIZE`, only over windows already
older than the safety lag — and may pass a window ONLY when it is accounted
for:

| verdict | evidence |
| --- | --- |
| `finalized` | a canonical closed row exists (the ingest-seq scan fills from it independently; a repair that restored the row counts `repairedWindowCount`) |
| `no_trade` | the provider cursor CONFIRMED coverage of the window's range and returned no candle (`coverageComplete` over `[open, close)`). "No trades" is provider evidence, **never** an inference from our own silence |
| `outside_session` | stock-market window outside the calendar session (calendar unavailable ⇒ no advance at all) |
| bootstrap | windows before the asset's earliest activated order are vacuously complete — eligibility is rounded UP at create time |

Everything else — feed gap, finalizer failure, failed write, unreachable
provider, exhausted repair budget
(`LIMIT_ORDER_CANDLE_COMPLETION_REPAIR_BUDGET_PER_SWEEP`) — leaves the FIRST
unaccounted window recorded as `pendingWindowOpenTime`/`pendingSince` with
bounded REST-repair retries on later sweeps. A pending window is never
recorded as no-trade, and a no-trade window is never left pending.

One asset's stall gates ONLY that asset (see the asset-scoped gate below);
every other asset's cursor, scans and fills keep moving. Crypto windows are
24/7; for KRX/US only calendar-session windows are owed a candle.

The ingest-seq row scan is deliberately NOT bounded by this cursor: a path-B
fill is evidence-based (a canonical closed row proving the low touched the
limit) and always pays the LIMIT price, so processing an existing later row
while an earlier sibling window is still pending changes no financial
outcome. What the cursor adds is the one thing a row scan structurally cannot
do — CONCLUDE something about absence.

### Asset-scoped health gate

`assertAvailable(now, assetId)` runs the global checks plus, for the ordered
asset:

| code | trigger |
| --- | --- |
| `LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED` | retention passed the asset's unresolved window (sticky, operator-cleared on the asset checkpoint) |
| `LIMIT_ORDER_CANDLE_FINALIZER_STALE` | the asset's first unaccounted window pending longer than `LIMIT_ORDER_CANDLE_ASSET_FINALIZER_STALE_MS` |
| `LIMIT_ORDER_CANDLE_ASSET_BACKLOG_EXCEEDED` | more than `LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG` open deferred candles on the asset |

An asset with NO checkpoint passes: checkpoints exist only for assets with
activated orders, and a first order on a fresh asset owes nothing to windows
that closed before its creation. Global failures (scheduler stopped, DB
unavailable, global gap) still gate every asset; asset failures gate only the
named asset. Cancel, cleanup, market orders and FX are never gated by either.

### Candle revision (corrections)

The ingest-seq trigger re-sequences a candle whenever a correction changes
what the window could fill (`is_closed`, `low`, window, asset). Processing is
revision-aware end to end:

- `limit_order_processed_candles.candle_ingest_seq` records WHICH revision the
  row covers; a candle whose current `ingest_seq` is higher reappears in the
  scan and is re-examined. `revision_count` and `first_processed_at` keep the
  audit trail; the reprocess is logged as
  `limit_order_candle_revision_reprocessed`.
- The re-run is ADDITIVE-ONLY: the status guard on orders means an order
  executed under revision 1 can never fill twice; only still-submitted orders
  the correction newly qualifies are filled (at THEIR limit price, as always).
- `limit_order_candle_evidences` is revision-scoped
  (`UNIQUE (market_candle_id, candle_ingest_seq)`) and IMMUTABLE per revision:
  a correction produces a NEW evidence row carrying the corrected low, and the
  evidence an earlier fill points at keeps its original values verbatim. Two
  revisions never share or overwrite evidence.
- An unrelated update (`source_updated_at` refresh) does not re-sequence and
  therefore does not reprocess.

### Retention gap

Three independent, exact signals:

1. **The market-time marker is older than the candle retention horizon**
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

3. **A candle the STORAGE-order position has not reached, whose window is
   already older than the retention horizon and that an activated order could
   still match.** Signal 1 structurally cannot see this one: the market-time
   marker moves with the newest windows the sweep touched, so a single very old
   window stored late sits far behind it while the marker itself looks
   perfectly current.

   The eligible-order condition is exactly the scan's own, which is what keeps
   this exact rather than noisy — an old window no order could ever match is
   not an exposure, and alarming on it would fail every new limit order on a
   healthy system. Reported as `candle_retention_passed_unscanned_candle`.

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
# Two-phase guard on the storage-order position. See "Storage-position advance
# rules" above; an in-flight write transaction older than the observation holds
# the position back exactly, whenever the role can read pg_stat_activity.
LIMIT_ORDER_CANDLE_RECONCILIATION_INGEST_SETTLE_GRACE_MS=60000
LIMIT_ORDER_CANDLE_COMPLETION_WINDOW_BATCH_SIZE=24
LIMIT_ORDER_CANDLE_COMPLETION_REPAIR_BUDGET_PER_SWEEP=5
LIMIT_ORDER_CANDLE_ASSET_FINALIZER_STALE_MS=1800000
LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG=10
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BATCH_SIZE=50
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_BASE_DELAY_MS=60000
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_RETRY_MAX_DELAY_MS=1800000
LIMIT_ORDER_CANDLE_RECONCILIATION_DEFERRED_MAX_ATTEMPTS=50
LIMIT_ORDER_CANDLE_RECONCILIATION_HEALTH_MAX_AGE_MS=300000
LIMIT_ORDER_CANDLE_COMPLETION_HEALTH_MAX_AGE_MS=300000
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
| `LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE` | completion never succeeded, or the latest pass failed/incompletely recorded after an earlier success |
| `LIMIT_ORDER_CANDLE_COMPLETION_STALE` | last successful completion older than `..._COMPLETION_HEALTH_MAX_AGE_MS` |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_BACKLOG_EXCEEDED` | emergency total deferred+permanent queue over `..._MAX_DEFERRED_BACKLOG`; this is the only normal backlog condition that blocks every asset |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED` | `gapDetectedAt` set |
| `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH` | `reservationMismatchCount` over `..._MAX_RESERVATION_MISMATCH` |
| `LIMIT_ORDER_CANDLE_ASSET_GAP_DETECTED` | requested asset's completion checkpoint has a retention gap |
| `LIMIT_ORDER_CANDLE_FINALIZER_STALE` | requested asset's first pending window is older than `..._ASSET_FINALIZER_STALE_MS` |
| `LIMIT_ORDER_CANDLE_ASSET_BACKLOG_EXCEEDED` | requested asset's deferred count or oldest deferred age exceeds its limit |
| `LIMIT_ORDER_CANDLE_ASSET_PERMANENT_FAILURE` | requested asset has at least one permanent deferred row |

All are HTTP 503 in the standard `{ success: false, error: { code, message } }`
envelope.

**Never blocked by this gate:** a deployment with path B disabled (the gate is
inert), a quiet market, a sweep with no candle to process, market orders, FX,
Cancel, and season-end / participant-exclusion cleanup.

`lastSuccessfulRunAt` is the row-scan heartbeat and is written on every
completed sweep including one that found nothing to do. Window completion has
separate run/success/error/failure-count fields. A failed latest completion is
unavailable immediately; an older success does not buy an additional grace
period. One healthy pass updates its success timestamp and clears the error and
failure count. Thus a quiet market remains healthy, while either scheduler
stage stopping or failing is visible.

An asset with no submitted path-B order may have no completion checkpoint and
still pass. Create inserts the first checkpoint in the same transaction as the
order, anchored immediately before `candleMatchingEligibleFrom`; rollback
removes both, and the `(asset_id, interval)` unique key makes concurrent
creates safe. A submitted path-B order with no checkpoint is unavailable.

## Deferred revision lifecycle and migration

`MarketCandle.ingestSeq` is the candle revision identity.
`limit_order_deferred_candles.candle_ingest_seq` records the exact revision the
queue entry covers. The forward scan excludes a row only when the stored queue
revision is greater than or equal to the current candle revision. Equal
revision failure increments attempts while preserving `firstDeferredAt`; a
higher revision atomically replaces asset/interval/window/error metadata,
resets attempts and age, and reactivates `permanent` to `deferred`; a lower
late callback is a strict no-op. Retry reloads the candle and fails closed if
its current revision regressed. Evidence remains immutable per
`(marketCandleId, candleIngestSeq)`, while the processed row advances to the
latest revision.

Migration
`20260723230000_add_limit_order_deferred_candle_revision_and_completion_health`
is additive. It adds the nullable revision and separate completion-health
columns plus revision/asset query indexes. Existing queue rows whose candle
still exists are deterministically backfilled from its current `ingest_seq`.
An orphan row stays nullable and in its existing state because its enqueue-time
revision cannot be reconstructed; `NULL` is treated as unknown/lowest, so any
future concrete revision replaces it. The candle-evidence composite unique
index keeps the already-deployed truncated PostgreSQL name through Prisma
`map: "limit_order_candle_evidences_market_candle_id_candle_inges_key"`;
this prevents a duplicate/rename drift.

Roll out by deploying migrations first, verifying migrate status/diff, then
deploying the binary with flags still false. Keep `LIMIT_ORDER_ENABLED=false`
while starting path A/shared readiness and path B; after both path-B
heartbeats have succeeded and per-asset checkpoints/backlogs are healthy,
enable new limit Quote/Create traffic.
Rollback is flag/application rollback only: do not edit or reverse applied
migrations, and do not delete queue/checkpoint rows.

## Monitoring

- `OpsJobRun(limit_order_candle_reconciliation)` per tick, with
  `scannedCandles / processedCandles / skippedCandles / matchedOrders /
  deferredCandles / retriedCandles / recoveredCandles / permanentCandles`, the
  swept window, the current `watermarkOpenTime` / `watermarkCandleId`, and
  `gapDetected` / `degradedReason`;
- **row-scan and completion success heartbeats** are independent. Alert on a
  failed latest completion immediately and on either success age threshold;
- **watermark progress** remains a row-scan progress signal: a watermark that
  stops advancing while candles keep closing means the sweep is stuck;
- **deferred backlog count and oldest age by asset** contain ordinary faults
  to that asset. Alert globally only when the emergency total threshold is
  crossed. Any `permanent` row still needs an operator, but does not by itself
  stop healthy sibling assets;
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
| `LIMIT_ORDER_CANDLE_COMPLETION_UNAVAILABLE` | Inspect `last_window_completion_run_at`, `last_window_completion_successful_at`, `window_completion_error_*`, and consecutive failures. Fix the completion dependency and wait for one successful pass; do not copy the row-scan heartbeat into the completion fields. |
| Asset completion checkpoint missing | If no submitted path-B order exists, no action is required. If one exists, stop new orders for that asset, reconstruct/ensure the checkpoint only after checking `candle_matching_eligible_from`, and investigate why the create transaction/bootstrap row was removed. |
| Many `deferredCandles` on one asset | Check the asset's market price snapshot and USD/KRW FX freshness — the equity snapshot each fill records needs both. Path B writes no price row of its own. |
| Path B filling orders that path A should have caught | Check provider connection generation churn, subscription acks, publisher activity and Redis Stream health. Path B is a safety net, not the intended path. |
| Job stuck `LOCKED` | Another instance holds `limit_order_candle_reconciliation:5m`. Verify the other instance is alive; the lock has a TTL and is renewed while the job runs. |
| Need to disable urgently | Set `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=false` and restart. Path A keeps running; existing orders keep their `candleMatchingEligibleFrom`, and the checkpoint keeps its position, so re-enabling resumes exactly where it stopped without a backfill. |
| `LIMIT_ORDER_CANDLE_RECONCILIATION_GAP_DETECTED` | Candles were retention-deleted before the sweep examined them. Identify the affected window from `gap_from_open_time` / `gap_to_open_time` and the still-submitted orders whose `candle_matching_eligible_from` falls inside it, decide explicitly what to do about them, and only THEN clear the alarm: `UPDATE limit_order_reconciliation_checkpoints SET gap_detected_at = NULL, gap_from_open_time = NULL, gap_to_open_time = NULL, degraded_reason = NULL WHERE scope = '5m';`. Clearing it first hides a real exposure. |
| Deferred candle parked as `permanent` | Inspect its asset, `candle_ingest_seq`, and error. A genuine candle correction receives a higher `ingest_seq` and reactivates it automatically. If no correction is possible, make an explicit exposure decision before manually rescheduling; never delete the row merely to clear health. |
| Market-time marker not advancing | Check the deferred queue first (a full retry batch every tick starves nothing, but a large backlog is the usual cause), then whether closed 5m rows are actually being written for the active assets. |
| `watermarkIngestSeq` not advancing while `observedIngestSeq` climbs | The two-phase guard is holding the position back — the summary reports `ingestCeilingHeld: true`. Look for a long-running WRITE transaction touching `market_candles`: `SELECT pid, xact_start, state, query FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY xact_start;`. This is the guard working, not a fault; nothing is lost while it holds, only re-scanned. |
| `candle_retention_passed_unscanned_candle` | A window older than the retention horizon is still unscanned and an activated order could match it. Identify it from `gap_from_open_time`, then follow the same operator procedure as any other gap below. |
| `market_candles.ingest_seq` NULL on a row | The `market_candles_ingest_seq` trigger is missing — check the migration applied and the trigger exists (`\dS+ market_candles`). The sweep skips NULL rows, so this is a silent coverage hole until fixed. |

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
  quotes/creates closed. It additionally covers the storage-order position: a
  candle STORED after the market-time marker passed its window still being
  processed, a row that only becomes closed later being re-sequenced and swept,
  an unrelated update NOT renumbering a row, the two-phase guard refusing to
  advance onto its own observation and advancing once it settles, and the
  unscanned-candle retention gap. It also covers deferred/permanent revision
  replacement, lower-revision no-op, completion failure/recovery, missing
  asset checkpoint, asset isolation, and emergency global backlog. Elapsed
  time is simulated by ageing stored observations rather than by sleeping.
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
