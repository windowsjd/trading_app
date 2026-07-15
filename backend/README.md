# trading_app Backend

Season-based virtual trading app backend built with NestJS, Prisma 7 adapter style, PostgreSQL, and Redis.

This service owns backend APIs, database access, financial calculations, and server-side write paths for the MVP. Financial values are exchanged as strings.

## Current MVP Scope

- Access token + refresh token auth: signup, login, refresh, logout, logout-all, and `GET /api/v1/me`.
- Admin/operator authorization and account management: `UserRole`, DB-current-role access context, `GET /api/v1/operator/me`, admin-only user list/get, admin-only role change, admin-only user status/restore, and internal operator audit log service/model.
- Internal reward fulfillment foundation: operator/admin managed request queue/status APIs, idempotent internal reward requests, fulfillment into `SeasonReward`, and fulfilled-only user reward visibility. This does not call or implement external cash, point, coupon, gifticon, payment, or delivery APIs.
- Admin/operator runtime DBs must have migration `20260601090000_add_user_role_operator_audit_logs` applied so `users.role` and `operator_audit_logs` exist.
- Current season lookup and season join.
- Season write paths require effective active season state: `status=active` and `startAt <= now < endAt` for join, FX quote/execute, and orders quote/create/execute. Public order cancel is currently blocked with `ORDER_CANCEL_NOT_SUPPORTED`.
- Home as one aggregate API.
- Home settled final-result read model from existing `rankType=final` `season_rankings`.
- Wallets, records, ranking, and orders read APIs.
- Return-rate values are percentages everywhere; the schema column name is unchanged.
- FX quote checks the joined participant's source cash wallet balance before storing a durable quote. FX execute consumes durable quotes and reprices at execute time from fresh `provider_api` USD/KRW rows. Korea EXIM exchange (`korea_exim_exchange_rate`) is preferred, and ExchangeRate-API (`exchange_rate_api`) remains the fallback provider.
- `GET /api/v1/fx/rates/current` returns the current stored USD/KRW rate. `refresh=true` may refresh Korea EXIM exchange data only when both `PROVIDER_INGESTION_ENABLED=true` and `KOREA_EXIM_EXCHANGE_ENABLED=true`; otherwise it falls back to existing DB snapshots, using only approved `admin_manual` rows when provider rows are unavailable.
- Orders quote stores durable quotes; `POST /api/v1/orders` requires `quoteId` and `idempotencyKey`, creates the market order, consumes the quote, and immediately executes from fresh `provider_api` asset/FX rows.
- Stock order quote/create/execute enforce regular market hours. Crypto orders and FX quote/execute do not receive a market-hours block in this gate.
- FX execute and orders create idempotency request hashes include `quoteId`, so the same idempotency key with a different quote conflicts instead of replaying an old result.
- KRW and USD cash wallets. US stocks and USD-settled crypto use the USD wallet.
- Final valuation policy is KRW total assets.
- Provider ingestion foundation exists for Korea EXIM exchange and ExchangeRate-API USD/KRW, Binance Spot WebSocket crypto streaming with REST fallback, KIS REST current-price snapshots, and KIS WebSocket KRX/US stock market data row insertion.
- `GET /api/v1/assets/:assetId/candles` supports domestic/US stock candles through KIS and crypto chart candles through Binance Spot `GET /api/v3/klines`. 지원 candle interval은 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w만 허용한다. 프론트 자산 상세 차트 탭도 1m, 5m, 15m, 30m, 1h, 4h, 1d, 1w 순서를 사용한다. 그 외 interval은 validation error로 처리한다. 필요 시 서버가 더 짧은 원천 candle을 집계해 상위 interval candle을 생성한다.
- Provider_api source eligibility is opened only for explicitly allowed workflows: `/fx quote`, `/fx execute`, assets `withPrice`, orders quote, order execution, live portfolio/home/positions valuation, the operator-run daily portfolio snapshot valuation job, and season settlement valuation. Orders create uses the durable quote and immediate execution path.
- Asset list/detail/price `changeRate` is calculated from the immediately previous positive `asset_price_snapshots.price` row for the same asset and price currency; it is `null` when no valid previous positive snapshot exists. Provider raw payloads, provider-specific ticker change fields, tokens, secrets, and private ledger data are not exposed.
- Read-only/quote responses expose backward-compatible optional source metadata for provider/admin visibility: `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation source summaries where applicable.
- Batch job execution foundation with idempotent `batch_job_runs` recording, operator-only noop/health-check script, operator-run daily portfolio snapshot generation, operator-run season ranking generation from existing daily snapshots, an operator-run daily season cycle orchestration job, an operator-run season settlement MVP job, an operator-run reward grant marker MVP job, and an operator-run season lifecycle transition job.
- Scheduler/Ops foundation with disabled-by-default scheduler config, `ops_job_runs` audit rows, `ops_job_locks`, internal runner services, and `GET /readiness`. Enabled provider ingestion, ranking, season lifecycle, and settlement scheduler jobs perform real backend automation behind locks.
- Daily portfolio snapshot batch results include sourceSummary/fallback metadata in `batch_job_runs.resultPayloadJson`; `daily_portfolio_snapshots` row schema is unchanged.
- Durable Quote plus realtime provider execute is implemented for `/fx execute` and the order execution path used by `POST /api/v1/orders`. Quote remains a reference quote; execute reprices from fresh provider_api rows, enforces quote-to-execute bps thresholds, and forbids default admin_manual execute fallback. `POST /api/v1/orders/:orderId/execute` remains as an internal compatibility/deprecation path, not the required public user flow.
- Current ranking refresh runs through the enabled scheduler every 1 minute, updates live participant valuations, creates scheduled equity snapshots only on 5-minute buckets, writes `season_rankings` with `rankType=daily`, and updates `SeasonParticipant.currentRank`.
- Season settlement freezes valuation at `Season.endAt`, uses the latest valid price and USD/KRW rows with `effectiveAt <= Season.endAt` without enforcing quote/execute freshness windows, writes final `equity_snapshots`, creates `rankType=final` rankings, assigns final tiers, and changes the season to `settled` only after final rank and tier readiness checks pass. Reward payout remains pending/unimplemented.
- Market holidays are configured in `src/orders/market-holidays.config.ts`; domestic/US stock quote/create/execute return `MARKET_CLOSED` on configured holidays, while crypto orders and FX are not holiday-blocked.

## STOP / Not Implemented

These are intentionally outside the current implementation and should not be added without a separate gate:

- Provider-backed reward workflows.
- Binance Futures APIs and Binance authenticated order/account/user-data APIs.
- OANDA and Twelve Data are historical provider candidates only, not the current MVP core provider stack.
- Batch run HTTP APIs, scheduler HTTP APIs, external reward fulfillment APIs, and reward policy/catalog APIs.
- Production cron job implementation beyond the disabled-by-default foundation, scheduler-driven provider ingestion, scheduler-driven reward automation, or external reward fulfillment jobs.
- Provider-backed reward automation.
- KIS order/account/balance/fill/deposit/withdrawal APIs, KIS orderbook/hoga, Binance authenticated/order/account/user-data APIs, and real external trading/account integrations.
- External payment, point, coupon, gifticon, delivery, cash-out, or provider-backed reward fulfillment. App-internal operator/admin reward fulfillment creates `SeasonReward` rows only when fulfilled.
- Access token blacklist/revocation, server-side session auth, and cookie auth.
- Matching engine, partial fill, or exact order execute replay.
- Fake, static, sample, temporary, or fallback business price data.

## Environment Variables

Required for local application work:

- `DATABASE_URL`: PostgreSQL connection string used by Prisma.
- `REDIS_URL`: Redis connection string reserved for backend runtime integration.
- `JWT_ACCESS_SECRET`: strong secret for access-token signing and verification.
- `JWT_ACCESS_TTL`: explicit access-token lifetime.
- `REFRESH_TOKEN_TTL`: explicit opaque refresh-token lifetime.

`JWT_ACCESS_SECRET` and `REFRESH_TOKEN_TTL` are fail-closed. If either is missing, auth configuration validation fails.

`JWT_ACCESS_TTL` and `REFRESH_TOKEN_TTL` must be a number plus one allowed unit with no spaces:

- Allowed: `30s`, `15m`, `1h`, `7d`, `2w`
- Common refresh examples: `7d`, `14d`, `30d`
- Rejected: `900`, `15 m`, `15 d`, `500ms`, `1y`, empty string

Refresh tokens are opaque random tokens. The raw token is returned to the client and never stored in PostgreSQL; only a SHA-256 hash is stored in `refresh_token_sessions`. Refresh uses token rotation. Logout revokes refresh sessions. Access tokens remain stateless Bearer JWTs and are not blacklisted in this MVP.

Scheduler/Ops env is non-secret and disabled by default. `SCHEDULER_ENABLED=false` prevents interval registration unless one of the explicit scheduler aliases or provider job flags is enabled. Each `SCHEDULER_*_ENABLED=false` flag keeps its job from running automatically. `SCHEDULER_PROVIDER_FX_ENABLED`, `SCHEDULER_PROVIDER_BINANCE_ENABLED`, and `SCHEDULER_PROVIDER_KIS_ENABLED` enable provider ingestion jobs; KIS also accepts `ENABLE_PROVIDER_KIS_SCHEDULER`. `SCHEDULER_RANKING_ENABLED` or `ENABLE_RANKING_SCHEDULER` enables current ranking refresh, `SCHEDULER_SEASON_LIFECYCLE_ENABLED` or `ENABLE_SEASON_LIFECYCLE_SCHEDULER` enables `active -> ended` lifecycle transitions, and `SCHEDULER_SETTLEMENT_ENABLED` or `ENABLE_SEASON_SETTLEMENT_SCHEDULER` enables ended-season settlement. `SCHEDULER_TICK_INTERVAL_MS` defaults to `60000`; `RANKING_REFRESH_INTERVAL_SECONDS` and `SEASON_SETTLEMENT_INTERVAL_SECONDS` are accepted second-based aliases when the tick interval is not set. `SCHEDULER_LOCK_TTL_SECONDS` defaults to `600`, and `SCHEDULER_MAX_ATTEMPTS` defaults to `1`.

Production ranking automation requires the deployment environment to enable the ranking scheduler. Without this, current ranking automatic refresh and 5-minute scheduled equity snapshot creation do not run. Recommended production example:

```env
SCHEDULER_ENABLED=true
SCHEDULER_RANKING_ENABLED=true
SCHEDULER_TICK_INTERVAL_MS=60000
SCHEDULER_LOCK_TTL_SECONDS=600
SCHEDULER_MAX_ATTEMPTS=1
```

The minimal ranking-only alias is also accepted:

```env
ENABLE_RANKING_SCHEDULER=true
```

When the ranking scheduler is enabled, current ranking refresh runs on each 1-minute scheduler tick and scheduled equity snapshots are created from that ranking tick only on 5-minute buckets. Provider ingestion scheduler flags and reward marker scheduler flags are separate gates and must not be confused with ranking automation. These settings do not change the `/api/v1` contract and do not introduce `/api/v2`.

Provider scheduler example:

```env
SCHEDULER_ENABLED=true
SCHEDULER_PROVIDER_FX_ENABLED=true
SCHEDULER_PROVIDER_BINANCE_ENABLED=true
SCHEDULER_PROVIDER_KIS_ENABLED=false

