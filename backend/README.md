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
- Crypto candle DB persistence, frontend chart integration, Binance Futures APIs, and Binance authenticated order/account/user-data APIs.
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
```

The FX execute opt-in integration spec runs `npm run test:db:prepare`
(`prisma migrate deploy`) before its DB-backed runner so an existing test
database is brought up to the checked-in Prisma migrations without reset,
drop, or seed.

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
