// READ-ONLY diagnosis on production: EXPLAIN (ANALYZE, BUFFERS) of the SELECT part of
// the price retention batch (scan + protections), without FOR UPDATE and without DELETE.
import { Client } from '../../../../backend/node_modules/pg';
import { assetPriceSnapshotRetentionBatchSql } from '../../../../backend/src/providers/asset-price-snapshot-retention.service';

async function main() {
  const [assetId, limitArg, mode] = process.argv.slice(2);
  const c = new Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000', ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const now = (await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const sql = assetPriceSnapshotRetentionBatchSql({ retentionDays: 14, assetId, limit: Number(limitArg), now, after: null });
  const cut = sql.text.indexOf('FOR UPDATE OF m SKIP LOCKED');
  const selectOnly = `${sql.text.slice(0, cut)}\n    ) SELECT count(*) AS candidates, (SELECT count(*) FROM scan) AS scanned FROM candidates`;
  const prefix = mode === 'analyze' ? 'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ' : 'EXPLAIN ';
  const t = Date.now();
  const { rows } = await c.query(prefix + selectOnly, sql.values as unknown[]);
  console.log(`-- ${mode ?? 'plan'} ${Date.now() - t} ms`);
  for (const r of rows) console.log(r['QUERY PLAN']);
  await c.query('ROLLBACK');
  await c.end();
}
main().catch((e) => { console.error('failed', e.code ?? e.message); process.exit(1); });
