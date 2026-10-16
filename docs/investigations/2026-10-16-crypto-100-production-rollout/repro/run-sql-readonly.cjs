// Runs one SQL file READ-ONLY (session read-only, 20 s statement timeout) and prints rows as a table.
// Usage: TZ=UTC DATABASE_URL=... node run-sql-readonly.cjs <file.sql> [name=value ...]  (:name placeholders, integers only)
const { Client } = require('pg');
const fs = require('node:fs');
const [file, ...pairs] = process.argv.slice(2);
let sql = fs.readFileSync(file, 'utf8');
for (const pair of pairs) {
  const [k, v] = pair.split('=');
  if (!/^\d+$/.test(v)) throw new Error('integer parameters only');
  sql = sql.replaceAll(`:${k}`, v);
}
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, options: '-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=1000', ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('BEGIN READ ONLY');
  const t = Date.now();
  const { rows } = await c.query(sql);
  await c.query('ROLLBACK');
  await c.end();
  console.table(rows);
  console.log(`${rows.length} rows in ${Date.now() - t} ms`);
})().catch((e) => { console.error('query failed', e.code ?? e.message); process.exit(1); });
