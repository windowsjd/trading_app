#!/usr/bin/env python3
"""Writes backend/scripts/zz-strict-plan-probe.ts: a temporary copy of
futures-price-safety-integration.ts that re-runs the retention plan matrix
(2 cost profiles x batch 1000/10000) after 12 ANALYZE rounds per table and
prints every plan shape. The copy keeps the committed assertion (no Sort, no
Hash Join, no Seq Scan or non-primary-key bitmap of the snapshot table), so a
single unstable plan fails the run. Delete the copy afterwards.

  python3 -I strict-plan-rule-probe.py <repo>
  cd <repo>/backend && NODE_ENV=test FUTURES_DB_INTEGRATION=1 \
    FUTURES_PRICE_SAFETY_DB_INTEGRATION=1 DATABASE_URL=<loopback *_test URL> \
    pnpm exec tsx scripts/zz-strict-plan-probe.ts | grep -E '^PLAN|PASS'
  rm scripts/zz-strict-plan-probe.ts
"""
import pathlib
import sys

ROUNDS = 12
repo = pathlib.Path(sys.argv[1])
src = (repo / 'backend/scripts/futures-price-safety-integration.ts').read_text()


def once(text, old, new):
    if text.count(old) != 1:
        sys.exit(f'anchor not found once: {old[:60]!r}')
    return text.replace(old, new)


probe = once(src, 'function assertOrderedRetentionPlan(explain: unknown, table: string) {',
             "let probeLabel = 'analyze-1000';\n"
             'function assertOrderedRetentionPlan(explain: unknown, table: string) {')
probe = once(probe, '  const indexes = (node: PlanNode): string[] => [',
             '  console.log(`PLAN ${probeLabel} ${table} :: ${shape}`);\n'
             '  const indexes = (node: PlanNode): string[] => [')
probe = once(probe, '      try {\n        assertOrderedRetentionPlan(explain, table);',
             '      probeLabel = `${profile}/${limit}`;\n'
             '      try {\n        assertOrderedRetentionPlan(explain, table);')
end = ('          `${table} plan (${profile}, batch ${limit}): ${(error as Error).message}`,\n'
       '        );\n      }\n    }\n')
probe = once(probe, end, end + "  probeLabel = 'analyze-1000';\n")
for table, build, cutoff in (
    ('futures_last_price_snapshots', 'futuresLastPriceRetentionBatchSql', 'cutoff'),
    ('futures_mark_snapshots', 'futuresMarkRetentionBatchSql', 'markCutoff'),
):
    call = (f'  await db.$executeRaw`ANALYZE {table}`;\n'
            f'  await assertStableRetentionPlans(\n    {build},\n    {cutoff},\n'
            f"    '{table}',\n  );\n")
    probe = once(probe, call, f'  for (let round = 0; round < {ROUNDS}; round++) {{\n{call}  }}\n')
out = repo / 'backend/scripts/zz-strict-plan-probe.ts'
out.write_text(probe)
print(out)
