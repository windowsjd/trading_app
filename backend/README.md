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
- FX quote stores durable quotes; FX execute consumes durable quotes and reprices at execute time from fresh `provider_api` USD/KRW rows. Korea EXIM exchange (`korea_exim_exchange_rate`) is preferred, and ExchangeRate-API (`exchange_rate_api`) remains the fallback provider.
- `GET /api/v1/fx/rates/current` returns the current stored USD/KRW rate. `refresh=true` may refresh Korea EXIM exchange data only when both `PROVIDER_INGESTION_ENABLED=true` and `KOREA_EXIM_EXCHANGE_ENABLED=true`; otherwise it falls back to existing DB snapshots.
- Orders quote stores durable quotes; `POST /api/v1/orders` requires `quoteId` and `idempotencyKey`, creates the market order, consumes the quote, and immediately executes from fresh `provider_api` asset/FX rows.
- Stock order quote/create/execute enforce regular market hours. Crypto orders and FX quote/execute do not receive a market-hours block in this gate.
- FX execute and orders create idempotency request hashes include `quoteId`, so the same idempotency key with a different quote conflicts instead of replaying an old result.
- KRW and USD cash wallets. US stocks and USD-settled crypto use the USD wallet.
- Final valuation policy is KRW total assets.
- Provider ingestion foundation exists for Korea EXIM exchange and ExchangeRate-API USD/KRW, Binance public REST crypto, and KIS WebSocket KRX/US stock market data row insertion.
- `GET /api/v1/assets/:assetId/candles` supports crypto chart candles through Binance Spot `GET /api/v3/klines`. Supported crypto intervals are exactly `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, and `1w`; Binance Futures klines are not used. Crypto candles are display-only and are not stored or wired into orders, valuation, settlement, ranking, or scheduler flows.
- Provider_api source eligibility is opened only for explicitly allowed workflows: `/fx quote`, `/fx execute`, assets `withPrice`, orders quote, order execution, live portfolio/home/positions valuation, the operator-run daily portfolio snapshot valuation job, and season settlement valuation. Orders create uses the durable quote and immediate execution path.
- Read-only/quote responses expose backward-compatible optional source metadata for provider/admin visibility: `rateSource`, `priceSource`, `assetPriceSource`, `fxRateSource`, and live valuation source summaries where applicable.
- Batch job execution foundation with idempotent `batch_job_runs` recording, operator-only noop/health-check script, operator-run daily portfolio snapshot generation, operator-run season ranking generation from existing daily snapshots, an operator-run daily season cycle orchestration job, an operator-run season settlement MVP job, an operator-run reward grant marker MVP job, and an operator-run season lifecycle transition job.
- Scheduler/Ops foundation with disabled-by-default scheduler config, `ops_job_runs` audit rows, `ops_job_locks`, internal runner services, and `GET /readiness`. Enabled ranking, season lifecycle, and settlement scheduler jobs perform real backend automation behind locks.
- Daily portfolio snapshot batch results include sourceSummary/fallback metadata in `batch_job_runs.resultPayloadJson`; `daily_portfolio_snapshots` row schema is unchanged.
- Durable Quote plus realtime provider execute is implemented for `/fx execute` and the order execution path used by `POST /api/v1/orders`. Quote remains a reference quote; execute reprices from fresh provider_api rows, enforces quote-to-execute bps thresholds, and forbids default admin_manual execute fallback. `POST /api/v1/orders/:orderId/execute` remains as an internal compatibility/deprecation path, not the required public user flow.
- Current ranking refresh updates live participant valuations, equity snapshots for scheduled refreshes, `season_rankings` with `rankType=daily`, and `SeasonParticipant.currentRank`.
- Season settlement freezes valuation at `Season.endAt`, uses the latest valid price and USD/KRW rows with `effectiveAt <= Season.endAt` without enforcing quote/execute freshness windows, writes final `equity_snapshots`, creates `rankType=final` rankings, assigns final tiers, and changes the season to `settled` only after final rank and tier readiness checks pass. Reward payout remains pending/unimplemented.
- Market holidays are configured in `src/orders/market-holidays.config.ts`; domestic/US stock quote/create/execute return `MARKET_CLOSED` on configured holidays, while crypto orders and FX are not holiday-blocked.

## STOP / Not Implemented

These are intentionally outside the current implementation and should not be added without a separate gate:

- Provider ingestion trigger APIs, scheduler-driven provider ingestion implementation, and provider-backed reward workflows.
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

Scheduler/Ops env is non-secret and disabled by default. `SCHEDULER_ENABLED=false` prevents interval registration unless one of the explicit aliases is enabled. Each `SCHEDULER_*_ENABLED=false` flag keeps its job from running automatically. `SCHEDULER_RANKING_ENABLED` or `ENABLE_RANKING_SCHEDULER` enables current ranking refresh, `SCHEDULER_SEASON_LIFECYCLE_ENABLED` or `ENABLE_SEASON_LIFECYCLE_SCHEDULER` enables `active -> ended` lifecycle transitions, and `SCHEDULER_SETTLEMENT_ENABLED` or `ENABLE_SEASON_SETTLEMENT_SCHEDULER` enables ended-season settlement. `SCHEDULER_TICK_INTERVAL_MS` defaults to `60000`; `RANKING_REFRESH_INTERVAL_SECONDS` and `SEASON_SETTLEMENT_INTERVAL_SECONDS` are accepted second-based aliases when the tick interval is not set. `SCHEDULER_LOCK_TTL_SECONDS` defaults to `600`, and `SCHEDULER_MAX_ATTEMPTS` defaults to `1`.

`PROVIDER_INGESTION_ENABLED=false` is the fail-closed default for provider refresh/ingestion calls. Korea EXIM on-demand refresh requires both `PROVIDER_INGESTION_ENABLED=true` and `KOREA_EXIM_EXCHANGE_ENABLED=true`. If either flag is disabled, `GET /api/v1/fx/rates/current` falls back to existing DB snapshots and returns `FX_RATE_UNAVAILABLE` only when no usable DB row exists.

Korea EXIM exchange provider env is `KOREA_EXIM_EXCHANGE_ENABLED`, `KOREA_EXIM_EXCHANGE_AUTH_KEY`, `KOREA_EXIM_EXCHANGE_BASE_URL`, `KOREA_EXIM_EXCHANGE_DATA`, and `KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS`. The request URL is `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON` with `authkey`, `searchdate`, and `data=AP01`; USD/KRW uses the USD row's `DEAL_BAS_R` value with commas removed. Real auth keys must live only in `.env.local`; `.env.example` keeps the auth key blank. ExchangeRate-API remains the fallback provider after Korea EXIM exchange.

Binance public market data uses `BINANCE_REST_BASE_URL`, defaulting to `https://api.binance.com` when unset. Crypto candles use only the public Spot `GET /api/v3/klines` endpoint with USDT quote symbols such as `BTCUSDT` and `ETHUSDT`; no Binance API key or secret is required for this candle path.

