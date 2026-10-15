# Database, Futures Mark collection and retention monitoring

Operational signals added by the P0 database stabilization (2026-10-16). They
**detect** problems; **delivering** an alert to a person needs the operator setup
in §3. Nothing here is a financial input: risk, liquidation, valuation and
execution always read PostgreSQL evidence.

Background: the production database filled its 5 GB disk on 2026-10-12 and was
unwritable for about 8 hours with no alert
([incident](../../docs/investigations/2026-10-12-db-disk-full-incident/report.md)).

## 1. Signals

| Signal | Produced by | Threshold | `/readiness` reason | Log event (JSON `event`) |
|---|---|---|---|---|
| Disk usage | `DatabaseStorageMonitorService` (opt-in, §3.1): `pg_database_size` every 5 min, first sample 30 s after start | ≥ 60 % warning, ≥ 80 % action required, ≥ 90 % critical, against `DATABASE_STORAGE_CAPACITY_GB` | `DB_STORAGE_WARNING` / `DB_STORAGE_ACTION_REQUIRED` / `DB_STORAGE_CRITICAL` | `db_storage_level` on every level change; repeated every 6 h (warning), 1 h (action required) or every sample (critical) |
| Daily growth / runway | same, from this process's own samples (window ≥ 1 h for growth, ≥ 6 h for runway, at most 24 h) | fewer than 14 days until 80 % | `DB_STORAGE_RUNWAY_SHORT` | `db_storage_runway_short` (every 6 h) |
| Futures Mark freshness | `FuturesMarkIngestion`, in process; no database query | any target's newest STORED Mark older than 5 s (`MARK_MAX_AGE_MS`), after a 5 s grace for a new target or process | `FUTURES_MARK_STALE` | `futures_mark_stale` (once a minute while stale), `futures_mark_fresh_again` |
| Mark write failures | same | 3 consecutive failed stores | `FUTURES_MARK_PERSIST_FAILING` | `futures_mark_persist_failed` (once a minute per category) |
| Retention failures | `futures_mark_retention`, `futures_last_price_retention` workers | 3 consecutive failed runs (one run per minute) | `FUTURES_MARK_RETENTION_FAILING`, `FUTURES_LAST_PRICE_RETENTION_FAILING` | `futures_retention_failing` (every 5 min), `futures_retention_recovered` |
| Retention backlog | same | 10 consecutive runs that hit the per-run cap (10 batches) | `FUTURES_MARK_RETENTION_BACKLOG`, `FUTURES_LAST_PRICE_RETENTION_BACKLOG` | `futures_retention_backlog` |
| Disk full on write | Mark ingestion and both retention workers (SQLSTATE 53100 / "No space left on device") | any, reported for 10 min after the last one | `DB_DISK_FULL` | `db_disk_full` (error) |
| Database unreachable | existing readiness `SELECT 1` | any | `CANDLE_DB_UNAVAILABLE` (existing), `status: unavailable` | — |

Failure categories (`kind`, and `ops_job_runs.result_json.failureKind` for a failed
retention run): `disk_full`, `statement_timeout`, `lock_timeout`, `connection`,
`data_rejected`, `database_error`, `lease_lost`, `unknown`. A failed retention run
also records the `deletedCount`/`batchCount` its committed batches reached. Driver
messages, SQL and parameters are never logged or stored.

Limits of the signals:
- Disk usage is the database size (`pg_database_size`). It excludes WAL, temp files
  and filesystem overhead, which also use the disk. That is why the capacity is read
  as decimal GB (the conservative side). Render's disk metric remains the
  authoritative usage. About 0.25 GB of difference was measured on 2026-10-15.
- Growth is unknown for the first hour after every restart or deploy, because the
  samples live in memory.
- Mark freshness is this instance's view of the rows it stored. A restarted
  process reports targets as missing until its first rows are stored (5 s grace).

## 2. Where to read them

