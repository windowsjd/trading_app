# FX Execute Safety Plan

## Status
- This document records the accepted safety design for future `/fx execute`.
- `fx_execute_requests` schema/migration foundation is reflected, but `/fx execute` is not implemented.
- This is documentation only.
- Detailed unresolved decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- Related candidate policies: `docs/fx-decimal-rounding-scale-policy.md`, `docs/fx-execute-error-policy.md`, `docs/fx-idempotency-lifecycle-policy.md`.
- Do not implement `/fx execute` from this document yet.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, or temporary FX rates from this document.

## Purpose
- Prevent duplicate `/fx execute` execution before wallet mutation.
- Prevent wallet overspend under concurrent exchange/order requests.
- Preserve the accepted idempotency storage strategy.
- Keep wallet concurrency, rounding, and failed command lifecycle STOP points visible before execute implementation.

## Current Constraints
- `exchange_transactions` exists, has nullable `fxRateSnapshotId`, and still has no `idempotencyKey`.
- `wallet_transactions` exists and has `[referenceType, referenceId]` index only.
- `fx_execute_requests` exists as the durable execute request/command table foundation.
- `/fx quote/execute` contract candidates are documented in `docs/fx-api-contract.md`.
- Fake or temporary FX rates are forbidden.
- `fx_rate_snapshots` exists and `/fx quote` uses it for the legal `appliedRate` source.
- Production provider/batch ingestion is not implemented yet.
- Actual execute implementation remains blocked until wallet conditional update, Decimal rounding/scale, failed command lifecycle, and execute-time rate/source policy are finalized.

## Idempotency Strategy Candidates

### Candidate A: Add `exchange_transactions.idempotencyKey`
Pros:
- Simple for a small MVP.
- Directly attached to the successful exchange row.
- Duplicate retry can look up the original exchange row.

Cons:
- Weak pending/failed request lifecycle representation.
- Hard to record command state before wallet mutation.
- Awkward place for request payload hash and conflict decision metadata.

### Candidate B: Use Reflected `fx_execute_requests` Command Table
Pros:
- Explicitly records request lifecycle.
- Supports `pending`, `succeeded`, and `failed` states.
- Can store `requestHash`.
- Makes duplicate retry and idempotency conflict easier to distinguish.
- Can become the same command pattern for future order execute.

Cons:
- Command lifecycle implementation is still required.
- Slightly increases implementation complexity.

### Candidate C: API Layer Durable Store
Pros:
- Can reduce direct DB table shape changes.

Cons:
- Hard to keep consistent with the wallet DB transaction.
- Redis-only storage creates durability and recovery concerns.
- Not suitable as the only correctness boundary for a financial write path.

### Candidate D: No Idempotency
Decision:
- Not recommended.
- Close to forbidden for `/fx execute`.
- Client retry, network timeout, or duplicate request can debit the source wallet more than once.
- Duplicate `exchange_transactions` and `wallet_transactions` rows would look like real user actions.

## Recommended Idempotency Decision
- Candidate B is accepted and reflected: separate `fx_execute_requests` command table.
- Reason: execute request can be recorded before wallet mutation.
- Reason: lifecycle can be tracked as `pending`, `succeeded`, or `failed`.
- Reason: duplicate retry and payload conflict can be separated by `idempotencyKey` plus `requestHash`.
- Reason: future order execute can reuse the same command table pattern.
- `exchange_transactions.idempotencyKey` remains intentionally absent because the command table owns idempotency.
- This document does not authorize additional schema changes or `/fx execute` implementation.

## Reflected `fx_execute_requests` Foundation

| Field | Purpose |
| --- | --- |
| `id` | Request row primary key. |
| `userId` | User scope for idempotency and audit. |
| `seasonParticipantId` | Active joined participant that owns the wallet mutation. |
| `idempotencyKey` | Client-supplied retry key. Must be unique inside the chosen scope. |
| `requestHash` | Hash of normalized execute request payload; detects same key with different payload. |
| `fromCurrency` | Source wallet currency. |
| `toCurrency` | Target wallet currency. |
| `sourceAmount` | Requested debit amount, stored as `Decimal(24, 8)`. |
| `status` | Command lifecycle status. |
| `exchangeTransactionId` | Linked `exchange_transactions.id` after success. |
| `responsePayloadJson` | Optional stored success response for replaying duplicate retry. |
| `errorCode` | Optional failed command error code. |
| `errorMessage` | Optional failed command error message. |
| `requestedAt` | Time the user requested execute. |
| `completedAt` | Time the command succeeded or failed. |
| `createdAt` | Row creation timestamp. |
| `updatedAt` | Row update timestamp. |

## Reflected Enum
`FxExecuteRequestStatus`:
- `pending`
- `succeeded`
- `failed`

## Reflected Unique And Indexes

Reflected unique:
- `unique(userId, idempotencyKey)`

