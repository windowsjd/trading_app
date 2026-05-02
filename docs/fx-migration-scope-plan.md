# FX Migration Scope Plan

## Status
- This document records the accepted `/fx` DB foundation and migration scope history.
- Candidate C was accepted and reflected into Prisma schema and migration.
- Prisma schema reflection is complete for this scope.
- Migration `20260501212120_add_fx_rate_and_execute_safety_tables` has been created and applied to the local DB.
- Prisma Client generate, build, test, and e2e verification passed.
- `/fx quote` read-only implementation exists.
- `/fx execute` remains forbidden.
- Do not implement `/fx execute`, `/wallets`, `/orders`, `/records`, or `/home` from this document.
- Do not hand-write a migration as a workaround for `prisma migrate dev --create-only` failure.
- Do not add seed changes, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Preserve the accepted DB foundation decision for `/fx`.
- Record why `fx_rate_snapshots`, `fx_execute_requests`, and `exchange_transactions.fxRateSnapshotId` were migrated together.
- Keep the remaining `/fx execute` and production ingestion STOP conditions visible.

## Current Premises
- `/fx quote` read-only implementation exists.
- `/fx execute` remains forbidden.
- `fx_rate_snapshots` is reflected in schema and migration.
- `fx_execute_requests` is reflected in schema and migration.
- `exchange_transactions` has nullable `fxRateSnapshotId`.
- Fake, static, and temporary FX rates are forbidden.
- `fx_rate_snapshots` source structure exists, but production ingestion path is not implemented.
- This document does not authorize `/fx execute` or wallet write path implementation.

## Migration Scope Candidates

### Candidate A: Migrate Only `fx_rate_snapshots` First
Pros:
- Resolves the `appliedRate` source blocker first.
- Keeps the next `/fx quote` preparation focused.
- Separates rate source design from idempotency and execute safety design.

Cons:
- `/fx execute` still needs `fx_execute_requests`.
- Adding `exchange_transactions.fxRateSnapshotId` later would require another migration.

### Candidate B: Migrate Only `fx_execute_requests` First
Pros:
- Prepares duplicate execute protection first.
- Can extend the command pattern to future order execute.

Cons:
- `/fx quote` and `/fx execute` remain blocked because there is still no `appliedRate` source.
- Lower priority for actual exchange readiness than the rate source table.

### Candidate C: Migrate `fx_rate_snapshots`, `fx_execute_requests`, And `exchange_transactions.fxRateSnapshotId` Together
Pros:
- Secures the core DB base needed before `/fx quote` and `/fx execute`.
- Handles `appliedRate` source, execute idempotency, and exchange audit link together.
- Makes the next `/fx` implementation design clearer after migration.

Cons:
- Larger migration scope.
- FK delete behavior, nullable policy, and seed policy need careful review.

## Recommended Migration Scope
- Candidate C was selected and implemented.
- Reason: `/fx execute` needs both an authoritative `appliedRate` source and durable idempotency.
- Reason: adding `exchange_transactions.fxRateSnapshotId` in the same migration makes the rate source used at execution auditable.
- Reason: if these are split, the project is likely to need another immediate follow-up migration before real `/fx` implementation.
- No additional schema or migration change is implied by this document.

## `FxRateSourceType` Enum Candidate
Recommended values:
- `official_batch`
- `provider_api`
- `admin_manual`

Forbidden values:
- `fake`
- `static`
- `temporary`

## `FxRateSnapshot` Model Candidate
Table name:
- `@@map("fx_rate_snapshots")`

Field candidates:
- `id: String @id @default(uuid())`
- `baseCurrency: CurrencyCode @map("base_currency")`
- `quoteCurrency: CurrencyCode @map("quote_currency")`
- `rate: Decimal @db.Decimal(18, 8)`
- `sourceType: FxRateSourceType @map("source_type")`
- `sourceName: String? @map("source_name")`
- `sourceTimestamp: DateTime? @map("source_timestamp")`
- `effectiveAt: DateTime @map("effective_at")`
- `capturedAt: DateTime @map("captured_at")`
- `createdAt: DateTime @default(now()) @map("created_at")`
- `rawPayloadJson: Json? @map("raw_payload_json")`
- `approvedByUserId: String? @map("approved_by_user_id")`
- `note: String?`

Relation candidates:
- `ExchangeTransaction -> FxRateSnapshot?` through `exchange_transactions.fxRateSnapshotId`.
- `FxRateSnapshot -> ExchangeTransaction[]`.
- `approvedByUserId` can either stay as a plain nullable `String` or become a relation to `User` or a future admin/operator model.

Recommended `approvedByUserId` decision:
- Start MVP with nullable `String` only.
- Revisit `User` relation or `Admin` relation after auth/admin ownership is finalized.
- Reason: the auth/admin body is still incomplete.
- Reason: creating the wrong FK now can increase migration burden when the operator/admin model changes.

