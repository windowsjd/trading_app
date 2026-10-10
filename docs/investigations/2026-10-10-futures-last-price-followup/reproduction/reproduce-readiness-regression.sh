#!/usr/bin/env bash
set -euo pipefail
# Pure policy comparison; no environment files, database or provider access.
project_root=$(git rev-parse --show-toplevel)
readiness_tmp=$(mktemp -d /tmp/futures-readiness-regression.XXXXXX)
trap 'rm -rf "$readiness_tmp"' EXIT
git show "${READINESS_BASE:-f512dab0a612681b14e2320b6631a2bd7459a3c8}:backend/scripts/lib/futures-readiness.ts" > "$readiness_tmp/before.ts"
cat > "$readiness_tmp/compare.ts" <<'TS'
import assert from 'node:assert/strict';
const before = require(process.argv[2]).evaluateFuturesReadiness;
const after = require(process.argv[3]).evaluateFuturesReadiness;
const now = new Date('2026-10-10T00:00:00Z');
const config = { tradingMode: 'DISABLED', riskEngine: true, markIngestion: true, lastPriceIngestion: true, conditionalOrders: false };
const row = { symbol: 'BTCUSDT', instrumentId: 'btc', active: true, coverage: 'verified', last: { valid: true }, mark: { valid: true }, openPositions: 0, pendingEntries: 0, liveProtections: 1 };
const run = { jobName: 'conditional_orders', status: 'succeeded', startedAt: now.toISOString(), finishedAt: now.toISOString(), dryRun: false, resultJson: { states: { disabled: 1 } } };
const cases = [
  { name: 'disabled live protections', row, run },
  { name: 'preview-only risk worker', row: { ...row, liveProtections: 0, openPositions: 1 }, run: { ...run, jobName: 'futures_liquidation', dryRun: true } },
];
const results = cases.map(c => ({ name: c.name, before: before([c.row], [c.run], config, now).readiness.launchReady, after: after([c.row], [c.run], config, now).readiness.launchReady }));
for (const result of results) { assert.equal(result.before, true); assert.equal(result.after, false); }
console.log(JSON.stringify(results, null, 2));
TS
cd "$project_root/backend"
pnpm exec tsx "$readiness_tmp/compare.ts" "$readiness_tmp/before.ts" "$project_root/backend/scripts/lib/futures-readiness.ts"