SCHEDULER_TICK_INTERVAL_MS=60000

SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS=3600
SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS=60

SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=true
SCHEDULER_PROVIDER_TARGET_SOURCE=merged

PROVIDER_INGESTION_ENABLED=true
```

Provider intervals are checked against the latest `ops_job_runs` row and do not create noisy skipped rows when a provider is not due. Defaults are FX 3600 seconds, Binance 60 seconds, and KIS 60 seconds. `SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=true` queues one asynchronous startup run for enabled provider jobs only and then emits a non-fatal market snapshot health warning when active asset coverage is still unavailable. Binance and KIS real-time prices are owned by their long-lived WebSocket streaming services below, not by the scheduler. When `BINANCE_WEBSOCKET_STREAMING_ENABLED=true`, the scheduler protects against duplicate Binance REST polling by skipping `provider_binance_ingest`. `SCHEDULER_PROVIDER_BINANCE_ENABLED=true` and `SCHEDULER_PROVIDER_KIS_ENABLED=true` remain available only for fallback/manual/debug ingestion jobs.

`SCHEDULER_PROVIDER_TARGET_SOURCE` controls provider price targets:

- `active_assets`: build Binance/KIS targets only from active DB assets.
- `env`: use provider env watchlists only.
- `merged`: combine env watchlists and active DB assets without duplicates. This is the default and keeps existing env behavior while adding active assets automatically.

`PROVIDER_INGESTION_ENABLED=false` is the fail-closed default for provider refresh/ingestion calls. Korea EXIM on-demand refresh requires both `PROVIDER_INGESTION_ENABLED=true` and `KOREA_EXIM_EXCHANGE_ENABLED=true`. If either flag is disabled, `GET /api/v1/fx/rates/current` falls back to existing DB snapshots and returns `FX_RATE_UNAVAILABLE` only when no usable provider row or approved `admin_manual` row exists.

Korea EXIM exchange provider env is `KOREA_EXIM_EXCHANGE_ENABLED`, `KOREA_EXIM_EXCHANGE_AUTH_KEY`, `KOREA_EXIM_EXCHANGE_BASE_URL`, `KOREA_EXIM_EXCHANGE_DATA`, and `KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS`. The request URL is `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON` with `authkey`, `searchdate`, and `data=AP01`; USD/KRW uses the USD row's `DEAL_BAS_R` value with commas removed. ExchangeRate-API fallback env is `EXCHANGE_RATE_API_ENABLED`, `EXCHANGE_RATE_API_KEY`, and `EXCHANGE_RATE_API_BASE_URL`. Real auth keys must live only in `.env.local`; `.env.example` keeps the auth key blank. ExchangeRate-API remains the fallback provider after Korea EXIM exchange.

Binance public market data uses `BINANCE_PUBLIC_MARKET_DATA_ENABLED`, `BINANCE_REST_BASE_URL`, `BINANCE_WS_MARKET_DATA_BASE_URL`, `BINANCE_CRYPTO_SYMBOLS`, and `BINANCE_CRYPTO_USDT_AS_USD_EQUIVALENT`, with `BINANCE_REST_BASE_URL` defaulting to `https://api.binance.com` and `BINANCE_WS_MARKET_DATA_BASE_URL` defaulting to `wss://stream.binance.com:9443` when unset. Crypto candles use only the public Spot `GET /api/v3/klines` endpoint with USDT quote symbols such as `BTCUSDT` and `ETHUSDT`; supported kline intervals are `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, and `1w`. No Binance API key or secret is required for public Spot candle or WebSocket market-data paths.

