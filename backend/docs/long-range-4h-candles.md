# Long-range 4h candles (2026-10-13, current)

Completed 4h history for KRX stocks, Binance Spot crypto and Binance USDⓈ-M
perpetual futures, kept separately from the 5m feed. This is chart data only:
no order, fill, TP/SL, valuation, liquidation or ledger price changes. All
routes stay under `/api/v1`.

Evidence for the KRX source: [KOSCOM 10-minute history live check](../../docs/investigations/2026-10-13-koscom-10m-date-quota/report.md) (§4–5).

## Policy

| | KRX stocks | Crypto Spot | Crypto Futures (USDⓈ-M) |
| --- | --- | --- | --- |
| Chart window (`range=96d`, `interval=4h`) | 96th previous real KRX session open → now (96 completed sessions + today; ≤ 194 candles) | rolling 96 × 24h (≈ 576 + current) | rolling 96 × 24h (≈ 576 + current) |
| Completed-bucket source | KOSCOM 10-minute history, verified per session (`koscom_history_10m`) | Binance Spot `/api/v3/klines` interval `4h` (`binance_klines`) | Binance `/fapi/v1/klines` interval `4h` of the contract (`binance_usdm_klines`) |
| Current (in-progress) bucket | live 5m aggregation (existing path) | live 5m aggregation (existing path) | stored provisional row, refreshed by `futures_candle_sync` (≈ 60 s) |
| Storage | `market_candles` (`interval='4h'`) | `market_candles` (`interval='4h'`) | `futures_market_candles` (keyed by `FuturesInstrument`) |
| Retention | 180 calendar days (`MARKET_CANDLE_4H_RETENTION_DAYS`, min 150) | same | same |

- 5m retention stays 35 days; 15m/30m/1h stay read-time aggregates; 1d/1w are
  unchanged and never pruned. 180-day retention is a ceiling, not a promise
  that 180 days were collected: only confirmed history is shown.
- US stocks keep the 30-day 4h window: `range=96d` is rejected for `us_stock`
  (400 `ASSET_CANDLES_INVALID_RANGE`), and the app keeps sending `30d`/200.
- `range=96d` accepts only `interval=4h`; the request `limit` stays ≤ 1000
  (the app sends 600).

## Data identity and isolation

- `FuturesInstrument` references its Spot underlying `Asset` (20 of the 25
  catalog contracts share the Spot row; HYPE/PUMP/BCH/FIL/AAVE have their own
  futures-only Asset). `market_candles` is keyed by
  `(asset_id, interval, open_time)`, so a contract candle can never live there.
  Contract klines go to `futures_market_candles`
  `(futures_instrument_id, interval, open_time)` with `contract_symbol`; an
  identity trigger rejects a row whose `contract_symbol` is not the
  instrument's underlying symbol, and the identity columns are immutable.
- The same symbol and time can hold one Spot 4h row and one contract 4h row;
  neither overwrites the other (DB smoke:
  `MARKET_CANDLE_LONG_DB_SMOKE=1 … jest src/assets/market-candle-long.integration.spec.ts`).
- Spot reads, Spot response caches (keyed by `assetId`), Spot WebSocket
  candles and limit-order path B never read `futures_market_candles`; the
  futures chart never reads Spot candles (futures-only underlyings stay
  `ASSET_NOT_FOUND` on the Spot candle route and are never registered as Spot).
- Mark (`markPriceKlines`) and Index series are not collected; Futures Mark
  and Last snapshots and their retention are unchanged.

## Reads

`GET /api/v1/assets/:assetId/candles?range=96d&interval=4h&limit=600`
(`CandleDatabaseLoader`, read plan `history`):

1. stored completed `4h` rows over the whole window;
2. the stored 5m feed aggregated over the regular 4h window (the most recent
   30 days, `30d + 4h` of 5m) for the current bucket and for buckets that have
   no stored completed row yet (e.g. today's finished KRX 09:00 bucket before
   the post-close verification, or history not backfilled yet);
3. per bucket exactly one source: current → live aggregate; otherwise a stored
   completed row; otherwise a complete closed aggregate. Incomplete buckets
   without a stored row are dropped (never interpolated); an `openTime` is
   never returned twice; output is ascending.

Coverage/freshness/on-demand refresh semantics are those of the 5m part (the
history is served as stored). The response shape is unchanged; for KRX,
`source.sourceProviders` lists the sources actually used (e.g.
`koscom_history_10m`, `koscom_intraday`). Writes invalidate the asset's
response cache generation. The live overlay and `asset_candle` WebSocket keep
updating the current bucket.

`GET /api/v1/futures/instruments/:instrumentId/candles?interval=4h&range=96d&limit=600`
(`FuturesCandlesController`, authenticated, not account-scoped):

