// P0-A1: futures Mark/Last retention DELETE, 70f51455 statement (`p0`) vs the
// fixed production builder (`fixed`), each scenario on a fresh TEMPLATE clone
// in an ISOLATED local PostgreSQL, under the service's SET LOCAL statement_timeout=5s.
// Usage: tsx measure-futures-retention.ts <adminUrl> <templateDb> <datasetEndNaiveUtc> <mark|last> <p0|fixed> <scenario>
//   scenario: steady | backlog | held | deadprefix | one12h   (BATCH env, default 1000)
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { TABLE, retentionStatement, summarizePlan, type Table, type Variant } from './futures-retention-sql';

const [adminUrl, template, end, tableArg, variantArg, scenario] = process.argv.slice(2);
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(adminUrl).hostname));
assert.ok(template.endsWith('_test') && ['mark', 'last'].includes(tableArg));
const table = tableArg as Table;
const variant = variantArg as Variant;
const E = Date.parse(end + 'Z');
const BATCH = Number(process.env.BATCH ?? 1000);
const T = TABLE[table];

async function main() {
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
  await c.query(`ANALYZE ${T}`);
  type R = { label: string; i: number; ms?: number; deleted?: number; error?: string } & Partial<ReturnType<typeof summarizePlan>>;
  const results: R[] = [];
  const batch = async (cutoffMs: number, label: string, i: number): Promise<R> => {
    const q = retentionStatement(table, variant, new Date(cutoffMs), BATCH, true);
    await c.query('BEGIN');
    try {
      await c.query("SET LOCAL statement_timeout = '5s'");
      const t = performance.now();
      const { rows } = await c.query({ text: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text}`, values: q.values });
      const ms = performance.now() - t;
      await c.query('COMMIT');
      const root = rows[0]['QUERY PLAN'][0].Plan;
      const r: R = { label, i, ms: +ms.toFixed(1), deleted: root['Actual Rows'], ...summarizePlan(root, table) };
      results.push(r);
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      const r: R = { label, i, error: (e as { code?: string }).code ?? String((e as Error).message).slice(0, 60) };
      results.push(r);
      return r;
    }
  };
  const run = async (cutoffMs: number, batches: number, label: string) => {
    for (let i = 0; i < batches; i++) {
      const r = await batch(cutoffMs, label, i);
      if (r.error || (r.deleted ?? 0) < BATCH) break;
    }
  };
  const naive = (ms: number) => new Date(ms).toISOString().replace('Z', '');
  if (scenario === 'steady') await run(E - 24 * 3600000 + 60000, 10, 'steady');
  else if (scenario === 'backlog') for (let k = 0; k < 5; k++) await run(E - 12 * 3600000, 10, `run${k}`);
  else if (scenario === 'held') {
    const holder = new Client({ connectionString: url.toString() });
    await holder.connect();
    await holder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await holder.query('SELECT count(*) FROM futures_instruments');
    for (let k = 0; k < 3; k++) await run(E - 12 * 3600000, 10, `held${k}`);
    await holder.query('ROLLBACK');
    await holder.end();
  } else if (scenario === 'deadprefix') {
    await c.query(`DELETE FROM ${T} WHERE captured_at < $1`, [naive(E - 19.5 * 3600000)]);
    for (let k = 0; k < 3; k++) await run(E - 19.5 * 3600000 + 60000 * (k + 1), 10, `dead${k}`);
  } else if (scenario === 'one12h') await run(E - 12 * 3600000, 1, 'one');
  else throw new Error('unknown scenario');
  await c.end();
  const z = new Client({ connectionString: adminUrl });
  await z.connect();
  await z.query(`DROP DATABASE IF EXISTS ${db}`);
  await z.end();
  const ok = results.filter((r) => !r.error);
  const total = ok.reduce((n, r) => n + (r.ms ?? 0), 0);
  const deleted = ok.reduce((n, r) => n + (r.deleted ?? 0), 0);
  const steps: Record<string, number> = {};
  for (const r of ok) steps[r.deleteStep!] = (steps[r.deleteStep!] ?? 0) + 1;
  console.log(JSON.stringify({
    template, table, variant, scenario, batch: BATCH, batches: results.length, deleted,
    totalMs: Math.round(total), rowsPerSec: total ? Math.round(deleted / (total / 1000)) : 0,
    errors: results.filter((r) => r.error).map((r) => r.error),
    maxMs: Math.max(0, ...ok.map((r) => r.ms ?? 0)),
    meanBuffers: ok.length ? Math.round(ok.reduce((n, r) => n + (r.buffers ?? 0), 0) / ok.length) : 0,
    maxBuffers: Math.max(0, ...ok.map((r) => r.buffers ?? 0)),
    tempBlocks: ok.reduce((n, r) => n + (r.temp ?? 0), 0),
    deleteSteps: steps,
    batchesWithSeqOrBitmapOfTable: ok.filter((r) => r.seqOrBitmapOnTable).length,
    batchesWithHashOrSortOverTable: ok.filter((r) => r.hashOrSortOverTable).length,
  }));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
