#!/usr/bin/env bash
set -euo pipefail
# Run from backend/. All connections must be explicitly supplied.
node -e 'for (const key of ["DATABASE_URL", "REDIS_URL"]) { const u = new URL(process.env[key]); if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) throw new Error("Disposable loopback URLs required"); if (key === "DATABASE_URL" && !u.pathname.endsWith("_test")) throw new Error("Test DB suffix required"); }'
export NODE_ENV=test
export LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1 LIMIT_ORDER_IDEMPOTENT_REPLAY_INTEGRATION=1 LIMIT_ORDER_MATCHING_DB_INTEGRATION=1
export ORDER_EXECUTE_DB_INTEGRATION=1 MARKET_EXECUTION_DB_INTEGRATION=1 FX_EXECUTE_DB_INTEGRATION=1
export FUTURES_DB_INTEGRATION=1 FUTURES_RISK_DB_INTEGRATION=1 FUTURES_F3_DB_INTEGRATION=1 FUTURES_F31_DB_INTEGRATION=1
export CONDITIONAL_DB_INTEGRATION=1 FUTURES_LIMIT_DB_INTEGRATION=1 MVP_FLOW_DB_SMOKE=1
pnpm exec jest --runInBand --json --outputFile="${FINANCIAL_GATE_JSON:?Set output path}" \
  src/orders/order-input-policy.integration.spec.ts \
  src/orders/limit-order-reservation.integration.spec.ts \
  src/wallets/spot-wallet-transfer.integration.spec.ts \
  src/wallets/wallet-fx-transfer.integration.spec.ts \
  src/futures/futures.integration.spec.ts \
  src/futures/futures-risk.integration.spec.ts \
  src/futures/futures-f3.integration.spec.ts \
  src/futures/futures-f31.integration.spec.ts \
  src/conditional/conditional.integration.spec.ts \
  src/futures/futures-limit.integration.spec.ts \
  src/futures/futures-isolated-boundary.integration.spec.ts \
  src/orders/limit-order-create-race.integration.spec.ts \
  src/orders/limit-order-transaction-time.integration.spec.ts \
  src/orders/trading-transaction-time.integration.spec.ts \
  src/orders/trading-fee-pinning.integration.spec.ts \
  src/orders/limit-order-create-no-redis.integration.spec.ts \
  src/orders/limit-order-idempotent-replay.integration.spec.ts \
  src/orders/limit-order-matching.integration.spec.ts \
  src/orders/orders.execute.integration.spec.ts \
  src/orders/market-execution.integration.spec.ts \
  src/fx/fx.execute.integration.spec.ts \
  src/mvp-flow.integration.spec.ts
