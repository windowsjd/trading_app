// P1-B6: WAL and full-page images of the futures Mark steady state with random
// (v4) vs time-ordered (v7) text primary keys, on fresh clones of a prod-like
// 24 h template in an ISOLATED local PostgreSQL (prod pg_settings).
// Simulated time: one multi-row INSERT of all contracts per second (the drain),
// a CHECKPOINT every 300 s (checkpoint_timeout) and the retention DELETE every
// 60 s, for SECONDS simulated seconds.
// Usage: node measure-uuid-wal.cjs <adminUrl> <templateDb> <datasetEndNaiveUtc> <v4|v7> [seconds]
const { Client } = require('pg');
const assert = require('node:assert/strict');
const [adminUrl, template, end, variant, secondsArg] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname));
assert.ok(template.endsWith('_test') && ['v4', 'v7'].includes(variant));
const SECONDS = Number(secondsArg ?? 1800);
const E = Date.parse(end + 'Z');
const iso = (ms) => new Date(ms).toISOString().replace('Z', '');

(async () => {
  const db = `uuidwal_${variant}_test`;
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${db}`);
  await a.query(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  await a.end();
  const url = new URL(adminUrl);
  url.pathname = '/' + db;
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  // RFC 9562 v7 from the simulated capture time (48-bit ms + random), as text.
  await c.query(`CREATE OR REPLACE FUNCTION bench_uuid_v7(ts timestamp) RETURNS text AS $$
    SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid())
      PLACING substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
      FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid::text $$ LANGUAGE sql VOLATILE`);
  const { rows: instruments } = await c.query(
    `SELECT i.id, a.symbol FROM futures_instruments i JOIN assets a ON a.id = i.underlying_asset_id ORDER BY i.id`,
  );
  await c.query(`ANALYZE futures_mark_snapshots`);
  await c.query('CHECKPOINT');
  const wal = async () => (await c.query(`SELECT pg_current_wal_lsn() AS lsn, (SELECT wal_fpi FROM pg_stat_wal) AS fpi, (SELECT wal_records FROM pg_stat_wal) AS rec`)).rows[0];
  const before = await wal();
  const t0 = performance.now();
  let inserted = 0;
  let deleted = 0;
  const idExpr = variant === 'v7' ? 'bench_uuid_v7(x.cap::timestamp)' : 'gen_random_uuid()::text';
  for (let s = 1; s <= SECONDS; s++) {
    const at = E + s * 1000;
    const values = instruments.map((inst, k) => ({ id: inst.id, symbol: inst.symbol, eff: iso(at + ((k * 7) % 50)), cap: iso(at + ((k * 7) % 50) + 70) }));
    const r = await c.query(
      `INSERT INTO futures_mark_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
       SELECT ${idExpr}, x.id, x.symbol, 'binance_usdm_mark_ws', 100, x.eff::timestamp, x.cap::timestamp
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, symbol text, eff text, cap text)`,
      [JSON.stringify(values)],
    );
    inserted += r.rowCount;
    if (s % 60 === 0) {
      // The production retention batch statement (fixed form), up to 10 x 1000.
      for (let b = 0; b < 10; b++) {
        const d = await c.query(
          `WITH candidates AS (
             SELECT m.id FROM futures_mark_snapshots m
             WHERE m.captured_at < $1
             ORDER BY m.captured_at, m.id
             LIMIT 1000 FOR UPDATE OF m SKIP LOCKED
           )
           DELETE FROM futures_mark_snapshots m
           WHERE m.id = ANY (ARRAY(SELECT c.id FROM candidates c)) AND m.effective_at < $1`,
          [iso(at - 24 * 3600000)],
        );
        deleted += d.rowCount;
        if (d.rowCount < 1000) break;
      }
    }
    if (s % 300 === 0) await c.query('CHECKPOINT');
  }
  const after = await wal();
  const { rows: [{ bytes }] } = await c.query(`SELECT pg_wal_lsn_diff($1, $2)::bigint AS bytes`, [after.lsn, before.lsn]);
  const sizes = (await c.query(`SELECT relname, pg_relation_size(oid) AS bytes FROM pg_class WHERE relname LIKE 'futures_mark_snapshots%' ORDER BY relname`)).rows;
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db}`);
  await z.end();
  console.log(JSON.stringify({
    variant, template, simulatedSeconds: SECONDS, contracts: instruments.length, inserted, deleted,
    walBytes: Number(bytes), walBytesPerInsertedRow: Math.round(Number(bytes) / inserted),
    fpi: Number(after.fpi) - Number(before.fpi), walRecords: Number(after.rec) - Number(before.rec),
    fpiPerCheckpoint: Math.round((Number(after.fpi) - Number(before.fpi)) / Math.floor(SECONDS / 300)),
    elapsedS: +((performance.now() - t0) / 1000).toFixed(1), sizes,
  }));
})().catch((e) => { console.error(e); process.exit(1); });
