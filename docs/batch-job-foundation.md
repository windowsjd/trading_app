# Batch Job Foundation

Status: implemented foundation with operator-run daily portfolio snapshot and season ranking jobs, no cron scheduler.

## Scope

The batch foundation is a common job execution envelope for operator-run work and possible future scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, cron scheduling, daily snapshot automation, settlement, or reward.

## Current Components

- Prisma enum: `BatchJobStatus`
  - `pending`, `running`, `succeeded`, `failed`, `skipped`
- Prisma model/table: `BatchJobRun` / `batch_job_runs`
- Service: `BatchService`
- Business job: `DailyPortfolioSnapshotJobService`
- Business job: `SeasonRankingJobService`
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
- `season-ranking:<season-id>:<YYYY-MM-DD>`

## Operator Script

Supported jobs now:

- `noop`: records the batch run lifecycle only.
- `health-check`: checks DB reachability only.
- `daily-portfolio-snapshot`: creates `daily_portfolio_snapshots` for active participants of one season/date using existing DB `admin_manual` price/FX data only.
- `season-ranking`: creates `season_rankings` for one season/date from existing `daily_portfolio_snapshots` only.

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

Season ranking example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job season-ranking \
  --season-id <SEASON_ID> \
  --snapshot-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Season ranking policy:

- If `--idempotency-key` is omitted, it is generated as `season-ranking:<season-id>:<YYYY-MM-DD>`. An explicit key is allowed for controlled retries or operator grouping.
- `--dry-run` reads eligible participants and existing daily snapshots, returns `wouldCreate` and `topRanks`, and does not insert `season_rankings`.
- Non-dry-run inserts `season_rankings` only when no ranking rows already exist for the same `seasonId`, `rankType=daily`, and `snapshotDate`.
- Existing ranking rows are classified as `existing`/`skipped`; the job does not overwrite, delete, recreate, or upsert them.
- Ranking writes are wrapped in a Prisma transaction to avoid partial ranking creation.
- Source of truth is existing `daily_portfolio_snapshots` for the requested date. The job does not create daily snapshots, call providers, read provider APIs, create price/FX rows, mutate wallets/orders/positions, settle seasons, or grant rewards.
- Allowed season status is `active` or `ended`. `upcoming` and `settled` are job-level errors.
- Ranking candidates are participants in `active`, `finished`, or `rewarded` status that have a daily snapshot for the requested date. Missing participant snapshots are excluded from ranking and counted as `missingSnapshots`.
- If no snapshots are available, the job succeeds with `reason=NO_SNAPSHOTS_AVAILABLE`, `created=0`, and no fake ranking rows.
- Ranking uses `totalAssetKrw desc` and stable ordering by `userId asc`, then `seasonParticipantId asc`.
- Current `season_rankings` has a unique `(seasonId, rankType, rankingDate, rank)` constraint, so this job persists deterministic unique sequential ranks. A true competition-rank tie policy such as `1, 2, 2, 4` requires a separate schema/migration gate and is not implemented here.
- `topRanks` is capped at 10 rows in the batch result payload.

## Future Work

Cron scheduling, provider ingestion, daily snapshot automation, ranking overwrite/regeneration, settlement, and reward remain separate gates.
