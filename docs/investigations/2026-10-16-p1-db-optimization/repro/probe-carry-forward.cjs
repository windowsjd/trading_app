// P1-B6: the closed-market carry-forward price read (findMarketAwareAssetPriceCandidates,
// one source per query) for a US stock that has no rows, across repeated ANALYZE
// samples. equality: Prisma's shape as shipped; range: asset_id >= X AND <= X with
// ORDER BY asset_id DESC first, so only the (asset_id, effective_at) index fits.
// Usage: node probe-carry-forward.cjs <url of a *_test DB> <rounds>
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [url, rounds] = process.argv.slice(2);
assert.ok(new URL(url).pathname.endsWith('_test'));
const shape = (range) => `
  SELECT id, asset_id, price, effective_at, captured_at, created_at FROM asset_price_snapshots
  WHERE ${range ? 'asset_id >= $1 AND asset_id <= $1' : 'asset_id = $1'}
    AND currency_code = 'USD' AND source_type = 'provider_api'
    AND effective_at >= $2 AND effective_at <= $3 AND source_name = $4 AND price > 0
  ORDER BY ${range ? 'asset_id DESC, ' : ''}effective_at DESC, captured_at DESC, created_at DESC LIMIT 1`;
(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const { rows: [{ id }] } = await c.query(`SELECT id FROM assets WHERE asset_type = 'us_stock' LIMIT 1`);
  const { rows: [{ newest }] } = await c.query(`SELECT max(effective_at) AS newest FROM asset_price_snapshots`);
  // The latest completed US regular session window, 13:30-20:00 UTC.
  const day = new Date(Date.UTC(newest.getFullYear(), newest.getMonth(), newest.getDate() - 1));
  const open = new Date(+day + 13.5 * 3600000), close = new Date(+day + 20 * 3600000);
  const tally = { equality: {}, range: {} };
  const worst = { equality: 0, range: 0 };
  const iso = (d) => d.toISOString().replace('Z', '');
  for (let r = 0; r < Number(rounds); r++) {
    await c.query('ANALYZE asset_price_snapshots');
    for (const [name, range] of [['equality', false], ['range', true]]) {
      const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${shape(range)}`, [id, iso(open), iso(close), 'kis_us_delayed_trade']);
      const plan = rows[0]['QUERY PLAN'][0];
      const idx = new Set();
      const walk = (p) => { if (p['Relation Name'] === 'asset_price_snapshots') idx.add(p['Index Name'] ?? p['Node Type']); for (const k of p.Plans ?? []) walk(k); };
      walk(plan.Plan);
      const key = [...idx].sort().join('+');
      tally[name][key] = (tally[name][key] ?? 0) + 1;
      worst[name] = Math.max(worst[name], plan.Plan['Shared Hit Blocks'] + plan.Plan['Shared Read Blocks']);
    }
  }
  console.log(JSON.stringify({ db: new URL(url).pathname.slice(1), window: [open, close], rounds: Number(rounds), choice: tally, worstBuffers: worst }));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
