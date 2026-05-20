# trading_app Backend

Season-based virtual trading app backend built with NestJS, Prisma 7 adapter style, PostgreSQL, and Redis.

This service owns backend APIs, database access, financial calculations, and server-side write paths for the MVP. Financial values are exchanged as strings.

## Current MVP Scope

- Access token + refresh token auth: signup, login, refresh, logout, logout-all, and `GET /api/v1/me`.
- Current season lookup and season join.
- Home as one aggregate API.
- Wallets, records, ranking, and orders read APIs.
- FX quote and execute for KRW/USD using approved `admin_manual` FX snapshots.
- Submitted order create, cancel, and full-fill execute MVP.
- KRW and USD cash wallets. US stocks and USD-settled crypto use the USD wallet.
- Final valuation policy is KRW total assets.
- Batch job execution foundation with idempotent `batch_job_runs` recording and operator-only noop/health-check script.

## STOP / Not Implemented

These are intentionally outside the current implementation and should not be added without a separate gate:

- Provider ingestion for OANDA, Twelve Data, Binance, or any other market data provider.
- Cron scheduler, provider ingestion jobs, automatic daily snapshot/ranking jobs, settlement jobs, or reward jobs.
- Settlement.
- Reward, badge, or trophy grants.
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
```

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

Not possible without a separate provider gate:

- OANDA/Twelve Data/Binance ingestion.
- Provider-backed FX, stock, or crypto price freshness claims.
- Scheduler-driven snapshots/rankings.
- Settlement or reward automation.

Never create fake/static/sample business prices to make a test or local flow pass.
