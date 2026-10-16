# Database, collector and retention monitoring

Operational signals added by the P0 database stabilization and the P1 storage
work (2026-10-16). They **detect** problems; **delivering** an alert to a person
needs the operator setup in §3. Nothing here is a financial input: risk,
liquidation, valuation and execution always read PostgreSQL evidence.

Background: the production database filled its disk on 2026-10-12 and was
unwritable for about 8 hours with no alert
([incident](../../docs/investigations/2026-10-12-db-disk-full-incident/report.md)).

## 1. Signals

| Signal | Produced by | Threshold | `/readiness` reason | Log event (JSON `event`) |
|---|---|---|---|---|
| Disk usage | `DatabaseStorageMonitorService` (opt-in, §3 step 1): every 5 min, first sample 30 s after start, `pg_database_size` **plus `max_wal_size` as WAL headroom** | ≥ 60 % warning, ≥ 80 % action required, ≥ 90 % critical, against `DATABASE_STORAGE_CAPACITY_GB` | `DB_STORAGE_WARNING` / `DB_STORAGE_ACTION_REQUIRED` / `DB_STORAGE_CRITICAL` | `db_storage_level` on every level change; repeated every 6 h (warning), 1 h (action required) or every sample (critical) |
| Daily growth / runway | same, from this process's own samples (window ≥ 1 h for growth, ≥ 6 h for runway, at most 24 h) | fewer than 14 days until 80 % | `DB_STORAGE_RUNWAY_SHORT` | `db_storage_runway_short` (every 6 h) |
| Storage sampler silent | same | no successful sample for 15 min (3 missed samples) | `DB_STORAGE_SAMPLE_STALE` | `db_storage_sample_failed` (hourly, category only) |
| Futures Mark freshness | `FuturesMarkIngestion`, in process; no database query | any target's newest STORED Mark older than 5 s (`MARK_MAX_AGE_MS`), after a 5 s grace for a new target or process | `FUTURES_MARK_STALE` | `futures_mark_stale` (once a minute while stale), `futures_mark_fresh_again` |
| Mark write failures | same | 3 consecutive failed stores | `FUTURES_MARK_PERSIST_FAILING` | `futures_mark_persist_failed` (once a minute per category) |
| Futures retention failures | `futures_mark_retention`, `futures_last_price_retention` workers | 3 consecutive failed runs (one run per minute) | `FUTURES_MARK_RETENTION_FAILING`, `FUTURES_LAST_PRICE_RETENTION_FAILING` | `futures_retention_failing` (every 5 min), `futures_retention_recovered` |
| Futures retention backlog | same | 10 consecutive runs that hit the per-run cap (10 batches) | `FUTURES_MARK_RETENTION_BACKLOG`, `FUTURES_LAST_PRICE_RETENTION_BACKLOG` | `futures_retention_backlog` |
| Price snapshot retention failures | `asset_price_snapshot_retention` worker (opt-in, §6) | 3 consecutive failed runs (one run per 5 min) | `ASSET_PRICE_SNAPSHOT_RETENTION_FAILING` | `price_snapshot_retention_failing` (every 5 min), `price_snapshot_retention_recovered` |
| Price snapshot retention backlog | same | 10 consecutive runs that hit the per-run cap | `ASSET_PRICE_SNAPSHOT_RETENTION_BACKLOG` (readiness note only, §4) | `price_snapshot_retention_backlog` |
| Order-book history write failures | `CryptoOrderBookHistoryService` (opt-in, §7) | 3 consecutive failed minute writes | `CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING` | `crypto_order_book_history_persist_failed` (once a minute per category) |
| Order-book history retention failures | `crypto_order_book_retention` worker (§7) | 3 consecutive failed runs (one run per 5 min) | `CRYPTO_ORDER_BOOK_RETENTION_FAILING` | `crypto_order_book_retention_failing` (every 5 min), `crypto_order_book_retention_recovered` |
| Order-book history retention backlog | same | 10 consecutive runs that hit the per-run cap (20,000 rows) | `CRYPTO_ORDER_BOOK_RETENTION_BACKLOG` | `crypto_order_book_retention_backlog` |
| Disk full on write | Mark ingestion, the order-book history writer and the four retention workers (SQLSTATE 53100 / "No space left on device") | any, reported for 10 min after the last one | `DB_DISK_FULL` | `db_disk_full` (error) |
| Database unreachable | existing readiness `SELECT 1` | any | `CANDLE_DB_UNAVAILABLE`, `status: unavailable` | — |

