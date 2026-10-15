// Production READ-ONLY check (P0-A2/A3, P1-B5 inputs). Session options force
// read-only transactions, statement_timeout 20 s and lock_timeout 1 s; every
// query is catalog/statistics or an index-bounded range. Prints counts, sizes
// and timings only (no row contents, credentials or user identifiers).
// Usage: DATABASE_URL=<production> node prod-readonly-check.cjs [label]
const { Client } = require('pg');
const label = process.argv[2] ?? 'sample';
(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const q = async (name, sql, params = []) => {
    const t = Date.now();
    try {
      const { rows } = await c.query(sql, params);
      return { name, ms: Date.now() - t, rows };
    } catch (e) {
      return { name, ms: Date.now() - t, error: e.code ?? 'error' };
    }
  };
  const out = { label, at: new Date().toISOString(), results: [] };
  const push = async (...args) => out.results.push(await q(...args));
  await push('server', `SELECT current_setting('server_version') AS version, now() AS now, pg_database_size(current_database())::bigint AS db_bytes,
      current_setting('max_wal_size') AS max_wal_size, current_setting('checkpoint_timeout') AS checkpoint_timeout`);
  await push('tables', `SELECT relname, pg_relation_size(relid)::bigint AS heap, pg_indexes_size(relid)::bigint AS idx,
      pg_total_relation_size(relid)::bigint AS total, n_live_tup::bigint AS live, n_dead_tup::bigint AS dead,
      n_tup_ins::bigint AS ins, n_tup_upd::bigint AS upd, n_tup_del::bigint AS del, seq_scan::bigint, idx_scan::bigint,
      last_autovacuum, last_autoanalyze
    FROM pg_stat_user_tables WHERE relname IN ('asset_price_snapshots','futures_mark_snapshots','futures_last_price_snapshots',
      'asset_orderbook_snapshots','market_candles','market_candle_sync_states','ops_job_runs','futures_season_prices') ORDER BY total DESC`);
  await push('statio', `SELECT relname, heap_blks_read::bigint, heap_blks_hit::bigint, idx_blks_read::bigint, idx_blks_hit::bigint
    FROM pg_statio_user_tables WHERE relname IN ('asset_price_snapshots','futures_mark_snapshots','futures_last_price_snapshots')`);
  await push('wal', `SELECT wal_records::bigint, wal_fpi::bigint, wal_bytes::bigint, stats_reset FROM pg_stat_wal`);
  await push('database', `SELECT xact_commit::bigint, blks_read::bigint, blks_hit::bigint, temp_files::bigint, temp_bytes::bigint, stats_reset
    FROM pg_stat_database WHERE datname = current_database()`);
  await push('index_usage', `SELECT indexrelname, idx_scan::bigint, pg_relation_size(indexrelid)::bigint AS bytes FROM pg_stat_user_indexes
    WHERE relname IN ('asset_price_snapshots','futures_mark_snapshots','futures_last_price_snapshots','asset_orderbook_snapshots') ORDER BY relname, indexrelname`);
  // Futures retention runs per hour since 2026-10-15 12:00Z (P0 deploy ~19:10Z).
  await push('futures_retention_hourly', `SELECT job_name, date_trunc('hour', started_at) AS hour, status::text, count(*)::int AS runs,
      sum((result_json->>'deletedCount')::bigint)::bigint AS deleted, max(duration_ms)::int AS max_ms,
      count(*) FILTER (WHERE (result_json->>'batchLimitReached')::boolean)::int AS capped,
      string_agg(DISTINCT result_json->>'failureKind', ',') AS failure_kinds
    FROM ops_job_runs WHERE job_name IN ('futures_mark_retention','futures_last_price_retention') AND started_at >= '2026-10-15 12:00'
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  // Backlog: oldest kept receipt per table against the 24 h window.
  await push('futures_oldest', `SELECT 'mark' AS t, (SELECT captured_at FROM futures_mark_snapshots ORDER BY captured_at, id LIMIT 1) AS oldest
    UNION ALL SELECT 'last', (SELECT captured_at FROM futures_last_price_snapshots ORDER BY captured_at, id LIMIT 1)`);
  // Mark persistence gaps > 5 s per hour for the two busiest contracts (index range per contract).
  await push('mark_gaps_hourly', `WITH inst AS (SELECT i.id, a.symbol FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id
        WHERE a.symbol IN ('BTCUSDT','ETHUSDT','BTC','ETH') AND i.is_active), w AS (
      SELECT inst.symbol, s.effective_at, s.effective_at - lag(s.effective_at) OVER (PARTITION BY s.instrument_id ORDER BY s.effective_at) AS gap
      FROM inst JOIN futures_mark_snapshots s ON s.instrument_id = inst.id
      WHERE s.source IN ('binance_usdm_mark_ws','binance_usdm_mark_rest') AND s.effective_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours')
    SELECT symbol, date_trunc('hour', effective_at) AS hour, count(*)::int AS rows,
      count(*) FILTER (WHERE gap > interval '5 seconds')::int AS gaps_over_5s, max(extract(epoch FROM gap))::numeric(10,2) AS max_gap_s
    FROM w GROUP BY 1, 2 ORDER BY 1, 2`);
  // P1-B5 growth inputs: ops_job_runs and sync states written in the last 24 h.
  await push('ops_runs_24h', `SELECT job_name::text, status::text, count(*)::int AS runs, coalesce(sum(pg_column_size(result_json)), 0)::bigint AS result_bytes
    FROM ops_job_runs WHERE started_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours' GROUP BY 1, 2 ORDER BY runs DESC`);
  await push('sync_states_24h', `SELECT feed, mode::text, status::text, error_code, count(*)::int AS rows
    FROM market_candle_sync_states WHERE updated_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours' GROUP BY 1, 2, 3, 4 ORDER BY rows DESC LIMIT 20`);
  // P1-B1 input: planner estimate (no execution) of rows older than 14 days.
  await push('older_than_14d_estimate', `EXPLAIN (FORMAT JSON) SELECT 1 FROM asset_price_snapshots WHERE effective_at < (now() AT TIME ZONE 'UTC') - interval '14 days'`);
  await push('price_sources', `SELECT most_common_vals::text AS vals, most_common_freqs::text AS freqs FROM pg_stats
    WHERE tablename = 'asset_price_snapshots' AND attname = 'source_name'`);
  await c.query('ROLLBACK');
  await c.end();
  console.log(JSON.stringify(out));
})().catch((e) => { console.error(e.code ?? e.name ?? 'error'); process.exit(1); });
