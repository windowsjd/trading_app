# Batch Job Foundation

Status: implemented foundation with an operator-run daily portfolio snapshot job, no cron scheduler.

## Scope

The batch foundation is a common job execution envelope for future operator-run or scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, cron scheduling, automatic ranking generation, settlement, or reward.

## Current Components

- Prisma enum: `BatchJobStatus`
  - `pending`, `running`, `succeeded`, `failed`, `skipped`
- Prisma model/table: `BatchJobRun` / `batch_job_runs`
- Service: `BatchService`
- Business job: `DailyPortfolioSnapshotJobService`
- Module: `BatchModule`
- Operator script: `scripts/admin-run-batch-job.ts`

No batch write/run HTTP API exists. The project does not have an admin role model yet, so users cannot trigger batch jobs through an API.

## Idempotency Policy

Each run is keyed by `(jobName, idempotencyKey)`.

- A newly accepted job creates a `running` run row.
- A successful handler updates the run to `succeeded` and stores `resultPayloadJson`.
- A failed handler updates the run to `failed`, stores `errorCode` and `errorMessage`, and the caller receives an error.
- If the same `(jobName, idempotencyKey)` already `succeeded`, the handler is not run again and the existing run is returned as deduplicated/skipped.
- If the same key is `running` or `pending`, duplicate execution is blocked.
- If the same key `failed`, retry requires a new `idempotencyKey`.

Current business key examples:

- `daily-portfolio-snapshot:<season-id>:<YYYY-MM-DD>`
- `season-ranking:<season-id>:YYYY-MM-DD`

## Operator Script

Supported jobs now:

- `noop`: records the batch run lifecycle only.
- `health-check`: checks DB reachability only.
- `daily-portfolio-snapshot`: creates `daily_portfolio_snapshots` for active participants of one season/date using existing DB `admin_manual` price/FX data only.

Example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job noop \
  --idempotency-key noop:local-check \
  --dry-run \
  --requested-by local-operator \
  --payload-json '{"purpose":"batch-foundation-check"}'
```

The script requires `DATABASE_URL`. `noop` and `health-check` create only `batch_job_runs` rows. `daily-portfolio-snapshot` additionally creates `daily_portfolio_snapshots` only when `--dry-run` is not set and participant valuation is available. It does not create provider, FX, asset price, wallet, order, position, ranking, settlement, or reward rows.

Daily snapshot example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job daily-portfolio-snapshot \
  --season-id <SEASON_ID> \
  --snapshot-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Daily snapshot policy:

- If `--idempotency-key` is omitted, it is generated as `daily-portfolio-snapshot:<season-id>:<YYYY-MM-DD>`.
- `--dry-run` evaluates active participants and reports `wouldCreate`, `existing`, and `failed` counts without inserting `daily_portfolio_snapshots`.
- Non-dry-run creates snapshots only for participants whose valuation is available.
- Existing `(seasonParticipantId, snapshotDate)` rows are classified as `existing` and are not overwritten.
- Missing/stale USD/KRW FX or missing price evidence is participant-level failure with no fake fallback.
- Only approved fresh `admin_manual` USD/KRW and latest eligible `admin_manual` asset prices are used. The job does not allow `provider_api` or `official_batch` sources.
- The job does not generate rankings, settlement, rewards, provider rows, or scheduler registrations.

## Future Work

Season ranking jobs can be added later on top of this envelope in a separate gate. Provider ingestion, cron scheduling, settlement, and reward remain separate gates.
