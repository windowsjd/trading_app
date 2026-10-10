#!/usr/bin/env bash
set -euo pipefail
# Transient user service; never provisions, migrates or changes production.
# Supply a fresh, migrated loopback *_test DB and disposable loopback Redis.
repo=$(git rev-parse --show-toplevel)
unit=${SOAK_UNIT:-trading-futures-soak-followup-24h}
report_dir=${SOAK_REPORT_DIR:-$repo/docs/investigations/2026-10-10-futures-last-price-followup/evidence}
node -e 'for (const key of ["DATABASE_URL", "REDIS_URL"]) { const u = new URL(process.env[key]); if (!["localhost", "127.0.0.1"].includes(u.hostname)) throw new Error("Disposable loopback URLs required"); if (key === "DATABASE_URL" && !u.pathname.endsWith("_test")) throw new Error("Test DB suffix required"); }'
mkdir -p "$report_dir"
systemd-run --user --unit="$unit" \
  --property="WorkingDirectory=$repo/backend" \
  --property=MemoryMax=4G --property=RuntimeMaxSec=97200 \
  --property=TimeoutStopSec=60 \
  --property="StandardOutput=append:$report_dir/soak-24h.log" \
  --property="StandardError=append:$report_dir/soak-24h.log" \
  /usr/bin/env "PATH=$PATH" NODE_ENV=test FUTURES_DB_INTEGRATION=1 \
  NODE_OPTIONS=--max-old-space-size=2048 \
  "DATABASE_URL=$DATABASE_URL" "REDIS_URL=$REDIS_URL" \
  SOAK_SECONDS=86400 "SOAK_REPORT=$report_dir/soak-24h.json" \
  node ./node_modules/tsx/dist/cli.mjs scripts/futures-collection-soak.ts
systemctl --user show "$unit" \
  -p Id -p ActiveState -p SubState -p MainPID -p MemoryMax \
  -p RuntimeMaxUSec -p ExecMainStartTimestamp -p ExecMainStartTimestampMonotonic
