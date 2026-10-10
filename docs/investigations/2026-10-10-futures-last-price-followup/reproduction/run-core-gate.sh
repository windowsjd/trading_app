#!/usr/bin/env bash
set -euo pipefail
node -e 'for (const key of ["DATABASE_URL", "REDIS_URL"]) { const u = new URL(process.env[key]); if (!["127.0.0.1", "localhost"].includes(u.hostname)) throw new Error("Disposable loopback URLs required"); if (key === "DATABASE_URL" && !u.pathname.endsWith("_test")) throw new Error("Test DB suffix required"); }'
export NODE_ENV=test LIMIT_ORDER_ENABLED=true AD_REWARD_ENABLED=true JWT_ACCESS_SECRET=disposable-core-test-secret
export FRIENDS_DB_INTEGRATION=1 TRADING_ACCOUNT_DB_INTEGRATION=1 BEGINNER_ACCOUNT_DB_INTEGRATION=1 GENERAL_TRADING_DB_INTEGRATION=1 GENERAL_FX_DB_INTEGRATION=1 SEASON_JOIN_DB_INTEGRATION=1 AUTH_DB_SMOKE=1 OPS_JOB_LOCK_DB_SMOKE=1
pnpm exec jest --runInBand --json --outputFile="${CORE_GATE_JSON:?Set output path}" \
  src/assets/assets-tradability.integration.spec.ts \
  src/seasons/trading-account.integration.spec.ts \
  src/seasons/trading-account-link.integration.spec.ts \
  src/seasons/trading-account-financial-scope.integration.spec.ts \
  src/seasons/trading-account-trading-scope.integration.spec.ts \
  src/trading-accounts/general-account.integration.spec.ts \
  src/trading-accounts/beginner-account.integration.spec.ts \
  src/trading-accounts/beginner-quest.integration.spec.ts \
  src/wallets/wallet-scope.integration.spec.ts \
  src/orders/general-account-trading.integration.spec.ts \
  src/fx/general-account-fx.integration.spec.ts \
  src/orders/order-replay-and-cancel-scope.integration.spec.ts \
  src/portfolio/general-performance-hardening.integration.spec.ts \
  src/portfolio/krx-closed-price.integration.spec.ts \
  src/portfolio/krx-session-close-recovery.integration.spec.ts \
  src/portfolio/snapshot-scope-audit.integration.spec.ts \
  src/trading-accounts/general-trading-audit.integration.spec.ts \
  src/ranking/season-ranking-scope.integration.spec.ts \
  src/ranking/ranking-consistency.integration.spec.ts \
  src/friends/friends.integration.spec.ts \
  src/seasons/seasons.join.integration.spec.ts \
  src/auth/auth.integration.spec.ts \
  src/ops/ops-job-lock.integration.spec.ts
