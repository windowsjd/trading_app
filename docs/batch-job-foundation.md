# Batch Job Foundation

Status: implemented foundation, no cron scheduler.

## Scope

The batch foundation is a common job execution envelope for future operator-run or scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, automatic daily snapshot generation, automatic ranking generation, settlement, reward, or a cron scheduler.

## Current Components

- Prisma enum: `BatchJobStatus`
  - `pending`, `running`, `succeeded`, `failed`, `skipped`
- Prisma model/table: `BatchJobRun` / `batch_job_runs`
- Service: `BatchService`
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

Examples of future business keys:

- `daily-portfolio-snapshot:YYYY-MM-DD`
- `season-ranking:<season-id>:YYYY-MM-DD`

## Operator Script

Supported jobs now:

- `noop`: records the batch run lifecycle only.
- `health-check`: checks DB reachability only.

Example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job noop \
  --idempotency-key noop:local-check \
  --dry-run \
  --requested-by local-operator \
  --payload-json '{"purpose":"batch-foundation-check"}'
```

The script requires `DATABASE_URL`, creates only `batch_job_runs` rows, and does not create provider, FX, asset price, wallet, order, position, snapshot, ranking, settlement, or reward rows.

## Future Work

Daily portfolio snapshot and season ranking jobs can be added later on top of this envelope, including partial-failure policy and operational scheduling. Provider ingestion, cron scheduling, settlement, and reward remain separate gates.