Alternative unique to review:
- `unique(seasonParticipantId, idempotencyKey)`

Reflected indexes:
- `index(seasonParticipantId, requestedAt)`
- `index(status, requestedAt)`
- `index(exchangeTransactionId)`

## Recommended Unique Scope
- Prefer `userId + idempotencyKey`.
- Client idempotency keys are usually generated per user request.
- This makes duplicate user request detection clear even if active season participant context changes.
- `/fx execute` is still allowed only for an active joined season, so `seasonParticipantId` must also be stored.

## Idempotent Execute Lifecycle Candidate
1. Normalize request payload.
2. Compute `requestHash`.
3. Insert `fx_execute_requests` row with `pending` status and `unique(userId, idempotencyKey)`.
4. If the same key already exists:
   - same `requestHash` and `succeeded`: return stored response or rebuild response from `exchangeTransactionId`.
   - same `requestHash` and `pending`: return or retry according to final API policy.
   - different `requestHash`: return `IDEMPOTENCY_CONFLICT`.
5. Execute wallet mutation and exchange ledger writes in one DB transaction.
6. On success, set status to `succeeded`, store `exchangeTransactionId`, `responsePayloadJson`, and `completedAt`.
7. On failure, set status to `failed`, store `errorCode`, `errorMessage`, and `completedAt` if the final policy records failed commands.

## Wallet Concurrency And Overspend Candidates

### Candidate A: Row-Level Lock
- Use `SELECT ... FOR UPDATE` or an equivalent strategy.
- Lock source and target wallet rows before validation.
- Pros: explicit locking.
- Cons: Prisma Client may require raw SQL.

### Candidate B: Conditional Update
- Debit source wallet only when `balanceAmount >= sourceAmount`.
- Confirm affected row count is exactly 1.
- Pros: simple MVP fit and prevents stale read overspend.
- Cons: must verify Prisma can safely express Decimal condition and affected row checks.

### Candidate C: Serializable Transaction
- Use serializable isolation and retry serialization failures.
- Pros: strong DB-level protection.
- Cons: retry and serialization failure handling is more complex.

### Candidate D: Application-Level Mutex
- Serialize by wallet in application code.
- Pros: easy in a single instance.
- Cons: risky in multi-instance deployments.
- Cons: must not be the only correctness boundary.

## Recommended Wallet Safety Decision
- Recommend Candidate B: conditional update as the MVP first choice.
- Implementation must verify Prisma support before coding.
- If Prisma Decimal conditional update and affected row checks are not safe enough, switch to raw SQL or row-level lock.
- Order execute must share the same wallet safety pattern.

## Conditional Update Principles
- Run inside the `/fx execute` DB transaction.
- Source wallet debit is a conditional update with:
  - wallet id
  - `seasonParticipantId`
  - `currencyCode`
  - `balanceAmount >= sourceAmount`
- If affected row count is 0:
  - reread latest source wallet balance.
  - if balance is insufficient, return `INSUFFICIENT_BALANCE`.
  - if balance appears sufficient but update failed, return `CONCURRENT_WALLET_UPDATE`.
- Target wallet credit runs in the same transaction.
- `exchange_transactions` row is created in the same transaction.
- `wallet_transactions` source debit and target credit rows are created in the same transaction.
- `wallet_transactions.balanceAfter` must use actual post-update wallet balances.

## Reflected Schema/Migration Foundation
The accepted migration already includes:
- enum `FxExecuteRequestStatus`.
- model `FxExecuteRequest`.
- relations:
  - `User -> FxExecuteRequest[]`
  - `SeasonParticipant -> FxExecuteRequest[]`
  - `FxExecuteRequest -> ExchangeTransaction?`
- `unique(userId, idempotencyKey)`.
- indexes:
  - `[seasonParticipantId, requestedAt]`
  - `[status, requestedAt]`
  - `[exchangeTransactionId]`
- No `exchange_transactions.idempotencyKey`, because `fx_execute_requests` owns idempotency.

## FK Delete Behavior STOP
- Request/command rows are audit and replay records.
- Preservation is preferred over convenient cascading deletion.
- Existing `User` and `SeasonParticipant` delete behavior may conflict with preservation-first command records.
- Current reflected relation policy uses `onDelete: Restrict`.
- Do not change cascade/restrict/soft-delete policy without explicit schema review.

## Applied Rate STOP
- `fx_rate_snapshots` exists as the authoritative rate snapshot structure.
- `/fx quote` uses the latest fresh USD/KRW snapshot and returns `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE` when appropriate.
- Fake or temporary FX rates are forbidden.
- Adding idempotency and wallet safety schema does not make `/fx execute` implementable by itself.
- Actual execute implementation remains blocked until execute-time snapshot selection, 60-second freshness behavior, sourceType priority, and provider/batch ingestion assumptions are reviewed for execute.
