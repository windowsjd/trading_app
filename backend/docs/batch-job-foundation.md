# Batch Job Foundation

Status: implemented foundation with operator-run daily portfolio snapshot, season ranking, daily season cycle, season settlement MVP, final tier assignment MVP, and a reward-grant gate-closed job. Scheduler/Ops foundation now exists separately and is disabled by default.

## Scope

The batch foundation is a common job execution envelope for operator-run work and possible future scheduler-run work. It records job start, finish, result, failure, dry-run mode, request payload, and idempotency state in `batch_job_runs`.

This is not provider ingestion, provider trigger HTTP API, batch HTTP API, production cron business automation, or actual reward/payment/point/delivery/external fulfillment. Settlement and final tier assignment are limited to the operator-run MVP jobs described below. Reward grant is intentionally disabled until a Reward Policy / Catalog gate opens.

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

Scheduler/Ops foundation is documented in `docs/scheduler-ops-foundation.md`. Its internal daily snapshot runner can call `DailyPortfolioSnapshotJobService` with a job lock and ops audit, but automatic scheduler flags are disabled by default and placeholder jobs are recorded as skipped/not implemented.

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
- `daily-portfolio-snapshot`: creates `daily_portfolio_snapshots` for active participants of one season/date using existing fresh eligible `provider_api` price/FX data first, then existing safe `admin_manual` fallback.
- `season-ranking`: creates `season_rankings` for one season/date from existing `daily_portfolio_snapshots` only.
- `daily-season-cycle`: runs daily portfolio snapshot, then season ranking, for one season/date.
- `season-settlement`: creates final `season_rankings` from existing `daily_portfolio_snapshots` for one ended season/date and transitions the season to `settled`.
- `final-tier-assignment`: assigns `SeasonParticipant.finalRank` and `SeasonParticipant.finalTier` from existing final `season_rankings` for one settled season/date.
- `reward-grant`: records a failed batch run with `REWARD_POLICY_GATE_CLOSED` for both dry-run and non-dry-run. It does not write participant reward markers or reward/badge/trophy rows.

Example:

```bash
pnpm tsx scripts/admin-run-batch-job.ts \
  --job noop \
  --idempotency-key noop:local-check \
  --dry-run \
  --requested-by local-operator \
  --payload-json '{"purpose":"batch-foundation-check"}'
```

The script requires `DATABASE_URL`. `noop` and `health-check` create only `batch_job_runs` rows. `daily-portfolio-snapshot` additionally creates `daily_portfolio_snapshots` only when `--dry-run` is not set and participant valuation is available. `season-ranking` additionally creates daily `season_rankings` only when `--dry-run` is not set and ranking rows do not already exist. `daily-season-cycle` creates its own cycle `batch_job_runs` row and child batch runs for daily snapshot and season ranking. `season-settlement` additionally creates final `season_rankings` and updates the season status to `settled` only when `--dry-run` is not set and settlement prerequisites pass. `final-tier-assignment` updates only `season_participants.final_rank` and `season_participants.final_tier` when `--dry-run` is not set and assignment prerequisites pass. `reward-grant` creates only its `batch_job_runs` failure envelope and zero-count result payload; no participant reward marker or reward/badge/trophy row is written. None of these jobs create provider, FX, asset price, wallet, order, position, payment, point, delivery, or external fulfillment rows outside their stated scope.

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
- `--dry-run` evaluates active participants and reports `wouldCreate`, `existing`, `failed`, and aggregate `sourceSummary` counts without inserting `daily_portfolio_snapshots`.
- Non-dry-run creates snapshots only for participants whose valuation is available.
- Existing `(seasonParticipantId, snapshotDate)` rows are classified as `existing` and are not overwritten.
- Fresh eligible `provider_api` rows are selected first for USD/KRW and asset prices. Provider USD/KRW freshness uses capturedAt age <= 300 seconds; provider asset price freshness uses capturedAt age <= 60 seconds.
- Missing, stale, future, non-positive, wrong-source, wrong-type, or ineligible provider rows fall back to existing safe `admin_manual` selection where available.
- Provider missing/rejected plus missing/stale admin_manual evidence is participant-level failure with no fake fallback.
- `sourceSummary` records participant counts for provider_api/admin_manual/fallback use plus fallback and rejected-provider reasons in the batch result payload. Raw provider payloads and secrets are not included.
- `daily_portfolio_snapshots` row schema is unchanged and does not store source metadata.
- `official_batch` remains not allowed for the current daily snapshot valuation workflow.
- The job does not generate rankings, settlement, rewards, provider rows, price/FX rows, or scheduler registrations.
- Verification on 2026-06-05 confirms `DailyPortfolioSnapshotJobService` passes the `daily_portfolio_snapshot` workflow explicitly, dry-run does not create snapshot rows, non-dry-run creates only available participant snapshot rows, and participant failures are reported without opening ranking/settlement/reward/provider-trigger paths.

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
- The cycle does not call external providers, create provider/price/FX rows, register a scheduler, settle seasons, grant rewards, or expose an HTTP batch execution API. Its daily snapshot child may consume existing eligible provider_api DB rows through the daily snapshot valuation workflow.

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
- `finalTier` uses the fixed cumulative cutoff policy:
  - `master`: top 4%
  - `diamond`: top 11%
  - `platinum`: top 23%
  - `gold`: top 40%
  - `silver`: top 70%
  - `bronze`: top 100%
