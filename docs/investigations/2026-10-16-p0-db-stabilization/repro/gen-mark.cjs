// Synthetic prod-like futures_mark_snapshots history in an ISOLATED local PG17.
// Usage: node gen-mark.cjs <databaseUrl> <instrumentCount> <hours>
// Writes `hours` of history as prod does (1 ws row/s per instrument, sparse
// REST rows), keeping a sliding 24 h window with retention-style deletes and a
// VACUUM every 4 simulated hours, so index bloat matches 24 h churn.
const { Client } = require('pg');
const assert = require('node:assert/strict');

const [url, countArg, hoursArg] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname), 'loopback only');
assert.ok(u.pathname.endsWith('_test'), '*_test database only');
const count = Number(countArg ?? 25);
const hours = Number(hoursArg ?? 48);
// REST rows per instrument: every restEvery s for the first restShare of instruments (0 = none).
const restEvery = Number(process.argv[5] ?? 300);
const restShare = Number(process.argv[6] ?? 1);

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  // Fixed end time: data covers (end - hours, end]. Stored as naive UTC.
  // Naive UTC as text: node-pg would read a timestamp without time zone as local time.
  const { rows: [{ end }] } = await c.query(
    "SELECT to_char(date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS end",
  );
  const endIso = new Date(end + 'Z').toISOString();
  console.log('end', endIso);
  await c.query(`ALTER TABLE futures_mark_snapshots SET (autovacuum_enabled = false)`);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const symbol = `PERF${String(i).padStart(3, '0')}USDT`;
    const { rows: [a] } = await c.query(
      `INSERT INTO assets (id, symbol, name, market, currency_code, price_currency, settlement_currency, asset_type, updated_at)
       VALUES (gen_random_uuid()::text, $1, $1, 'BINANCE', 'USD', 'USD', 'USD', 'crypto', now())
       ON CONFLICT (market, symbol) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [symbol],
    );
    const { rows: [f] } = await c.query(
      `INSERT INTO futures_instruments (id, underlying_asset_id, updated_at)
       VALUES (gen_random_uuid()::text, $1, now())
       ON CONFLICT (underlying_asset_id, product_type, settlement_currency) DO UPDATE SET is_active = true RETURNING id`,
      [a.id],
    );
    ids.push({ id: f.id, symbol });
  }
  const startMs = Date.parse(endIso) - hours * 3600000;
  const t0 = performance.now();
  for (let h = 0; h < hours; h++) {
    const from = new Date(startMs + h * 3600000).toISOString();
    // One row per second per instrument, in time order across instruments
    // (prod drains all symbols each second). Fixed per-instrument ms jitter.
    await c.query(
      `INSERT INTO futures_mark_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
       SELECT gen_random_uuid()::text, t.id, t.symbol, 'binance_usdm_mark_ws', 100 + (s % 97),
              $1::timestamp + s * interval '1 second' + t.j * interval '1 millisecond',
              $1::timestamp + s * interval '1 second' + (t.j + 70) * interval '1 millisecond'
       FROM generate_series(0, 3599) s
       CROSS JOIN LATERAL (SELECT x.id, x.symbol, x.j FROM jsonb_to_recordset($2::jsonb) AS x(id text, symbol text, j int)) t
       ORDER BY s, t.id`,
      [from, JSON.stringify(ids.map((x, i) => ({ ...x, j: (i * 7) % 50 })))],
    );
    // Sparse REST recovery rows.
    if (restEvery > 0) await c.query(
      `INSERT INTO futures_mark_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
       SELECT gen_random_uuid()::text, t.id, t.symbol, 'binance_usdm_mark_rest', 100,
              $1::timestamp + s * interval '1 second' + interval '500 milliseconds',
              $1::timestamp + s * interval '1 second' + interval '700 milliseconds'
       FROM generate_series(0, 3599, $3::int) s
       CROSS JOIN LATERAL (SELECT x.id, x.symbol FROM jsonb_to_recordset($2::jsonb) AS x(id text, symbol text)) t
       ORDER BY s, t.id`,
      [from, JSON.stringify(ids.slice(0, Math.round(ids.length * restShare))), Math.min(restEvery, 3600)],
    );
    if (h >= 24) {
      // Sliding 24 h window: delete the oldest hour in captured_at order.
      const cutoff = new Date(startMs + (h - 23) * 3600000).toISOString();
      await c.query(`DELETE FROM futures_mark_snapshots WHERE captured_at < $1`, [cutoff]);
      if ((h - 24) % 4 === 3) await c.query('VACUUM futures_mark_snapshots');
    }
    if (h % 6 === 5) console.log(`hour ${h + 1}/${hours} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  await c.query('ANALYZE futures_mark_snapshots');
  const { rows: [stat] } = await c.query(
    `SELECT (SELECT count(*) FROM futures_mark_snapshots) AS rows,
            pg_relation_size('futures_mark_snapshots') AS heap,
            pg_relation_size('futures_mark_snapshots_instrument_id_source_effective_at_key') AS uniq,
            pg_relation_size('futures_mark_snapshots_captured_at_id_idx') AS captured,
            pg_relation_size('futures_mark_snapshots_instrument_id_effective_at_idx') AS inst_eff,
            pg_relation_size('futures_mark_snapshots_pkey') AS pkey,
            (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname = 'futures_mark_snapshots') AS dead`,
  );
  console.log(JSON.stringify({ end: endIso, instruments: count, ...stat }));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
