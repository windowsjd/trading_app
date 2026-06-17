> Historical document.
> This file is not the current source of truth.
> See `docs/current-status.md`, `docs/backend-gate-roadmap.md`, and the relevant API contract or provider policy document.

# FX Execute Error Policy

## Status
- Documentation only.
- `/fx execute` remains STOP.
- Error code/status/retryability policy is accepted for future implementation prompts.
- This document is not permission to implement `/fx execute`.
- No code/schema/migration/package changes.

## Purpose
- Provide accepted frontend/client retry decision rules.
- Distinguish idempotency conflict, pending duplicate, stale pending, failed duplicate, and duplicate replay behavior.
- Distinguish stale rate, insufficient balance, wallet integrity, concurrency, and infrastructure errors.
- Prevent unsafe retry in a financial write path.

## Accepted error envelope
`/fx execute` errors must use the same envelope shape as `/fx quote`:

```json
{
  "success": false,
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<human readable message>"
  }
}
```

This document only accepts the error envelope. The `/fx execute` success response remains outside this policy.

## Accepted error table
| Code | HTTP status | Retryable? | Wallet mutation allowed? | Meaning |
| --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | No | No | 인증 사용자 없음 또는 잘못된 인증 |
| `INVALID_CURRENCY_PAIR` | 400 | No | No | KRW/USD MVP pair가 아니거나 같은 currency |
| `INVALID_AMOUNT` | 400 | No | No | `sourceAmount` 누락, string 아님, invalid decimal, non-positive |
| `IDEMPOTENCY_REQUIRED` | 400 | No | No | `idempotencyKey` 누락 또는 빈 문자열 |
| `IDEMPOTENCY_CONFLICT` | 409 | No | No | same key + different `requestHash` |
| `IDEMPOTENCY_PENDING` | 409 | Conditional client retry after short delay | No new mutation | same key + same hash + fresh pending |
| `IDEMPOTENCY_PENDING_STALE` | 409 | No automatic client retry | No new mutation | same key + same hash + stale pending, manual/server recovery required |
| `IDEMPOTENCY_FAILED` | 409 | No automatic retry with same key | No new mutation | same key + same hash + terminal failed command |
| `SEASON_NOT_FOUND` | 404 | Conditional after season setup | No | current season 없음 |
| `SEASON_NOT_ACTIVE` | 409 | No | No | upcoming/ended/settled season |
| `SEASON_NOT_JOINED` | 403 | No | No | active season에 참가하지 않음 |
| `SOURCE_WALLET_NOT_FOUND` | 409 | No | No | joined participant의 source wallet 없음; data integrity issue |
| `TARGET_WALLET_NOT_FOUND` | 409 | No | No | joined participant의 target wallet 없음; data integrity issue |
| `INSUFFICIENT_BALANCE` | 409 | No | No | source wallet balance 부족 |
| `FX_RATE_UNAVAILABLE` | 503 | Conditional after approved fresh rate input | No | eligible USD/KRW snapshot 없음 |
| `FX_RATE_STALE` | 503 | Conditional after approved fresh rate input | No | selected snapshot stale |
| `CONCURRENT_WALLET_UPDATE` | 409 | Conditional with same idempotency key only if lifecycle policy permits; otherwise surface failure | No partial rows | conditional debit conflict or safe concurrency rejection |
| `EXECUTE_TRANSACTION_FAILED` | 500 | Conditional only through idempotency proof | Rollback only | transaction failed before safe completion |
| `INTERNAL_ERROR` | 500 | Conditional only through idempotency proof | Rollback or replay only | unexpected server error |

`CONCURRENT_WALLET_UPDATE` is tied to the future wallet safety strategy. This policy does not accept conditional update, row-level lock, raw SQL, or any wallet safety implementation.

Automatic retry with the same `idempotencyKey` must be judged together with `docs/fx-idempotency-lifecycle-policy.md`.

## Accepted retryability policy
Non-retryable:
- `UNAUTHORIZED`
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `IDEMPOTENCY_PENDING_STALE`
- `IDEMPOTENCY_FAILED`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `SOURCE_WALLET_NOT_FOUND`
- `TARGET_WALLET_NOT_FOUND`
- `INSUFFICIENT_BALANCE`

Conditionally retryable:
- `IDEMPOTENCY_PENDING`
  - Retry only with the same `idempotencyKey` and same payload.
  - A short delay retry is allowed.
  - No new wallet mutation is allowed while the command remains pending.
- `FX_RATE_UNAVAILABLE`
  - A new request may succeed after approved fresh rate input.
- `FX_RATE_STALE`
  - A new request may succeed after approved fresh rate input.
- `CONCURRENT_WALLET_UPDATE`
  - Retry only when the wallet safety and lifecycle policies prove the retry path is safe.
- `EXECUTE_TRANSACTION_FAILED` / `INTERNAL_ERROR`
  - Retry only when idempotency replay can prove the original outcome safely.

STOP:
- Wallet safety strategy remains STOP.
- Rollback and partial-write test gate remains STOP.

## Wallet mutation rule by error
- Validation errors must occur before wallet mutation.
- Idempotency conflict must occur before wallet mutation.
- No rate/stale rate must occur before wallet mutation.
- Insufficient balance must create no `exchange_transactions` or `wallet_transactions`.
- Wallet not found must create no `exchange_transactions` or `wallet_transactions`.
- Concurrency failure must create no partial exchange/ledger rows.
- Internal failure after partial write must roll back the transaction.
- If commit succeeded but response failed, idempotency replay must return the original success response, not a failure.

## Defect scenarios
- `IDEMPOTENCY_CONFLICT` occurs but wallet mutation still happens.
- `IDEMPOTENCY_PENDING_STALE` triggers automatic execute retry and double debits.
- Stale rate is detected but execute succeeds.
- Insufficient balance still creates an `exchange_transactions` row.
- Source or target wallet is missing but ledger rows are created.
- Concurrency error is marked broadly retryable and the same request executes twice.
- Internal error after commit is stored as failure, then retry double debits.
- Frontend repeatedly retries a non-retryable business error.

## Required tests before implementation
Do not add these tests in this documentation task.

- Each error returns the accepted envelope and HTTP status.
- No wallet mutation on validation errors.
- No wallet mutation on stale/no rate.
- No wallet mutation on idempotency conflict.
- No wallet mutation on wallet-not-found errors.
- `IDEMPOTENCY_PENDING` uses 409 and performs no new mutation.
- `IDEMPOTENCY_PENDING_STALE` uses 409 and performs no automatic retry.
- `IDEMPOTENCY_FAILED` uses 409 and performs no wallet mutation.
- Insufficient balance creates no exchange/ledger.
- Concurrency zero affected row classification.
- Duplicate succeeded replay is safe.
- Internal rollback keeps no partial writes.

## Explicit non-goals
- No controller/service implementation.
- No test implementation.
- No schema change.
- No package/env/provider changes.
