// Row-format storage/WAL comparison for 10-level book history (PG17, private).
const { Client } = require(process.env.PG_MODULE);
const fs = require('fs');
const crypto = require('crypto');
const dir = process.argv[2];
function load(file, spot) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => {
    const { receivedAt, frame } = JSON.parse(l); const f = JSON.parse(frame); const d = f.data;
    const bids = (spot ? d.bids : d.b).map(([p, q]) => [p, q]);
    const asks = (spot ? d.asks : d.a).map(([p, q]) => [p, q]);
    return { receivedAt, bids, asks, seq: String(spot ? d.lastUpdateId : d.u), T: spot ? null : d.T };
  });
}
const spot = load(dir + '/spot.ndjson', true), fut = load(dir + '/futures.ndjson', false);
const formats = {
  jsonb2: { cols: 'bids jsonb NOT NULL, asks jsonb NOT NULL', vals: (b) => [JSON.stringify(b.bids), JSON.stringify(b.asks)], ph: (i) => `$${i}::jsonb, $${i + 1}::jsonb`, n: 2 },
  json2: { cols: 'bids json NOT NULL, asks json NOT NULL', vals: (b) => [JSON.stringify(b.bids), JSON.stringify(b.asks)], ph: (i) => `$${i}::json, $${i + 1}::json`, n: 2 },
  numeric4: { cols: 'bid_prices numeric[] NOT NULL, bid_quantities numeric[] NOT NULL, ask_prices numeric[] NOT NULL, ask_quantities numeric[] NOT NULL',
    vals: (b) => [b.bids.map((x) => x[0]), b.bids.map((x) => x[1]), b.asks.map((x) => x[0]), b.asks.map((x) => x[1])],
    ph: (i) => `$${i}::numeric[], $${i + 1}::numeric[], $${i + 2}::numeric[], $${i + 3}::numeric[]`, n: 4 },
  jsonb1: { cols: 'book jsonb NOT NULL', vals: (b) => [JSON.stringify({ b: b.bids, a: b.asks })], ph: (i) => `$${i}::jsonb`, n: 1 },
};
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
  const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
  const out = {};
  for (const [market, books] of [['spot', spot], ['futures', fut]]) for (const [name, f] of Object.entries(formats)) {
    const t = `bench_${market}_${name}`;
    await c.query(`DROP TABLE IF EXISTS ${t}`);
    await c.query(`CREATE TABLE ${t} (product_id text NOT NULL, bucket_start_at timestamp(3) NOT NULL, captured_at timestamp(3) NOT NULL, ${market === 'futures' ? 'effective_at timestamp(3) NOT NULL,' : ''} sequence bigint NOT NULL, ${f.cols}, created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (product_id, bucket_start_at))`);
    await c.query('CHECKPOINT');
    const lsn0 = (await c.query('SELECT pg_current_wal_insert_lsn() l')).rows[0].l;
    const ROWS = 100000, BATCH = 100; const base = Date.UTC(2026, 9, 1);
    for (let k = 0; k < ROWS / BATCH; k++) {
      const params = []; const tuples = [];
      for (let j = 0; j < BATCH; j++) {
        const b = books[(k * BATCH + j) % books.length];
        const bucket = new Date(base + k * 60000);
        const p = [ids[j], bucket, new Date(bucket.getTime() + 59000)];
        if (market === 'futures') p.push(new Date(bucket.getTime() + 58900));
        p.push(b.seq, ...f.vals(b));
        const start = params.length + 1;
        const n = p.length - f.n;
        const ph = Array.from({ length: n }, (_, x) => `$${start + x}`).join(',') + ',' + f.ph(start + n);
        tuples.push(`(${ph})`); params.push(...p);
      }
      await c.query(`INSERT INTO ${t} (product_id, bucket_start_at, captured_at, ${market === 'futures' ? 'effective_at,' : ''} sequence, ${f.cols.split(',').map((s) => s.trim().split(' ')[0]).join(',')}) VALUES ${tuples.join(',')} ON CONFLICT DO NOTHING`, params);
    }
    const lsn1 = (await c.query('SELECT pg_current_wal_insert_lsn() l')).rows[0].l;
    const wal = (await c.query('SELECT pg_wal_lsn_diff($1,$2)::bigint d', [lsn1, lsn0])).rows[0].d;
    await c.query(`VACUUM ANALYZE ${t}`);
    const s = (await c.query(`SELECT pg_relation_size('${t}') heap, pg_indexes_size('${t}') idx, pg_total_relation_size('${t}') total, (SELECT avg(pg_column_size(x.*)) FROM ${t} x) avgrow`)).rows[0];
    out[`${market}.${name}`] = { heapPerRow: +(s.heap / ROWS).toFixed(1), indexPerRow: +(s.idx / ROWS).toFixed(1), totalPerRow: +(s.total / ROWS).toFixed(1), avgTuple: +(+s.avgrow).toFixed(1), walPerRow: +(wal / ROWS).toFixed(1) };
    await c.query(`DROP TABLE ${t}`);
  }
  console.log(JSON.stringify(out, null, 1));
  await c.end();
})().catch((e) => { console.error(e); process.exit(1); });
