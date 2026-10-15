// P1-B1 at production scale: the scheduled asset price snapshot retention
// (real AssetPriceSnapshotRetentionWorker, production defaults) on a fresh
// clone of the gen-asset-prices.cjs template, in an ISOLATED local PostgreSQL
// with production pg_settings. Measures the first cleanup of the backlog while
// ingestion keeps inserting (Binance 25 rows / 6 s, KOSCOM 15 rows / 4 s), WAL
// and full-page images, VACUUM, file size and free-space reuse, and plan choice
// across repeated ANALYZE samples. Usage:
//   tsx measure-asset-retention.ts <adminUrl> <templateDb>
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

const [adminUrl, template] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname));
assert.ok(template.endsWith('_test'));
const db = 'aps_bench_run_test';
const url = new URL(adminUrl);
url.pathname = '/' + db;

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };
const signature = (root: PlanNode) => {
  const T = 'asset_price_snapshots';
  const parts: string[] = [];
  const walk = (n: PlanNode) => {
    if (n['Relation Name'] === T) parts.push(`${n['Node Type']}:${(n['Index Name'] ?? '').replace(T + '_', '')}`);
    for (const c of n.Plans ?? []) walk(c);
  };
  walk(root);
  return [...new Set(parts)].sort().join('+');
};
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1) : null;
};

