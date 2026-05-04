# FX Idempotency Lifecycle Policy

## Status
- Documentation only.
- `/fx execute` implementation remains STOP.
- Candidate lifecycle policy for `fx_execute_requests`.
- `requestHash` canonical rule is accepted, while pending/failed lifecycle and stale pending recovery remain STOP.
- No code/schema/migration changes.

## Purpose
- Prevent double debit caused by client retry.
- Prevent executing different payloads with the same `idempotencyKey`.
- Provide candidate handling for `pending`, `succeeded`, and `failed` states.
- Provide candidate response replay rules.
- Provide a basis for stuck pending recovery discussion.

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

## Candidate lifecycle table
| Existing row state | Incoming requestHash | Candidate behavior | Wallet mutation allowed? | Response candidate | Status |
| --- | --- | --- | --- | --- | --- |
| No existing row | N/A | Insert `pending`, continue execution. | Yes, after all pre-mutation validations pass | Execute response after success | candidate |
| `pending` | same hash | Return `IDEMPOTENCY_PENDING` candidate; do not start new wallet mutation. | No new mutation | Pending/in-progress response; exact status STOP | STOP |
| `pending` | different hash | Return `IDEMPOTENCY_CONFLICT`. | No | Conflict error | candidate |
| `succeeded` | same hash | Replay `responsePayloadJson`. | No new mutation | Original success response | candidate |
| `succeeded` | different hash | Return `IDEMPOTENCY_CONFLICT`. | No | Conflict error | candidate |
| `failed` | same hash | STOP: replay failure or allow safe retry policy unresolved. | No until policy accepted | `IDEMPOTENCY_FAILED` or original failure candidate | STOP |
| `failed` | different hash | Return `IDEMPOTENCY_CONFLICT`. | No | Conflict error | candidate |
| stale `pending` | same hash | STOP: recovery policy unresolved. | No until recovered safely | Recovery/pending response candidate | STOP |

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

STOP:
- Decide which failures are stored as `failed` commands.
- Decide failed-row replay/retry policy.
- Distinguish infrastructure failures from business validation failures.

## Stale pending recovery STOP
- Pending timeout threshold is not accepted.
- Recovery job/manual recovery path is not accepted.
- Need to review the case where commit succeeded but status update failed.
- Need to review whether `exchangeTransactionId` and reference rows can prove success during recovery.
- Recovery policy is required before implementation.

## Defect scenarios
- Same key and same hash duplicate performs a new wallet mutation.
- Same key and different hash replays an existing success response.
- Commit succeeded but `responsePayloadJson` is missing.
- Pending gets stuck and the user is permanently blocked with the same key.
- Failed row retries and double debits.
- `requestHash` includes timestamp, so the same request gets a different hash every time.
- Decimal formatting differences make the same `sourceAmount` conflict.
- Rate snapshot or wallet balance is included in the hash, causing safe retry to conflict after state changes.

## Required tests before implementation
Do not add these tests in this documentation task.

- Missing `idempotencyKey`.
- Same key same hash succeeded replay.
- Same key different hash conflict.
- Pending same hash behavior.
- Pending different hash conflict.
- Failed same hash behavior.
- Stale pending recovery behavior.
- `responsePayloadJson` exact replay.
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