- `GET /readiness` (public): `data.reasons`, `data.futuresMark`,
  `data.futuresRetention.{mark,last}`, `data.databaseStorage`.
  - These reasons set `status: degraded` but keep HTTP 200 and `success: true`.
    Only an unreachable database makes readiness `unavailable`.
  - The Render web service has **no health check path** configured (verified
    2026-10-16), so a degraded readiness never restarts or blocks a deploy.
- Render logs: search for the `event` names above.
- Durable history (read-only):

```sql
-- Latest retention runs with failure category and committed progress.
SELECT job_name, status, started_at,
       result_json->>'failureKind'  AS failure_kind,
       result_json->>'deletedCount' AS deleted,
       result_json->>'batchLimitReached' AS at_cap
FROM ops_job_runs
WHERE job_name IN ('futures_mark_retention', 'futures_last_price_retention')
ORDER BY started_at DESC
LIMIT 30;
```

## 3. Operator setup (not done by code)

Render notifies only about a **service persistent disk** above 80 %. It sends no
Postgres storage notification; Postgres has the dashboard Storage graph and
optional autoscaling ([notifications](https://render.com/docs/notifications),
[storage](https://render.com/tutorials/postgres-on-render/storage-and-autoscaling)).
None of the signals above reaches a person until an operator does the following.

1. **Enable the disk sampler** on the Render web service:
   `DATABASE_STORAGE_MONITOR_ENABLED=true` and `DATABASE_STORAGE_CAPACITY_GB=50`
   (the current disk). Change the capacity after every resize. Startup rejects any
   value other than `true`/`false`, or a capacity outside 1–16384.
2. **Poll readiness from an external monitor** every 1–5 minutes. Any HTTP keyword
   monitor works; the repository provides none.
   - Alert when `GET /readiness` returns non-200 or its body contains any of:
     `DB_STORAGE_`, `DB_DISK_FULL`, `FUTURES_MARK_STALE`,
     `FUTURES_MARK_PERSIST_FAILING`, `RETENTION_FAILING`, `RETENTION_BACKLOG`.
   - Alert on these keywords, not on `degraded`: readiness also degrades for
     unrelated reasons, such as the provisional calendar.
3. Optional:
   - Stream Render logs to a provider that can alert on the log events.
   - Use the Render Datadog integration for disk metrics.
4. **Decide on Postgres storage autoscaling.** At about 90 % it grows the disk by
   about 50 %. It is billed, and a disk can never shrink. It was off during the
   incident, and the P0 work did not enable it.
5. **Keep heavy analysis off the production database.** Use `BEGIN READ ONLY`, a
   `statement_timeout`, index-range or `TABLESAMPLE` reads, and no `EXPLAIN ANALYZE`
   of deletes. Run large analyses on a restored copy.

### Verification after deploy and step 1

1. Within a minute `/readiness` shows `databaseStorage.enabled: true`,
   `capacityConfigured: true`, and a `usedPercent` close to Render's usage minus
   about 0.25 GB.
2. `futuresMark.enabled: true`, `targets` equals the active contracts, and
   `staleTargets: 0` with `oldestStoredAgeMs` under 3000.
3. `futuresRetention.mark.lastSucceededAt` and `.last.lastSucceededAt` are under
   two minutes old, with `consecutiveFailures: 0`.
4. Render logs show no `futures_mark_stale` in steady state.
5. Alert path test: point a staging or local instance at a capacity below its
   database size. `DB_STORAGE_CRITICAL` should appear and the monitor should fire.
   Do not do this in production without coordinating.

## 4. Why these thresholds

- 60/80/90 % is the operator policy; Render autoscaling acts at about 90 %.
- 5 s is the financial Mark freshness: beyond it, risk and liquidation fail closed
  with `FUTURES_MARK_UNAVAILABLE`.
- REST recovery starts at 3 s without a stored WS Mark, leaving 2 s of margin.
- Three failed retention runs are three minutes. Ten capped runs mean 100,000 rows
  deleted while the backlog still grows.
