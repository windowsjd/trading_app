# trading_app Backend

Season-based virtual trading app backend built with NestJS, Prisma 7 adapter style, PostgreSQL, and Redis.

This service owns backend APIs, database access, financial calculations, and server-side write paths for the MVP. Financial values are exchanged as strings.

## Current MVP Scope

- Access token + refresh token auth: signup, login, refresh, logout, logout-all, and `GET /api/v1/me`.
- Current season lookup and season join.
- Home as one aggregate API.
- Home settled final-result read model from existing `rankType=final` `season_rankings`.
- Wallets, records, ranking, and orders read APIs.
- FX quote and execute for KRW/USD using approved `admin_manual` FX snapshots.
- Submitted order create, cancel, and full-fill execute MVP.
- KRW and USD cash wallets. US stocks and USD-settled crypto use the USD wallet.
- Final valuation policy is KRW total assets.
- Batch job execution foundation with idempotent `batch_job_runs` recording, operator-only noop/health-check script, operator-run daily portfolio snapshot generation, operator-run season ranking generation from existing daily snapshots, an operator-run daily season cycle orchestration job, an operator-run season settlement MVP job, and an operator-run reward grant marker MVP job.
- Operator-run final tier assignment MVP job from existing final `season_rankings`.

## STOP / Not Implemented

These are intentionally outside the current implementation and should not be added without a separate gate:

- Provider ingestion for OANDA, Twelve Data, Binance, or any other market data provider.
- Cron scheduler, provider ingestion jobs, scheduler-driven snapshot/ranking jobs, settlement extension jobs beyond final tier assignment, or actual reward fulfillment jobs.
- Provider-backed settlement recalculation or reward automation.
- Actual payment, point, badge, or trophy fulfillment beyond the `rewardGrantedAt` marker MVP.
- Access token blacklist/revocation, server-side session auth, and cookie auth.
- Matching engine, partial fill, durable quote, or exact order execute replay.
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

## Local Commands

```bash
pnpm install
docker compose up -d
pnpm start:dev
```

Do not add provider API keys for the current MVP hardening work. Provider-backed ingestion is still STOP.

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

# operator-run daily portfolio snapshot dry-run, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job daily-portfolio-snapshot --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run season ranking dry-run from existing daily snapshots, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job season-ranking --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run daily season cycle dry-run: daily snapshot, then ranking
pnpm tsx scripts/admin-run-batch-job.ts --job daily-season-cycle --season-id <SEASON_ID> --snapshot-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run season settlement dry-run from existing daily snapshots, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job season-settlement --season-id <SEASON_ID> --settlement-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run final tier assignment dry-run from existing final rankings, no provider calls
pnpm tsx scripts/admin-run-batch-job.ts --job final-tier-assignment --season-id <SEASON_ID> --ranking-date <YYYY-MM-DD> --dry-run --requested-by local-operator

# operator-run reward grant marker dry-run, no provider calls or payment/badge/trophy fulfillment
pnpm tsx scripts/admin-run-batch-job.ts --job reward-grant --season-id <SEASON_ID> --dry-run --requested-by local-operator

# operator-run reward grant marker dry-run with explicit marker date
pnpm tsx scripts/admin-run-batch-job.ts --job reward-grant --season-id <SEASON_ID> --grant-date <YYYY-MM-DD> --dry-run --requested-by local-operator
```

`daily-portfolio-snapshot` uses the idempotency key `daily-portfolio-snapshot:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reports `wouldCreate`, `existing`, and participant-level failures without inserting snapshots. Non-dry-run inserts only available participant snapshots, skips existing `(seasonParticipantId, snapshotDate)` rows without overwrite, and uses only existing approved fresh `admin_manual` USD/KRW plus latest eligible `admin_manual` asset price data. It does not call providers, schedule cron, generate rankings, settle seasons, or grant rewards.

`season-ranking` uses the idempotency key `season-ranking:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reads existing `daily_portfolio_snapshots` and reports planned rankings without inserting rows. Non-dry-run creates `season_rankings` only when no rows already exist for the same season/date/type; existing rankings are skipped without overwrite. It does not call providers, create daily snapshots, mutate wallets/orders/positions, settle seasons, or grant rewards. Ranking is `totalAssetKrw desc` with stable user/participant ordering; the current schema requires unique persisted ranks, so true same-rank competition ties need a future schema gate.

`daily-season-cycle` uses the idempotency key `daily-season-cycle:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. It runs `daily-portfolio-snapshot` first and `season-ranking` second through their existing services. Dry-run is passed to both child jobs. A daily snapshot job-level failure stops ranking and fails the cycle; participant-level snapshot failures are summarized but ranking still runs against existing snapshots. A season ranking job-level failure fails the cycle. It is not cron scheduling, provider ingestion, settlement, or reward.

