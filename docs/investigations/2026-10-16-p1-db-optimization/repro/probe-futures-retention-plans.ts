// P0-A1: plan choice of the whole retention batch statement across repeated
// ANALYZE samples, cost profiles and batch sizes (EXPLAIN only, nothing deleted).
// Usage: tsx probe-futures-retention-plans.ts <url of a *_test DB> <datasetEndNaiveUtc> <mark|last> <rounds>
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { TABLE, retentionStatement, summarizePlan, type Table } from './futures-retention-sql';

const [url, end, tableArg, rounds] = process.argv.slice(2);
assert.ok(new URL(url).pathname.endsWith('_test'));
const table = tableArg as Table;
const E = Date.parse(end + 'Z');
const PROFILES: Record<string, string[]> = {
  postgresDefaults: ['random_page_cost = 4', "effective_cache_size = '4GB'", "work_mem = '4MB'"],
  production: ['random_page_cost = 1.1', "effective_cache_size = '768MB'", "work_mem = '6617kB'"],
};
// Normal steady state (1 min past the 24 h window) and a 12 h backlog.
const CUTOFFS: Record<string, number> = { steady: E - 24 * 3600000 + 60000, backlog12h: E - 12 * 3600000 };
async function main() {
  const c = new Client({ connectionString: url });
  await c.connect();
  const tally: Record<string, Record<string, number>> = {};
  for (let r = 0; r < Number(rounds); r++) {
    await c.query(`ANALYZE ${TABLE[table]}`);
    for (const variant of ['p0', 'fixed'] as const)
      for (const [profile, sets] of Object.entries(PROFILES))
        for (const [cut, ms] of Object.entries(CUTOFFS))
          for (const limit of [1000, 10000]) {
            const q = retentionStatement(table, variant, new Date(ms), limit);
            await c.query('BEGIN');
            for (const s of sets) await c.query(`SET LOCAL ${s}`);
            const { rows } = await c.query({ text: `EXPLAIN (FORMAT JSON) ${q.text}`, values: q.values });
            await c.query('ROLLBACK');
            const s = summarizePlan(rows[0]['QUERY PLAN'][0].Plan, table);
            const key = `${variant}|${profile}|${cut}|${limit}`;
            const sig = `${s.deleteStep}${s.seqOrBitmapOnTable ? '+SEQ/BITMAP' : ''}${s.hashOrSortOverTable ? '+HASH/SORT' : ''}`;
            tally[key] ??= {};
            tally[key][sig] = (tally[key][sig] ?? 0) + 1;
          }
  }
  console.log(JSON.stringify({ url: new URL(url).pathname.slice(1), table, rounds: Number(rounds), tally }));
  await c.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
