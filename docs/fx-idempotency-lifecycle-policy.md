# FX Idempotency Lifecycle Policy

## Status
- Documentation only.
- `/fx execute` implementation remains STOP.
- `requestHash` canonical rule is accepted.
- Pending/succeeded/failed MVP lifecycle policy is accepted.
- Stale pending automatic re-execution is not allowed.
- No code/schema/migration changes.

## Purpose
- Prevent double debit caused by client retry.
- Prevent executing different payloads with the same `idempotencyKey`.
- Provide accepted MVP handling for `pending`, `succeeded`, and `failed` states.
- Provide accepted response replay rules.
- Provide a safe baseline for stale pending recovery without implementing recovery yet.

## Current schema baseline
- `id`
- `userId`
- `seasonParticipantId`
- `idempotencyKey`
- `requestHash`
- `fromCurrency`
- `toCurrency`
- `sourceAmount`
- `status`
- `exchangeTransactionId`
- `responsePayloadJson`
- `errorCode`
- `errorMessage`
- `requestedAt`
- `completedAt`
- `createdAt`
- `updatedAt`
- `unique(userId, idempotencyKey)`
- status enum: `pending`, `succeeded`, `failed`

## Accepted requestHash canonical rule
- Purpose:
  - The same economic request must always produce the same `requestHash`.
  - A different economic request sent with the same `idempotencyKey` must conflict.
  - Client formatting, whitespace, and decimal representation differences must not change the hash.
  - Execution-time values such as rate snapshot, current timestamp, and wallet balance must not be included.
- Hash algorithm: SHA-256.
- Canonical JSON rules:
  - JSON object key order is fixed.
  - Undefined, null, and optional display fields are excluded.
  - Whitespace does not affect the hash.
  - All string fields are converted to canonical form before JSON serialization.
  - The canonical JSON UTF-8 string is the SHA-256 input.
- Accepted fields and order:

```json
{
  "apiVersion": "fx-execute:v1",
  "userId": "<authenticated user id>",
  "seasonParticipantId": "<active season participant id>",
  "fromCurrency": "<UPPERCASE currency code>",
  "toCurrency": "<UPPERCASE currency code>",
  "sourceAmount": "<scale 8 decimal string>"
}
```

- Field normalization:
  - `apiVersion` is exactly `fx-execute:v1`.
  - `userId` is the authenticated user id string.
  - `seasonParticipantId` is the active joined season participant id string.
  - `fromCurrency` and `toCurrency` are uppercase currency codes.
  - `sourceAmount` is parsed as Decimal and canonicalized to a scale 8 decimal string using the accepted half-up rounding/scale policy.
- Excluded fields:
  - `idempotencyKey`
  - `quoteId`
  - rate snapshot id
  - applied rate
  - current timestamp
  - wallet balance
  - client display formatting
  - whitespace
  - request arrival time

## Accepted lifecycle principles
- `idempotencyKey` is required for `/fx execute`.
- `idempotencyKey` is the lookup key, not part of `requestHash`.
- `requestHash` identifies the normalized economic payload.
- Same key + different `requestHash` always returns `IDEMPOTENCY_CONFLICT`.
- Duplicate requests must never create a second wallet mutation.
- Succeeded duplicate must replay the original success response.
- Failed duplicate must not automatically re-execute.
- Pending duplicate must not start another wallet mutation.
- Stale pending must not automatically re-execute in MVP.
- Manual/server recovery is required for stale pending before any safe retry behavior is allowed.

## Accepted lifecycle table
| Existing row state | Incoming requestHash | Accepted behavior | Wallet mutation allowed? | Response |
| --- | --- | --- | --- | --- |
| No existing row | N/A | Insert `pending` and continue only after pre-mutation validations pass. | Yes, later in transaction | Execute response after success |
| `pending`, fresh | same hash | Do not execute again. | No | `IDEMPOTENCY_PENDING` |
| `pending`, fresh | different hash | Conflict. | No | `IDEMPOTENCY_CONFLICT` |
| `pending`, stale | same hash | Do not execute automatically; require recovery. | No | `IDEMPOTENCY_PENDING_STALE` |
| `pending`, stale | different hash | Conflict. | No | `IDEMPOTENCY_CONFLICT` |
| `succeeded` | same hash | Replay stored `responsePayloadJson`. | No | Original success response |
| `succeeded` | different hash | Conflict. | No | `IDEMPOTENCY_CONFLICT` |
| `failed` | same hash | Do not execute automatically. | No | `IDEMPOTENCY_FAILED` or stored original failure payload |
| `failed` | different hash | Conflict. | No | `IDEMPOTENCY_CONFLICT` |

