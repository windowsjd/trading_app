> Historical document.
> This file is not the current source of truth.
> See `docs/current-status.md`, `docs/backend-gate-roadmap.md`, and the relevant API contract or provider policy document.

# FX Rate Input Path Plan

## Status
- This document records the accepted rate input path for `fx_rate_snapshots`.
- The approved internal CLI implementation now exists at `scripts/admin-insert-fx-rate.ts`.
- The `/fx quote` integration check is documented in `docs/fx-quote-integration-check.md`.
- `/fx quote` read-only implementation exists and applies a 60-second stale threshold.
- `admin_manual` is a bootstrap/manual correction path, not the long-term primary ingestion path.
- Do not implement `/fx execute`, `/wallets`, `/orders`, `/records`, `/home`, admin APIs, or additional CLI scripts from this document.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Decide how authoritative USD/KRW rates enter `fx_rate_snapshots`.
- Define the minimum operational path that can make `/fx quote` work without fake, static, or temporary rates.
- Record the accepted `admin_manual` bootstrap path.
- Clarify why provider/batch ingestion is required after `/fx quote` adopted a 60-second stale threshold.

## Current Premises
- `fx_rate_snapshots` schema and migration are created and applied locally.
- `fx_execute_requests` schema and migration are created and applied locally.
- Prisma Client generate, build, test, and e2e verification passed.
- `/fx quote` read-only implementation exists.
- `/fx execute` implementation does not exist yet.
- There is no `fx_rate_snapshots` seed data.
- Fake, static, and temporary FX rates are forbidden.
- `/fx quote` must return `FX_RATE_UNAVAILABLE` when there is no eligible `fx_rate_snapshots` row.

## Rate Input Candidates

### Candidate A: `admin_manual` Input
- An operator or developer enters an approved USD/KRW rate manually.
- Store `sourceType = admin_manual`.
- Store `sourceName` as the input actor, operating source, or approved source label.
- `approvedByUserId` may remain nullable because auth/admin ownership is not finalized.

Pros:
- Simplest MVP path.
- Allows quote testing without external provider integration.
- Unlike fake/static rates, it leaves evidence that an operator approved a real input value.

Cons:
- An operator must enter the value.
- Missing input or wrong input is possible.
- Needs an input path clearly separated from seed data and hardcoded fallback data.

### Candidate B: `official_batch` Input
- A batch process collects or inputs an official reference rate.
- Store `sourceType = official_batch`.

Pros:
- Consistent reference basis.
- Reduces the feeling that an operator picked an arbitrary number.

Cons:
- Requires source and schedule design.
- Requires an actual official provider/source decision.
- Higher initial MVP implementation cost.

### Candidate C: `provider_api` Direct Integration
- The application collects rates automatically from an external FX provider API.
- Store `sourceType = provider_api`.

Pros:
- Can be automated.
- Reduces operator workload.

Cons:
- Requires provider selection, API key handling, outage behavior, rate limit handling, and test environment design.
- Too large for the current MVP step.

### Candidate D: Seed Or Hardcoded Static Rate
- Forbidden.
- Seeded, hardcoded, fake, static, or temporary rates must not be used as `/fx quote` or `/fx execute` evidence.
- This includes test-looking business rows that can be mistaken for real operating data.

## Reflected Rate Input Decision
- MVP uses the implemented `admin_manual` internal CLI as the bootstrap/manual correction path.
- This is treated as a separate operating input path, not seed data.
- The CLI path is separated from fake/static seed and hardcoded fallback behavior.
- Admin API should wait until auth/admin authorization is finalized.
- `admin_manual` is an MVP operating/bootstrap path, not the final long-term rate ingestion design.
- Production-oriented rate ingestion should move toward `provider_api` or `official_batch` automatic/periodic updates.

## `admin_manual` Input Policy

Required input fields:
- `baseCurrency = USD`
- `quoteCurrency = KRW`
- `rate`
- `sourceType = admin_manual`
- `sourceName`
- `effectiveAt`
- `capturedAt`
- At least one of `note` or `rawPayloadJson` is recommended.

Optional fields:
- `sourceTimestamp`
- `approvedByUserId`
- `rawPayloadJson`
- `note`

