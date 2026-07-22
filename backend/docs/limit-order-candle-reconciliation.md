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
valuation price, a lock timeout) is logged, that candle is left unprocessed for
the next tick, and the sweep continues with the other assets.

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
- a transient failure (calendar unavailable, inactive asset) writes NO row and
  retries.

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
LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS=3600000
LIMIT_ORDER_CANDLE_RECONCILIATION_CANDLE_BATCH_SIZE=200
LIMIT_ORDER_CANDLE_RECONCILIATION_ORDER_BATCH_SIZE=100
```

## Monitoring

- `OpsJobRun(limit_order_candle_reconciliation)` per tick, with
  `scannedCandles / processedCandles / skippedCandles / matchedOrders /
  deferredCandles` and the swept window;
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
| Need to disable urgently | Set `LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED=false` and restart. Path A keeps running; existing orders keep their `candleMatchingEligibleFrom`, so re-enabling resumes without a backfill. |

## Verification

- `limit-order-candle-matching.spec.ts` — eligibility boundary arithmetic,
  canonical-candle checks, limit-price amounts, reservation-mismatch refusal,
  flag combinations, advisory-key identity.
- `limit-order-phase3.integration.spec.ts` — full path-B flow against
  PostgreSQL + Redis, first-eligible-candle boundary, NULL-eligibility orders,
  season-end exclusion, processed-candle idempotence, crashed-sweep re-run,
  and every race above.
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
- path B does not reconstruct intra-candle ordering, so simultaneous touches
  across many orders all fill at their own limit prices;
- no user-specific order WebSocket; the client polls conditionally.
