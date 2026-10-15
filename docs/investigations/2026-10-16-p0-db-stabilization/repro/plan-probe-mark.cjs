// Planner probe: Futures Mark retention candidate query, previous production SQL
// (HEAD 4f5c4dda) vs the 2026-10-16 statement, across cutoffs and batch sizes.
// EXPLAIN only (nothing executes). ISOLATED local *_test database only.
// Usage: node plan-probe-mark.cjs <databaseUrl> <datasetEndNaiveUtc>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, end] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname.endsWith('_test'));
const E = Date.parse(end + 'Z');
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const OLD = `SELECT m.id FROM futures_mark_snapshots m
  WHERE m.captured_at < $1 AND m.effective_at < $1
    AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
    AND EXISTS (SELECT 1 FROM futures_mark_snapshots newer
      WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
        AND newer.effective_at > m.effective_at)
  ORDER BY m.captured_at, m.id LIMIT $2 FOR UPDATE OF m SKIP LOCKED`;
// Candidate part of futuresMarkRetentionBatchSql (the DELETE wraps it).
const NEW = `SELECT m.id FROM futures_mark_snapshots m
  WHERE m.captured_at < $1
    AND m.id <> ALL (ARRAY(
      SELECT newest.id FROM futures_instruments i
      CROSS JOIN unnest(enum_range(NULL::"FuturesMarkSource")) AS s(source)
      CROSS JOIN LATERAL (SELECT n.id FROM futures_mark_snapshots n
        WHERE n.instrument_id = i.id AND n.source >= s.source AND n.source <= s.source
        ORDER BY n.source DESC, n.effective_at DESC LIMIT 1) newest))
    AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
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
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const plan = async (sql, params) =>
    shape((await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0]);
  const bad = (x) => {
    const tail = x.nodes.split('LockRows')[1] ?? x.nodes;
    return /Sort|Hash|Seq Scan\(futures_mark_snapshots\)/.test(tail);
  };
  let oldBad = 0, newBad = 0, cases = 0;
  for (const hours of [24, 23.9, 23, 18, 12, 2]) {
    for (const limit of [1000, 10000]) {
      const params = [iso(E - hours * 3600000), limit];
      const o = await plan(OLD, params);
      const n = await plan(NEW, params);
      cases++;
      if (bad(o)) oldBad++;
      if (bad(n)) newBad++;
      console.log(`${String(hours).padEnd(5)} ${String(limit).padEnd(6)} old=${bad(o) ? 'SORT/HASH/SEQ' : 'ordered      '} cost=${String(o.cost).padEnd(10)} | new=${bad(n) ? 'SORT/HASH/SEQ' : 'ordered'} cost=${n.cost}`);
      if (bad(o)) console.log('      old:', (o.nodes.split('LockRows')[1] ?? o.nodes).slice(0, 200));
      if (bad(n)) console.log('      new:', (n.nodes.split('LockRows')[1] ?? n.nodes).slice(0, 200));
    }
  }

  console.log(JSON.stringify({ cases, oldUnordered: oldBad, newUnordered: newBad }));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