Binance long-lived WebSocket streaming starts with the NestJS backend process when `BINANCE_WEBSOCKET_STREAMING_ENABLED=true` and the provider gates are satisfied:

```env
PROVIDER_INGESTION_ENABLED=true
BINANCE_PUBLIC_MARKET_DATA_ENABLED=true
BINANCE_WS_MARKET_DATA_BASE_URL=wss://stream.binance.com:9443
BINANCE_CRYPTO_SYMBOLS=BTCUSDT,ETHUSDT
BINANCE_WEBSOCKET_STREAMING_ENABLED=true
BINANCE_WEBSOCKET_STREAMING_RECONNECT_MIN_MS=1000
BINANCE_WEBSOCKET_STREAMING_RECONNECT_MAX_MS=30000
BINANCE_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS=60000
BINANCE_WS_SNAPSHOT_THROTTLE_MS=5000
SCHEDULER_PROVIDER_BINANCE_ENABLED=false
```

The streaming service subscribes to public Spot `<symbol>@ticker` streams such as `btcusdt@ticker`, updates an in-memory latest-price cache on every tick, publishes `/api/v1/ws` `asset_ticker` updates for subscribed clients, and writes `asset_price_snapshots` only through `BINANCE_WS_SNAPSHOT_THROTTLE_MS`. It reconnects with backoff, reconnects before Binance's 24-hour connection limit, responds to ping frames with pong payloads, and resubscribes after reconnect. REST 24hr ticker ingestion remains available for fallback/manual/debug use with the scheduler or operator paths, but should not run as the default real-time crypto path while streaming is enabled.

KIS long-lived WebSocket streaming starts with the NestJS backend process when `KIS_WEBSOCKET_STREAMING_ENABLED=true` and the provider gates are satisfied:

```env
PROVIDER_INGESTION_ENABLED=true
KIS_MARKET_DATA_ENABLED=true
KIS_APP_KEY=...
KIS_APP_SECRET=...
KIS_REST_BASE_URL=...
KIS_WS_BASE_URL=...
KIS_WEBSOCKET_STREAMING_ENABLED=true
KIS_WEBSOCKET_STREAMING_RECONNECT_MIN_MS=1000
KIS_WEBSOCKET_STREAMING_RECONNECT_MAX_MS=30000
KIS_WEBSOCKET_STREAMING_HEARTBEAT_TIMEOUT_MS=60000
```

The streaming service uses `KIS_REST_BASE_URL` only to issue/cache `/oauth2/Approval` approval keys through `KisAuthClient`; the cache is in-memory and is lost on process restart. It keeps the KIS WebSocket open, resubscribes after reconnect, updates an in-memory latest-price cache on every tick, and writes `asset_price_snapshots` only through the existing `KIS_WS_SNAPSHOT_THROTTLE_MS` DB throttle. `KIS_WS_MAX_RUNTIME_MS` is only for the one-shot WebSocket ingestion job. KIS REST current price ingestion remains available for fallback/manual/debug use with `KIS_PRICE_INGESTION_MODE=rest_current_price`.

Market snapshot readiness requires provider ingestion and at least one USD/KRW FX provider:

```env
PROVIDER_INGESTION_ENABLED=true

# FX, one of:
KOREA_EXIM_EXCHANGE_ENABLED=true
KOREA_EXIM_EXCHANGE_AUTH_KEY=...
# or
EXCHANGE_RATE_API_ENABLED=true
EXCHANGE_RATE_API_KEY=...

# Binance
BINANCE_PUBLIC_MARKET_DATA_ENABLED=true
BINANCE_CRYPTO_SYMBOLS=BTCUSDT,ETHUSDT

# KIS
KIS_MARKET_DATA_ENABLED=true
KIS_REST_BASE_URL=...
KIS_APP_KEY=...
KIS_APP_SECRET=...
KIS_DOMESTIC_SYMBOLS=005930,000660
KIS_US_SYMBOLS=AAPL,TSLA
```

Display/read freshness is intentionally wider than execute freshness. Asset list/detail/price, Home, positions, and live portfolio valuation use display defaults of 300 seconds for asset prices and 7200 seconds for USD/KRW. Quote paths keep shorter quote defaults, and order/FX execute paths keep the strict existing execute defaults of 10 seconds for asset prices and 60 seconds for USD/KRW.

### Redis and the candle response cache

Redis runs from `docker-compose.yml` alongside PostgreSQL:

```bash
cd backend
docker compose up -d          # starts postgres and redis
docker compose up -d redis    # redis only
```

Connection env:

- `REDIS_URL`: Redis connection string (default `redis://localhost:6379`).
- `REDIS_CONNECT_TIMEOUT_MS`: connect timeout in milliseconds; default `3000`. Must be a positive integer.
- `REDIS_COMMAND_TIMEOUT_MS`: maximum duration of an individual Redis command; default `1000`. Timed-out cache commands fail open, while coordination falls back locally.

Candle response cache env:

- `CANDLE_CACHE_ENABLED`: default `false`. Accepts `true`/`false`/`1`/`0`.
- `CANDLE_CACHE_MAX_PAYLOAD_BYTES`: default `2097152` (2 MiB). Must be a positive integer.
- `CANDLE_CACHE_CURRENT_STALE_TTL_SECONDS`: hard TTL for latest/current responses; default `300` (the interval fresh TTL remains 15s–3600s).
- `CANDLE_CACHE_HISTORICAL_FRESH_TTL_SECONDS` / `CANDLE_CACHE_HISTORICAL_STALE_TTL_SECONDS`: completed historical response TTLs; defaults `900` / `3600`.
- `CANDLE_CACHE_EMPTY_FRESH_TTL_SECONDS` / `CANDLE_CACHE_EMPTY_STALE_TTL_SECONDS`: shorter confirmed-empty TTLs; defaults `10` / `60`.
- `CANDLE_SINGLE_FLIGHT_LOCK_TTL_MS`: distributed load-lock TTL; default `30000`.
- `CANDLE_SINGLE_FLIGHT_WAIT_TIMEOUT_MS`: bounded remote-owner wait; default `35000`.
- `CANDLE_SINGLE_FLIGHT_POLL_INTERVAL_MS`: cache polling interval; default `100`.
- `CANDLE_SINGLE_FLIGHT_RENEW_INTERVAL_MS`: owner lock renewal interval; default `10000` and must be below the lock TTL.

KIS REST coordination env:

- `KIS_RATE_LIMIT_ENABLED`: default `true`.
- `KIS_API_ENVIRONMENT`: explicit `real` or `virtual`; default `real`. URL guessing is not used.
- `KIS_REST_MIN_INTERVAL_MS`: default `125` for real (~8/sec) and `1000` for virtual (1/sec). Real values below `56` and virtual values below `1000` are rejected, preserving the official maxima of 18/sec and 1/sec respectively.
- `KIS_OAUTH_MIN_INTERVAL_MS`: default/minimum `1000` (1/sec) for `/oauth2/tokenP` and other OAuth REST calls.
- `KIS_RATE_LIMIT_MAX_WAIT_MS`: queue/reservation wait bound; default `30000`.
- `KIS_RATE_LIMIT_MAX_QUEUE_SIZE`: per-process FIFO queue bound; default `500`.

### Managed HTTP candle serving (unit 3-1 / 3-2)

