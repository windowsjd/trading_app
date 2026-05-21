# Batch Job Foundation

Status: implemented foundation with operator-run daily portfolio snapshot, season ranking, daily season cycle, and season settlement MVP jobs, no cron scheduler.

## Scope

The batch foundation is a common job execution envelope for operator-run work and possible future scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, cron scheduling, daily snapshot automation, or reward. Settlement is limited to the operator-run MVP job described below.

## Current Components

- Prisma enum: `BatchJobStatus`
  - `pending`, `running`, `succeeded`, `failed`, `skipped`
- Prisma model/table: `BatchJobRun` / `batch_job_runs`
- Service: `BatchService`
- Business job: `DailyPortfolioSnapshotJobService`
- Business job: `SeasonRankingJobService`
- Orchestration job: `DailySeasonCycleJobService`
- Business job: `SeasonSettlementJobService`
- Module: `BatchModule`
- Operator script: `scripts/admin-run-batch-job.ts`

No batch write/run HTTP API exists. The project does not have an admin role model yet, so users cannot trigger batch jobs through an API.

## Idempotency Policy

Each run is keyed by `(jobName, idempotencyKey)`.

- A newly accepted job creates a `running` run row.
- A successful handler updates the run to `succeeded` and stores `resultPayloadJson`.
- A failed handler updates the run to `failed`, stores `errorCode` and `errorMessage`, and the caller receives an error. If the handler provides an explicit failure summary, `resultPayloadJson` is also stored; the daily season cycle job uses this for child-step failure summaries.
- If the same `(jobName, idempotencyKey)` already `succeeded`, the handler is not run again and the existing run is returned as deduplicated/skipped.
- If the same key is `running` or `pending`, duplicate execution is blocked.
- If the same key `failed`, retry requires a new `idempotencyKey`.

Current business key examples:

- `daily-portfolio-snapshot:<season-id>:<YYYY-MM-DD>`
- `season-ranking:<season-id>:<YYYY-MM-DD>`
- `daily-season-cycle:<season-id>:<YYYY-MM-DD>`
- `season-settlement:<season-id>:<YYYY-MM-DD>`

## Operator Script

Supported jobs now:

- `noop`: records the batch run lifecycle only.
- `health-check`: checks DB reachability only.
- `daily-portfolio-snapshot`: creates `daily_portfolio_snapshots` for active participants of one season/date using existing DB `admin_manual` price/FX data only.
- `season-ranking`: creates `season_rankings` for one season/date from existing `daily_portfolio_snapshots` only.
- `daily-season-cycle`: runs daily portfolio snapshot, then season ranking, for one season/date.
- `season-settlement`: creates final `season_rankings` from existing `daily_portfolio_snapshots` for one ended season/date and transitions the season to `settled`.

Example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job noop \
  --idempotency-key noop:local-check \
  --dry-run \
  --requested-by local-operator \
  --payload-json '{"purpose":"batch-foundation-check"}'
