# Scheduler / Ops Foundation

Status: implemented foundation, disabled by default.

## Scope

This gate adds an internal operations foundation for scheduler ownership, job run audit, and duplicate-run locks.

Implemented:

- Prisma enums: `OpsJobName`, `OpsJobRunStatus`, `OpsJobTrigger`
- Prisma models/tables: `OpsJobRun` / `ops_job_runs`, `OpsJobLock` / `ops_job_locks`
- Internal services: `OpsJobRunService`, `OpsJobLockService`, `OpsJobRunnerService`, `OpsSchedulerService`
- App readiness endpoint: `GET /readiness`
- Non-secret scheduler env defaults in `.env.example`

Not implemented:

- Provider ingestion HTTP trigger API
- Batch HTTP API
- KIS order/account/balance/fill/deposit/withdrawal APIs
- Binance authenticated/order/account/user-data APIs
- Real external trading/account/deposit/withdrawal API
- Admin role management API
- Reward fulfillment or external payment/point/badge/trophy delivery

## Job Names

`OpsJobName` values:

- `provider_fx_ingest`
- `provider_binance_ingest`
- `daily_portfolio_snapshot`
- `season_ranking_generation`
- `season_settlement`
- `reward_marker`

`provider_fx_ingest`, `provider_binance_ingest`, `season_ranking_generation`, `season_settlement`, and `reward_marker` are recorded as `skipped` with `NOT_IMPLEMENTED` by the internal runner in this gate. This must not be interpreted as completed business automation.

`daily_portfolio_snapshot` can call the existing `DailyPortfolioSnapshotJobService` through the internal runner. It supports `dryRun`, job lock, and ops audit. The existing batch service still owns actual snapshot creation rules and idempotency.

## Run Audit

`OpsJobRun` records:

- `jobName`
- `status`: `running`, `succeeded`, `failed`, `skipped`, `locked`
- `trigger`: `scheduler`, `operator`, `manual_script`, `test`
- `requestedBy`
- `startedAt`, `finishedAt`, `durationMs`
- `lockKey`, `idempotencyKey`
- `dryRun`, `attempt`, `maxAttempts`
- `errorCode`, `errorMessage`
- `resultJson`, `metadataJson`

`resultJson` and `metadataJson` pass through ops redaction before storage. Secret-like keys, authorization values, database URLs, raw provider payload keys, approval keys, access tokens, refresh tokens, app keys, app secrets, and token-like fields are redacted.

Raw provider payloads and secret env values must not be stored in ops audit rows.

## Lock Policy

`OpsJobLock` is keyed by unique `lockKey`.

Lock behavior:

- No existing active lock: acquire.
- Existing unexpired unreleased lock: return locked and record an `OpsJobRun` with status `locked`.
- Existing expired or released lock: takeover is allowed.
- Success/failure releases the lock by `lockKey + ownerId`.
- Lock TTL defaults to `SCHEDULER_LOCK_TTL_SECONDS=600`.

Default lock keys:

- `provider_fx_ingest`
- `provider_binance_ingest`
- `daily_portfolio_snapshot:{seasonId}:{date}`
- `season_ranking_generation:{seasonId}:{rankDate}`
- `season_settlement:{seasonId}`
- `reward_marker:{seasonId}`

## Scheduler Env

All scheduler flags are disabled by default:

```env
SCHEDULER_ENABLED=false
SCHEDULER_TIMEZONE=Asia/Seoul
SCHEDULER_PROVIDER_FX_ENABLED=false
SCHEDULER_PROVIDER_BINANCE_ENABLED=false
SCHEDULER_DAILY_SNAPSHOT_ENABLED=false
SCHEDULER_RANKING_ENABLED=false
SCHEDULER_SETTLEMENT_ENABLED=false
SCHEDULER_REWARD_MARKER_ENABLED=false
SCHEDULER_LOCK_TTL_SECONDS=600
SCHEDULER_MAX_ATTEMPTS=1
```

No secret scheduler env is introduced.

When `SCHEDULER_ENABLED=false`, no interval is registered and no automatic job runs. When enabled, individual job flags decide which internal runner methods are called. The foundation uses an internal `setInterval` shell without adding package dependencies.

## Readiness

`GET /readiness` performs only a lightweight database query and returns public-safe app/database/scheduler status. It does not call ExchangeRate-API, Binance, KIS, or any external provider.

`GET /health` and `GET /health/db` remain backward-compatible.

## Closed Boundaries

The scheduler foundation does not open provider_api source eligibility for ranking, settlement, final result, reward final tier, or reward fulfillment.

The scheduler foundation does not expose HTTP trigger APIs. Internal runner methods are for service-level wiring and future gates only.

## Next Gates

- Scheduler job implementation hardening for currently skipped placeholders
- Admin/operator Account Management Gate
- Reward Fulfillment Backend Gate
- Deployment/ops runbook and production scheduler ownership gate
