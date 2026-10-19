# Futures chart timeframes (2026-10-20, current)

The USDⓈ-M contract chart offers the general chart's 봉 시간 — 5m, 15m, 30m,
1h, 4h and 1d. Every timeframe is the contract's own `/fapi/v1/klines` series
(contract trade price). Mark (`markPriceKlines`), Index (`indexPriceKlines`)
and Spot (`/api/v3/klines`) klines are never read for it, never substituted,
and the response says `priceBasis: "contract_last_trade"`. Order, fill, TP/SL,
valuation, liquidation and ledger prices are unchanged (Futures Last and Mark
stay as in [futures-last-price-contract.md](futures-last-price-contract.md)).
All routes stay under `/api/v1`.

## Windows

`GET /api/v1/futures/instruments/:instrumentId/candles?interval=…&range=…&limit=…`
(authenticated, not account-scoped). `interval` defaults to `4h`; `range`
defaults to the interval's own window and must match it; `limit` must stay
inside the window (defaults to its maximum, 600 for 4h).

| interval | range | rows in window | max `limit` | delivery |
| --- | --- | --- | --- | --- |
| 5m | `2d` (rolling 48 h) | 577 | 600 | provider |
| 15m | `3d` | 289 | 300 | provider |
| 30m | `14d` | 673 | 700 | provider |
| 1h | `14d` | 337 | 350 | provider |
| 4h | `96d` | 577 | 1000 (app sends 600) | stored |
| 1d | `1y` (365 days) | 366 | 400 | provider |

The windows follow the general crypto chart (`frontend/src/features/asset/chartTimeframes.ts`);
5m is a rolling 48 h because contracts trade 24/7 (the Spot tab anchors on 09:00 KST).
Anything else is 400 `FUTURES_CANDLES_INVALID_QUERY`; an unknown or non-catalog
contract stays 404 `FUTURES_INSTRUMENT_NOT_FOUND`.

## Delivery

**4h — stored, unchanged.** The 96-day history in `futures_market_candles`,
collected by `futures_candle_sync` and `pnpm candle:long-backfill`; reads are
DB-only ([long-range-4h-candles.md](long-range-4h-candles.md)). Nothing about
its collection, retention (180 days) or response changed.

**5m, 15m, 30m, 1h, 1d — the contract's native klines, on demand.**
`FuturesCandleProviderService` reads `/fapi/v1/klines` with the contract
symbol and THE interval asked for (Binance aggregates its own klines on the UTC
grid, so 15m/30m/1h/1d need no aggregation of ours), through the existing
`BinanceCandleIngestionService` page parser (grid alignment, consistent close
times, future klines rejected, positive/consistent OHLC, duplicates removed,
`isClosed` = Binance's close time against the server clock of the read).

Why not a stored 5m feed aggregated into 15m/30m/1h (the Spot design): the
30m/1h windows are 14 days, which would need ≥ 14 days of stored 5m per
contract (≈ 400,000 rows for 100 contracts) plus a 100-call-per-minute upkeep
for every listed contract, viewed or not.

### Shared cache, single flight, budget

- One cached read per **contract and interval**, shared by every viewer and
  account (market data; the response holds no account field).
- A read stays current for 15 s (5m), 30 s (15m, 30m), 60 s (1h), 120 s (1d)
  — and never across a bucket boundary, so a new bucket always triggers a
  refresh. The app polls at the same cadence.
- Concurrent viewers of a stale key share ONE provider call.
- Provider calls run **one at a time**, at least 150 ms apart, whatever the
  contract or interval — the 4h upkeep's rule — so chart reads never hold
  more than one of the coordinator's two slots and Futures Last
  re-confirmation / Mark recovery keeps the other (a call that never settles
  gives up its turn after 15 s, so it cannot stall the rest). A viewer that already has a
  cached copy waits at most 2 s for its refresh and otherwise gets that copy
  marked stale; a viewer with nothing cached waits at most 8 s and otherwise
  gets the retryable 503. The refresh still completes and serves the next
  poll or retry.
- A refresh re-reads from the bucket **before** the last cached one (< 100
  rows = Binance weight 1), so the bucket that closed last is read again after
  its close (late revisions). The whole window (weight 2–5) is read when
  nothing usable is cached, and once when the cached copy has a missing bucket
  (a row the page parser refused); a bucket Binance itself never had is not
  re-read again.
- At most `FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE` (default 60, 1..600)
  provider calls per minute per process, on top of the shared Binance REST
  coordinator (one weight budget, 418/429 cooldown, see
  [binance-rest-limits.md](binance-rest-limits.md)). The app polls each viewed
  series at its freshness, so one continuously viewed 5m series costs ≈ 4
  calls a minute: beyond ≈ 15 such series per process the cap is reached and
  further series refresh less often (their charts show the stale note). Raise
  the cap only together with the coordinator budget.
- At most 200 contract/interval series are cached per process
  (least-recently-read eviction), and a series nobody has read for 10 minutes
  is dropped. The route's own 5-second answer cache drops expired answers on
  every insert.

### States

| Situation | Answer |
| --- | --- |
| first read of a contract/interval | one provider read, then `state: available` (or `empty` if Binance has no klines in the window) |
| new listing with a short history | only the klines that exist (fewer than the window's rows); nothing padded |
| provisional bucket | the bucket containing "now" is `provisional: true`; an open kline whose bucket has ended (a stale copy) is withheld, never shown as final |
| provider failure, rate limit, cooldown, call cap, refresh queued > 2 s | the last good copy with `source.stale: true` and `source.fetchedAt`; the app notes "차트 갱신이 지연되고 있습니다." |
| …and nothing cached yet (or queued > 8 s) | 503 `FUTURES_CANDLES_UNAVAILABLE`; the app shows the chart error with 다시 시도 |
| retries after a failure | the key is not re-read for 15 s (3 s when the coordinator's slots were busy); a 418/429 from Binance (or the coordinator's cooldown after one) pauses every on-demand read for at least 30 s (or Retry-After); the coordinator's own refusal (its shared minute budget spent, a recovery probe running) pauses them only until it admits again (1–60 s) |

Missing candles are never generated, interpolated, or borrowed from another
series or interval.

## Retention and backfill

The on-demand intervals are **not stored**: there is no table, no retention
job and no backfill. Binance is the history; the server holds at most the
current window per contract/interval in process memory. The 4h history keeps
its stored collection and its backfill command; no backfill was run or is
needed for this change.

## Provider load (100 contracts)

| Case | Calls / weight |
| --- | --- |
| a viewer on one contract and interval | ≈ 1 call per freshness window, weight 1 (tail) |
| first view of a series in a process | 1 call, weight 2 (≤ 499 rows) or 5 (577–673 rows) |
| every listed contract × interval viewed at once (worst case) | capped at 60 calls/min/process by default (≈ 60–300 weight), the rest served stale |
| nobody viewing | 0 — nothing is collected in the background |

Existing collection is untouched: the 4h upkeep stays ≈ 100 weight per run.

## App

`FuturesCandleChart` takes the shared `ChartTimeframeSelector` (5분 by default,
like the asset detail): below the chart on the contract detail, above it on
the full-screen chart. Each contract × 봉 시간 is its own query key
(`['futuresMarket','candles', id, range, interval, limit]`), so a late answer for
an earlier choice is never drawn under the current one; the viewport resets per
contract and interval, and a cached choice draws at once and refreshes behind
the chart.

## Rollout

Backend first (an older backend answers 400 to the new intervals; an older app
only ever asks for 4h, unchanged), then the app. No migration, no flag, no
backfill. Optional: set `FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE` if the
default 60 should change.
