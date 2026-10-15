// Old Mark freshness groupBy (exact Prisma SQL shape) vs per-instrument LATERAL
// LIMIT 1, EXPLAIN (ANALYZE, BUFFERS) on an ISOLATED local PG.
// Usage: node measure-freshness.cjs <databaseUrl> <datasetEndNaiveUtc> [runs]
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, end, runsArg] = process.argv.slice(2);
const u = new URL(url);
assert.ok(['127.0.0.1', 'localhost'].includes(u.hostname) && u.pathname.endsWith('_test'));
const runs = Number(runsArg ?? 3);

function buffers(plan) {
  const p = plan[0].Plan;
  return {
    hit: p['Shared Hit Blocks'],
    read: p['Shared Read Blocks'],
    total: p['Shared Hit Blocks'] + p['Shared Read Blocks'],
    rows: p['Actual Rows'],
    ms: plan[0]['Execution Time'],
  };
}
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows: inst } = await c.query(
    `SELECT id FROM futures_instruments ORDER BY id`,
  );
  const ids = inst.map((r) => r.id);
  const cutoff = `${end}`; // replaced per run below
  const out = { instruments: ids.length, groupBy: [], lateral: [] };
  for (let i = 0; i < runs; i++) {
    // Same shape as the prod slow log: IN ($n...), CAST(text AS enum), >=, GROUP BY, OFFSET.
    const at = new Date(Date.parse(end + 'Z') - 3000).toISOString().replace('Z', '');
    const params = ids.map((_, k) => `$${k + 1}`).join(',');
    const sql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT "futures_mark_snapshots"."instrument_id" FROM "futures_mark_snapshots"
      WHERE ("futures_mark_snapshots"."instrument_id" IN (${params})
        AND "futures_mark_snapshots"."source" = CAST($${ids.length + 1}::text AS "FuturesMarkSource")
        AND "futures_mark_snapshots"."effective_at" >= $${ids.length + 2})
      GROUP BY "futures_mark_snapshots"."instrument_id" OFFSET $${ids.length + 3}`;
    const { rows } = await c.query(sql, [...ids, 'binance_usdm_mark_ws', at, 0]);
    const plan = rows[0]['QUERY PLAN'];
    out.groupBy.push({ ...buffers(plan), node: plan[0].Plan.Plans?.[0]?.['Node Type'], index: plan[0].Plan.Plans?.[0]?.['Index Name'] });
    const lat = await c.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT t.id, m.effective_at FROM unnest($1::text[]) AS t(id)
       CROSS JOIN LATERAL (
         SELECT s.effective_at FROM futures_mark_snapshots s
         WHERE s.instrument_id = t.id AND s.source = 'binance_usdm_mark_ws'
         ORDER BY s.effective_at DESC LIMIT 1) m`,
      [ids],
    );
    out.lateral.push(buffers(lat.rows[0]['QUERY PLAN']));
  }
  console.log(JSON.stringify(out, null, 1));
  await c.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
