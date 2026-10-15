// Synthetic prod-like futures_last_price_snapshots history in an ISOLATED local PG.
// Usage: node gen-last.cjs <databaseUrl> <instrumentCount> <hours>
// ~1 aggTrade row/s per instrument (trade time 50 ms before receipt) and REST
// re-confirmations every 45 s (~2.2 %, as in prod), sliding 24 h window with a
// VACUUM every 4 simulated hours. One far-future active Season, as in prod.
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, countArg, hoursArg] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname.endsWith('_test'));
const count = Number(countArg ?? 25);
const hours = Number(hoursArg ?? 48);
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows: [{ end }] } = await c.query(
    "SELECT to_char(date_trunc('second', clock_timestamp() AT TIME ZONE 'UTC'), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS end",
  );
  const endMs = Date.parse(end + 'Z');
  console.log('end', end);
  await c.query(`ALTER TABLE futures_last_price_snapshots SET (autovacuum_enabled = false)`);
  await c.query(
    `INSERT INTO seasons (id, name, status, start_at, end_at, initial_capital_krw, trade_fee_rate, fx_fee_rate, updated_at)
     VALUES (gen_random_uuid()::text, 'perf season', 'active', '2000-01-01', '2099-12-31', 10000000, 0.001, 0.001, now())`,
  );
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
    ids.push({ id: f.id, symbol, j: (i * 7) % 50 });
  }
  const startMs = endMs - hours * 3600000;
  const t0 = performance.now();
  for (let h = 0; h < hours; h++) {
    const from = new Date(startMs + h * 3600000).toISOString().replace('Z', '');
    await c.query(
      `INSERT INTO futures_last_price_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
       SELECT gen_random_uuid()::text, t.id, t.symbol, 'binance_usdm_agg_trade_ws', 100 + (s % 97),
              $1::timestamp + s * interval '1 second' + t.j * interval '1 millisecond',
              $1::timestamp + s * interval '1 second' + (t.j + 50) * interval '1 millisecond'
       FROM generate_series(0, 3599) s
       CROSS JOIN LATERAL (SELECT x.id, x.symbol, x.j FROM jsonb_to_recordset($2::jsonb) AS x(id text, symbol text, j int)) t
       ORDER BY s, t.id`,
      [from, JSON.stringify(ids)],
    );
    await c.query(
      `INSERT INTO futures_last_price_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
       SELECT gen_random_uuid()::text, t.id, t.symbol, 'binance_usdm_ticker_price_rest', 100,
              $1::timestamp + s * interval '1 second' - interval '2 seconds',
              $1::timestamp + s * interval '1 second' + interval '700 milliseconds'
       FROM generate_series(0, 3599, 45) s
       CROSS JOIN LATERAL (SELECT x.id, x.symbol FROM jsonb_to_recordset($2::jsonb) AS x(id text, symbol text)) t
       ORDER BY s, t.id`,
      [from, JSON.stringify(ids)],
    );
    if (h >= 24) {
      const cutoff = new Date(startMs + (h - 23) * 3600000).toISOString().replace('Z', '');
      await c.query(`DELETE FROM futures_last_price_snapshots WHERE captured_at < $1`, [cutoff]);
      if ((h - 24) % 4 === 3) await c.query('VACUUM futures_last_price_snapshots');
    }
    if (h % 12 === 11) console.log(`hour ${h + 1}/${hours} ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  await c.query('ANALYZE futures_last_price_snapshots');
  const { rows: [stat] } = await c.query(
    `SELECT (SELECT count(*) FROM futures_last_price_snapshots) AS rows,
            pg_relation_size('futures_last_price_snapshots') AS heap,
            pg_indexes_size('futures_last_price_snapshots') AS idx`,
  );
  console.log(JSON.stringify({ end, instruments: count, ...stat }));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
