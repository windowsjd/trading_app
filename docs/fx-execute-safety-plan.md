# FX Execute Safety Plan

## Status
- This document records the accepted safety design for future `/fx execute`.
- `fx_execute_requests` schema/migration foundation is reflected, but `/fx execute` is not implemented.
- This is documentation only.
- Detailed unresolved decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- Accepted policy references: `docs/fx-decimal-rounding-scale-policy.md`, `docs/fx-execute-error-policy.md`, `docs/fx-idempotency-lifecycle-policy.md`.
- Error/status/retryability, idempotency pending/succeeded/failed MVP lifecycle, wallet safety strategy, rollback/partial-write test gate, sourceType eligibility, execute-time snapshot selection, and execute-time freshness are accepted.
- Final implementation gate and test matrix: `docs/fx-execute-final-implementation-gate.md`.
- `/fx execute` is still not implemented; implementation requires a separate task with full test matrix and wallet safety proof.
- Do not implement `/fx execute` from this document yet.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, or temporary FX rates from this document.

## Purpose
- Prevent duplicate `/fx execute` execution before wallet mutation.
- Prevent wallet overspend under concurrent exchange/order requests.
- Preserve the accepted idempotency storage strategy.
- Keep wallet concurrency, rounding, provider/sourceType, snapshot freshness, and implementation test gates visible before execute implementation.

## Current Constraints
- `exchange_transactions` exists, has nullable `fxRateSnapshotId`, and still has no `idempotencyKey`.
- `wallet_transactions` exists and has `[referenceType, referenceId]` index only.
- `fx_execute_requests` exists as the durable execute request/command table foundation.
- `/fx quote/execute` contract candidates are documented in `docs/fx-api-contract.md`.
- Fake or temporary FX rates are forbidden.
- `fx_rate_snapshots` exists and `/fx quote` uses it for the legal `appliedRate` source.
- Production provider/batch ingestion is not implemented yet.
- Decimal rounding/scale and `requestHash` canonical rule are accepted in their policy documents.
- `provider_api`, `official_batch`, and scheduler ingestion are not implemented.
- Provider final selection is not confirmed; OANDA is primary candidate and Twelve Data is secondary candidate only.
- Near-term execute source eligibility allows approved fresh `admin_manual` only.
- Actual execute implementation requires a separate implementation task with full test matrix and wallet safety proof.

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

## Idempotent Execute Lifecycle Accepted MVP Policy
1. Normalize request payload.
2. Compute `requestHash`.
3. Insert `fx_execute_requests` row with `pending` status and `unique(userId, idempotencyKey)`.
4. If the same key already exists:
   - same `requestHash` and `succeeded`: return stored `responsePayloadJson`; do not recompute.
   - same `requestHash` and fresh `pending`: return `IDEMPOTENCY_PENDING`; do not mutate wallets.
   - same `requestHash` and stale `pending`: return `IDEMPOTENCY_PENDING_STALE`; do not automatically re-execute.
   - same `requestHash` and `failed`: return `IDEMPOTENCY_FAILED` or stored original failure payload; do not automatically re-execute.
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
- Status: fallback/alternative for MVP if guarded conditional debit cannot be proven safe.

### Candidate B: Conditional Update
- Debit source wallet only when `balanceAmount >= sourceAmount`.
- Confirm affected row count is exactly 1.
- Pros: simple MVP fit and prevents stale read overspend.
- Cons: must verify Prisma can safely express Decimal condition and affected row checks.
- Status: accepted MVP default as guarded conditional source debit.

### Candidate C: Serializable Transaction
- Use serializable isolation and retry serialization failures.
- Pros: strong DB-level protection.
- Cons: retry and serialization failure handling is more complex.

### Candidate D: Application-Level Mutex
- Serialize by wallet in application code.
- Pros: easy in a single instance.
- Cons: risky in multi-instance deployments.
- Cons: must not be the only correctness boundary.
- Decision: application-level mutex, Redis lock, or process-local lock may be auxiliary optimization only and must not be the sole financial correctness boundary.

## Accepted Wallet Safety Decision
- Candidate B is accepted as the MVP default: guarded conditional source debit.
- This is policy acceptance, not `/fx execute` implementation permission.
- Implementation must verify Prisma support before coding.
- If Prisma Decimal conditional update, affected row count, or post-update balance capture are not safe enough, switch to raw SQL or row-level lock.
- Order execute must share the same wallet safety pattern.

## Conditional Update Principles
- Run inside the `/fx execute` DB transaction.
- Source wallet debit is a conditional update with:
  - wallet id
  - `seasonParticipantId`
  - `currencyCode`
  - `balanceAmount >= rounded sourceAmount`
