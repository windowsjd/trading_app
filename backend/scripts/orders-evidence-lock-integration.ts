import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';

const target = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.ORDERS_EVIDENCE_LOCK_DB_INTEGRATION, '1');
assert.equal(
  ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
  true,
);
assert.equal(target.pathname.startsWith('/safety_migration_worker_'), true);

const name = '20261013120000_add_conditional_sell_and_loc_sell';
const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8');
const previous = readFileSync(
  'prisma/migrations/20261012180000_add_conditional_buy_and_limit_on_close/migration.sql',
  'utf8',
);
const constraint = 'orders_session_close_evidence_shape';
const originalAdd = previous.match(
  /ALTER TABLE "orders" ADD CONSTRAINT "orders_session_close_evidence_shape" CHECK \([\s\S]*?\n\);/,
)?.[0];
const replacement = sql.match(
  /ALTER TABLE "orders" DROP CONSTRAINT "orders_session_close_evidence_shape";[\s\S]*?\) NOT VALID;/,
)?.[0];
assert.equal(typeof originalAdd, 'string');
assert.equal(typeof replacement, 'string');
const ddl = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const traffic = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
const schema = 'safety_orders_evidence_probe';
const metrics: unknown[] = [];
let probeCreated = false;

async function rejects(query: string, expected: string) {
  let code = 'RESOLVED';
  try {
    await traffic.query(query);
  } catch (error) {
    code = (error as { code?: string }).code ?? 'UNKNOWN';
  }
  assert.equal(code, expected);
}
async function grantedLocks() {
  const result = await ddl.query<{ mode: string }>(
    `SELECT mode FROM pg_locks WHERE pid=pg_backend_pid() AND relation='${schema}.orders'::regclass AND granted ORDER BY mode`,
  );
  return result.rows.map((row) => row.mode);
}
async function setup() {
  await ddl.query(`DROP TABLE IF EXISTS ${schema}.orders`);
  await ddl.query(`CREATE TABLE orders (
    id text PRIMARY KEY, side text NOT NULL, order_type text NOT NULL,
    session_close_evidence_id text, asset_price_snapshot_id text,
    limit_order_candle_evidence_id text, gross_amount numeric(24,8) NOT NULL DEFAULT 100
  )`);
  await ddl.query(originalAdd!);
  await ddl.query(`INSERT INTO orders (id,side,order_type,session_close_evidence_id) VALUES
    ('existing-loc-buy','buy','limit','close'), ('ordinary','sell','market',NULL)`);
}
async function preservation() {
  const { rows } = await traffic.query<{ id: string; gross_amount: string }>(
    "SELECT id,gross_amount FROM orders WHERE id IN ('existing-loc-buy','ordinary') ORDER BY id",
  );
  assert.equal(rows.length, 2);
  assert.equal(
    rows.map((row) => `${row.id}:${row.gross_amount}`).join(','),
    'existing-loc-buy:100.00000000,ordinary:100.00000000',
  );
}
async function checkWrites() {
  for (const side of ['buy', 'sell']) {
    await traffic.query(
      `INSERT INTO orders(id,side,order_type,session_close_evidence_id) VALUES('valid-${side}','${side}','limit','close')`,
    );
    await rejects(
      `INSERT INTO orders(id,side,order_type,session_close_evidence_id) VALUES('invalid-${side}','${side}','market','close')`,
      '23514',
    );
    for (const link of [
      'asset_price_snapshot_id',
      'limit_order_candle_evidence_id',
    ]) {
      await rejects(
        `INSERT INTO orders(id,side,order_type,session_close_evidence_id,${link}) VALUES('bad-link','${side}','limit','close','other')`,
        '23514',
      );
      await rejects(
        `UPDATE orders SET ${link}='other' WHERE id='valid-${side}'`,
        '23514',
      );
    }
    await rejects(
      `UPDATE orders SET order_type='market' WHERE id='valid-${side}'`,
      '23514',
    );
  }
  // CHECK's existing SQL NULL semantics are preserved, not silently hardened.
  await traffic.query(
    "INSERT INTO orders(id,side,order_type,asset_price_snapshot_id) VALUES('snapshot','buy','market','snapshot')",
  );
  await traffic.query(
    "INSERT INTO orders(id,side,order_type,limit_order_candle_evidence_id) VALUES('candle','sell','limit','candle')",
  );
  await preservation();
}
async function history() {
  const before = await ddl.query<{
    migration_name: string;
    checksum: string;
    finished: boolean;
    rolled_back: boolean;
  }>(
    'SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,rolled_back_at IS NOT NULL AS rolled_back FROM public._prisma_migrations ORDER BY migration_name',
  );
  const directories = readdirSync('prisma/migrations', {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  assert.equal(before.rows.length, directories.length);
  for (const entry of directories) {
    const row = before.rows.find((row) => row.migration_name === entry.name);
    assert.equal(row !== undefined, true);
    assert.equal(row?.finished, true);
    assert.equal(row?.rolled_back, false);
    const checksum = createHash('sha256')
      .update(readFileSync(`prisma/migrations/${entry.name}/migration.sql`))
      .digest('hex');
    assert.equal(row?.checksum, checksum);
  }
  const result = await ddl.query<{ convalidated: boolean; definition: string }>(
    "SELECT convalidated,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname=$1",
    [constraint],
  );
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].convalidated, true);
  return JSON.stringify(before.rows);
}
async function main() {
  await ddl.connect();
  await traffic.connect();
  const version = (
    await ddl.query<{ server_version: string }>('SHOW server_version')
  ).rows[0].server_version;
  assert.equal(version.startsWith('16.'), true);
  const beforeHistory = await history();
  await ddl.query(`CREATE SCHEMA ${schema}`);
  probeCreated = true;
  for (const client of [ddl, traffic]) {
    await client.query(`SET search_path TO ${schema},public`);
    await client.query(
      "SET lock_timeout='150ms'; SET statement_timeout='3s'; SET idle_in_transaction_session_timeout='10s'",
    );
  }

  // Reproduce the exact CHECK DDL from the immutable migration.
  await setup();
  await rejects(
    "INSERT INTO orders(id,side,order_type,session_close_evidence_id) VALUES('old-loc-sell','sell','limit','close')",
    '23514',
  );
  await ddl.query('BEGIN');
  const originalStarted = performance.now();
  await ddl.query(replacement!);
  await ddl.query(`ALTER TABLE orders VALIDATE CONSTRAINT ${constraint}`);
  const originalLocks = await grantedLocks();
  assert.equal(originalLocks.includes('AccessExclusiveLock'), true);
  await rejects('SELECT count(*) FROM orders', '55P03');
  await rejects(
    "UPDATE orders SET gross_amount=100 WHERE id='ordinary'",
    '55P03',
  );
  await rejects(
    "INSERT INTO orders(id,side,order_type) VALUES('concurrent','buy','market')",
    '55P03',
  );
  metrics.push({
    path: 'original-single-transaction',
    locks: originalLocks,
    observedTransactionMs: +(performance.now() - originalStarted).toFixed(2),
    read: 'lock_timeout',
    update: 'lock_timeout',
    insert: 'lock_timeout',
    note: 'includes three deliberate 150ms lock-timeout probes; not scan duration',
  });
  await ddl.query('COMMIT');
  await checkWrites();
  const originalDefinition = (
    await ddl.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='orders'::regclass AND conname=$1",
      [constraint],
    )
  ).rows[0].definition;

  // A test-only candidate. Never rewrite or resolve a recorded migration.
  await setup();
  await ddl.query('BEGIN');
  await ddl.query(
    'ALTER TABLE orders DROP CONSTRAINT orders_session_close_evidence_shape',
  );
  // The uncommitted DROP exposes no write window to another connection.
  await rejects(
    "INSERT INTO orders(id,side,order_type,session_close_evidence_id) VALUES('gap','buy','market','close')",
    '55P03',
  );
  await ddl.query(
    replacement!.slice(replacement!.indexOf('ALTER TABLE "orders" ADD')),
  );
  assert.equal((await grantedLocks()).includes('AccessExclusiveLock'), true);
  await ddl.query('COMMIT');
  await checkWrites(); // NOT VALID already rejects new invalid INSERT/UPDATE
  const notValidated = (
    await ddl.query<{ convalidated: boolean }>(
      "SELECT convalidated FROM pg_constraint WHERE conrelid='orders'::regclass AND conname=$1",
      [constraint],
    )
  ).rows[0].convalidated;
  assert.equal(notValidated, false);
  await ddl.query('BEGIN');
  const validationStarted = performance.now();
  await ddl.query(`ALTER TABLE orders VALIDATE CONSTRAINT ${constraint}`);
  const validationMs = performance.now() - validationStarted;
  const splitLocks = await grantedLocks();
  assert.equal(splitLocks.join(','), 'ShareUpdateExclusiveLock');
  await traffic.query('SELECT count(*) FROM orders');
  await traffic.query("UPDATE orders SET gross_amount=100 WHERE id='ordinary'");
  await traffic.query(
    "INSERT INTO orders(id,side,order_type) VALUES('concurrent','buy','market')",
  );
  await rejects(
    "UPDATE orders SET asset_price_snapshot_id='other' WHERE id='valid-buy'",
    '23514',
  );
  await ddl.query('COMMIT');
  const splitDefinition = (
    await ddl.query<{ definition: string; convalidated: boolean }>(
      "SELECT pg_get_constraintdef(oid) AS definition,convalidated FROM pg_constraint WHERE conrelid='orders'::regclass AND conname=$1",
      [constraint],
    )
  ).rows[0];
  assert.equal(splitDefinition.definition, originalDefinition);
  assert.equal(splitDefinition.convalidated, true);
  await preservation();
  metrics.push({
    path: 'test-only-split-ddl-validation',
    locks: splitLocks,
    validationMs: +validationMs.toFixed(2),
    read: 'PASS',
    update: 'PASS',
    insert: 'PASS',
    invalidInsertUpdate: 'rejected',
    definitionEqual: true,
  });
  assert.equal(await history(), beforeHistory);
  console.log(
    `ORDERS_EVIDENCE_LOCK_METRICS ${JSON.stringify({ version, checksum: createHash('sha256').update(sql).digest('hex'), migrationHistoryUnchanged: true, results: metrics })}`,
  );
  console.log(
    'Orders evidence PostgreSQL lock PASS (original risk reproduced; split candidate verified, not deployed)',
  );
}
main()
  .catch(() => {
    console.error('ORDERS_EVIDENCE_LOCK_TEST_FAILED');
    process.exitCode = 1;
  })
  .finally(async () => {
    await ddl.query('ROLLBACK').catch(() => undefined);
    if (probeCreated) {
      try {
        await ddl.query(`DROP SCHEMA ${schema} CASCADE`);
      } catch {
        console.error('ORDERS_EVIDENCE_PROBE_CLEANUP_FAILED');
        process.exitCode = 1;
      }
    }
    await Promise.all([ddl.end(), traffic.end()]);
  });