Failure categories (`kind`, and `ops_job_runs.result_json.failureKind` for a failed
retention run): `disk_full`, `statement_timeout`, `lock_timeout`, `connection`,
`data_rejected`, `database_error`, `lease_lost`, `unknown`. A failed retention run
also records the `deletedCount`/`batchCount` its committed batches reached. Driver
messages, SQL and parameters are never logged or stored.

Limits of the signals:
- Disk usage is an estimate from inside PostgreSQL: the database size plus
  `max_wal_size` (1,280 MB in production) as WAL headroom. It excludes temp files,
  other databases and filesystem overhead. The capacity is read as decimal GB (the
  conservative side). Render's disk metric remains the authoritative usage
  (measured differences in the P1 report).
- Growth is unknown for the first hour after every restart or deploy, because the
  samples live in memory.
- Mark freshness is this instance's view of the rows it stored. A restarted
  process reports targets as missing until its first rows are stored (5 s grace).

## 2. Where to read them

- `GET /readiness` (public, root path, no `/api/v1`): `data.reasons`,
  `data.alerts` (the subset in §4 that needs an operator), `data.futuresMark`,
  `data.futuresRetention.{mark,last}`, `data.assetPriceRetention`,
  `data.cryptoOrderBookHistory.{recorder,retention}`, `data.databaseStorage`.
  - **Always HTTP 200**, even when the database is unreachable (`status:
    unavailable`, `success: false`). A monitor that checks only the HTTP status of
    `/readiness` misses every incident.
- `GET /readiness/alerts` (public): **HTTP 503 while any §4 alert code is
  active**, HTTP 200 otherwise. Body: `{ success, data: { status, alerts,
  currentTime } }`. It runs exactly the `/readiness` queries (`SELECT 1` plus
  small Ops-run reads for the enabled reconciliation and candle retention jobs).
  This is the endpoint for monitors.
  - **Never configure it as the Render health check path**: a 503 there makes
    Render restart or stop routing to a serving instance for a disk warning. The
    Render web service has no health check path configured (verified 2026-10-16).
- Render logs: search for the `event` names above.
- Durable history (read-only):

```sql
-- Latest retention runs with failure category and committed progress.
SELECT job_name, status, started_at,
       result_json->>'failureKind'  AS failure_kind,
       result_json->>'deletedCount' AS deleted,
       result_json->>'batchLimitReached' AS at_cap
FROM ops_job_runs
WHERE job_name IN ('futures_mark_retention', 'futures_last_price_retention',
                   'asset_price_snapshot_retention', 'crypto_order_book_retention')
ORDER BY started_at DESC
LIMIT 30;
```

## 3. Operator setup (not done by code)