- If affected row count is 0:
  - reread the source wallet in the same transaction or safe read context.
  - if the source wallet is missing, return `SOURCE_WALLET_NOT_FOUND`.
  - if `balanceAmount < rounded sourceAmount`, return `INSUFFICIENT_BALANCE`.
  - if `balanceAmount >= rounded sourceAmount` but guarded debit failed, return `CONCURRENT_WALLET_UPDATE`.
- If source debit fails, target wallet credit, `exchange_transactions`, wallet ledger rows, and command success finalization must not happen.
- Target wallet credit runs after successful source debit in the same transaction.
- `exchange_transactions` row is created in the same transaction.
- `wallet_transactions` source debit and target credit rows are created in the same transaction.
- `wallet_transactions.balanceAfter` must use actual post-update wallet balances.

## Accepted Update Order And Balance Source
1. Validate request and idempotency preconditions.
2. Select a fresh eligible FX snapshot according to the execute-time policy candidate/final gate.
3. Calculate rounded `sourceAmount`, `grossTargetAmount`, `feeAmount`, and `netTargetAmount` using the accepted Decimal policy.
4. Resolve source wallet and target wallet.
5. Perform guarded conditional source debit.
6. If debit fails, classify failure and stop with no partial rows.
7. Perform target wallet credit in the same DB transaction.
8. Capture actual post-update balances for both wallets.
9. Create `exchange_transactions` row.
10. Create source debit `wallet_transactions` row using actual source `balanceAfter`.
11. Create target credit `wallet_transactions` row using actual target `balanceAfter`.
12. Finalize `fx_execute_requests` to `succeeded` with `exchangeTransactionId` and exact `responsePayloadJson`.
13. Commit transaction.
14. Succeeded duplicate later replays stored `responsePayloadJson`.

`wallet_transactions.balanceAfter` must come from actual post-update wallet balances, not estimated pre-read arithmetic. If DB update cannot return that value directly, reread inside the same transaction or use safe raw SQL/locking.

## Accepted Rollback / Partial-Write Test Gate
A future `/fx execute` implementation task is not complete unless it includes these tests:

1. Source debit failure -> no target credit, no exchange row, no wallet transaction rows, command not succeeded.
2. Target credit failure after source debit attempt -> entire transaction rollback.
3. `exchange_transactions` create failure -> wallet balances rollback, no `wallet_transactions`, command not succeeded.
4. Source `wallet_transactions` create failure -> wallet balances rollback, no exchange committed, command not succeeded.
5. Target `wallet_transactions` create failure -> wallet balances rollback, no exchange committed, command not succeeded.
6. `fx_execute_requests` finalization failure -> wallet/exchange/ledger rollback or recovery-required behavior explicitly tested.
7. `responsePayloadJson` storage failure -> no committed success unless recovery path is explicitly proven.
8. Duplicate retry after simulated response loss -> no second wallet mutation, replay or recovery-required behavior.
9. Insufficient balance -> no exchange/ledger rows.
10. Concurrent wallet update conflict -> no partial exchange/ledger rows.
11. Wallet not found -> no exchange/ledger rows.
12. Stale/no FX rate -> no wallet mutation.
13. Idempotency conflict -> no wallet mutation.
14. No `equity_snapshots` created.
15. No fee wallet transaction row created.

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

## Applied Rate Implementation Gate
- `fx_rate_snapshots` exists as the authoritative rate snapshot structure.
- `/fx quote` uses the latest fresh USD/KRW snapshot and returns `FX_RATE_UNAVAILABLE` or `FX_RATE_STALE` when appropriate.
- Fake or temporary FX rates are forbidden.
- Adding idempotency and wallet safety schema does not make `/fx execute` implementable by itself.
- Execute-time source selection policy is accepted for near-term execute:
  - use explicit allowed sourceType gate, not implicit priority;
  - allowed sourceType is approved fresh `admin_manual` only;
  - `provider_api` is excluded until provider final selection, contract/API validation, ingestion implementation, and separate document review;
  - `official_batch` is excluded from real-time execute and remains settlement/reference/reconciliation candidate;
  - automatic fallback between source types is forbidden for MVP.
- Execute-time snapshot selection is accepted:
  - pair USD/KRW;
  - allowed sourceType only;
  - usable current schema rows only;
  - `effectiveAt <= executeNow`;
  - positive `rate`;
  - order by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- Selected snapshot id must be linked to `exchange_transactions.fxRateSnapshotId`, and selected `rate` becomes `appliedRate`.
- Execute-time freshness is accepted as quote-matching: `executeNow - selectedSnapshot.effectiveAt > 60_000ms` returns `FX_RATE_STALE`; exactly `60_000ms` is accepted.
- Snapshot selection and freshness checks must happen before wallet mutation.
- No eligible snapshot or stale snapshot must create no wallet mutation, exchange row, wallet ledger row, or command succeeded finalization.
- Actual `/fx execute` implementation is not performed here; future implementation must include the final test matrix in `docs/fx-execute-final-implementation-gate.md`.
