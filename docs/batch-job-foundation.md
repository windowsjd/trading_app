# Batch Job Foundation

Status: implemented foundation with operator-run daily portfolio snapshot, season ranking, daily season cycle, season settlement MVP, final tier assignment MVP, and reward grant internal reward foundation MVP jobs, no cron scheduler.

## Scope

The batch foundation is a common job execution envelope for operator-run work and possible future scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, cron scheduling, daily snapshot automation, or actual reward/payment/point/delivery/external fulfillment. Settlement, final tier assignment, and reward grant are limited to the operator-run MVP jobs described below.

## Current Components

- Prisma enum: `BatchJobStatus`
  - `pending`, `running`, `succeeded`, `failed`, `skipped`
- Prisma model/table: `BatchJobRun` / `batch_job_runs`
- Service: `BatchService`
- Business job: `DailyPortfolioSnapshotJobService`
- Business job: `SeasonRankingJobService`
- Orchestration job: `DailySeasonCycleJobService`
- Business job: `SeasonSettlementJobService`
- Business job: `FinalTierAssignmentJobService`
- Business job: `RewardGrantJobService`
- Module: `BatchModule`
- Operator script: `scripts/admin-run-batch-job.ts`

No batch write/run HTTP API exists. The project now has an admin/operator role foundation, but batch job HTTP execution remains a separate gate and users still cannot trigger batch jobs through an API.

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
- `final-tier-assignment:<season-id>:<YYYY-MM-DD>`
- `reward-grant:<season-id>` or `reward-grant:<season-id>:<YYYY-MM-DD>` when `--grant-date` is provided

## Operator Script

Supported jobs now:

- `noop`: records the batch run lifecycle only.
- `health-check`: checks DB reachability only.
- `daily-portfolio-snapshot`: creates `daily_portfolio_snapshots` for active participants of one season/date using existing DB `admin_manual` price/FX data only.
- `season-ranking`: creates `season_rankings` for one season/date from existing `daily_portfolio_snapshots` only.
- `daily-season-cycle`: runs daily portfolio snapshot, then season ranking, for one season/date.
- `season-settlement`: creates final `season_rankings` from existing `daily_portfolio_snapshots` for one ended season/date and transitions the season to `settled`.
- `final-tier-assignment`: assigns `SeasonParticipant.finalRank` and `SeasonParticipant.finalTier` from existing final `season_rankings` for one settled season/date.
- `reward-grant`: ensures `SeasonParticipant.rewardGrantedAt` plus internal tier badge/TOP10 trophy rows in `badges`, `user_badges`, and `season_rewards` for final-assigned settled participants.

Example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job noop \
  --idempotency-key noop:local-check \
  --dry-run \
  --requested-by local-operator \
  --payload-json '{"purpose":"batch-foundation-check"}'
```

The script requires `DATABASE_URL`. `noop` and `health-check` create only `batch_job_runs` rows. `daily-portfolio-snapshot` additionally creates `daily_portfolio_snapshots` only when `--dry-run` is not set and participant valuation is available. `season-ranking` additionally creates daily `season_rankings` only when `--dry-run` is not set and ranking rows do not already exist. `daily-season-cycle` creates its own cycle `batch_job_runs` row and child batch runs for daily snapshot and season ranking. `season-settlement` additionally creates final `season_rankings` and updates the season status to `settled` only when `--dry-run` is not set and settlement prerequisites pass. `final-tier-assignment` updates only `season_participants.final_rank` and `season_participants.final_tier` when `--dry-run` is not set and assignment prerequisites pass. `reward-grant` writes the reward marker and internal reward/badge/trophy foundation rows when `--dry-run` is not set and prerequisites pass. None of these jobs create provider, FX, asset price, wallet, order, position, payment, point, delivery, or external fulfillment rows outside their stated scope.

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
- `GET /api/v1/ranking` supports `rankType=final`, and settled joined `GET /api/v1/home` reads generated final rankings as its authoritative final result. Missing final rankings remain unavailable; Home does not use live valuation fallback for settled final results.

Final tier assignment example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job final-tier-assignment \
  --season-id <SEASON_ID> \
  --ranking-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Final tier assignment policy:

- If `--idempotency-key` is omitted, it is generated as `final-tier-assignment:<season-id>:<YYYY-MM-DD>`. An explicit key is allowed for controlled retries or operator grouping.
- The target season must be `settled`. `ended` seasons fail with `SETTLEMENT_REQUIRED`; `active` and `upcoming` seasons fail with `SEASON_STATUS_NOT_ALLOWED`.
- Source of truth is existing `rankType=final` `season_rankings` for the requested `rankingDate`. The job never selects the latest date automatically and never creates fake final rankings.
- If no final rows exist for the requested date, the job fails with `FINAL_RANKING_UNAVAILABLE`.
- Final ranking rows may cover only a subset of participants; this job assigns only participants present in the selected final ranking rows and does not re-check settlement snapshot completeness.
- `finalRank` is copied from `season_rankings.rank`.
- `finalTier` uses this default MVP policy when no clear `Season.rewardPolicyJson.tierPolicy.tiers` exists:
  - rank 1: `master`
  - rank 2-3: `diamond`
  - rank 4-10: `platinum`
  - `rank / totalParticipants <= 0.30`: `gold`
  - `rank / totalParticipants <= 0.60`: `silver`
  - fallback: `bronze`
- Tier strings are lowercase: `master`, `diamond`, `platinum`, `gold`, `silver`, `bronze`.
- A clear season reward tier policy may be read from `rewardPolicyJson.tierPolicy.tiers` when entries use only tier assignment rules such as exact rank, max rank, max percent, and fallback. Reward amounts, badges, trophies, and payment fields are ignored. Ambiguous or complex policy JSON falls back to `default_mvp`; custom policy parsing beyond this MVP is a separate gate.
- `--dry-run` returns the assignment plan, policy source, participant counts, and up to 10 `topAssignments` without updating participants.
- Non-dry-run updates only participants where both `finalRank` and `finalTier` are null. If either field is already present, the participant is classified as `existing`/`skipped` and is not overwritten.
- Non-dry-run writes run in a Prisma transaction for the participant updates to avoid partial assignment.
- The job never updates `rewardGrantedAt` and never creates reward, payment, point, delivery, or external fulfillment rows. It also does not create internal badge/trophy foundation rows; `reward-grant` handles that.
- The job does not call providers, create price/FX rows, register a scheduler, expose an HTTP batch execution API, mutate wallets/orders/positions/snapshots/rankings, or change the settlement final ranking policy.
- Current final rankings use deterministic unique sequential ranks because `season_rankings` has a unique `(seasonId, rankType, rankingDate, rank)` constraint. True competition tie rank remains a separate schema/migration gate.
- Settled joined `GET /api/v1/home` reads `season_participants.finalTier`; after this job assigns it, `finalResult.tier` becomes available. Missing `finalTier` remains `FINAL_TIER_UNAVAILABLE`.

Reward grant example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job reward-grant \
  --season-id <SEASON_ID> \
  --dry-run \
  --requested-by local-operator
```