Render notifies only about a **service persistent disk** above 80 %. It sends no
Postgres storage notification; Postgres has the dashboard Storage graph and
optional autoscaling ([notifications](https://render.com/docs/notifications),
[storage](https://render.com/tutorials/postgres-on-render/storage-and-autoscaling)).
None of the signals above reaches a person until an operator does the following.
Each step is an approved production change; none is done by deploying the code.

1. **Enable the disk sampler** on the Render web service:
   `DATABASE_STORAGE_MONITOR_ENABLED=true` and `DATABASE_STORAGE_CAPACITY_GB=50`
   (the current disk). Change the capacity after every resize. Startup rejects any
   value other than `true`/`false`, or a capacity outside 1–16384.
2. **Deliver alerts.** Use either or both; both read `GET /readiness/alerts`.
   - **a. GitHub (in this repository, no new service):**
     `.github/workflows/ops-readiness-alerts.yml` polls every 15 minutes, checks
     twice a minute apart, and keeps **one** open issue labelled `ops-alert`:
     opened when an alert persists, one comment when the set of codes changes,
     closed when the endpoint answers 200 twice. Activate by setting the
     repository variable `OPS_READINESS_ALERTS_URL` to
     `https://<service>.onrender.com/readiness/alerts` (Settings → Secrets and
     variables → Actions → Variables). It runs only from the default branch;
     GitHub may delay scheduled runs, so it is a backstop for incidents that last
     minutes or longer. People who watch the repository get the issue e-mails.
     Test once with "Run workflow" (workflow_dispatch).
   - **b. Any external HTTP monitor** (1–5 minute interval): monitor
     `GET /readiness/alerts` and alert on any non-200 response. No keyword list
     is needed; the monitor's own state handles repeats and recovery. Set it to
     alert after two consecutive failures to ignore a brief Mark gap.
3. **Render notifications:** in the Render workspace, enable e-mail (or Slack)
   notifications for deploy failures and service failures. They cover a crashed
   or unresponsive process, which the endpoint cannot report about itself.
4. **Decide on Postgres storage autoscaling.** At about 90 % it grows the disk by
   about 50 %. It is billed, and a disk can never shrink. It was off during the
   incident and is still off.
5. **Keep heavy analysis off the production database.** Use `BEGIN READ ONLY`, a
   `statement_timeout`, index-range or `TABLESAMPLE` reads, and no `EXPLAIN ANALYZE`
   of deletes. Run large analyses on a restored copy.

### Verification after deploy and step 1

1. Within a minute `/readiness` shows `databaseStorage.enabled: true`,
   `capacityConfigured: true`, `walReserveBytes` ≈ 1.28 GB, and a `usedPercent`
   close to Render's usage plus about 1 GB (the WAL headroom, minus the actual WAL).
2. `futuresMark.enabled: true`, `targets` equals the active contracts, and
   `staleTargets: 0` with `oldestStoredAgeMs` under 3000.
3. `futuresRetention.mark.lastSucceededAt` and `.last.lastSucceededAt` are under
   two minutes old, with `consecutiveFailures: 0`.
4. `GET /readiness/alerts` answers 200 with `alerts: []`.
5. Render logs show no `futures_mark_stale` in steady state.
6. Alert path test: point a staging or local instance at a capacity below its
   database size (`DB_STORAGE_CRITICAL` → 503) and confirm the issue or monitor
   fires, then clears. Do not do this in production without coordinating.

## 4. Alert codes and first response

`data.alerts` and `/readiness/alerts` carry exactly these codes. Other readiness
reasons (calendar, session override, provider lag) degrade readiness by design and
are not paged.

| Code | Meaning | First response |
|---|---|---|
| `CANDLE_DB_UNAVAILABLE` | The app cannot run `SELECT 1` | Render Postgres status and logs; disk full is the usual cause (see `DB_DISK_FULL`) |
| `DB_DISK_FULL` | A write failed for lack of disk in the last 10 min | Incident: expand the Render disk, then follow the 2026-10-12 incident record |
| `DB_STORAGE_WARNING` / `_ACTION_REQUIRED` / `_CRITICAL` | Estimated use ≥ 60 / 80 / 90 % | Check retention jobs are running; plan (80 %) or do (90 %) a disk resize; update `DATABASE_STORAGE_CAPACITY_GB` after a resize |
| `DB_STORAGE_RUNWAY_SHORT` | Fewer than 14 days to 80 % at the measured growth | Find the growing table (P1 report queries); confirm retention is enabled and not failing |
| `DB_STORAGE_SAMPLE_STALE` | The sampler has not succeeded for 15 min | `db_storage_sample_failed` logs (category); the level shown is not current |
| `FUTURES_MARK_STALE` | A contract's newest stored Mark is older than 5 s | Risk and liquidation fail closed by design; check Binance WS and `futures_mark_persist_failed` |
| `FUTURES_MARK_PERSIST_FAILING` | 3 consecutive failed Mark stores | Failure category in the logs; database health |
| `FUTURES_MARK_RETENTION_FAILING` / `FUTURES_LAST_PRICE_RETENTION_FAILING` | 3 consecutive failed futures retention runs | `ops_job_runs.result_json.failureKind`; the 24 h window grows while it fails |
| `FUTURES_MARK_RETENTION_BACKLOG` / `FUTURES_LAST_PRICE_RETENTION_BACKLOG` | 10 capped runs in a row | Deletion is not keeping up with the inflow; check run times and failures |
| `ASSET_PRICE_SNAPSHOT_RETENTION_FAILING` | 3 consecutive failed price snapshot retention runs | `failureKind` in the failed runs; set `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false` if it is causing load |
| `CRYPTO_ORDER_BOOK_HISTORY_PERSIST_FAILING` | 3 consecutive failed order-book history writes | Category in `crypto_order_book_history_persist_failed`; the realtime books are unaffected; set `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false` if the database needs the room |
| `CRYPTO_ORDER_BOOK_RETENTION_FAILING` / `_BACKLOG` | 3 failed or 10 capped order-book retention runs in a row | `ops_job_runs` (`failureKind`, `deleted`, `oldestRemaining`); stop recording first if the backlog grows |

`ASSET_PRICE_SNAPSHOT_RETENTION_BACKLOG` is a readiness reason but not an alert:
the first cleanup of the existing history runs at the capped pace for hours by
design, and growth that retention does not contain is paged by the `DB_STORAGE_`
codes. The same holds for the daily candle retention job
(`SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED`): `MARKET_CANDLE_RETENTION_FAILED`
(its latest run failed) and `MARKET_CANDLE_RETENTION_STALE` (no successful run in
26 h) are readiness reasons, with run counts in `ops_job_runs` and
`data.marketCandleRetention` on `/readiness`.

## 5. Why these thresholds

- 60/80/90 % is the operator policy; Render autoscaling acts at about 90 %.
- 5 s is the financial Mark freshness: beyond it, risk and liquidation fail closed
  with `FUTURES_MARK_UNAVAILABLE`.
- REST recovery starts at 3 s without a stored WS Mark, leaving 2 s of margin.
- Three failed futures retention runs are three minutes. Ten capped runs mean
  100,000 rows deleted while the backlog still grows.
- The price snapshot retention runs every 5 minutes: three failures are 15 minutes.

## 6. Asset price snapshot retention (`asset_price_snapshots`, 14 days)

Product policy (2026-10-16): ordinary price snapshots are kept 14 days. The
scheduled worker is **off by default**; enabling it in production starts deleting
the existing history and is an approved rollout step (P1 report §14).

- **Enable:** `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=true`. Optional:
  `ASSET_PRICE_SNAPSHOT_RETENTION_DAYS` (14–3650, default 14; never fewer than the
  policy), `..._BATCH_SIZE` (default 1000), `..._MAX_BATCHES` (per run, default 20).
- **Pace:** every 5 minutes one instance (Ops lease) sweeps the assets round-robin;
  each batch examines at most `BATCH_SIZE` rows of one asset in time order, has a
  5 s statement timeout and commits on its own. A run stops starting batches once
  it has examined `MAX_BATCHES × BATCH_SIZE` rows or after 60 s. Defaults examine
  (and so delete) at most 240,000 rows an hour; in steady state a run examines
  only the rows that crossed the cutoff since the previous one.
- **Kept regardless of age:** rows referenced by any financial record (9 RESTRICT
  foreign keys, also the final fence), each asset/source/exchange-local date's last
  row (close and holiday carry-forward evidence; it also keeps each source's newest
  row), the 20 newest positive rows per source before every Season end (settlement
  reads 10 per eligible source together), `admin_manual` rows, and rows created or
  captured in the last 2 days.
- **Observe:** `/readiness` `data.assetPriceRetention`, `ops_job_runs` rows with
  `deletedCount`, `scannedCount`, `batchCount`, `assetsSwept`, `batchLimitReached`.
- **Disk:** a DELETE does not shrink the table file. After VACUUM (autovacuum) the
  space is reused by new rows, so the file stops growing; shrinking it needs a
  rewrite (`VACUUM FULL`, `pg_repack`), which is a separate approved maintenance.
- **Rollback:** set the flag back to `false`. Deleted rows are not restored; every
  row that any financial record or reader could need was kept.

## 7. Crypto order-book history (`crypto_spot_order_book_snapshots`, `futures_order_book_snapshots`, 14 days)

Contract: [crypto-order-book-history-contract.md](crypto-order-book-history-contract.md).
Display-only 60 s samples of the Binance Spot and USDⓈ-M 10-level books; at
100 + 100 products at most 288,000 rows a day. **Off by default.**

- **Enable (after the disk decision):** `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=true`
  on every instance; the retention follows unless
  `CRYPTO_ORDER_BOOK_RETENTION_ENABLED` is set. No stream, Redis channel or
  financial path changes.
- **Pace:** the writer inserts once a minute (one statement per table, 5 s
  statement timeout); the retention runs every 5 minutes at :45 and deletes rows
  whose whole minute is older than 336 hours, at most 20,000 rows or 60 s a run.
- **Observe:** `/readiness` `data.cryptoOrderBookHistory` (recorder counts,
  `lastInsertedAt`, `consecutiveWriteFailures`; retention `lastResult` with
  `oldestRemaining`), `ops_job_runs` for `crypto_order_book_retention`.
- **Disk:** see the 2026-10-16 report for the measured bytes per row and the
  14-day size; like every DELETE, the space is reused after VACUUM, not returned.
- **Rollback:** `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false` stops new rows at once;
  leave `CRYPTO_ORDER_BOOK_RETENTION_ENABLED=true` for 14 days to empty the
  tables. The tables are never read by any financial path.
