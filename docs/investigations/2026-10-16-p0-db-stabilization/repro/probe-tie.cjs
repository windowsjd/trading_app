// Plan stability of the retention newest-row-per-pair probe across repeated
// ANALYZE samples, on a fresh TEMPLATE clone in an ISOLATED local PostgreSQL.
// equality: source = s.source ORDER BY time DESC (first 2026-10-16 draft)
// range:    source >= s.source AND source <= s.source ORDER BY source, time DESC (final)
// Usage: node probe-tie.cjs <adminUrl> <templateDb> <mark|last> <rounds>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [adminUrl, template, table, rounds] = process.argv.slice(2);
assert.ok(template.endsWith('_test') && ['mark', 'last'].includes(table));
const T = table === 'mark' ? 'futures_mark_snapshots' : 'futures_last_price_snapshots';
const ENUM = table === 'mark' ? 'FuturesMarkSource' : 'FuturesLastPriceSource';
const TIME = table === 'mark' ? 'effective_at' : 'captured_at';
const V = {
  equality: `SELECT newest.id FROM futures_instruments i
    CROSS JOIN unnest(enum_range(NULL::"${ENUM}")) AS s(source)
    CROSS JOIN LATERAL (SELECT n.id FROM ${T} n
      WHERE n.instrument_id = i.id AND n.source = s.source
      ORDER BY n.${TIME} DESC LIMIT 1) newest`,
  range: `SELECT newest.id FROM futures_instruments i
    CROSS JOIN unnest(enum_range(NULL::"${ENUM}")) AS s(source)
    CROSS JOIN LATERAL (SELECT n.id FROM ${T} n
      WHERE n.instrument_id = i.id AND n.source >= s.source AND n.source <= s.source
      ORDER BY n.source DESC, n.${TIME} DESC LIMIT 1) newest`,
};
(async () => {
  const db = `probe_tie_${table}_test`;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${db}`);
  await a.query(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  await a.end();
  const u = new URL(adminUrl);
  u.pathname = '/' + db;
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  const tally = { equality: {}, range: {} };
  const worst = { equality: 0, range: 0 };
  for (let r = 0; r < Number(rounds); r++) {
    await c.query(`ANALYZE ${T}`);
    for (const [name, sql] of Object.entries(V)) {
      const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      const plan = rows[0]['QUERY PLAN'][0];
      const idx = new Set();
      const walk = (p) => {
        if (p['Relation Name'] === T) idx.add(p['Index Name'] ? p['Index Name'].replace(`${T}_`, '') : p['Node Type']);
        for (const k of p.Plans ?? []) walk(k);
      };
      walk(plan.Plan);
      const key = [...idx].sort().join('+') || 'none';
      tally[name][key] = (tally[name][key] ?? 0) + 1;
      worst[name] = Math.max(worst[name], plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks']);
    }
  }
  console.log(JSON.stringify({ template, table, rounds: Number(rounds), choice: tally, worstBuffers: worst }));
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db}`);
  await z.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
