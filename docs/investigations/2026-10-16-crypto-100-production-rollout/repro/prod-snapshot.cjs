// Production READ-ONLY snapshot for the crypto 100+100 rollout. Session options force
// read-only transactions, statement_timeout 20 s and lock_timeout 1 s. Prints counts,
// symbols and timestamps only (no user identifiers, balances or credentials).
// Usage: TZ=UTC DATABASE_URL=<production> node prod-snapshot.cjs <label> <out.json> [allowlist ids csv]
const { Client } = require('pg');
const fs = require('node:fs');
const [label = 'sample', outFile, allowlistCsv = ''] = process.argv.slice(2);
(async () => {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    options: '-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000',
    ssl: { rejectUnauthorized: false },
  });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const out = { label, at: new Date().toISOString(), results: {} };
  const q = async (name, sql, params = []) => {
    const t = Date.now();
    await c.query('SAVEPOINT q');
    try {
      const { rows } = await c.query(sql, params);
      out.results[name] = { ms: Date.now() - t, rows };
      await c.query('RELEASE SAVEPOINT q');
    } catch (e) {
      out.results[name] = { ms: Date.now() - t, error: e.code ?? String(e.message).slice(0, 120) };
      await c.query('ROLLBACK TO SAVEPOINT q');
    }
  };
  await q('server', `SELECT now() AS now, current_setting('server_version') AS version`);
  await q('migrations_last', `SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations ORDER BY started_at DESC LIMIT 4`);
  await q('migrations_summary', `SELECT count(*)::int AS total, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished, count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS rolled_back FROM _prisma_migrations`);
  await q('crypto_assets', `SELECT symbol, is_active, id, created_at FROM assets WHERE market = 'BINANCE' AND asset_type = 'crypto' ORDER BY created_at, symbol`);
  await q('futures_instruments', `SELECT a.symbol, i.is_active, i.product_type::text, i.settlement_currency::text, i.mark_verified_at IS NOT NULL AS mark_verified, i.id, i.created_at
    FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id ORDER BY i.created_at, a.symbol`);
  if (allowlistCsv) {
    await q('allowlist_assets', `SELECT id, symbol, market, asset_type::text, is_active FROM assets WHERE id = ANY($1::text[]) ORDER BY asset_type, symbol`, [allowlistCsv.split(',')]);
  }
  await q('spot_candle_coverage', `SELECT a.symbol, c.interval, count(*)::int AS n, min(c.open_time) AS min_open, max(c.open_time) AS max_open
    FROM market_candles c JOIN assets a ON a.id = c.asset_id WHERE a.market = 'BINANCE' AND a.asset_type = 'crypto' GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('futures_candle_coverage', `SELECT a.symbol, f.interval, count(*)::int AS n, min(f.open_time) AS min_open, max(f.open_time) AS max_open
    FROM futures_market_candles f JOIN futures_instruments i ON i.id = f.futures_instrument_id JOIN assets a ON a.id = i.underlying_asset_id GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('sync_states_crypto', `SELECT s.feed::text, s.status::text, s.mode::text, count(*)::int AS n, max(s.updated_at) AS last_update
    FROM market_candle_sync_states s JOIN assets a ON a.id = s.asset_id WHERE a.market = 'BINANCE' AND a.asset_type = 'crypto' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
  await q('crypto_holdings', `SELECT a.symbol, count(*)::int AS holders FROM positions p JOIN assets a ON a.id = p.asset_id
    WHERE a.market = 'BINANCE' AND a.asset_type = 'crypto' AND p.quantity > 0 GROUP BY 1 ORDER BY 1`);
  await q('orders_status', `SELECT a.asset_type::text, o.status::text, count(*)::int AS n FROM orders o JOIN assets a ON a.id = o.asset_id GROUP BY 1, 2 ORDER BY 1, 2`);
  for (const t of ['conditional_buy_orders', 'conditional_sell_orders', 'limit_on_close_orders', 'entry_tp_sl_plans', 'futures_limit_orders', 'futures_conditional_entries', 'futures_tp_sl_settings']) {
    await q(`status_${t}`, `SELECT status::text, count(*)::int AS n FROM ${t} GROUP BY 1 ORDER BY 1`);
  }
  await q('futures_positions_open', `SELECT a.symbol, p.status::text, count(*)::int AS n FROM futures_positions p JOIN futures_instruments i ON i.id = p.instrument_id
    JOIN assets a ON a.id = i.underlying_asset_id GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('ops_jobs_24h', `SELECT job_name::text, status::text, count(*)::int AS n, max(started_at) AS last_started FROM ops_job_runs
    WHERE started_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours' GROUP BY 1, 2 ORDER BY 1, 2`);
  await q('order_book_history_rows', `SELECT (SELECT count(*) FROM crypto_spot_order_book_snapshots)::int AS spot, (SELECT count(*) FROM futures_order_book_snapshots)::int AS futures`);
  await q('wallets_ledger_counts', `SELECT (SELECT count(*) FROM wallet_transactions)::int AS wallet_tx, (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM futures_positions)::int AS futures_positions, (SELECT count(*) FROM positions)::int AS positions`);
  await c.query('ROLLBACK');
  await c.end();
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  for (const [k, v] of Object.entries(out.results)) console.log(k, v.error ? `ERROR ${v.error}` : `${v.rows.length} rows ${v.ms}ms`);
})().catch((e) => { console.error('snapshot failed', e.code ?? e.message); process.exit(1); });
