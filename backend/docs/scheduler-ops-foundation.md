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
- Scheduler-driven reward-grant writes or automatic reward payment/delivery
- External payment/point/coupon/gifticon/cash reward delivery

## Job Names

`OpsJobName` values:

- `provider_fx_ingest`
- `provider_binance_ingest`
- `daily_portfolio_snapshot`
- `season_ranking_generation`
- `season_settlement`
- `reward_marker`

`provider_fx_ingest`, `provider_binance_ingest`, `season_ranking_generation`, `season_settlement`, and `reward_marker` are recorded as `skipped` with `NOT_IMPLEMENTED` by the internal runner in this gate. This must not be interpreted as completed business automation.

Skipped placeholder results are operational evidence only. They are not fake success and must not be interpreted as completed provider ingestion, ranking generation, settlement, or reward business automation.

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
SCHEDULER_TICK_INTERVAL_MS=60000
SCHEDULER_LOCK_TTL_SECONDS=600
SCHEDULER_MAX_ATTEMPTS=1
```

No secret scheduler env is introduced.

`SCHEDULER_TICK_INTERVAL_MS` is non-secret and defaults to `60000`.

When `SCHEDULER_ENABLED=false`, no interval is registered and no automatic job runs. When enabled, individual job flags decide which internal runner methods are called. The foundation uses an internal `setInterval` shell without adding package dependencies.

Even when `SCHEDULER_ENABLED=true`, this foundation scheduler calls jobs with `dryRun=true`. Real automatic writes are not opened here. Automatic daily snapshot writes, ranking generation writes, settlement writes, reward-grant writes, and provider ingestion writes require a separate Production Scheduler Ownership Gate plus any job-specific business gate such as Reward Policy / Catalog.

## Real DB Lock Smoke

`OPS_JOB_LOCK_DB_SMOKE=1 pnpm test -- ops-job-lock.integration.spec.ts` runs an opt-in PostgreSQL smoke for `OpsJobLockService`.

Coverage:

- Same `lockKey` concurrent acquire attempts produce exactly one `acquired=true`.
- An active unexpired lock blocks a second acquire.
- An expired lock can be taken over.
- Release by `lockKey + ownerId` allows reacquire.

The smoke is disabled by default because it must run only against an explicit test database. Default `pnpm test` records the disabled reason and does not touch a real DB.

## Readiness

`GET /readiness` performs only a lightweight database query and returns public-safe app/database/scheduler status. It does not call ExchangeRate-API, Binance, KIS, or any external provider.

`GET /health` and `GET /health/db` remain backward-compatible.

## Closed Boundaries

The scheduler foundation does not open provider_api source eligibility for ranking, settlement, final result, reward final tier, or reward fulfillment.

The scheduler foundation does not expose HTTP trigger APIs. Internal runner methods are for service-level wiring and future gates only.

The scheduler foundation does not create provider ingestion HTTP trigger APIs, batch HTTP APIs, scheduler reward automation, external reward APIs, real trading/account APIs, KIS order/account/balance/fill/deposit/withdrawal APIs, or Binance authenticated order/account/user-data APIs.

## Next Gates

- Scheduler job implementation hardening for currently skipped placeholders
- Scheduler Production Ownership Gate
- Reward Policy / Reward Catalog Gate
- Deployment/ops runbook and production scheduler ownership gate