- 404 `FUTURES_INSTRUMENT_NOT_FOUND` unless the instrument is a catalog
  USDⓈ-M `synthetic_perpetual` (inactive instruments stay readable for their
  history); 400 `FUTURES_CANDLES_INVALID_QUERY` for anything but `4h`/`96d`/
  limit 1–1000.
- DB only (no provider call in the request path); per-instance 5 s cache with
  in-flight sharing.
- Closed rows whose window ended, plus the open row of the current bucket
  marked `provisional: true`; an open row from an ended window (collection
  stopped) is withheld. `priceBasis: "contract_last_trade"`,
  `source.provisionalUpdatedAt` dates the provisional row.

## Collection

Nothing collects on deploy. Both upkeep jobs are opt-in and the initial
backfill is an explicit operator command.

### Backfill command

```bash
cd backend   # pin DATABASE_URL/REDIS_URL — .env.local may point at Render
pnpm candle:long-backfill --market spot --market futures            # plan only
pnpm candle:long-backfill --market spot --market futures --apply
pnpm candle:long-backfill --market krx --apply --max-calls 800      # outside 09:00–15:30 KST
```

Flags: `--market spot|krx|futures` (required, repeatable), `--apply` (default
is a dry-run plan with no provider call or write), `--days N` (crypto, 1–180,
default 96), `--sessions N` (KRX, 1–125, default 97), `--asset-id`,
`--instrument-id` (repeatable), `--include-inactive-futures` (with
`--instrument-id`), `--max-calls N` (KRX KOSCOM calls per run, default 1500),
`--min-remaining-daily N` (stop once an observed `X-RateLimit-Remaining-Day`
is ≤ N, default 20000), `--min-call-interval-ms N` (KRX pacing, default
1000), `--allow-during-krx-session`, `--no-fetch-missing-daily`.

- Stored rows are the progress record. A rerun after an interruption, a call
  cap or a failure fetches only buckets/sessions that are still missing;
  verified rows are never refetched. Upserts are idempotent.
- Per-series Redis locks (`candles:sync:lock:v1:…:long-4h|usdm-4h`) and the
  same Ops job locks as the scheduled jobs (`market_candle_long_sync`,
  `futures_candle_sync`) prevent overlap. Each `--apply` writes an
  `ops_job_runs` row (`trigger=manual_script`) whose `resultJson` lists per
  series: expected/missing, rows written, provider calls, held sessions with
  reasons, pending sessions, error codes, and the lowest observed KOSCOM
  daily remainder. SIGINT/SIGTERM stop after the current provider call.

### Scheduled upkeep (opt-in)

| Job | Flag | Interval | Work per run |
| --- | --- | --- | --- |
| `market_candle_long_sync` | `SCHEDULER_MARKET_CANDLE_LONG_SYNC_ENABLED=true` (`…_MARKETS=spot,krx`) | `SCHEDULER_MARKET_CANDLE_LONG_SYNC_INTERVAL_SECONDS` (900) | Spot: missing closed buckets of the last 2 days + one re-fetch of a bucket first stored within 2 min of its close (1 call/symbol when due). KRX (skipped while the session is open): the last 5 completed sessions (close + 20 min) missing a verified row — 1 call per session, only when the dated `koscom_history` daily bar is already stored by the existing 1d sync (no duplicate KOSCOM daily call; otherwise the session stays `pending`); ≤ 60 calls/run |
| `futures_candle_sync` | `SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED=true` | `SCHEDULER_FUTURES_CANDLE_SYNC_INTERVAL_SECONDS` (60) | catalog contracts that are active + verified or hold an open position, and whose stored contract mapping still parses as USDⓈ-M PERPETUAL/TRADING (otherwise `CONTRACT_UNVERIFIED`, history kept): missing closed buckets of the last 2 days + the current provisional bucket — 1 call (`limit<100`, weight 1) per contract |

Retention of the 4h history runs inside the existing `market_candle_retention`
job after the unchanged 5m prune (its own 180-day cutoff; `resultJson`
`fourHour` / `futuresFourHour`).

### Provider budgets

- **KOSCOM** (single 50,000/day limit assumed; the several remaining-count
  streams seen live are not treated as extra allowance): initial KRX backfill
  for the current 15-symbol universe ≈ 15 × 97 ten-minute calls + ≤ 2 daily
  calls per symbol ≈ 1,485 calls (100 symbols would be ≈ 9,900, reference
  only). Daily upkeep ≈ 1 call per symbol per session. Live price/order-book
  polling has priority: backfill refuses the open session by default, stops at
  `--max-calls` or the observed-remaining reserve, and spaces calls
  ≥ 1 s. A 429 sets the shared KOSCOM cooldown and stops the run.