`season-settlement` uses the idempotency key `season-settlement:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run validates settleability and planned final rankings without writing. Non-dry-run requires an `ended` season, uses existing settlement-date `daily_portfolio_snapshots`, creates `rankType=final` `season_rankings`, and transitions the season to `settled` in one transaction. Existing final rankings are never overwritten; an `ended` season with existing final rows only has its status settled. Already `settled` seasons return idempotent existing/skipped success. No settlement-date snapshots fail with `NO_FINAL_SNAPSHOTS_AVAILABLE`, and missing eligible participant snapshots fail with `MISSING_FINAL_SNAPSHOTS`. The job does not call providers, recalculate prices/FX/wallets/orders/positions/snapshots, run cron, expose an HTTP batch API, or grant rewards. `GET /api/v1/ranking?rankType=final` and settled joined `GET /api/v1/home` can read generated final rankings.

`final-tier-assignment` uses the idempotency key `final-tier-assignment:<season-id>:<YYYY-MM-DD>` when `--idempotency-key` is omitted. Dry-run reads existing `rankType=final` `season_rankings` for the requested `--ranking-date` and returns the assignment plan without writing. Non-dry-run requires a `settled` season and updates only `SeasonParticipant.finalRank` and `finalTier` for participants with both fields still null. Existing `finalRank` or `finalTier` is treated as existing/skipped and is not overwritten. Missing final rankings fail with `FINAL_RANKING_UNAVAILABLE`. The default MVP tier policy is rank 1 `master`, rank 2-3 `diamond`, rank 4-10 `platinum`, top 30% `gold`, top 60% `silver`, and fallback `bronze`; clear `Season.rewardPolicyJson.tierPolicy.tiers` rules may override tier assignment only. The job does not update `rewardGrantedAt`, grant rewards, call providers, run cron, expose an HTTP batch API, or mutate price/FX/wallet/order/position/snapshot/ranking rows. Settled joined Home reads the assigned `finalTier` read-only.

`reward-grant` uses the idempotency key `reward-grant:<season-id>` when `--idempotency-key` is omitted. If `--grant-date <YYYY-MM-DD>` is provided, the generated key is `reward-grant:<season-id>:<YYYY-MM-DD>` and the marker timestamp is `<YYYY-MM-DD>T00:00:00.000Z`; otherwise the batch run start timestamp is used. Dry-run reports grantable, existing, ineligible, skipped, and `topGranted` preview counts without writing. Non-dry-run requires a `settled` season and updates only `SeasonParticipant.rewardGrantedAt` for participants that already have both `finalRank` and `finalTier` and still have null `rewardGrantedAt`. Existing `rewardGrantedAt` is treated as existing/skipped and is not overwritten. If no participant has both `finalRank` and `finalTier`, the job fails with `FINAL_TIER_ASSIGNMENT_REQUIRED`. The job does not calculate reward amounts, create payment/point/badge/trophy rows, call providers, run cron, expose an HTTP batch API, mutate price/FX/wallet/order/position/snapshot/ranking rows, or change settlement/final-tier policy. Settled joined Home reads `rewardGrantedAt` read-only and returns `finalResult.reward.state = granted` when present.

Opt-in real PostgreSQL integration tests require a reachable `DATABASE_URL` and an explicit env flag:

```bash
AUTH_DB_SMOKE=1 pnpm test -- auth.integration.spec.ts
SEASON_JOIN_DB_INTEGRATION=1 pnpm test -- seasons.join.integration.spec.ts
FX_EXECUTE_DB_INTEGRATION=1 pnpm test -- fx.execute.integration.spec.ts
ORDER_EXECUTE_DB_INTEGRATION=1 pnpm test -- orders.execute.integration.spec.ts
MVP_FLOW_DB_SMOKE=1 pnpm test -- mvp-flow.integration.spec.ts
```

These tests create isolated rows and clean them up. They do not call external providers.
`MVP_FLOW_DB_SMOKE=1` is a service-composed real PostgreSQL smoke for the current MVP user flow: Auth signup/login/refresh, season join, wallets, admin_manual FX/asset/price test fixtures, assets, FX quote/execute, orders quote/create/execute, positions, records, home, ranking unavailable, and logout-all. It uses test-only fixture rows and is not provider ingestion, scheduler, settlement, reward, seed, or sample business data.

## Docs Entry Point

Start with `docs/README.md`.

Current source of truth order:

1. `docs/README.md`
2. `docs/current-status.md`
3. `docs/backend-gate-roadmap.md`
4. `docs/backend-test-coverage-matrix.md`
5. `docs/auth-api-contract.md` and API contract docs under `docs/*-api-contract.md`
6. `docs/batch-job-foundation.md`

`docs/archive/` is historical reference only and must not override the current documents above.

## Working Without Provider Keys

Possible now:

- Auth, season join, wallet, records, ranking, home, FX, and order backend hardening.
- Mocked HTTP e2e coverage for guard routing and controller/service entry.
- Opt-in real PostgreSQL integration tests for implemented DB write paths.
- Manual admin input paths using operator-approved real data.
- Operator-run daily portfolio snapshot batch jobs using existing `admin_manual` DB data.
- Operator-run season ranking batch jobs using existing `daily_portfolio_snapshots`.
- Operator-run daily season cycle batch jobs that run daily snapshot and season ranking in order.
- Operator-run season settlement MVP jobs that finalize from existing `daily_portfolio_snapshots`.
- Operator-run final tier assignment MVP jobs that assign final rank/tier from existing final `season_rankings`.
- Operator-run reward grant marker MVP jobs that set `SeasonParticipant.rewardGrantedAt` after settlement and final tier assignment.
- Settled joined Home final-result reads from existing `rankType=final` `season_rankings`; missing final rankings return unavailable without live valuation fallback.

Not possible without a separate provider gate:

- OANDA/Twelve Data/Binance ingestion.
- Provider-backed FX, stock, or crypto price freshness claims.
- Cron scheduler-driven snapshots/rankings.
- Provider-backed settlement recalculation or reward automation.
- Actual payment, point, badge, or trophy fulfillment.

Never create fake/static/sample business prices to make a test or local flow pass.
