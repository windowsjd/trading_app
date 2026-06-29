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
- `provider_kis_ingest`
- `daily_portfolio_snapshot`
- `season_ranking_generation`
- `season_settlement`
- `reward_marker`

`provider_fx_ingest`, `provider_binance_ingest`, and `provider_kis_ingest` call the existing provider ingestion services through ops locks and write real provider snapshots when provider env is enabled.

`reward_marker` remains recorded as `skipped` with `NOT_IMPLEMENTED` by the internal runner in this gate. This must not be interpreted as completed reward business automation.

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

- `provider_fx_ingest:usd_krw`
- `provider_binance_ingest:prices`
- `provider_kis_ingest:rest_current_price`
- `daily_portfolio_snapshot:{seasonId}:{date}`
- `season_ranking_generation:current`
- `season_settlement:ended`
- `reward_marker`

## Scheduler Env

All scheduler flags are disabled by default:

```env
SCHEDULER_ENABLED=false
SCHEDULER_TIMEZONE=Asia/Seoul
SCHEDULER_PROVIDER_FX_ENABLED=false
SCHEDULER_PROVIDER_BINANCE_ENABLED=false
SCHEDULER_PROVIDER_KIS_ENABLED=false
SCHEDULER_DAILY_SNAPSHOT_ENABLED=false
SCHEDULER_RANKING_ENABLED=false
SCHEDULER_SEASON_LIFECYCLE_ENABLED=false
SCHEDULER_SETTLEMENT_ENABLED=false
SCHEDULER_REWARD_MARKER_ENABLED=false
SCHEDULER_TICK_INTERVAL_MS=60000
SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS=3600
SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS=60
SCHEDULER_PROVIDER_KIS_INTERVAL_SECONDS=60
SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=false
SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS=500
SCHEDULER_LOCK_TTL_SECONDS=600
SCHEDULER_MAX_ATTEMPTS=1
ENABLE_PROVIDER_KIS_SCHEDULER=false
PROVIDER_INGESTION_MAX_SNAPSHOTS=500
```

No secret scheduler env is introduced.

`SCHEDULER_TICK_INTERVAL_MS` is non-secret and defaults to `60000`.

When `SCHEDULER_ENABLED=false`, no interval is registered and no automatic job runs. When enabled, individual job flags decide which internal runner methods are called. The foundation uses an internal `setInterval` shell without adding package dependencies.

To run current ranking automation in production, enable at least one ranking scheduler flag in the deployment environment. Recommended production example:

```env
SCHEDULER_ENABLED=true
SCHEDULER_RANKING_ENABLED=true
SCHEDULER_TICK_INTERVAL_MS=60000
SCHEDULER_LOCK_TTL_SECONDS=600
SCHEDULER_MAX_ATTEMPTS=1
```

The minimal accepted alias is:

```env
ENABLE_RANKING_SCHEDULER=true
```

If the ranking scheduler is not enabled, current ranking automatic refresh and 5-minute scheduled equity snapshot creation do not run. Ranking refresh runs every 1-minute scheduler tick when enabled, and scheduled equity snapshots are created from that ranking tick only on 5-minute buckets.

Enabled scheduler calls use ops locks and `dryRun=false` for jobs whose backend automation is implemented. Current ranking refresh runs every `SCHEDULER_TICK_INTERVAL_MS` tick, which defaults to 1 minute, and scheduled equity snapshots are created only on 5-minute buckets with duplicate-bucket protection. Reward marker jobs remain skipped/not implemented unless a later gate opens them.

Provider ingestion scheduler flags and reward marker scheduler flags are separate gates and must not be confused with ranking automation. Scheduler env changes do not alter the `/api/v1` contract and do not add `/api/v2`.

## Provider Scheduler

Provider ingestion is disabled by default and can be enabled per provider:

```env
SCHEDULER_ENABLED=true
SCHEDULER_PROVIDER_FX_ENABLED=true
SCHEDULER_PROVIDER_BINANCE_ENABLED=true
SCHEDULER_PROVIDER_KIS_ENABLED=true

SCHEDULER_TICK_INTERVAL_MS=60000

SCHEDULER_PROVIDER_FX_INTERVAL_SECONDS=3600
SCHEDULER_PROVIDER_BINANCE_INTERVAL_SECONDS=60
SCHEDULER_PROVIDER_KIS_INTERVAL_SECONDS=60

SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=true

PROVIDER_INGESTION_ENABLED=true
```

Provider intervals are checked before each scheduler tick calls a provider runner. The due check uses the latest persisted `ops_job_runs` row for the provider job and does not create a skipped row when the interval is not due. A failed provider run is eligible to retry on the next tick. The defaults are FX every 3600 seconds, Binance every 60 seconds, and KIS every 60 seconds.

`SCHEDULER_PROVIDER_INGESTION_RUN_ON_STARTUP=true` queues a one-time asynchronous startup run for enabled provider jobs only. It does not run season lifecycle, settlement, ranking, daily snapshot, or reward jobs. Provider ops locks still prevent duplicate execution.

KIS scheduler enablement accepts either `SCHEDULER_PROVIDER_KIS_ENABLED=true` or `ENABLE_PROVIDER_KIS_SCHEDULER=true`. KIS REST current price runs with `maxSnapshots` from `SCHEDULER_PROVIDER_KIS_MAX_SNAPSHOTS`, then `PROVIDER_INGESTION_MAX_SNAPSHOTS`, then the safe default `500`.

Provider env required before real runs:

- FX: `KOREA_EXIM_EXCHANGE_ENABLED`, `KOREA_EXIM_EXCHANGE_AUTH_KEY`, `KOREA_EXIM_EXCHANGE_BASE_URL`, `KOREA_EXIM_EXCHANGE_DATA`, `KOREA_EXIM_EXCHANGE_LOOKBACK_DAYS`, or ExchangeRate-API env `EXCHANGE_RATE_API_ENABLED`, `EXCHANGE_RATE_API_KEY`, `EXCHANGE_RATE_API_BASE_URL`.
- Binance: `BINANCE_PUBLIC_MARKET_DATA_ENABLED`, `BINANCE_REST_BASE_URL`, `BINANCE_CRYPTO_SYMBOLS`, `BINANCE_CRYPTO_USDT_AS_USD_EQUIVALENT`.
- KIS: `KIS_MARKET_DATA_ENABLED`, `KIS_REST_BASE_URL`, `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_DOMESTIC_SYMBOLS`, `KIS_US_SYMBOLS`, plus optional REST path/TR id overrides `KIS_REST_DOMESTIC_CURRENT_PRICE_PATH`, `KIS_REST_DOMESTIC_CURRENT_PRICE_TR_ID`, `KIS_REST_US_CURRENT_PRICE_PATH`, and `KIS_REST_US_CURRENT_PRICE_TR_ID`.

Provider failures are recorded in `ops_job_runs` as `failed` by the runner where possible. One provider failure does not prevent the scheduler from attempting other enabled provider jobs in the same tick. Result and metadata JSON are sanitized before storage; provider tokens, app keys, app secrets, API keys, JWT secrets, database URLs, access tokens, and refresh tokens must not be logged or stored in ops audit JSON.

## Production TODO

- Decide whether provider scheduling should stay in the API server process or move to a dedicated provider worker.
- Confirm provider rate limits for Binance, Korea EXIM, ExchangeRate-API, and KIS against the chosen intervals and watchlists.
- Connect provider failure alerting to Slack, Sentry, or the production incident channel.
- Remove the always-open development season and apply the KST Monday 09:00 through next Friday 09:00 season policy.

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