Validation rules:
- `baseCurrency` must be `USD`.
- `quoteCurrency` must be `KRW`.
- `baseCurrency` and `quoteCurrency` must not be equal.
- `rate` must be greater than 0.
- `effectiveAt` must be a strict UTC ISO timestamp like `2026-05-01T00:00:00.000Z`.
- `capturedAt` must be a strict UTC ISO timestamp like `2026-05-01T00:00:00.000Z`.
- `sourceTimestamp`, when provided, must be a strict UTC ISO timestamp like `2026-05-01T00:00:00.000Z`.
- Date-only values, timezone offsets, and timestamps without milliseconds are rejected.
- `capturedAt` should represent input time or approval time.
- `effectiveAt` should represent the latest valid FX rate time for quote freshness.
- For `/fx quote` success, the selected snapshot `effectiveAt` must be within 60 seconds of quote time.
- `sourceName` must not be an empty string.
- `sourceName`, `note`, and `rawPayloadJson` must not describe the rate as fake, static, temporary, sample, placeholder, or test business data.
- Old `effectiveAt` snapshots may remain stored for audit, but `/fx quote` rejects them with `FX_RATE_STALE`.

Audit guidance:
- `sourceName` should identify the approved operating source clearly enough for debugging.
- `note` or `rawPayloadJson` should explain why the rate is acceptable for MVP operation.
- `approvedByUserId` should remain nullable until auth/admin ownership is finalized.

## Freshness And Stale Policy

Selection candidate:
- `/fx quote` selects the latest eligible snapshot where:
  - `baseCurrency = USD`
  - `quoteCurrency = KRW`
  - `effectiveAt <= now`
- If no eligible snapshot exists, return `FX_RATE_UNAVAILABLE`.

Freshness candidates:
- Treat snapshots older than 60 seconds as stale.
- Treat snapshots older than 5 minutes as stale.
- Treat snapshots older than 1 hour as stale.
- Treat snapshots outside the current business day as stale.

Recommendation:
- MVP quote uses the latest eligible `effectiveAt` snapshot and a 60-second stale threshold.
- If the selected snapshot `effectiveAt` is older than quote time by more than 60 seconds, return `FX_RATE_STALE`.
- If no eligible snapshot exists, return `FX_RATE_UNAVAILABLE`.
- `admin_manual` input can bootstrap MVP testing, but operators must input a current approved rate for successful quote responses.
- Long-running operation should use `provider_api` or `official_batch` automatic/periodic updates.
- `/fx quote` must never fall back to fake/static/temporary rates when snapshots are missing or stale.

## Implementation Path Candidates

### Candidate A: internal CLI script
- Example command shape: `pnpm tsx scripts/admin-insert-fx-rate.ts`.

Pros:
- Can support operating input before auth/admin is complete.
- Does not require an admin screen.
- Smallest path to valid `fx_rate_snapshots` rows for MVP.

Cons:
- Low operational UX.
- Execution permission must be controlled.
- Needs careful input logs and audit discipline.

### Candidate B: Admin-Only API
- Example route shape: `POST /api/v1/admin/fx/rates`.

Pros:
- Better long-term operating model.
- Can connect approver, actor, and authorization metadata.

Cons:
- Auth/admin authorization model is not finalized.
- Implementing it now risks temporary permission bypasses.

### Candidate C: Official Batch Job
- A scheduler inserts official reference rates into `fx_rate_snapshots`.

Pros:
- Good long-term operating fit.
- Reduces manual input work.

Cons:
- Requires source decision and batch infrastructure.
- Should be split into a follow-up task.

Recommended implementation path:
- Prefer an approved internal CLI script immediately before MVP.
- The MVP internal CLI script exists and remains create-only.
- Admin API should wait for auth/admin model agreement.
- Official batch and provider API should be separate follow-up designs.
- Production operation should prioritize `provider_api` polling or `official_batch` ingestion design.

## `/fx quote` Operating Preconditions

Required for successful `/fx quote` responses:
- `fx_rate_snapshots` migration applied.
- Prisma Client generate completed.
- Rate input path decided and implemented as the internal `admin_manual` CLI.
- At least one approved fresh USD/KRW snapshot inserted through the approved path.
- Snapshot selection rule finalized and implemented.
- Stale threshold finalized and implemented as 60 seconds.
- No eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- Stale selected snapshot returns `FX_RATE_STALE`.

Read-only quote write prohibitions:
- Do not implement `/fx execute`.
- Do not mutate wallets.
- Do not create `exchange_transactions`.
- Do not create `wallet_transactions`.
- Do not create `fx_execute_requests`.
- Do not create `equity_snapshots`.
- Do not add fake/static/temporary fallback rates.

## Design Phase Status
- `/fx quote` documentation design and read-only implementation are complete.
- `/fx quote` integration smoke requires an approved fresh snapshot within the 60-second stale threshold.
- FX provider/batch ingestion design is documented in `docs/fx-rate-ingestion-plan.md`; the next step is implementation STOP review and provider/source selection.
- For `/fx execute`, document design still has open implementation policy points:
  - conditional update verification,
  - Decimal rounding and scale rules,
  - failed command lifecycle details.
- Full `/fx execute` implementation remains forbidden.