```

The script requires `DATABASE_URL`. `noop` and `health-check` create only `batch_job_runs` rows. `daily-portfolio-snapshot` additionally creates `daily_portfolio_snapshots` only when `--dry-run` is not set and participant valuation is available. `season-ranking` additionally creates daily `season_rankings` only when `--dry-run` is not set and ranking rows do not already exist. `daily-season-cycle` creates its own cycle `batch_job_runs` row and child batch runs for daily snapshot and season ranking. `season-settlement` additionally creates final `season_rankings` and updates the season status to `settled` only when `--dry-run` is not set and settlement prerequisites pass. None of these jobs create provider, FX, asset price, wallet, order, position, reward, badge, or trophy rows outside their stated scope.

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

Daily season cycle example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job daily-season-cycle \
  --season-id <SEASON_ID> \
  --snapshot-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Daily season cycle policy:

- If `--idempotency-key` is omitted, it is generated as `daily-season-cycle:<season-id>:<YYYY-MM-DD>`. An explicit key is allowed.
- The cycle is an operator-run orchestration job, not a cron scheduler.
- The cycle uses `BatchService.runJob()` for the cycle envelope, then calls `DailyPortfolioSnapshotJobService.run()` followed by `SeasonRankingJobService.run()`.
- The cycle does not calculate valuation or ranking itself and does not duplicate child job logic.
- Child job idempotency keys are derived from the cycle key as `<cycle-idempotency-key>:daily-portfolio-snapshot` and `<cycle-idempotency-key>:season-ranking`. This keeps cycle child runs separate from standalone child job business keys while preserving cycle-level idempotency.
- `--dry-run` is passed to both child jobs. A dry-run cycle does not create daily snapshots or season rankings.
- If the daily snapshot child job has a job-level failure, season ranking is not run and the cycle fails. The failed cycle result summary records `seasonRanking.state = not_run`.
- If the daily snapshot child job succeeds with participant-level failures, the cycle still runs season ranking. Ranking reads whatever `daily_portfolio_snapshots` exist.
- If the season ranking child job has a job-level failure, the cycle fails.
- Child deduplicated/skipped responses are copied into the cycle result summary and do not stop the next step.
- Cycle-level validation covers required `seasonId` and `snapshotDate` format. Season existence and status validation are delegated to the child jobs, which currently allow active/ended seasons and reject upcoming/settled seasons.
- The cycle does not call providers, create price/FX rows, register a scheduler, settle seasons, grant rewards, or expose an HTTP batch execution API.

Season settlement example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job season-settlement \
  --season-id <SEASON_ID> \
  --settlement-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Season settlement policy:

- If `--idempotency-key` is omitted, it is generated as `season-settlement:<season-id>:<YYYY-MM-DD>`. An explicit key is allowed for controlled retries or operator grouping.
- `--dry-run` validates settleability, reads existing final rankings or settlement-date snapshots, returns `wouldCreate` and `topRanks`, and does not insert final rankings or update season status.
- Settlement target season must be `ended`. `active` and `upcoming` seasons are job-level errors with `SEASON_STATUS_NOT_ALLOWED`.
- An already `settled` season returns idempotent success with existing/skipped final ranking counts when final rows exist. If no final rows exist for the date, the result says so and does not synthesize rows.
- Source of truth is existing `daily_portfolio_snapshots` for `settlementDate`. The job never recalculates wallets, positions, prices, FX, daily snapshots, or daily rankings.
- If no settlement-date snapshots exist and final rankings do not already exist, settlement fails with `NO_FINAL_SNAPSHOTS_AVAILABLE`.
- Eligible participants are `active`, `finished`, and `rewarded`. If any eligible participant is missing a settlement-date snapshot and final rankings do not already exist, settlement fails with `MISSING_FINAL_SNAPSHOTS`.
- Final ranking rows use `rankType=final`, `rankingDate=settlementDate`, and `capturedAt` from the batch run start time.
- Existing final ranking rows are never overwritten, deleted, recreated, or upserted. If final rows already exist while the season is still `ended`, the job leaves them as-is and only transitions the season status to `settled`.
- New final ranking writes and the season status transition run in one Prisma transaction to avoid partial final result creation.
- Ranking uses `totalAssetKrw desc`, then `userId asc`, then `seasonParticipantId asc`.
- Current `season_rankings` has a unique `(seasonId, rankType, rankingDate, rank)` constraint, so final rankings persist deterministic unique sequential ranks. True competition tie ranks remain a separate schema/migration gate.
- `topRanks` is capped at 10 rows in the batch result payload.
- The job does not call providers, create price/FX rows, register a scheduler, expose an HTTP batch execution API, or grant rewards. Reward handoff remains a separate gate.
- `GET /api/v1/ranking` already supports `rankType=final`, so generated final rankings are readable there. `GET /api/v1/home` still returns the existing settled-season final result limitation until a participant-specific final result view is defined.

## Future Work

Cron scheduling, provider ingestion, daily snapshot automation, ranking overwrite/regeneration, settlement extensions, Home final-result integration, and reward remain separate gates.