async function main() {
  const a = new Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${db}`);
  await a.query(`CREATE DATABASE ${db} TEMPLATE ${template}`);
  await a.end();
  process.env.DATABASE_URL = url.toString();
  process.env.ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED = 'true';
  const { PrismaService } = await import('../../../../backend/src/prisma/prisma.service');
  const { OpsJobLockService } = await import('../../../../backend/src/ops/ops-job-lock.service');
  const { OpsJobRunService } = await import('../../../../backend/src/ops/ops-job-run.service');
  const { AssetPriceSnapshotRetentionWorker } = await import('../../../../backend/src/providers/asset-price-snapshot-retention.worker');
  const { assetPriceSnapshotRetentionBatchSql, AssetPriceSnapshotRetentionService } = await import('../../../../backend/src/providers/asset-price-snapshot-retention.service');
  const { Prisma } = await import('../../../../backend/src/generated/prisma/client');
  const prisma = new PrismaService();
  const c = new Client({ connectionString: url.toString() });
  await c.connect();
  const size = async () => (await c.query(`SELECT pg_relation_size('asset_price_snapshots')::bigint AS heap, pg_indexes_size('asset_price_snapshots')::bigint AS idx,
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE relname='asset_price_snapshots')::bigint AS live,
      (SELECT n_dead_tup FROM pg_stat_user_tables WHERE relname='asset_price_snapshots')::bigint AS dead`)).rows[0];
  const wal = async () => (await c.query(`SELECT pg_current_wal_lsn() AS lsn, (SELECT wal_fpi FROM pg_stat_wal)::bigint AS fpi`)).rows[0];
  const walSince = async (w: { lsn: string; fpi: string }) => {
    const now = await wal();
    const { rows: [{ b }] } = await c.query(`SELECT pg_wal_lsn_diff($1, $2)::bigint AS b`, [now.lsn, w.lsn]);
    return { walBytes: Number(b), fpi: Number(now.fpi) - Number(w.fpi) };
  };
  const { rows: [{ now }] } = await c.query(`SELECT clock_timestamp() AS now`);
  const cutoff = new Date(+now - 14 * 86400000);
  const before = await size();
  const { rows: [{ old }] } = await c.query(`SELECT count(*)::bigint AS old FROM asset_price_snapshots WHERE effective_at < $1`, [cutoff.toISOString().replace('Z', '')]);

  // 1) Plan choice across ANALYZE samples, both cost profiles, both batch sizes.
  const assets = (await c.query(`SELECT DISTINCT ON (asset_type) id, asset_type FROM assets ORDER BY asset_type, id`)).rows;
  const profiles: Record<string, string[]> = {
    postgresDefaults: ['random_page_cost = 4', "effective_cache_size = '4GB'", "work_mem = '4MB'"],
    production: ['random_page_cost = 1.1', "effective_cache_size = '768MB'", "work_mem = '6617kB'"],
  };
  const plans: Record<string, Record<string, number>> = {};
  for (let r = 0; r < 10; r++) {
    await c.query('ANALYZE asset_price_snapshots');
    for (const asset of assets)
      for (const [profile, sets] of Object.entries(profiles))
        for (const limit of [1000, 10000]) {
          const q = assetPriceSnapshotRetentionBatchSql({ retentionDays: 14, assetId: asset.id, limit, now });
          await c.query('BEGIN');
          for (const s of sets) await c.query(`SET LOCAL ${s}`);
          const { rows } = await c.query({ text: `EXPLAIN (FORMAT JSON) ${q.text}`, values: q.values as unknown[] });
          await c.query('ROLLBACK');
          const key = `${asset.asset_type}|${profile}|${limit}`;
          const sig = signature(rows[0]['QUERY PLAN'][0].Plan);
          plans[key] ??= {};
          plans[key][sig] = (plans[key][sig] ?? 0) + 1;
        }
  }

  // 2) Batch cost sample: EXPLAIN ANALYZE of the first batch of one crypto asset.
  const crypto = assets.find((x) => x.asset_type === 'crypto')!;
  const sampleQ = assetPriceSnapshotRetentionBatchSql({ retentionDays: 14, assetId: crypto.id, limit: 1000, now });
  await c.query('BEGIN');
  const { rows: [sample] } = await c.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sampleQ.text}`, values: sampleQ.values as unknown[] });
  await c.query('ROLLBACK');
  const sampleRoot = sample['QUERY PLAN'][0];

  // 3) First cleanup with production defaults while ingestion inserts.
  let stop = false;
  const insertMs: number[] = [];
  const krx = (await c.query(`SELECT id FROM assets WHERE asset_type = 'domestic_stock' ORDER BY id`)).rows.map((x) => x.id);
  const cryptoIds = (await c.query(`SELECT id FROM assets WHERE asset_type = 'crypto' ORDER BY id`)).rows.map((x) => x.id);
  const ingest = (async () => {
    const ic = new Client({ connectionString: url.toString() });
    await ic.connect();
    for (let tick = 0; !stop; tick++) {
      const batch = tick % 3 === 0 ? cryptoIds : krx;
      const t = performance.now();
      for (const id of batch)
        await ic.query(`INSERT INTO asset_price_snapshots (id, asset_id, price, currency_code, source_type, source_name, effective_at, captured_at, raw_payload_json)
          VALUES (gen_random_uuid()::text, $1, 100, 'USD', 'provider_api', 'bench_ingest', clock_timestamp() AT TIME ZONE 'UTC', clock_timestamp() AT TIME ZONE 'UTC', '{"truncated":false}'::jsonb)`, [id]);
      insertMs.push((performance.now() - t) / batch.length);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await ic.end();
  })();
  const locks = new OpsJobLockService(prisma);
  const runs = new OpsJobRunService(prisma);
  const worker = new AssetPriceSnapshotRetentionWorker(prisma, locks, runs);
  const inner = (worker as unknown as { retention: InstanceType<typeof AssetPriceSnapshotRetentionService> }).retention;
  const original = inner.deleteBatch.bind(inner);
  const batchMs: number[] = [];
  inner.deleteBatch = async (scope) => {
    const t = performance.now();
    try { return await original(scope); } finally { batchMs.push(performance.now() - t); }
  };
  const w0 = await wal();
  const runMs: number[] = [];
  let deleted = 0, scanned = 0, runCount = 0;
  const cleanupStart = performance.now();
  for (let guard = 0; guard < 1000; guard++) {
    const t = performance.now();
    const result = await worker.run();
    runMs.push(performance.now() - t);
    runCount++;
    deleted += result?.deletedCount ?? 0;
    scanned += result?.scannedCount ?? 0;
    if (!result?.batchLimitReached) break;
  }
  const cleanupS = (performance.now() - cleanupStart) / 1000;
  const cleanupWal = await walSince(w0);
  stop = true;
  await ingest;
  const afterCleanup = await size();
  // 4) A steady-state run right after (rows that crossed the cutoff since).
  const steadyStart = performance.now();
  const steady = await worker.run();
  const steadyMs = performance.now() - steadyStart;
  // 5) VACUUM (not FULL): dead tuples become reusable space; the file stays.
  const v0 = await wal();
  const vt = performance.now();
  await c.query('VACUUM asset_price_snapshots');
  const vacuumS = (performance.now() - vt) / 1000;
  const vacuumWal = await walSince(v0);
  const afterVacuum = await size();
  // 6) New rows reuse the freed space: 200k inserts, heap does not grow.
  await c.query(`INSERT INTO asset_price_snapshots (id, asset_id, price, currency_code, source_type, source_name, effective_at, captured_at, raw_payload_json)
    SELECT gen_random_uuid()::text, $1, 100, 'USD', 'provider_api', 'bench_reuse', t, t,
      jsonb_build_object('truncated', false, 'payload', jsonb_build_object('pad', repeat('x', 600)))
    FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' + n * interval '1 millisecond' AS t FROM generate_series(1, 200000) n) s`, [crypto.id]);
  const afterReuse = await size();
  await prisma.$disconnect();
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await z.end();
  console.log(JSON.stringify({
    template, oldRowsAtStart: Number(old), sizeBefore: before, plans,
    sampleBatch: { ms: sampleRoot['Execution Time'], buffers: sampleRoot.Plan['Shared Hit Blocks'] + sampleRoot.Plan['Shared Read Blocks'], deletedRows: null },
    cleanup: { runs: runCount, deleted, scanned, seconds: +cleanupS.toFixed(1), rowsPerSecond: Math.round(deleted / cleanupS),
      runMs: { p50: pct(runMs, 50), p95: pct(runMs, 95), max: pct(runMs, 100) },
      batchMs: { count: batchMs.length, p50: pct(batchMs, 50), p95: pct(batchMs, 95), max: pct(batchMs, 100) },
      ...cleanupWal, walBytesPerDeletedRow: Math.round(cleanupWal.walBytes / Math.max(1, deleted)) },
    concurrentInsertMs: { count: insertMs.length, p50: pct(insertMs, 50), p95: pct(insertMs, 95), max: pct(insertMs, 100) },
    sizeAfterCleanup: afterCleanup,
    steadyRun: { ms: Math.round(steadyMs), deleted: steady?.deletedCount, scanned: steady?.scannedCount, batches: steady?.batchCount },
    vacuum: { seconds: +vacuumS.toFixed(1), ...vacuumWal }, sizeAfterVacuum: afterVacuum, sizeAfterReuseOf200kRows: afterReuse,
  }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
