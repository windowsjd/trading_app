// P1-B6: plan choice of the futures reference-price Mark read (read API) across
// repeated ANALYZE samples. equality: `source = sources.source` (as shipped);
// range: `source >= s AND source <= s ORDER BY source DESC, ...` (P0 retention fix).
// Usage: node probe-reference-prices.cjs <url of a *_test DB> <datasetEndNaiveUtc> <rounds>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, end, rounds] = process.argv.slice(2);
assert.ok(new URL(url).pathname.endsWith('_test'));
const now = end;
const variant = (range) => `
  SELECT m.id FROM (SELECT id AS instrument_id FROM futures_instruments) AS target
  CROSS JOIN (VALUES ('binance_usdm_mark_ws'::"FuturesMarkSource"), ('binance_usdm_mark_rest'::"FuturesMarkSource")) AS sources(source)
  CROSS JOIN LATERAL (
    SELECT s.* FROM futures_mark_snapshots s
    WHERE s.instrument_id = target.instrument_id AND ${range ? 's.source >= sources.source AND s.source <= sources.source' : 's.source = sources.source'}
      AND s.effective_at <= $1 AND s.captured_at <= $1
    ORDER BY ${range ? 's.source DESC, ' : ''}s.effective_at DESC, s.captured_at DESC, s.id DESC LIMIT 1
  ) m`;
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const tally = { equality: {}, range: {} };
  const worst = { equality: 0, range: 0 };
  for (let r = 0; r < Number(rounds); r++) {
    await c.query('ANALYZE futures_mark_snapshots');
    for (const [name, range] of [['equality', false], ['range', true]]) {
      const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${variant(range)}`, [now]);
      const plan = rows[0]['QUERY PLAN'][0];
      const idx = new Set();
      const walk = (p) => { if (p['Relation Name'] === 'futures_mark_snapshots') idx.add(p['Index Name'] ?? p['Node Type']); for (const k of p.Plans ?? []) walk(k); };
      walk(plan.Plan);
      const key = [...idx].sort().join('+');
      tally[name][key] = (tally[name][key] ?? 0) + 1;
      worst[name] = Math.max(worst[name], plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks']);
    }
  }
  console.log(JSON.stringify({ db: new URL(url).pathname.slice(1), rounds: Number(rounds), choice: tally, worstBuffers: worst }));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