Recommended indexes:
- `@@index([baseCurrency, quoteCurrency, effectiveAt])`
- `@@index([baseCurrency, quoteCurrency, capturedAt])`
- `@@index([sourceType, effectiveAt])`

Unique constraint:
- Defer unique constraints in this migration.
- Reason: the same `effectiveAt` may need multiple sources, correction rows, or re-approval workflow.
- Reason: there is no agreed `approved` or `latest` marker policy yet.

## `FxExecuteRequestStatus` Enum Candidate
Recommended values:
- `pending`
- `succeeded`
- `failed`

## `FxExecuteRequest` Model Candidate
Table name:
- `@@map("fx_execute_requests")`

Field candidates:
- `id: String @id @default(uuid())`
- `userId: String @map("user_id")`
- `seasonParticipantId: String @map("season_participant_id")`
- `idempotencyKey: String @map("idempotency_key")`
- `requestHash: String @map("request_hash")`
- `fromCurrency: CurrencyCode @map("from_currency")`
- `toCurrency: CurrencyCode @map("to_currency")`
- `sourceAmount: Decimal @db.Decimal(24, 8) @map("source_amount")`
- `status: FxExecuteRequestStatus`
- `exchangeTransactionId: String? @map("exchange_transaction_id")`
- `responsePayloadJson: Json? @map("response_payload_json")`
- `errorCode: String? @map("error_code")`
- `errorMessage: String? @map("error_message")`
- `requestedAt: DateTime @map("requested_at")`
- `completedAt: DateTime? @map("completed_at")`
- `createdAt: DateTime @default(now()) @map("created_at")`
- `updatedAt: DateTime @updatedAt @map("updated_at")`

Relation candidates:
- `User -> FxExecuteRequest[]`.
- `SeasonParticipant -> FxExecuteRequest[]`.
- `FxExecuteRequest -> ExchangeTransaction?`.
- If strict one-to-one between request and exchange is required, `exchangeTransactionId` uniqueness must be explicitly reviewed. The current candidate keeps the requested index-only policy.

Recommended unique:
- `@@unique([userId, idempotencyKey])`

Recommended indexes:
- `@@index([seasonParticipantId, requestedAt])`
- `@@index([status, requestedAt])`
- `@@index([exchangeTransactionId])`

FK delete behavior candidate:
- Command/request rows are audit and replay records, so preservation is preferred.
- Prefer reviewing `onDelete: Restrict` first.
- Current `User` and `SeasonParticipant` relations include cascade paths, so this may conflict with existing deletion behavior.
- If the existing cascade policy conflicts with preservation-first command records, STOP and report before schema reflection.
- Do not choose `Cascade` arbitrarily.

## `exchange_transactions.fxRateSnapshotId` Candidate
Recommendation:
- Add `exchange_transactions.fxRateSnapshotId`.

Nullable policy candidate:
- Required would be ideal for newly implemented `/fx execute`.
- Nullable `String?` should be reviewed first for migration safety because existing `exchange_transactions` rows may exist.

Relation candidate:
- `ExchangeTransaction -> FxRateSnapshot?`.
- `FxRateSnapshot -> ExchangeTransaction[]`.

Index candidate:
- `@@index([fxRateSnapshotId])`
- Keep existing `exchange_transactions` indexes.

Reason:
- Storing only `appliedRate` is enough to reproduce wallet calculations.
- It is weak for auditing which source snapshot produced that numeric rate.
- `fxRateSnapshotId` makes quote, execute, debug, settlement, and replay verification easier.

## Seed Policy
- Do not add seed data in this migration scope by default.
- Do not create fake, static, or temporary FX rate rows.
- Real `fx_rate_snapshots` rows require an approved source input path such as `admin_manual`, `provider_api`, or `official_batch`.

## Remaining STOP Conditions After Candidate C Migration
- Production rate ingestion policy must be finalized.
- `provider_api` or `official_batch` ingestion is not implemented.
- Safe Prisma conditional update for wallet debit must be verified.
- Failed command lifecycle persistence policy must be finalized.
- Decimal rounding and scale rules must be finalized.
- `/fx execute` must not be considered implementation-ready immediately after this migration.
- `/fx quote` returns `FX_RATE_UNAVAILABLE` when no eligible rate snapshot exists.
- `/fx quote` returns `FX_RATE_STALE` when the selected snapshot is older than the 60-second threshold.

## Non-Goals
- No `/fx execute` implementation.
- No wallet, order, records, or home implementation.
- No additional schema or migration changes beyond this agreed `/fx` DB foundation.
- No seed changes.
- No API contract changes.
- No fake, static, or temporary FX rate.
