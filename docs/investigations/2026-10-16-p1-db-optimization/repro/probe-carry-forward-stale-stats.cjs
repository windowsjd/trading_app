// P1-B6: the same carry-forward read when the session window is NEWER than the
// last ANALYZE (production: analyze runs after ~10 % churn, so yesterday's US
// session can lie beyond the effective_at histogram). Clones the template,
// ANALYZEs, adds a 6.5 h window of Binance rows past every histogram bound,
// then EXPLAIN ANALYZEs both forms without re-ANALYZE.
// Usage: node probe-carry-forward-stale-stats.cjs <adminUrl> <templateDb>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [adminUrl, template] = process.argv.slice(2);
assert.ok(template.endsWith('_test'));
// equality: as shipped; range: asset_id range + ORDER BY asset_id (P0 tie fix);
// notin: source_type NOT IN the two other enum values (same rows, not indexable).
const shape = (variant) => `
  SELECT id FROM asset_price_snapshots
  WHERE ${variant === 'range' ? 'asset_id >= $1 AND asset_id <= $1' : 'asset_id = $1'}
    AND currency_code = 'USD'
    AND ${variant === 'notin' ? "source_type NOT IN ('admin_manual', 'official_batch')" : "source_type = 'provider_api'"}
    AND effective_at >= $2 AND effective_at <= $3 AND source_name = $4 AND price > 0
  ORDER BY ${variant === 'range' ? 'asset_id DESC, ' : ''}effective_at DESC, captured_at DESC, created_at DESC LIMIT 1`;
(async () => {
  const db = 'carry_stale_test';
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await a.query(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  await a.end();
  const u = new URL(adminUrl); u.pathname = '/' + db;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  await c.query('ANALYZE asset_price_snapshots');
  const { rows: [{ newest }] } = await c.query(`SELECT to_char(max(effective_at), 'YYYY-MM-DD"T"HH24:MI:SS') AS newest FROM asset_price_snapshots`);
  const open = new Date(Date.parse(newest + 'Z') + 3600000), close = new Date(+open + 6.5 * 3600000);
  const iso = (d) => d.toISOString().replace('Z', '');
  await c.query(`INSERT INTO asset_price_snapshots (id, asset_id, price, currency_code, source_type, source_name, effective_at, captured_at, raw_payload_json)
    SELECT gen_random_uuid()::text, a.id, 100, 'USD', 'provider_api', 'binance_spot_ws_ticker', t, t, '{"truncated":false}'::jsonb
    FROM assets a CROSS JOIN LATERAL (SELECT $1::timestamp + n * interval '6 seconds' AS t FROM generate_series(0, 3899) n) s
    WHERE a.asset_type = 'crypto'`, [iso(open)]);
  const { rows: [{ id }] } = await c.query(`SELECT id FROM assets WHERE asset_type = 'us_stock' LIMIT 1`);
  const out = {};
  const { rows: [{ cid }] } = await c.query(`SELECT id AS cid FROM assets WHERE asset_type = 'crypto' ORDER BY id LIMIT 1`);
  for (const name of ['equality', 'range', 'notin']) for (const [label, assetId, source] of [['us_no_rows', id, 'kis_us_delayed_trade'], ['crypto_rows', cid, 'binance_spot_ws_ticker']]) {
    const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${shape(name)}`, [assetId, iso(open), iso(close), source]);
    const plan = rows[0]['QUERY PLAN'][0];
    const idx = new Set();
    const walk = (p) => { if (p['Relation Name'] === 'asset_price_snapshots') idx.add(p['Index Name'] ?? p['Node Type']); for (const k of p.Plans ?? []) walk(k); };
    walk(plan.Plan);
    out[`${name}/${label}`] = { index: [...idx].join('+'), rows: plan.Plan['Actual Rows'], buffers: plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks'], ms: plan['Execution Time'], estimatedCost: plan.Plan['Total Cost'] };
  }
  console.log(JSON.stringify({ window: [open, close], insertedRows: 25 * 3900, ...out }));
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await z.end();
})().catch((e) => { console.error(e); process.exit(1); });
