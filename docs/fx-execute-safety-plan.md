# FX Execute Safety Plan

## Status
- This document fixes the pre-implementation safety design for `/fx execute`.
- This is documentation only.
- Do not implement `/fx execute` from this document yet.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, or temporary FX rates from this document.

## Purpose
- Prevent duplicate `/fx execute` execution before wallet mutation.
- Prevent wallet overspend under concurrent exchange/order requests.
- Decide an idempotency storage strategy before schema/migration reflection.
- Decide a wallet concurrency control strategy before implementation.
- Provide a schema/migration-ready design candidate for agreement.

## Current Constraints
- `exchange_transactions` exists but has no `idempotencyKey`.
- `wallet_transactions` exists and has `[referenceType, referenceId]` index only.
- There is no execute request or command table.
- `/fx quote/execute` contract candidates are documented in `docs/fx-api-contract.md`.
- Fake or temporary FX rates are forbidden.
- `fx_rate_snapshots` does not exist, so the legal `appliedRate` source is still a STOP decision.
- Even if idempotency and concurrency schema are added, actual execute implementation remains blocked until `appliedRate` source is decided.

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

### Candidate B: Add `fx_execute_requests` Command Table
Pros:
- Explicitly records request lifecycle.
- Supports `pending`, `succeeded`, and `failed` states.
- Can store `requestHash`.
- Makes duplicate retry and idempotency conflict easier to distinguish.
- Can become the same command pattern for future order execute.

Cons:
- Adds one table.
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
- Recommend Candidate B: separate `fx_execute_requests` command table.
- Reason: execute request can be recorded before wallet mutation.
- Reason: lifecycle can be tracked as `pending`, `succeeded`, or `failed`.
- Reason: duplicate retry and payload conflict can be separated by `idempotencyKey` plus `requestHash`.
- Reason: future order execute can reuse the same command table pattern.
- Do not add `exchange_transactions.idempotencyKey` in the first schema proposal because the command table owns idempotency.
- This task does not modify schema. Prisma model and migration require a separate STOP review.

## `fx_execute_requests` Table Candidate

| Field | Purpose |
| --- | --- |
| `id` | Request row primary key. |
| `userId` | User scope for idempotency and audit. |
| `seasonParticipantId` | Active joined participant that owns the wallet mutation. |
| `idempotencyKey` | Client-supplied retry key. Must be unique inside the chosen scope. |
| `requestHash` | Hash of normalized execute request payload; detects same key with different payload. |
| `fromCurrency` | Source wallet currency. |
| `toCurrency` | Target wallet currency. |
| `sourceAmount` | Requested debit amount, stored as `Decimal(24, 8)` candidate. |
| `status` | Command lifecycle status. |
| `exchangeTransactionId` | Linked `exchange_transactions.id` after success. |
| `responsePayloadJson` | Optional stored success response for replaying duplicate retry. |
| `errorCode` | Optional failed command error code. |
| `errorMessage` | Optional failed command error message. |
| `requestedAt` | Time the user requested execute. |
| `completedAt` | Time the command succeeded or failed. |
| `createdAt` | Row creation timestamp. |
| `updatedAt` | Row update timestamp. |

## Enum Candidate
`FxExecuteRequestStatus`:
- `pending`
- `succeeded`
- `failed`

## Unique And Index Candidates

Recommended unique:
- `unique(userId, idempotencyKey)`

Alternative unique to review:
- `unique(seasonParticipantId, idempotencyKey)`

Indexes:
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

## Schema/Migration Reflection Candidate
Next schema/migration task should consider:
- Add enum `FxExecuteRequestStatus`.
- Add model `FxExecuteRequest`.
- Add relations:
  - `User -> FxExecuteRequest[]`
  - `SeasonParticipant -> FxExecuteRequest[]`
  - `FxExecuteRequest -> ExchangeTransaction?`
- Add `unique(userId, idempotencyKey)`.
- Add indexes:
  - `[seasonParticipantId, requestedAt]`
  - `[status, requestedAt]`
  - `[exchangeTransactionId]`
- Do not add `exchange_transactions.idempotencyKey` in the first proposal because `fx_execute_requests` owns idempotency.

## FK Delete Behavior STOP
- Request/command rows are audit and replay records.
- Preservation is preferred over convenient cascading deletion.
- Existing `User` and `SeasonParticipant` delete behavior may conflict with preservation-first command records.
- Final `onDelete` policy must be decided before Prisma reflection.
- Do not choose a cascade/restrict/soft-delete policy without explicit schema review.

## Applied Rate STOP
- `fx_rate_snapshots` does not exist.
- There is no legal authoritative `appliedRate` source yet.
- Fake or temporary FX rates are forbidden.
- Adding idempotency and wallet safety schema does not make `/fx execute` implementable by itself.
- Actual execute implementation remains blocked until `appliedRate` source is decided.