- **Binance**: every call goes through the shared REST coordinator (one
  600/min weight budget and 2 slots for Spot + Futures, 418/429 back-off).
  Spot 4h klines cost 2 per call (≤ 1000 rows); USDⓈ-M klines cost 1 below
  100 rows and 2 below 500 (backfill pages are 499 rows). Long-range sync is
  strictly sequential with ≥ 150 ms between its calls so Futures Last/Mark REST
  recovery keeps a slot. Initial backfill: 10 Spot symbols × 1 call (weight
  20) + 25 contracts × 2 calls (weight 100). Upkeep: Spot ≈ 10 calls per 4h,
  Futures 25 weight per minute.

## KRX verification (KOSCOM 10-minute history)

Per completed calendar session (`resolveMarketSession`, overrides included;
holidays are never requested):

1. one `…/stocks/{code}/intraday?inddCycleTpCd=600&inqStrtDd=YYYYMMDD&strtTm=<open>&endTm=<close>` call;
2. reject the response if it names another symbol, carries another `trdDd`
   or has more than 100 rows;
3. hold the session on: no rows, ≥ 100 rows (possible truncation), any
   unparsable row, conflicting duplicate labels, any label off the session's
   10-minute END grid (e.g. a 09:00 pre-open row), or a missing required row
   (regular day: 09:10…13:00 = 24 and 13:10…15:20 = 14);
4. the closing-auction row (label = close) is optional and folded into the
   second bucket when present;
5. the aggregate O/H/L/C must EXACTLY equal the dated KOSCOM daily bar of the
   same date (stored `koscom_history` 1d row captured after that close, or a
   fetched `trdDd` daily page); KIS daily rows are not accepted as evidence;
6. hold when both 4h buckets repeat the previous session's OHLCV and amount
   (a re-returned previous session);
7. a volume difference against the daily bar is recorded
   (`volumeRelations`), not rejected.

Date-attribution evidence is `SUPPLIER_DAILY_CORROBORATION_ONLY`: rows carry
no date, so attribution rests on the same supplier's dated daily bar and is
not independently proven; the END meaning of `inddTm` is strongly supported
by the response pattern but not confirmed by the supplier. A held session is
never stored and is retried by later runs (or explicitly by backfill).

## Rollout (operator steps; none performed by this change)

1. Review the branch; push and deploy only with approval (`main` pushes
   without `[skip render]` run `prisma migrate deploy` on Render).
2. Migration `20261013200000_add_long_range_four_hour_candles`: adds two
   `OpsJobName` values, widens `market_candles_interval_check` to include
   `4h` (NOT VALID + VALIDATE), creates `futures_market_candles` and its
   identity trigger. Additive; no existing row changes.
3. Deploy the backend with all new flags off BEFORE releasing the app build:
   an older backend answers the app's `range=96d` with 400 and has no futures
   chart route (the chart then shows its error state). Before any backfill the
   `96d` window is served from the existing 5m aggregation (≈ 30 days, as
   before) — no regression.
4. Plan, then backfill: `--market spot --market futures` (seconds), then
   `--market krx` after the close with conservative `--max-calls`; repeat on
   later days until `missing=0`. Check held sessions in `ops_job_runs`.
5. Enable `SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED=true`, then
   `SCHEDULER_MARKET_CANDLE_LONG_SYNC_ENABLED=true` (optionally
   `…_MARKETS=spot` first). `market_candle_sync` must stay enabled for KRX
   upkeep (it stores the dated daily bars). Enable
   `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED` if not already on.
6. Verify: 4h charts of a KRX stock, a Spot coin, a Spot+Futures symbol
   (BTC) and a futures-only contract (HYPE); `ops_job_runs` results;
   Binance `X-MBX-USED-WEIGHT-1M` and KOSCOM remaining counts stay well within
   budget; Futures Last/Mark readiness unchanged.

Rollback: turn the two scheduler flags off (collection stops; reads keep
serving stored history). The app can be rolled back without the migration:
old code never reads `interval='4h'` rows or `futures_market_candles`.
Stored 4h rows can stay (pruned by retention) or be deleted by interval/table
without touching 5m/1d/1w, orders or ledgers. The migration itself is not
reverted; dropping the new table/values is a separate reviewed change.

## Not verified / limits

- KOSCOM: one live sample (5 sessions, one symbol, after the close). Coverage
  beyond 97 sessions, other symbols, the END semantics and quota scope are
  unconfirmed; held sessions surface the gaps instead of hiding them.
- Same-day KRX 4h after the close depends on when KOSCOM's daily history and
  the 1d upkeep store the dated bar; until then the 5m aggregate serves the
  day.
- Futures provisional bucket freshness is the job interval (~60 s), not tick
  level; the screen shows the live Futures Last separately.
