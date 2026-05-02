# FX Rate Snapshots Plan

## Status
- This document fixes the pre-schema design candidate for `fx_rate_snapshots`.
- This is documentation only.
- Do not implement `/fx quote`, `/fx execute`, `/home`, `/wallets`, `/orders`, or `/records` from this document.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Provide the authoritative `appliedRate` source for `/fx quote` and `/fx execute`.
- Provide USD -> KRW valuation evidence.
- Support future `/home`, asset valuation, settlement, ranking, and daily portfolio snapshots.
- Allow calculations without fake or temporary FX rates.
- Prepare a Prisma schema/migration candidate for agreement before implementation.

## Rate Meaning And Direction
- `rate` or `usdKrwRate` means KRW per 1 USD.
- Example: if 1 USD = 1350 KRW, `rate = 1350.00000000`.
- KRW -> USD: `grossTargetAmount = sourceAmount / appliedRate`.
- USD -> KRW: `grossTargetAmount = sourceAmount * appliedRate`.
- This matches `docs/fx-api-contract.md`.

## Supported Pair
- MVP authoritative pair:
  - `baseCurrency = USD`
  - `quoteCurrency = KRW`
- Store only USD/KRW in `fx_rate_snapshots` for MVP.
- Do not store KRW/USD as a separate authoritative pair in MVP.
- KRW -> USD exchange should use the USD/KRW snapshot and calculate by division.
- USD -> KRW exchange should use the USD/KRW snapshot and calculate by multiplication.

## FX Rate Source Policy Candidates

### Candidate A: External FX Provider API
Pros:
- Closer to market or official data.
- Can support automated refresh and timestamped provider metadata.

Cons:
- Provider selection is required.
- API key and rate limit handling are required.
- Provider outage and stale data policy are required.

### Candidate B: Admin Manual Entry
Pros:
- Simple for MVP.
- Does not require provider integration before first internal testing.

Cons:
- Operational mistakes are possible.
- Missing updates can produce stale rates.
- Requires approval and audit rules.

### Candidate C: Official Reference Rate Batch Input
Pros:
- Consistent and explainable reference basis.
- Easier to audit for settlement and final evaluation.

Cons:
- Lower real-time freshness.
- Requires batch ingestion and source timestamp policy.

### Candidate D: Fake, Static, Or Temporary Rate
Decision:
- Forbidden.
- Do not use hardcoded, fake, static, or temporary rates for `/fx quote`, `/fx execute`, valuation, settlement, or tests that can be mistaken as business data.

## Recommended Source Policy
- MVP should use either:
  - administrator/operator approved rate snapshots, or
  - official reference rate batch input.
- External provider direct integration can be split into a separate task.
- Fake/static hardcoded rates remain forbidden.
- Actual source policy must be decided before API implementation.
- Until the source is decided and `fx_rate_snapshots` exists, `/fx quote` and `/fx execute` remain STOP.

## `fx_rate_snapshots` Table Candidate

| Field | Type Candidate | Purpose |
| --- | --- | --- |
| `id` | `String @id @default(uuid())` | Snapshot row id. |
| `baseCurrency` | `CurrencyCode` | Base currency; MVP uses `USD`. |
| `quoteCurrency` | `CurrencyCode` | Quote currency; MVP uses `KRW`. |
| `rate` | `Decimal @db.Decimal(18, 8)` | KRW per 1 USD. |
| `sourceType` | `FxRateSourceType` | Source category. |
| `sourceName` | `String?` | Provider, official source, or admin source label. |
| `sourceTimestamp` | `DateTime?` | Timestamp from the upstream or official source. |
| `effectiveAt` | `DateTime` | Business-effective time for selecting this rate. |
| `capturedAt` | `DateTime` | Time the application captured or accepted the snapshot. |
| `createdAt` | `DateTime @default(now())` | Row creation timestamp. |
| `rawPayloadJson` | `Json?` | Optional original provider/batch/manual payload. |
| `approvedByUserId` | `String?` | Optional approving operator/admin user id. |
| `note` | `String?` | Optional audit note. |

## Enum Candidate
`FxRateSourceType`:
- `official_batch`
- `provider_api`
- `admin_manual`

Do not add `fake`, `static`, `temporary`, or similar source types.

## Unique And Index Candidates
Recommended indexes:
- `index(baseCurrency, quoteCurrency, effectiveAt)`
- `index(baseCurrency, quoteCurrency, capturedAt)`
- `index(sourceType, effectiveAt)`

Unique constraint:
- Defer unique constraint initially.
- Same `effectiveAt` may need to support multiple sources or correction workflows.
- Decide later whether to add uniqueness such as `[baseCurrency, quoteCurrency, sourceType, effectiveAt]` or a separate active/approved marker.

## Quote Snapshot Selection Candidate
For `POST /api/v1/fx/quote`:
1. Verify active season joined state.
2. Validate KRW/USD currency pair and positive `sourceAmount`.
3. Query `fx_rate_snapshots` where:
   - `baseCurrency = USD`
   - `quoteCurrency = KRW`
   - `effectiveAt <= now`
4. Select the most recent `effectiveAt` snapshot.
5. If no snapshot exists, return `FX_RATE_UNAVAILABLE`.
6. If selected snapshot `effectiveAt` is older than 60 seconds, return `FX_RATE_STALE`.
7. Use selected snapshot `rate` as `appliedRate`.

## Execute Snapshot Selection Candidate
For direct execute Candidate B in `docs/fx-api-contract.md`:
1. At execute time, select the latest effective USD/KRW snapshot using the same rule as quote.
2. Use selected snapshot `rate` as `appliedRate`.
3. Quote and execute may use different rates if a new snapshot becomes effective between requests.
4. If quoteId-based execute is introduced later, the quote should store the `fxRateSnapshotId` used for the quote.
5. If no valid snapshot exists at execute time, return `FX_RATE_UNAVAILABLE`.

## Quote Response Snapshot Id Decision
Candidates:
- Internal only: do not expose `fxRateSnapshotId` in quote response.
- Expose `fxRateSnapshotId`: useful for execute/debug/replay.

Recommendation:
- MVP quote response should not expose `fxRateSnapshotId`.
- Internal audit should still retain which snapshot was used where possible.
- Next exchange schema design should review whether `exchange_transactions.fxRateSnapshotId` is required.

## Exchange Transaction Connectivity
- Current `exchange_transactions` has no `fxRateSnapshotId`.
- Current `exchange_transactions.appliedRate` preserves the executed numeric rate.
- Numeric `appliedRate` alone is enough to reproduce wallet amounts, but weak for source audit.
- Future schema should consider adding `exchange_transactions.fxRateSnapshotId`.
- This task does not change schema.

## Home, Valuation, And Settlement Connectivity
`fx_rate_snapshots` should become the KRW conversion evidence for:
- USD cash valuation.
- US stock valuation.
- Crypto valuation when the asset valuation is USD-denominated.
- Settled/final KRW total asset evaluation.
- `daily_portfolio_snapshots` generation.
- `/home` summary and chart calculations once other blocker tables exist.

## Implementation STOP Points
- Decide actual source policy: approved manual/admin snapshot or official reference batch for MVP.
- Reflect `fx_rate_snapshots` schema/migration before `/fx quote` or `/fx execute`.
- Decide whether `exchange_transactions.fxRateSnapshotId` is needed in the same migration.
- Keep fake/static/temporary FX rates forbidden.
- `/fx execute` also remains blocked by idempotency/concurrency schema decisions in `docs/fx-execute-safety-plan.md`.
- `/home` full implementation remains blocked by positions, asset prices, daily snapshots, ranking, and valuation source completion.
