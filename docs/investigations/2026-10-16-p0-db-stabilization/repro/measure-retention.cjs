// Futures Mark/Last retention DELETE: previous production SQL (HEAD 4f5c4dda)
// vs the 2026-10-16 statement, each scenario on a fresh TEMPLATE clone in an
// ISOLATED local PostgreSQL, under the service's SET LOCAL statement_timeout=5s.
// Usage: node measure-retention.cjs <adminUrl> <templateDb> <datasetEndNaiveUtc> <mark|last> <old|new> <scenario>
//   scenario: steady | backlog | held | deadprefix | one12h   (BATCH env, default 1000)
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [adminUrl, template, end, table, variant, scenario] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname));
assert.ok(template.endsWith('_test') && ['mark', 'last'].includes(table));
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');
const E = Date.parse(end + 'Z');
const BATCH = Number(process.env.BATCH ?? 1000);

const MARK_OLD = `
WITH candidates AS (
  SELECT m.id FROM futures_mark_snapshots m
  WHERE m.captured_at < $1 AND m.effective_at < $1
    AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
    AND EXISTS (
      SELECT 1 FROM futures_mark_snapshots newer
      WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
        AND newer.effective_at > m.effective_at
    )
  ORDER BY m.captured_at, m.id
  LIMIT $2 FOR UPDATE OF m SKIP LOCKED
)
DELETE FROM futures_mark_snapshots m USING candidates c WHERE m.id = c.id
RETURNING m.id`;
// = futuresMarkRetentionBatchSql (+ RETURNING so EXPLAIN ANALYZE reports rows).
const MARK_NEW = `
WITH candidates AS (
  SELECT m.id FROM futures_mark_snapshots m
  WHERE m.captured_at < $1
    AND m.id <> ALL (ARRAY(
      SELECT newest.id FROM futures_instruments i
      CROSS JOIN unnest(enum_range(NULL::"FuturesMarkSource")) AS s(source)
      CROSS JOIN LATERAL (
        SELECT n.id FROM futures_mark_snapshots n
        WHERE n.instrument_id = i.id AND n.source >= s.source AND n.source <= s.source
        ORDER BY n.source DESC, n.effective_at DESC LIMIT 1
      ) newest
    ))
    AND NOT EXISTS (SELECT 1 FROM futures_liquidation_closes c WHERE c.mark_snapshot_id = m.id)
  ORDER BY m.captured_at, m.id
  LIMIT $2 FOR UPDATE OF m SKIP LOCKED
)
DELETE FROM futures_mark_snapshots m USING candidates c
WHERE m.id = c.id AND m.effective_at < $1
RETURNING m.id`;
const LAST_GUARDS = `
    AND NOT EXISTS (SELECT 1 FROM futures_executions e WHERE e.last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_season_prices p WHERE p.last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM protection_children c WHERE c.futures_last_price_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.registration_snapshot_id = m.id)
    AND NOT EXISTS (SELECT 1 FROM futures_conditional_entries ce WHERE ce.trigger_snapshot_id = m.id)
    AND NOT EXISTS (
      SELECT 1 FROM seasons s
      WHERE m.captured_at BETWEEN s.end_at - interval '10 seconds' AND s.end_at
    )`;
const LAST_OLD = `
WITH candidates AS (
  SELECT m.id FROM futures_last_price_snapshots m
  WHERE m.captured_at < $1 AND m.effective_at < $1 ${LAST_GUARDS}
    AND EXISTS (
      SELECT 1 FROM futures_last_price_snapshots newer
      WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source
        AND newer.captured_at > m.captured_at
    )
  ORDER BY m.captured_at, m.id
  LIMIT $2 FOR UPDATE OF m SKIP LOCKED
)
DELETE FROM futures_last_price_snapshots m USING candidates c WHERE m.id = c.id
RETURNING m.id`;
// = futuresLastPriceRetentionBatchSql (+ RETURNING).
const LAST_NEW = `
WITH candidates AS (
  SELECT m.id FROM futures_last_price_snapshots m
  WHERE m.captured_at < $1
    AND m.id <> ALL (ARRAY(
      SELECT newest.id FROM futures_instruments i
      CROSS JOIN unnest(enum_range(NULL::"FuturesLastPriceSource")) AS s(source)
      CROSS JOIN LATERAL (
        SELECT n.id FROM futures_last_price_snapshots n
        WHERE n.instrument_id = i.id AND n.source >= s.source AND n.source <= s.source
        ORDER BY n.source DESC, n.captured_at DESC LIMIT 1
      ) newest
    )) ${LAST_GUARDS}
  ORDER BY m.captured_at, m.id
  LIMIT $2 FOR UPDATE OF m SKIP LOCKED
)
DELETE FROM futures_last_price_snapshots m USING candidates c
WHERE m.id = c.id AND m.effective_at < $1
RETURNING m.id`;
const SQL = { mark: { old: MARK_OLD, new: MARK_NEW }, last: { old: LAST_OLD, new: LAST_NEW } }[table][variant];
const TABLE = table === 'mark' ? 'futures_mark_snapshots' : 'futures_last_price_snapshots';

