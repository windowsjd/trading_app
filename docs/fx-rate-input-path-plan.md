# FX Rate Input Path Plan

## Status
- This document fixes the rate input path candidate for `fx_rate_snapshots`.
- The approved internal CLI implementation now exists at `scripts/admin-insert-fx-rate.ts`.
- The `/fx quote` integration check is documented in `docs/fx-quote-integration-check.md`.
- Do not implement `/fx execute`, `/wallets`, `/orders`, `/records`, `/home`, admin APIs, or additional CLI scripts from this document.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Decide how authoritative USD/KRW rates enter `fx_rate_snapshots`.
- Define the minimum operational path that can make `/fx quote` work without fake, static, or temporary rates.
- Decide whether MVP should prefer `admin_manual` or `official_batch`.
- Decide whether the `/fx quote` implementation STOP can move to a final pre-implementation review.

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

## Recommended Rate Input Decision
- MVP should prefer `admin_manual` input path.
- This must be treated as a separate operating input path, not seed data.
- Before implementation, the path must be clearly separated from fake/static seed and hardcoded fallback behavior.
- Near-term implementation candidate can be an approved internal CLI script.
- Admin API should wait until auth/admin authorization is finalized.
- `official_batch` and `provider_api` should be follow-up operating improvements.

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
- `effectiveAt` must be a UTC ISO timestamp.
- `capturedAt` must be a UTC ISO timestamp.
- `capturedAt` should represent input time or approval time.
- `sourceName` must not be an empty string.
- `sourceName`, `note`, and `rawPayloadJson` must not describe the rate as fake, static, temporary, sample, placeholder, or test business data.
- Whether a very old `effectiveAt` snapshot may still be used must be decided before `/fx quote` implementation.

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
- MVP initial design should use the latest eligible `effectiveAt` snapshot.
- Stale threshold remains a STOP decision before `/fx quote` implementation.
- If the team intentionally defers a threshold for MVP, that deferral must be explicit and documented before coding.
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

## `/fx quote` Implementation Preconditions

Required before `/fx quote` implementation:
- `fx_rate_snapshots` migration applied.
- Prisma Client generate completed.
- Rate input path decided.
- At least one valid USD/KRW snapshot can be inserted through the approved path.
- Snapshot selection rule finalized.
- Stale threshold finalized, or explicit MVP no-threshold deferral policy finalized.
- No eligible snapshot returns `FX_RATE_UNAVAILABLE`.

Do not do during `/fx quote` implementation:
- Do not implement `/fx execute`.
- Do not mutate wallets.
- Do not create `exchange_transactions`.
- Do not create `wallet_transactions`.
- Do not create `fx_execute_requests`.
- Do not create `equity_snapshots`.
- Do not add fake/static/temporary fallback rates.

## Design Phase Status
- For `/fx quote`, documentation design is sufficient once this rate input path plan is accepted and the final STOP review confirms the stale threshold policy.
- For `/fx execute`, document design still has open implementation policy points:
  - conditional update verification,
  - Decimal rounding and scale rules,
  - failed command lifecycle details.
- The next step may move to `/fx quote` read-only implementation STOP review.
- Full `/fx execute` implementation remains forbidden.