## Local Commands

```bash
pnpm install
docker compose up -d
pnpm start:dev
```

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

These tests create isolated rows and clean them up. They do not call external providers.
`MVP_FLOW_DB_SMOKE=1` is a service-composed real PostgreSQL smoke for the current MVP user flow: Auth signup/login/refresh, season join, wallets, admin_manual FX/asset/price test fixtures, assets, FX quote/execute, orders quote/create/execute, positions, records, home, ranking unavailable, and logout-all. It uses test-only fixture rows and is not provider ingestion, scheduler, settlement, reward, seed, or sample business data.
`OPS_JOB_LOCK_DB_SMOKE=1` verifies real PostgreSQL `OpsJobLock` concurrency, active-lock blocking, expired takeover, and release/reacquire semantics against an explicit test DB. It is disabled by default.

## Docs Entry Point

Start with `docs/README.md`.

Current source of truth order:

1. `docs/README.md`
2. `docs/current-status.md`
3. `docs/backend-gate-roadmap.md`
4. `docs/backend-test-coverage-matrix.md`
5. `docs/auth-api-contract.md` and API contract docs under `docs/*-api-contract.md`
6. `docs/realtime-execution-policy.md`
7. `docs/scheduler-ops-foundation.md`
8. `docs/operator-api-contract.md`
9. `docs/batch-job-foundation.md`

`docs/archive/` is historical reference only and must not override the current documents above.

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
- Disabled-by-default scheduler execution for current ranking refresh, season lifecycle transition, and ended-season settlement when the corresponding env flags are enabled.
- Settled joined Home final-result reads from existing `rankType=final` `season_rankings`; missing final rankings return unavailable without live valuation fallback.
- Durable Quote-backed `/fx quote`, `/fx execute`, orders quote/create immediate market execution, the internal-compatible order execute path, plus provider_api-backed assets `withPrice` and live portfolio/home/positions valuation. Quote/read paths can use explicit admin_manual fallback; execute paths require fresh provider_api and reject default admin_manual fallback.
- Source metadata/outage visibility for those read-only/quote responses and daily snapshot batch results without exposing raw provider payloads or secrets.

Not possible without a separate provider/write or automation gate:

- Scheduler-driven provider ingestion and reward automation.
- Provider-backed reward automation.
- External payment, point, coupon, gifticon, delivery, or cash-out fulfillment.

Never create fake/static/sample business prices to make a test or local flow pass.
