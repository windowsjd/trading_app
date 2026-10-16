#!/bin/bash
# Local 100 + 100 soak of the built backend against REAL public Binance streams.
# usage: BACKEND=<repo>/backend RUN_DIR=<empty dir without .env files> \
#        DATABASE_URL=<loopback *_soak> REDIS_URL=<loopback> start-soak.sh <phase> <history true|false>
# The run directory must contain no .env* files: the app reads them from its
# working directory, and backend/.env.local points at production.
set -eu
cd "$RUN_DIR"
case "$DATABASE_URL" in postgresql://*@127.0.0.1:*) ;; *) echo "loopback DATABASE_URL only"; exit 2 ;; esac
case "$REDIS_URL" in redis://127.0.0.1:*) ;; *) echo "loopback REDIS_URL only"; exit 2 ;; esac
exec env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3999 \
  DATABASE_URL="$DATABASE_URL" REDIS_URL="$REDIS_URL" \
  JWT_ACCESS_SECRET=soak-access-secret-0123456789 JWT_REFRESH_SECRET=soak-refresh-secret-0123456789 \
  JWT_ACCESS_TTL=15m REFRESH_TOKEN_TTL=30d \
  PROVIDER_INGESTION_ENABLED=true BINANCE_PUBLIC_MARKET_DATA_ENABLED=true BINANCE_WEBSOCKET_STREAMING_ENABLED=true \
  FUTURES_MARK_INGESTION_ENABLED=true FUTURES_LAST_PRICE_INGESTION_ENABLED=true \
  SCHEDULER_ENABLED=false CRYPTO_ORDER_BOOK_HISTORY_ENABLED="$2" \
  SOAK_PROBE_FILE="$RUN_DIR/probe-$1.jsonl" NODE_OPTIONS=--max-old-space-size=1536 \
  node -r "$(dirname "$0")/eventloop-probe.cjs" "$BACKEND/dist/src/main.js"