function summarize(root) {
  const seq = new Set();
  let temp = 0;
  let sort = false;
  const walk = (p) => {
    if (p['Node Type'] === 'Seq Scan') seq.add(p['Relation Name']);
    if (p['Node Type'] === 'Sort' || p['Node Type'] === 'Hash Join') sort = true;
    temp += (p['Temp Read Blocks'] ?? 0) + (p['Temp Written Blocks'] ?? 0);
    for (const c of p.Plans ?? []) walk(c);
  };
  walk(root.Plan);
  return {
    buffers: root.Plan['Shared Hit Blocks'] + root.Plan['Shared Read Blocks'],
    reads: root.Plan['Shared Read Blocks'],
    temp,
    seqOnTable: seq.has(TABLE),
    sortOrHash: sort,
  };
}

(async () => {
  const db = `ret_${table}_${variant}_${scenario}_test`;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${db}`);
  await a.query(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  await a.end();
  const url = new URL(adminUrl);
  url.pathname = '/' + db;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  await c.query(`ANALYZE ${TABLE}`);
  const results = [];
  const batch = async (cutoffMs, label, i) => {
    await c.query('BEGIN');
    try {
      await c.query("SET LOCAL statement_timeout = '5s'");
      const t = performance.now();
      const { rows } = await c.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${SQL}`, [iso(cutoffMs), BATCH]);
      const ms = performance.now() - t;
      await c.query('COMMIT');
      const root = rows[0]['QUERY PLAN'][0];
      const r = { label, i, ms: +ms.toFixed(1), deleted: root.Plan['Actual Rows'], ...summarize(root) };
      results.push(r);
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      const r = { label, i, error: e.code ?? String(e.message).slice(0, 60) };
      results.push(r);
      return r;
    }
  };
  const run = async (cutoffMs, batches, label) => {
    for (let i = 0; i < batches; i++) {
      const r = await batch(cutoffMs, label, i);
      if (r.error || r.deleted < BATCH) break;
    }
  };
  const holder = new Client({ connectionString: url.toString() });
  if (scenario === 'steady') await run(E - 24 * 3600000 + 60000, 10, 'steady');
  else if (scenario === 'backlog') for (let k = 0; k < 5; k++) await run(E - 12 * 3600000, 10, `run${k}`);
  else if (scenario === 'held') {
    await holder.connect();
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await holder.query('SELECT count(*) FROM futures_instruments');
    for (let k = 0; k < 3; k++) await run(E - 12 * 3600000, 10, `held${k}`);
    await holder.query('ROLLBACK');
    await holder.end();
  } else if (scenario === 'deadprefix') {
    await c.query(`DELETE FROM ${TABLE} WHERE captured_at < $1`, [iso(E - 19.5 * 3600000)]);
    for (let k = 0; k < 3; k++) await run(E - 19.5 * 3600000 + 60000 * (k + 1), 10, `dead${k}`);
  } else if (scenario === 'one12h') await run(E - 12 * 3600000, 1, 'one');
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db}`);
  await z.end();
  const ok = results.filter((r) => !r.error);
  const total = ok.reduce((n, r) => n + r.ms, 0);
  const deleted = ok.reduce((n, r) => n + r.deleted, 0);
  console.log(JSON.stringify({
    table, variant, scenario, batch: BATCH, batches: results.length, deleted,
    totalMs: Math.round(total), rowsPerSec: total ? Math.round(deleted / (total / 1000)) : 0,
    errors: results.filter((r) => r.error).map((r) => r.error),
    maxMs: Math.max(0, ...ok.map((r) => r.ms)),
    meanBuffers: ok.length ? Math.round(ok.reduce((n, r) => n + r.buffers, 0) / ok.length) : 0,
    maxBuffers: Math.max(0, ...ok.map((r) => r.buffers)),
    tempBlocks: ok.reduce((n, r) => n + r.temp, 0),
    batchesWithSeqScanOfTable: ok.filter((r) => r.seqOnTable).length,
    batchesWithSortOrHashJoin: ok.filter((r) => r.sortOrHash).length,
  }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
