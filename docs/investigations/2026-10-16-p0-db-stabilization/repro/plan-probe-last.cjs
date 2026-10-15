// Planner probe: Futures Last retention candidate query, prod SQL vs rewrite.
// Usage: node plan-probe-last.cjs <databaseUrl> <datasetEndNaiveUtc>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, end] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname.endsWith('_test'));
const E = Date.parse(end + 'Z');
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const GUARDS = `
    AND NOT EXISTS (SELECT 1 FROM futures_executions e WHERE e.last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_season_prices p WHERE p.last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM protection_children c WHERE c.futures_last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.registration_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.trigger_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM seasons s WHERE m.captured_at BETWEEN s.end_at - interval '10 seconds' AND s.end_at)`;
const OLD = `SELECT m.id FROM futures_last_price_snapshots m
  WHERE m.captured_at < $1 AND m.effective_at < $1 ${GUARDS}
    AND EXISTS (SELECT 1 FROM futures_last_price_snapshots newer
      WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
        AND newer.captured_at > m.captured_at)
  ORDER BY m.captured_at, m.id LIMIT $2 FOR UPDATE OF m SKIP LOCKED`;
const NEW = `SELECT m.id FROM futures_last_price_snapshots m
  WHERE m.captured_at < $1
    AND m.id <> ALL (ARRAY(
      SELECT n.id FROM futures_instruments i
      CROSS JOIN unnest(enum_range(NULL::"FuturesLastPriceSource")) AS s(source)
      CROSS JOIN LATERAL (SELECT x.id FROM futures_last_price_snapshots x
        WHERE x.instrument_id = i.id AND x.source >= s.source AND x.source <= s.source
        ORDER BY x.source DESC, x.captured_at DESC LIMIT 1) n)) ${GUARDS}
  ORDER BY m.captured_at, m.id LIMIT $2 FOR UPDATE OF m SKIP LOCKED`;
function shape(plan) {
  const nodes = [];
  const walk = (p) => {
    nodes.push(p['Node Type'] + (p['Relation Name'] ? `(${p['Relation Name']})` : ''));
    for (const c of p.Plans ?? []) walk(c);
  };
  walk(plan.Plan);
  return { cost: plan.Plan['Total Cost'], nodes: nodes.join(' > ') };
}
async function plan(c, sql, params) {
  const { rows } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  return shape(rows[0]['QUERY PLAN'][0]);
}
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  let cases = 0, oldBad = 0, newBad = 0;
  for (const hours of [24, 23.9, 23, 18, 12, 2]) {
    for (const limit of [1000, 10000]) {
      const params = [iso(E - hours * 3600000), limit];
      const o = await plan(c, OLD, params);
      const n = await plan(c, NEW, params);
      cases++;
      const tail = (x) => x.nodes.split('LockRows')[1] ?? x.nodes;
      const bad = (x) => /Sort|Hash|Seq Scan\(futures_last_price_snapshots\)/.test(tail(x));
      console.log(
        `${String(hours).padEnd(5)} ${String(limit).padEnd(6)} old=${String(o.cost).padEnd(11)} ${bad(o) ? 'SORT/HASH' : 'ordered  '} | new=${String(n.cost).padEnd(11)} ${bad(n) ? 'SORT/HASH' : 'ordered'}`,
      );
      if (bad(o)) { oldBad++; console.log('      old:', tail(o).slice(0, 220)); }
      if (bad(n)) { newBad++; console.log('      new:', tail(n).slice(0, 220)); }
    }
  }
  console.log(JSON.stringify({ cases, oldUnordered: oldBad, newUnordered: newBad }));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