- Cutoff is `ceil(totalParticipants * cumulativeRatio)` and tiers are assigned from the top tier downward. Example: 100 participants produce master ranks 1-4, diamond 5-11, platinum 12-23, gold 24-40, silver 41-70, bronze 71-100. Ten participants produce master 1, diamond 2, platinum 3, gold 4, silver 5-7, bronze 8-10. One participant is master.
- Tier strings are lowercase: `master`, `diamond`, `platinum`, `gold`, `silver`, `bronze`.
- `Season.rewardPolicyJson` and reward policy/catalog values do not override final tier cutoffs in this MVP. Reward amounts, badges, trophies, and payment fields are ignored by `final-tier-assignment`.
- `--dry-run` returns the assignment plan, policy source, participant counts, and up to 10 `topAssignments` without updating participants.
- Each `topAssignments` row includes `existingFinalRank`, `existingFinalTier`, `computedFinalTier`, `willAssign`, and `skipReason`. `skipReason = FINAL_RESULT_ALREADY_EXISTS` when either existing final result field is already present. The existing `finalTier` field remains the computed tier for backward compatibility.
- Non-dry-run updates only participants where both `finalRank` and `finalTier` are null. If either field is already present, the participant is classified as `existing`/`skipped` and is not overwritten.
- Non-dry-run writes run in a Prisma transaction for the participant updates to avoid partial assignment.
- The job never updates `rewardGrantedAt` and never creates reward, payment, point, delivery, or external fulfillment rows.
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

Reward grant gate-closed policy:

- If `--idempotency-key` is omitted, it is generated as `reward-grant:<season-id>`. If `--grant-date` is provided, it is generated as `reward-grant:<season-id>:<YYYY-MM-DD>`.
- The handler always fails closed with HTTP `409` / `REWARD_POLICY_GATE_CLOSED`, for both `--dry-run` and non-dry-run.
- The failure result payload has `policy.source = reward_policy_catalog_gate_closed`, zero participant/reward/userBadge counts, empty preview arrays, and an `errors[]` entry with `REWARD_POLICY_GATE_CLOSED`.
- The job does not read settled participants for reward eligibility and does not interpret `Season.rewardPolicyJson`.
- The job does not update `SeasonParticipant.rewardGrantedAt`.
- The job does not create, update, or backfill `Badge`, `UserBadge`, or `SeasonReward` rows.
- No hardcoded tier reward, badge, or trophy catalog is active in this job. Reward Policy / Catalog must be defined in a separate gate before reward-grant can write business rows.
- The job does not calculate reward amounts and does not perform payment, point, delivery, transfer, or external fulfillment. Actual fulfillment remains a separate gate.
- The job does not call providers, create price/FX rows, register a scheduler, expose an HTTP batch execution API, mutate wallets/orders/positions/snapshots/rankings, or change settlement/final-tier policy.
- Settled joined `GET /api/v1/home` reads `season_participants.rewardGrantedAt`; after this job sets it, `finalResult.reward.state` becomes `granted`. Missing `rewardGrantedAt` remains `REWARD_NOT_GRANTED`.

## Future Work

Cron scheduling, provider ingestion, daily snapshot automation, ranking overwrite/regeneration, settlement extensions beyond final tier assignment, true competition tie rank, reward amount policy, and actual payment/point/delivery/external fulfillment remain separate gates.