## Fresh vs stale pending
- Fresh pending threshold is accepted as 2 minutes from `requestedAt`.
- Stale pending is `requestedAt` older than 2 minutes while `status` is still `pending`.
- This threshold is an MVP safety threshold, not a scheduler implementation.
- Stale pending recovery procedure is not implemented in this task.
- Stale pending automatic re-execution is explicitly forbidden.

## Failed command policy
- A failed command is terminal for the same `idempotencyKey`.
- Same key + same hash + failed returns `IDEMPOTENCY_FAILED` or the stored original failure payload.
- It must not mutate wallets.
- To prevent double debit, failed same-key retry must not re-run execute automatically.
- If a failure occurred after commit but before response, the command must be recovered to `succeeded`, not marked `failed`.
- Unknown commit outcome must not be marked as safely failed without recovery evidence.

## Response replay policy
- On success, store the exact `responsePayloadJson`.
- Same key + same hash + succeeded returns stored `responsePayloadJson`.
- Replay must not recompute rate, fee, wallet balance, or target amount.
- If `responsePayloadJson` is missing but `exchangeTransactionId` exists, fallback rebuild is not accepted yet; mark it as recovery-required STOP.
- Do not silently rebuild from newer state.

## Candidate success flow
1. Validate request.
2. Normalize request.
3. Compute `requestHash`.
4. Create pending `fx_execute_requests`.
5. Execute wallet/exchange/ledger writes in one transaction.
6. Store `exchangeTransactionId`.
7. Store exact `responsePayloadJson`.
8. Set status `succeeded`.
9. Set `completedAt`.
10. Duplicate retry returns stored `responsePayloadJson`.

STOP:
- The actual transaction boundary must be accepted before implementation.
- Specifically, how command row creation and wallet mutation transaction are grouped remains a STOP decision.

## Candidate failure flow
Failure classes to distinguish:
- Pre-mutation validation failure.
- Pre-mutation idempotency conflict.
- Pre-mutation stale/no rate.
- Wallet safety failure.
- Transaction failure before commit.
- Unknown failure after commit/response loss.

Accepted MVP safety baseline:
- Failed same-key duplicates do not automatically execute again.
- Stale pending same-key duplicates do not automatically execute again.
- Commit outcome must be proven before marking unknown failures as `failed`.

STOP:
- Decide exactly which failures are stored as `failed` commands.
- Define recovery operation for stale pending and unknown commit outcomes.
- Distinguish infrastructure failures from business validation failures in implementation tests.

## Stale pending recovery STOP
- Stale pending automatic re-execution is forbidden.
- Fresh-to-stale threshold is accepted as 2 minutes from `requestedAt`.
- Recovery job/manual recovery path is not implemented.
- Need to review the case where commit succeeded but status update failed.
- Need to review whether `exchangeTransactionId` and reference rows can prove success during recovery.
- Recovery operation itself is a future task before any safe same-key retry behavior can be added.

## Defect scenarios
- Same key and same hash duplicate performs a new wallet mutation.
- Same key and different hash replays an existing success response.
- Commit succeeded but `responsePayloadJson` is missing.
- Pending gets stuck and the user is permanently blocked with the same key.
- Stale pending automatically re-executes and double debits.
- Failed row retries and double debits.
- Failed after commit is incorrectly recorded as failed without recovery evidence.
- `requestHash` includes timestamp, so the same request gets a different hash every time.
- Decimal formatting differences make the same `sourceAmount` conflict.
- Rate snapshot or wallet balance is included in the hash, causing safe retry to conflict after state changes.

## Required tests before implementation
Do not add these tests in this documentation task.

- Missing `idempotencyKey`.
- Same key same hash succeeded replay.
- Same key different hash conflict.
- Fresh pending same hash -> `IDEMPOTENCY_PENDING`.
- Pending different hash conflict.
- Stale pending same hash -> `IDEMPOTENCY_PENDING_STALE`.
- Failed same hash -> `IDEMPOTENCY_FAILED`, no wallet mutation.
- Succeeded same hash -> exact `responsePayloadJson` replay.
- Missing `responsePayloadJson` with `exchangeTransactionId` -> recovery-required behavior.
- Failed after commit must not be recorded as failed without recovery evidence.
- No second wallet mutation on retry.
- `requestHash` canonical decimal equivalence.
- `requestHash` canonical currency casing.
- `requestHash` excludes timestamp, rate snapshot, and wallet balance.
- `requestHash` field order is stable.
- Conflict creates no wallet mutation.

## Explicit non-goals
- No implementation.
- No schema/migration changes.
- No package changes.
- No provider changes.
