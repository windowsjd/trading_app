# Crypto order-book history (60 s samples, 14 days)

Display and history data only. A stored book is never an execution price,
executable quantity, slippage input, valuation, risk, liquidation, trigger or
settlement input: Spot keeps its ticker-based execution, USDⓈ-M keeps Futures
Last (executions, limit/conditional/TP-SL triggers, Season exit) and Mark
(valuation, risk, liquidation). Nothing in this contract reads these tables.

Introduced 2026-10-16 together with the Binance Spot 100 + USDⓈ-M 100 catalog
([binance-crypto-100-2026-ytd.md](binance-crypto-100-2026-ytd.md)).

## Source: the existing realtime books

| Market | Stream (unchanged) | Owner (unchanged) | Identity |
| --- | --- | --- | --- |
| Binance Spot | `<symbol>@depth10` (1000 ms), combined stream | standalone streaming service or live-candle owner, through `BinanceOrderBookService` | `assets.id` |
| USDⓈ-M | `<symbol>@depth10@500ms` on `/public` | `FuturesMarketDataIngestion` | `futures_instruments.id` |

The sampler receives only books the display path has already accepted:
the existing parser (10 levels max, positive unique prices, exact decimal
strings, sort order) and the per-symbol sequence check (duplicates and
regressions dropped). It adds no socket, no subscription and no REST call,
and changes neither the WebSocket cadence nor the Redis fanout
(`market:order-book:v1`, `market:futures-order-book:v1`). The hand-off is an
in-memory O(1) step after the publish is queued; the publish never waits for
history.

## Sampling rule

Per product (Spot asset or USDⓈ-M instrument) and UTC minute, at most one row:

1. Only a book valid for history is a candidate: both sides non-empty,
   best bid < best ask, every quantity > 0, sequence a non-negative 64-bit
   integer; for USDⓈ-M the provider transaction time must be within 5 s of
   server receipt (a delayed backlog frame or a broken clock is refused).
   Spot partial books carry no provider time; none is invented.
2. The newest candidate received in the minute replaces older ones.
3. When the minute ends (the first book of the next minute, or the 1 s
   timer), its newest candidate is stored only if it was still current at the
   minute's end: received no more than 5 s before it (the app's
   `ORDER_BOOK_STALE_MS`). A silent or stale stream stores nothing; an old book
   is never stored again under a later minute.
4. A book for a minute this process already closed (wall clock stepped back)
   is ignored.

At 100 Spot + 100 USDⓈ-M products the maximum is 200 rows a minute,
288,000 a day and 4,032,000 over 14 days.

## Tables

`crypto_spot_order_book_snapshots` (Spot, `asset_id` → `assets`) and
`futures_order_book_snapshots` (USDⓈ-M, `instrument_id` →
`futures_instruments`). The same symbol on both markets is two histories in
two tables. KOSCOM/KIS books stay in `asset_orderbook_snapshots`, untouched.

| Column | Meaning |
| --- | --- |
| `bucket_start_at` | UTC minute containing `captured_at` (CHECK) |
| `asset_id` / `instrument_id` | product identity |
| `captured_at` | server receipt time of the book (= the realtime event's `capturedAt`) |
| `effective_at` | USDⓈ-M only: provider transaction time (`T`) |
| `sequence` | provider `lastUpdateId` (Spot) / final update id `u` (USDⓈ-M) |
| `bids`, `asks` | `json` `[[price, quantity], ...]`, best first, 1–10 levels (CHECK), exact provider strings including trailing zeros |
| `created_at` | database write time; never a market time |

The primary key `(bucket_start_at, product)` is the only index. It makes a
reconnect, a restart or a second instance unable to add a second row for a
minute (`INSERT … ON CONFLICT DO NOTHING`; the first writer wins), appends at
the right edge of the index and lets retention delete a prefix of it.
`json` text keeps the strings byte-exact and was the smallest exact format
measured (row-format comparison in the 2026-10-16 investigation).

## Writes and failure isolation

A 1 s timer writes the closed minutes: one `INSERT` per table, in its own
transaction with `statement_timeout = 5s` and a 10 s transaction timeout.
The queue holds at most one closed minute per product; while the database
fails, a product's newer minute replaces its unwritten one (`superseded`), so
memory and work stay bounded and nothing piles up. Failures back off 2 s → 60 s.
A row the database refuses (CHECK) is written alone and counted (`rejected`);
it never blocks the rest of the minute. Shutdown makes one last attempt for
closed minutes only.

## Retention (14 days)

`CryptoOrderBookRetentionWorker` (Ops job `crypto_order_book_retention`,
lock `crypto_order_book_retention:current`), every 5 minutes at :45 of the
process minute (Futures Last :00, price :15, Mark :30). A row is deleted once
its whole minute is older than 336 hours (`bucket_start_at <
floor_minute(now − 336 h)`, database clock), so no book captured within the
last 14 days is ever deleted. Batches of 1,000 (oldest first through the
primary key, `FOR UPDATE SKIP LOCKED`, deleted by row address), each its own
transaction with a 5 s statement timeout, at most 20,000 rows or 60 s a run;
the lease is renewed before every batch. Only these two tables are named.
Each run records `ops_job_runs` (`deleted` per table, `batchLimitReached`,
`oldestRemaining`, or `failureKind`).

## Flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRYPTO_ORDER_BOOK_HISTORY_ENABLED` | `false` | record 60 s samples (strict `true`/`false`) |
| `CRYPTO_ORDER_BOOK_RETENTION_ENABLED` | follows the recording flag | 14-day retention; set `true` alone to keep draining after recording stops |

Neither flag affects the streams, the realtime fanout or any financial path.
Rollback: set `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false` (keep retention on
for 14 days to empty the tables).

## Diagnostics

`/readiness` → `data.cryptoOrderBookHistory`:

- `recorder`: `enabled`, tracked products per market, `pendingRows`,
  `writeInFlight`, counts (`invalid`, `late`, `closedMinutes`,
  `staleMinutes`, `inserted`, `duplicates`, `superseded`, `rejected`),
  `lastInsertedAt`, `consecutiveWriteFailures`, `lastWriteFailure {kind, at}`;
- `retention`: `enabled`, `retentionHours`, the last run's result and the
  shared retention health (`failing`, `backlog`, `lastFailureKind`, …).

Alert reasons (also on `/readiness/alerts`):
`CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING` (3 consecutive failed writes),
`CRYPTO_ORDER_BOOK_RETENTION_FAILING` (3 failed runs),
`CRYPTO_ORDER_BOOK_RETENTION_BACKLOG` (10 capped runs in a row), and
`DB_DISK_FULL` when either reports `disk_full` within 10 minutes. Log events:
`crypto_order_book_history_persist_failed` / `db_disk_full` (at most once a
minute per kind) and `crypto_order_book_retention_failing|_recovered|_backlog`.
Monitoring details: [database-operations-monitoring.md](database-operations-monitoring.md).

## Capacity

Measured on PostgreSQL 17 with real Binance books (2026-10-16 investigation):
see the report for row, index and WAL bytes and the 14-day totals. Enabling
recording in production is a separate approved step after the disk decision.