`GET /api/v1/assets/:assetId/candles` has two explicit rollout modes. `CANDLE_SERVING_MODE=legacy` (the default) preserves the existing provider-direct path. `CANDLE_SERVING_MODE=database` enables the managed path for persisted `5m`/`1d`/`1w` feeds and read-time `15m`/`30m`/`1h`/`4h`; unknown mode values fail configuration instead of silently falling back. `1m`, ranges outside persistence/retention policy, and large cold requests without completed baseline coverage remain on legacy. Seed those cold baselines with the manual Ops `market_candle_sync` job; an HTTP request never starts an unbounded initial backfill.

Managed order is fresh Redis → PostgreSQL canonical rows → bounded incremental/small repair sync → PostgreSQL requery → Redis. Provider rows are never returned directly. Operational failures — including a PostgreSQL outage during the INITIAL database read, connection resets/timeouts/pool exhaustion, transient Prisma driver errors, and Redis single-flight wait timeouts (classified in `src/assets/candle-operational-error.ts`) — fall back to stale Redis and then strict PostgreSQL last-known-good; validation, configuration, schema/programmer, authentication, asset-not-found, and authorization errors are not hidden. When neither degraded copy exists, the request fails with the existing provider-compatible error contract (`ASSET_CANDLES_PROVIDER_ERROR` 502 for crypto, `ASSET_CANDLES_PROVIDER_UNAVAILABLE` 503 for stocks) WITHOUT contacting the provider: once a managed refresh has started, no failure path bypasses the canonical store with a provider-direct response (logged as `candle_delivery_failed`/`managed_unresolved`). Provider-direct serving is reachable only through `CANDLE_SERVING_MODE=legacy` (the explicit full-rollback switch), unmanaged read plans, or the documented cold-baseline policy (logged as `cold_baseline_required` — a request without completed baseline coverage whose range exceeds the on-demand repair budget, seeded by operators through the manual sync job). Redis failures retain local single-flight and DB/provider serving, but distributed dedupe is unavailable until Redis recovers.

The request clock is captured once. The read plan uses UTC half-open ranges, maps `5m`/derived intervals to stored `5m`, maps `1d`/`1w` directly, and pads the source start for complete higher-interval aggregation. Coverage comes from coverage-audited checkpoints: a run must be `status=completed` **and** `coverageComplete=true` with a persisted `[coveredFrom, coveredTo)` range spanning the request (clamped at the request clock). `completed` alone (e.g. a run that ended `provider_exhausted`/`empty_page` before reaching `targetFrom`) is never coverage evidence, and checkpoints completed before the coverage migration must be re-synced before database serving owns their ranges. The checkpoint repository enforces the full invariant on completion: a `coverageComplete=true` claim must carry `target_reached`/`confirmed_empty`, a well-formed `[coveredFrom, coveredTo)` with `coveredFrom <= targetFrom`, **and** `coveredTo >= requiredCoveredTo` where `requiredCoveredTo = min(targetTo, sync-time now)`; violations throw before the row is written. Sync summaries report `completedFeeds` (runs that terminated normally — NOT a coverage count) separately from `coverageCompleteFeeds` and `completedWithIncompleteCoverageFeeds`. Historical incomplete aggregate buckets are removed; an unconfirmed empty store is `missing`, not a successful empty response. See "Sync coverage completeness" in [`docs/candle-live-operations.md`](docs/candle-live-operations.md).

Cache keys use the `candles:data:v2` namespace, normalized semantic inputs, an asset generation, and a stable `latest` identity for requests without explicit `to`. Envelopes contain `schemaVersion`, `cachedAt`, `freshUntil`, `staleUntil`, and the unchanged response; Redis retains the key only through `staleUntil`. Corrupt entries delete only their exact key. Successful logical asset/feed writes increment `candles:gen:v2:{assetId}` after the durable write. Old-generation owners cannot write because the Lua write verifies both lock token and generation. An invalidation outage cannot roll back PostgreSQL; therefore hard stale TTLs remain bounded and a recovered Redis can expose an old entry only until that TTL expires.

The endpoint success/error JSON contract is unchanged. Persisted provider provenance is compatibility-mapped into the existing `source` union (KIS domestic/overseas minute or period path, or Binance klines); it does not claim that an HTTP provider call occurred for the current request. The v1 payload requires `amount` to be a string, so a persisted provider-native `amount=null` is centrally mapped to `"0.00000000"` until a separately versioned public contract can represent null. **Known limitation:** this mapping loses the distinction between "zero traded value" and "amount unavailable"; a future v2 (or response metadata) should consider `amountAvailable`/nullable `amount`. This stabilization deliberately makes no breaking v1 change.

Serving configuration: `CANDLE_SERVING_CURRENT_DB_FRESHNESS_MS` (default `60000`), `CANDLE_SERVING_ON_DEMAND_REFRESH_ENABLED` (default `true`), `CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_DURATION_MS` (default `15000`), `CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_PAGES` (default `10`), `CANDLE_SERVING_ON_DEMAND_REFRESH_MAX_ROWS` (default `5000`), `CANDLE_SERVING_STALE_WAITER_MAX_WAIT_MS` (default `500`), and `CANDLE_SERVING_ON_DEMAND_REPAIR_MAX_RANGE_MS` (default two days). These per-request budgets are clamped by the sync orchestrator's global page/row/duration budgets; cancellation and the asset/feed lock still apply.

WebSocket current/higher candle updates and disabled-by-default canonical reconciliation are implemented by the unit-3 live pipeline. See [`docs/candle-live-operations.md`](docs/candle-live-operations.md) — it also documents the versioned KRX/US market calendar (2026 audited; KRX 2027 provisional until the official KRX year-end notice — readiness reports `MARKET_CALENDAR_COVERAGE_MISSING` for missing years and `MARKET_CALENDAR_PROVISIONAL` for provisional ones, both degraded, and `MARKET_CALENDAR_REQUIRED_FROM_YEAR`/`MARKET_CALENDAR_REQUIRED_THROUGH_YEAR` drive the required range; uncovered dates fail safe), stale-Redis fallback semantics, old-generation live bucket recovery, connection liveness (`CANDLE_LIVE_CONNECTION_LIVENESS_TIMEOUT_MS`, supervisor watchdog) vs trade freshness (`CANDLE_LIVE_TRADE_STALE_THRESHOLD_MS`, readiness only; `CANDLE_LIVE_STALE_THRESHOLD_MS` is a deprecated fallback for both), the shared frontend WebSocket, the release fixture smoke (`CANDLE_PIPELINE_RELEASE_FIXTURE_SMOKE=1 pnpm run smoke:candle-fixture`), the real-provider long-smoke harness (`pnpm run smoke:candle-live`), and smoke commit traceability (`SMOKE_GIT_COMMIT`, `SMOKE_ALLOW_DIRTY`, NOT_RUN reports via `pnpm run smoke:candle-report`).