Reward grant with explicit marker date:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job reward-grant \
  --season-id <SEASON_ID> \
  --grant-date <YYYY-MM-DD> \
  --dry-run \
  --requested-by local-operator
```

Reward grant internal foundation policy:

- If `--idempotency-key` is omitted, it is generated as `reward-grant:<season-id>`. If `--grant-date` is provided, it is generated as `reward-grant:<season-id>:<YYYY-MM-DD>`.
- `--grant-date` is optional. When present, it must be `YYYY-MM-DD` and the stored `rewardGrantedAt` marker uses `<YYYY-MM-DD>T00:00:00.000Z`. When omitted, the batch run `startedAt` timestamp is used.
- The target season must be `settled`. `ended` seasons fail with `SETTLEMENT_REQUIRED`; `active` and `upcoming` seasons fail with `SEASON_STATUS_NOT_ALLOWED`.
- Source of truth is settled `SeasonParticipant` rows that already have both `finalRank` and `finalTier`.
- Participants missing `finalRank` or `finalTier` are `ineligible`/`skipped`.
- If no participant has both `finalRank` and `finalTier`, the job fails with `FINAL_TIER_ASSIGNMENT_REQUIRED`.
- The default internal reward policy grants one tier badge per final tier:
  - `master`: `TIER_MASTER`
  - `diamond`: `TIER_DIAMOND`
  - `platinum`: `TIER_PLATINUM`
  - `gold`: `TIER_GOLD`
  - `silver`: `TIER_SILVER`
  - `bronze`: `TIER_BRONZE`
- If `finalRank <= 10`, the job also grants `TROPHY_TOP10`.
- `Badge` rows are idempotent by `code`.
- `UserBadge` rows are idempotent by `userId + badgeId + seasonId`.
- `SeasonReward` rows are idempotent by `seasonParticipantId + rewardCode`.
- `--dry-run` returns participant counts, marker would-grant/existing counts, internal reward row would-create/existing counts, and preview rows without writing the database.
- Non-dry-run updates only participants where `rewardGrantedAt` is null. Participants that already have `rewardGrantedAt` keep their existing marker timestamp.
- If a participant already has `rewardGrantedAt` but is missing internal reward rows, the existing marker timestamp is used as `grantedAt`/`awardedAt` for idempotent backfill.
- Non-dry-run marker updates and internal reward/badge/trophy row writes run in a Prisma transaction.
- The job does not calculate reward amounts and does not perform payment, point, delivery, transfer, or external fulfillment. Actual fulfillment remains a separate gate.
- The job does not call providers, create price/FX rows, register a scheduler, expose an HTTP batch execution API, mutate wallets/orders/positions/snapshots/rankings, or change settlement/final-tier policy.
- Settled joined `GET /api/v1/home` reads `season_participants.rewardGrantedAt`; after this job sets it, `finalResult.reward.state` becomes `granted`. Missing `rewardGrantedAt` remains `REWARD_NOT_GRANTED`.

## Future Work

Cron scheduling, provider ingestion, daily snapshot automation, ranking overwrite/regeneration, settlement extensions beyond final tier assignment, true competition tie rank, reward amount policy, and actual payment/point/delivery/external fulfillment remain separate gates.