CI: `.github/workflows/ci.yml` gates every PR and `main` push with three jobs — **Backend quality** (`pnpm run lint:candles:check`, `pnpm run format:candles:check`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`), **Frontend quality** (`npm run typecheck`, `npm test`; the Expo app has no build script — typecheck is the compile gate), and **Candle fixture integration** (PostgreSQL+Redis services, `prisma migrate deploy`, the fixture smoke with artifact commit/dirty verification). The candle layer is the required lint/format gate; repository-wide lint debt outside it is known and not yet gated. Long real-provider smokes are never run in CI — see the runbook in [`docs/candle-live-operations.md`](docs/candle-live-operations.md).

Important operational behavior:
- KIS REST rate limiting is active on the actual `KisAuthClient` OAuth and `KisQuoteClient` quote request paths. It does not affect Binance REST or either provider's WebSocket traffic. Redis atomically reserves account-wide slots using Redis server time; if Redis is unavailable, each process continues with a conservative FIFO in-process limiter instead of calling KIS without limits. Multi-instance fallback cannot enforce a shared account limit and emits one outage warning until recovery.
- Single-flight uses local Promise sharing plus token-owned Redis locks, bounded cache polling, double-check after acquisition, and periodic ownership renewal. It is intended for bounded serving loads only; minute-scale historical backfills require a later job queue/backfill-lock design.
- Single-flight snapshots the asset cache generation once. Local Promise and distributed lock identities include that generation, and the final cache write is one Lua operation that verifies both the owner token and unchanged generation. A successful stale loader result may be returned to its caller but is never written into a newer generation.
- The cache **fails open**: `RedisService` connects lazily (no Redis connection is opened at boot while the cache is disabled), registers an error listener so a Redis outage cannot crash the process, and reconnects with bounded backoff. Cache reads return a `miss`/`error` status and cache writes return an `error` status when Redis is unavailable, so a Redis outage never breaks the API once the cache is wired. Redis URL/password and cached payloads are never logged.
- Cache invalidation for one asset is O(1) via a per-asset generation counter (`candles:gen:v2:{assetId}` is `INCR`ed); prior entries under `candles:data:v2:{assetId}:g{generation}:…` become unreachable and expire by TTL. No `KEYS`, production `SCAN`, `FLUSHDB`, or `FLUSHALL` is used.

Opt-in real Redis smoke test (needs a reachable `REDIS_URL`; runs in-process, so it works on Windows and Linux/WSL). Without the flag Jest reports it as skipped instead of passing a no-op:

```bash
CANDLE_CACHE_REDIS_SMOKE=1 pnpm test -- asset-candles-cache.integration.spec.ts
CANDLE_SERVING_DB_SMOKE=1 pnpm test -- candle-pipeline-foundation.integration.spec.ts
KIS_COORDINATION_REDIS_SMOKE=1 pnpm test -- kis-coordination.integration.spec.ts
```

It only creates and deletes keys under a random-UUID asset namespace and never flushes shared Redis data.

### Market candle retention

The future 4-hour chart serves a 30-day display window. The internal source policy keeps 5-minute candles for 35 days by default, leaving a five-day safety margin. Retention deletes only rows satisfying all of `interval='5m'`, `is_closed=true`, and `open_time < cutoff`. Open 5m candles, daily candles, weekly candles, and rows exactly at the cutoff are preserved.

Retention uses deterministic bounded PostgreSQL batches (default 5,000 rows), yields between full batches, and is idempotent after partial failure. The existing `(interval, open_time)` and `(is_closed, open_time)` indexes support candidate selection; no speculative index was added.

Scheduler configuration:

- `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=false`
- `MARKET_CANDLE_5M_RETENTION_DAYS=35` (minimum 31)
- `MARKET_CANDLE_RETENTION_BATCH_SIZE=5000` (maximum 10,000)
- `SCHEDULER_MARKET_CANDLE_RETENTION_HOUR=4`
- `SCHEDULER_MARKET_CANDLE_RETENTION_MINUTE=0`
- `SCHEDULER_MARKET_CANDLE_RETENTION_RUN_ON_STARTUP=false`

The default schedule is 04:00 in `SCHEDULER_TIMEZONE` (`Asia/Seoul`) and is disabled by default. Due checks use persisted successful non-dry-run `OpsJobRun` history, while the shared DB lock and owner-checked renewal ensure only one deletion owner across backend instances. Failed runs can retry on a later tick. Startup opt-in uses the same due check and does not run unconditionally.

Manual/operator code must call `OpsJobRunnerService.runMarketCandleRetentionJob({ trigger, requestedBy, dryRun })`; this preserves the same lock and `OpsJobRun` audit path. No unauthenticated/public retention endpoint or direct-delete script exists.

Opt-in smoke commands (all use isolated UUID fixtures and `migrate deploy`; none resets or drops the database):

```bash
MARKET_CANDLE_RETENTION_DB_SMOKE=1 pnpm test -- market-candle-retention.integration.spec.ts
KIS_COORDINATION_REDIS_SMOKE=1 pnpm test -- kis-coordination.integration.spec.ts
CANDLE_PIPELINE_FOUNDATION_SMOKE=1 pnpm test -- candle-pipeline-foundation.integration.spec.ts
```

KIS deployments with both `KIS_MARKET_DATA_ENABLED=true` and rate limiting enabled must explicitly set `KIS_API_ENVIRONMENT=real|virtual`; missing or unknown values fail startup. Redis outages retain a per-process conservative limiter, including the relative delay carried across Redis/local transitions.

The cache and single-flight coordinator are connected to the candles endpoint only in `CANDLE_SERVING_MODE=database`. Disabled-by-default post-session/rolling reconciliation reuses the checkpointed repair orchestrator; live delivery and operations are described in [`docs/candle-live-operations.md`](docs/candle-live-operations.md).

### KIS canonical 5-minute candle ingestion foundation

The storage-only ingestion path is separate from the existing candles HTTP endpoint:

- Domestic stocks call KIS `inquire-time-dailychartprice` backward by `FID_INPUT_DATE_1`/`FID_INPUT_HOUR_1`, combine all page rows before aggregation, and store only canonical 5-minute candles anchored at 09:00 Asia/Seoul. A historical bucket is written only when all five consecutive 1-minute constituents are present.
- US stocks call KIS `inquire-time-itemchartprice` with `NMIN=5`. The response `tr_cont` header decides whether another page exists; a next request uses `tr_cont=N`, `NEXT=1`, `PINC=1`, and the prior page's oldest candle minus five minutes as `KEYB`. Only the 09:30–16:00 America/New_York regular session is accepted, so DST is handled by the IANA timezone rather than a fixed UTC offset.
- Both paths use half-open UTC ranges (`from <= openTime < to`), strict timestamp/Decimal/OHLCV validation, timestamp deduplication, bounded pages/rows/duration, cancellation, empty-page and cursor-no-progress termination. Missing prices or volume are never synthesized, missing amount remains `null`, and missing minutes never become fake candles.
- `MarketCandleIngestionService` exposes `fetchDomesticFiveMinuteCandles`, `fetchUsFiveMinuteCandles`, `ingestDomesticFiveMinuteCandles`, and `ingestUsFiveMinuteCandles`. Ingestion writes through `MarketCandlesRepository.upsertMany`; conflict updates cannot regress `isClosed=true` to false.
- Every physical request uses the existing `KisAuthClient`/`KisQuoteClient` coordinator and shared KIS REST limiter. No adapter creates a client or limiter instance.

Only interval `5m` is persisted by this ingestion path. Domestic/US `1d` and `1w`, checkpointed initial/incremental/repair orchestration, and 5m-derived `15m`/`30m`/`1h`/`4h` aggregation are covered below. Database-mode HTTP serving consumes durable rows; the live pipeline overlays Redis current candles and publishes 5m-derived current snapshots without persisting the higher intervals.

Opt-in live schema smokes require real KIS credentials, explicit `KIS_API_ENVIRONMENT`, and the matching flag. They fetch at most one page through the production rate limiter, do not write the database, and never print credentials or raw payloads:

```bash
KIS_DOMESTIC_CANDLE_LIVE_SMOKE=1 pnpm test -- kis-candle-live.integration.spec.ts
KIS_US_CANDLE_LIVE_SMOKE=1 pnpm test -- kis-candle-live.integration.spec.ts
```

### Checkpointed market candle sync (5m/1d/1w)

Checkpointed sync of the persisted candle feeds is used by database-mode HTTP serving for bounded incremental/small repair refresh and by the manual Ops job for baselines. No scheduler triggers this job; market-close/real-time sync policy remains future work.

Providers per asset type and feed:

| Asset type | 5m | 1d / 1w | sourceProvider |
| --- | --- | --- | --- |
| domestic_stock | KIS `inquire-time-dailychartprice` (2-1 service) | KIS `inquire-daily-itemchartprice` (`FHKST03010100`) | `kis_domestic_minute` / `kis_domestic_period` |
| us_stock | KIS `inquire-time-itemchartprice` NMIN=5 (2-2 service) | KIS `dailyprice` (`HHDFS76240000`) | `kis_overseas_minute` / `kis_overseas_period` |
| crypto | Binance Spot `GET /api/v3/klines` | Binance Spot `GET /api/v3/klines` | `binance_klines` |

Storage policy: only `5m`, `1d`, and `1w` are persisted (5m ≈ 35 days, 1d ≈ 1 year/max ~400 rows, 1w ≈ 1 year/max ~60 rows). `1m` is never stored; `15m`/`30m`/`1h`/`4h` are derived from stored 5m at read time and never stored. Daily/weekly candles store provider-native rows — they are never rebuilt from 5m data.

KIS daily/weekly specifics:

- Domestic pages walk `FID_INPUT_DATE_2` backwards (≤100 rows per call, newest first) until the range start; duplicate dates are deduplicated with the latest response winning, and a non-advancing date cursor terminates the run as `cursor_not_advanced`. Adjusted prices are fixed on (`FID_ORG_ADJ_PRC=0`).
- US pages walk `BYMD` backwards (`GUBN` 0=daily/1=weekly, `MODP=1` adjusted). Each page is a fresh idempotent request whose `BYMD` is the day before the previous page's oldest row; the response `tr_cont` continuation header is preserved as checkpoint metadata but the date cursor is the progress guarantee.
- Daily candles cover the local trading date (`Asia/Seoul` / `America/New_York`; DST via the IANA timezone, never a fixed UTC offset — the US spring-forward date is a 23-hour window). Weekly candles are anchored to the Monday of the reported date's week. `isClosed` flips at the regular-session close (15:30 KST / 16:00 New York; Friday's close for weekly rows) and can never regress from `true` to `false` on re-sync.
- Strict normalization everywhere: invalid timestamps, non-positive prices, negative volume, or broken OHLC bounds reject the row; a missing amount stays `null`; nothing is interpolated; a response with no valid row is never treated as success. Blank padding rows in `FHKST03010100` responses are counted separately and are not data.

Binance kline specifics: forward `startTime` pagination against the 1000-row page cap, half-open `[from, to)` ranges, rows validated against the interval grid (weekly klines open Monday 00:00 UTC) with a consistent provider close time, quote-asset volume stored as `amount`, the in-progress kline kept with `isClosed=false` by the provider close time, and future klines rejected. This path uses only `BinancePublicClient` — never the KIS rate limiter.

Checkpoints and resume: every asset/feed run persists a `MarketCandleSyncState` row (target range, mode, status, opaque `cursorJson`, page/row counters; no credentials or raw payloads). One provider page (or one bounded KIS 5m segment) is fetched, its candles are written through the idempotent `MarketCandlesRepository.upsertMany`, and only then does the cursor advance — a failed write never moves the cursor, so resuming re-fetches the same page and converges. `pending`/`running`/`failed`/`canceled` runs are resumable (`resume: true`, the default, takes over the newest one with its stored range and cursor); `completed` runs never regress, and `resume: false` cancels stale active rows (`SUPERSEDED`) and starts a fresh run. At most one `pending`/`running` row can exist per asset/feed (partial unique index `market_candle_sync_states_active_unique`).

Modes: `initial` sweeps the full default range, `incremental` restarts from the latest stored row minus `MARKET_CANDLE_SYNC_INCREMENTAL_OVERLAP_MINUTES` (at least two intervals) so recent provider revisions are re-fetched — it inspects only the latest row and does not detect interior gaps — and `repair` re-syncs an explicit `[from, to)` range idempotently for gap repair. Runs that exhaust `MARKET_CANDLE_SYNC_MAX_PAGES`/`MAX_ROWS`/`MAX_DURATION_MS` stop as `failed` with the matching stopReason and a resumable checkpoint; `complete=true` is reported only when the target range was actually swept.

Locks: the manual Ops job takes the job-level DB lock (`market_candle_sync:manual`), and each asset/feed run additionally takes a Redis backfill lock (`candles:sync:lock:v1:{assetId}:{feed}`, TTL `MARKET_CANDLE_SYNC_LOCK_TTL_SECONDS`, renewed every `MARKET_CANDLE_SYNC_LOCK_RENEW_SECONDS` between pages). Lost ownership stops the run before the next provider page with a resumable checkpoint; a busy lock fails fast with `LOCK_BUSY`; if Redis is unavailable the sync refuses to run (`LOCK_UNAVAILABLE`) rather than run without mutual exclusion. These long-lived locks are separate from the short candle HTTP single-flight locks. KIS-backed assets always run sequentially on top of the shared KIS rate limiter; `MARKET_CANDLE_SYNC_ASSET_CONCURRENCY` bounds only crypto fan-out.

Read-time aggregation (`MarketCandleAggregationService`): `15m`/`30m`/`1h`/`4h` from stored 5m with open=first/high=max/low=min/close=last/volume=sum, amount=sum only when every constituent has one (otherwise `null`), and sourceUpdatedAt=max. Bucket anchors: domestic 09:00 `Asia/Seoul` with 4h buckets 09:00–13:00 and 13:00–15:30; US 09:30 `America/New_York` (DST-aware) with 4h buckets 09:30–13:30 and 13:30–16:00; crypto continuous UTC with 4h buckets at 00/04/08/12/16/20. Buckets never span different trading days. Fixed incompleteness policy: each bucket reports `expectedConstituentCount`/`actualConstituentCount`/`gapCount`/`complete`; only a fully populated historical bucket whose constituents are all closed becomes `isClosed=true`; gapped historical buckets are returned explicitly with `complete=false`/`isClosed=false` (never interpolated), and the in-progress bucket is flagged `isCurrent=true`. Without an exchange holiday calendar, empty days simply produce no buckets — absence is preserved, not synthesized.

Manual Ops execution (no unauthenticated endpoint, no scheduler):

```ts
await opsJobRunnerService.runMarketCandleSyncJob({
  trigger: OpsJobTrigger.operator,
  requestedBy: 'ops@example.com',
  dryRun: false,            // true: plan only — no provider calls, no candle/checkpoint writes
  assetIds: undefined,      // default: all active supported assets
  assetTypes: ['crypto'],   // domestic_stock | us_stock | crypto
  targets: ['5m', '1d', '1w'],
  mode: 'incremental',      // initial | incremental | repair (repair needs from/to)
  from: undefined,
  to: undefined,
  resume: true,
  continueOnError: true,
  maxAssets: 10,
});
```

The run is recorded as an `OpsJobRun` (`market_candle_sync`) whose result JSON contains per-asset/per-feed summaries (provider, range, pages, provider/accepted/rejected/duplicate/written rows, oldest/latest open time, `complete`, stopReason, status, error codes); a run with any failed feed is recorded as failed without hiding the other feeds' results. `MarketCandleSyncService.syncAsset`/`syncAssets` are the unit-3 entry points for serving-side backfill decisions.

Opt-in smokes (fixtures use isolated assets and only `migrate deploy`; live smokes fetch a few bounded pages and never log credentials):

```bash
MARKET_CANDLE_SYNC_DB_SMOKE=1 pnpm test -- market-candle-sync.integration.spec.ts   # needs PostgreSQL + Redis
KIS_PERIOD_CANDLE_LIVE_SMOKE=1 pnpm test -- kis-period-candle-live.integration.spec.ts
BINANCE_CANDLE_LIVE_SMOKE=1 pnpm test -- binance-candle-live.integration.spec.ts
```

## Local Commands

```bash
pnpm install
docker compose up -d
pnpm start:dev
```

### Development Data Helpers

Open the local development season as always active for app testing:

```bash
pnpm dev:open-season
npm run dev:open-season
```

This upserts `sea_2026_s1` as `status=active`, `startAt=2000-01-01T00:00:00.000Z`, and `endAt=2099-12-31T23:59:59.000Z`. This is a temporary development/testing setting only.

Resolve "market data preparing" locally by opening the dev season, running providers, and verifying active asset coverage:

```bash
cd backend
pnpm dev:open-season
pnpm dev:ensure-market-snapshots --operator-email <operator@example.com>
```

Run provider ingestion and inspect DB snapshot/coverage status without the shorter alias:

```bash
pnpm dev:run-provider-ingestions --operator-email <operator@example.com>
npm run dev:run-provider-ingestions -- --operator-email <operator@example.com>
```

The operator actor must be an existing user with `role=operator` or `role=admin`. You may pass `--operator-user-id <USER_ID>` instead, or set `LOCAL_OPERATOR_USER_ID` / `LOCAL_OPERATOR_EMAIL`. The scripts default to non-dry-run writes, `--target-source merged`, `--max-snapshots 500`, and fail when active asset price coverage is unavailable. Pass `--dry-run` to check providers without inserting snapshots, `--target-source active_assets|env|merged` to control target resolution, `--no-fail-on-unavailable` for diagnostics only, `--verbose` to print failed/skipped provider target details, or limit a run with `--provider binance`, `--provider kis`, `--provider korea-exim`, or `--provider exchange-rate`.

When the app shows market data as preparing or unavailable, verify that the backend has rows in:

```text
asset_price_snapshots
fx_rate_snapshots
```

Before production launch:

- Remove the always-open development season and switch to the KST Monday 09:00 through next Friday 09:00 policy.
- Decide whether provider ingestion stays in the API server scheduler or moves to a dedicated provider worker.
- Confirm provider rate limits and connect provider failure alerting to Slack/Sentry or the production incident channel.
- Deploy the API server on a public HTTPS/WSS domain.

Do not print or commit provider API keys or local env contents. Provider row insertion foundation exists, provider-backed execute is open only through durable quote gates, and real account/order APIs remain STOP.

## Tests

```bash
# unit and opt-in-disabled integration specs
pnpm test

# HTTP e2e with mocked Prisma
pnpm test:e2e

# Prisma schema validation
pnpm exec prisma validate

# operator-only batch foundation smoke, no provider or trading business rows
pnpm tsx scripts/admin-run-batch-job.ts --job noop --idempotency-key noop:local-check --dry-run --requested-by local-operator --payload-json '{"purpose":"batch-foundation-check"}'

# operator-run daily portfolio snapshot dry-run, no external provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job daily-portfolio-snapshot --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run season ranking dry-run from existing daily snapshots, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job season-ranking --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run daily season cycle dry-run: daily snapshot, then ranking
pnpm tsx scripts/admin-run-batch-job.ts --job daily-season-cycle --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run season settlement dry-run; freezes final valuation, ranking, and tier plan
pnpm tsx scripts/admin-run-batch-job.ts --job season-settlement --season-id <SEASON_ID> --settlement-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run final tier assignment dry-run from existing final rankings, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job final-tier-assignment --season-id <SEASON_ID> --ranking-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run reward grant marker dry-run, no provider calls or payment/badge/trophy fulfillment
pnpm tsx scripts/admin-run-batch-job.ts --job reward-grant --season-id <SEASON_ID> --dry-run --requested-by local-operator

# operator-run reward grant marker dry-run with explicit marker date
pnpm tsx scripts/admin-run-batch-job.ts --job reward-grant --season-id <SEASON_ID> --grant-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run season lifecycle transition dry-run, no scheduler/HTTP batch API
pnpm tsx scripts/admin-run-batch-job.ts --job season-lifecycle-transition --now <ISO_TIMESTAMP> --dry-run --requested-by local-operator
```

`daily-portfolio-snapshot` uses the idempotency key `daily-portfolio-snapshot:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reports `wouldCreate`, `existing`, participant-level failures, and `sourceSummary` without inserting snapshots. Non-dry-run inserts only available participant snapshots, skips existing `(seasonParticipantId, snapshotDate)` rows without overwrite, and uses fresh eligible `provider_api` rows first with explicit `admin_manual` fallback. It does not call external providers, create provider/price/FX rows, schedule cron, generate rankings, settle seasons, or grant rewards.

`season-ranking` uses the idempotency key `season-ranking:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reads existing `daily_portfolio_snapshots` and reports planned rankings without inserting rows. Non-dry-run creates `season_rankings` only when no rows already exist for the same season/date/type; existing rankings are skipped without overwrite. It does not call providers, create daily snapshots, mutate wallets/orders/positions, settle seasons, or grant rewards. Ranking is `totalAssetKrw desc` with stable user/participant ordering; the current schema requires unique persisted ranks, so true same-rank competition ties need a future schema gate.

`daily-season-cycle` uses the idempotency key `daily-season-cycle:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. It runs `daily-portfolio-snapshot` first and `season-ranking` second through their existing services. Dry-run is passed to both child jobs. A daily snapshot job-level failure stops ranking and fails the cycle; participant-level snapshot failures are summarized but ranking still runs against existing snapshots. A season ranking job-level failure fails the cycle. It is not cron scheduling, provider ingestion, settlement, or reward.

`season-settlement` uses the idempotency key `season-settlement:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run validates settleability and planned final valuation/ranking/tier assignment without writing. Non-dry-run requires an `ended` season, evaluates participants at `Season.endAt` using the latest valid price and USD/KRW rows whose `effectiveAt` is at or before `Season.endAt`, does not enforce the 60-second/10-second quote or execute freshness windows, writes or updates final `equity_snapshots` with `snapshotReason=settlement`, creates `rankType=final` `season_rankings`, assigns `SeasonParticipant.finalRank` and `finalTier`, verifies final rows and tiers, and only then transitions the season to `settled`. Existing final rankings are reused and final tiers are filled idempotently. The job does not grant rewards, call external order/account APIs, expose an HTTP batch API, or create payment/point/badge/trophy rows. `GET /api/v1/ranking?rankType=final`, settled joined `GET /api/v1/home`, and records APIs can read generated final rankings and tiers while rewards remain pending.

`final-tier-assignment` uses the idempotency key `final-tier-assignment:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reads existing `rankType=final` `season_rankings` for the requested `--ranking-date` and returns the assignment plan without writing. Non-dry-run requires a `settled` season and updates only `SeasonParticipant.finalRank` and `finalTier` for participants with both fields still null. Existing `finalRank` or `finalTier` is treated as existing/skipped and is not overwritten. Missing final rankings fail with `FINAL_RANKING_UNAVAILABLE`. The default MVP tier policy is rank 1 `master`, rank 2-3 `diamond`, rank 4-10 `platinum`, top 30% `gold`, top 60% `silver`, and fallback `bronze`; clear `Season.rewardPolicyJson.tierPolicy.tiers` rules may override tier assignment only. The job does not update `rewardGrantedAt`, grant rewards, call providers, run cron, expose an HTTP batch API, or mutate price/FX/wallet/order/position/snapshot/ranking rows. Settled joined Home reads the assigned `finalTier` read-only.

`reward-grant` uses the idempotency key `reward-grant:<season-id>` when `--idempotency-key` is omitted. If `--grant-date <YYYY-MM-DD>` is provided, the generated key is `reward-grant:<season-id>:<YYYY-MM-DD>` and the marker timestamp is `<YYYY-MM-DD>T00:00:00.000Z`; otherwise the batch run start timestamp is used. Dry-run reports grantable, existing, ineligible, skipped, and `topGranted` preview counts without writing. Non-dry-run requires a `settled` season and updates only `SeasonParticipant.rewardGrantedAt` for participants that already have both `finalRank` and `finalTier` and still have null `rewardGrantedAt`. Existing `rewardGrantedAt` is treated as existing/skipped and is not overwritten. If no participant has both `finalRank` and `finalTier`, the job fails with `FINAL_TIER_ASSIGNMENT_REQUIRED`. The job does not calculate reward amounts, create payment/point/badge/trophy rows, call providers, run cron, expose an HTTP batch API, mutate price/FX/wallet/order/position/snapshot/ranking rows, or change settlement/final-tier policy. Settled joined Home reads `rewardGrantedAt` read-only and returns `finalResult.reward.state = granted` when present.

`season-lifecycle-transition` uses the idempotency key `season-lifecycle-transition:<now-or-auto-now>` when `--idempotency-key` is omitted. Dry-run reports due `upcoming -> active` and expired `active -> ended` season ids without writing. Non-dry-run performs those transitions in one transaction and fails duplicate active-season situations with `DUPLICATE_ACTIVE_SEASON`. It does not run scheduler cron, expose an HTTP batch API, call providers, settle seasons, grant rewards, or mutate user/wallet/order/position rows.

Opt-in real PostgreSQL integration tests require a reachable `DATABASE_URL` and an explicit env flag:

```bash
AUTH_DB_SMOKE=1 pnpm test -- auth.integration.spec.ts
SEASON_JOIN_DB_INTEGRATION=1 pnpm test -- seasons.join.integration.spec.ts
FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts
ORDER_EXECUTE_DB_INTEGRATION=1 pnpm test -- orders.execute.integration.spec.ts
MVP_FLOW_DB_SMOKE=1 pnpm test -- mvp-flow.integration.spec.ts
OPS_JOB_LOCK_DB_SMOKE=1 pnpm test -- ops-job-lock.integration.spec.ts
MARKET_CANDLES_DB_SMOKE=1 pnpm test -- market-candles.integration.spec.ts
```

The candle response cache has its own opt-in real Redis smoke (needs
`REDIS_URL`, no database):

```bash
CANDLE_CACHE_REDIS_SMOKE=1 pnpm test -- asset-candles-cache.integration.spec.ts
```

The FX execute opt-in integration spec runs `npm run test:db:prepare`
(`prisma migrate deploy`) before its DB-backed runner so an existing test
database is brought up to the checked-in Prisma migrations without reset,
drop, or seed.

The market candles opt-in integration spec likewise runs
`pnpm run test:db:prepare` (`prisma migrate deploy`) before its DB-backed
runner. With no `MARKET_CANDLES_DB_SMOKE=1`, Jest reports the DB test as
skipped instead of passing a no-op test body.

These tests create isolated rows and clean them up. They do not call external providers.
`MVP_FLOW_DB_SMOKE=1` is a service-composed real PostgreSQL smoke for the current MVP user flow: Auth signup/login/refresh, season join, wallets, admin_manual FX/asset/price test fixtures, assets, FX quote/execute, orders quote/create/execute, positions, records, home, ranking unavailable, and logout-all. It uses test-only fixture rows and is not provider ingestion, scheduler, settlement, reward, seed, or sample business data.
`OPS_JOB_LOCK_DB_SMOKE=1` verifies real PostgreSQL `OpsJobLock` concurrency, active-lock blocking, expired takeover, and release/reacquire semantics against an explicit test DB. It is disabled by default.

## Docs Entry Point

Start with `docs/README.md`. Current implementation status is not tracked in a separate status doc; check the relevant controller/service source and the matching `docs/*-api-contract.md`.

Docs of record:

1. `docs/README.md`
2. `docs/auth-api-contract.md` and API contract docs under `docs/*-api-contract.md`
3. `docs/policy-decisions.md`
4. `docs/scheduler-ops-foundation.md`
5. `docs/operator-api-contract.md`
6. `docs/batch-job-foundation.md`

## Working Without Provider Keys

Possible now:

- Auth, season join, wallet, records, ranking, home, FX, and order backend hardening.
- Admin/operator authorization boundary checks and operator audit foundation tests.
- Admin-only user status/restore and operator/admin internal reward fulfillment tests.
- Mocked HTTP e2e coverage for guard routing and controller/service entry.
- Opt-in real PostgreSQL integration tests for implemented DB write paths.
- Manual admin input paths using operator-approved real data.
- Operator-run daily portfolio snapshot batch jobs using existing fresh eligible `provider_api` DB rows first, then existing `admin_manual` fallback data.
- Operator-run season ranking batch jobs using existing `daily_portfolio_snapshots`.
- Operator-run daily season cycle batch jobs that run daily snapshot and season ranking in order.
- Operator-run season settlement MVP jobs that freeze final valuation, final rankings, and final tiers.
- Operator-run final tier assignment MVP jobs that assign final rank/tier from existing final `season_rankings`.
- Operator-run reward grant marker MVP jobs that set `SeasonParticipant.rewardGrantedAt` after settlement and final tier assignment.
- Operator-run season lifecycle transition jobs that move seasons between `upcoming`, `active`, and `ended` according to `startAt`/`endAt`.
- Disabled-by-default scheduler execution for provider ingestion, current ranking refresh, season lifecycle transition, and ended-season settlement when the corresponding env flags are enabled.
- Settled joined Home final-result reads from existing `rankType=final` `season_rankings`; missing final rankings return unavailable without live valuation fallback.
- Durable Quote-backed `/fx quote`, `/fx execute`, orders quote/create immediate market execution, the internal-compatible order execute path, plus provider_api-backed assets `withPrice` and live portfolio/home/positions valuation. Quote/read paths can use explicit admin_manual fallback; execute paths require fresh provider_api and reject default admin_manual fallback.
- Source metadata/outage visibility for those read-only/quote responses and daily snapshot batch results without exposing raw provider payloads or secrets.

Not possible without a separate reward automation gate:

- Provider-backed reward automation.
- External payment, point, coupon, gifticon, delivery, or cash-out fulfillment.

Never create fake/static/sample business prices to make a test or local flow pass.
