# FX Execute Error Policy

## Status
- Documentation only.
- `/fx execute` remains STOP.
- Candidate error/status/retryability policy.
- No implementation from this document.

## Purpose
- Provide a candidate basis for frontend/client retry decisions.
- Distinguish idempotency conflict, pending duplicate, and duplicate replay behavior.
- Distinguish stale rate, insufficient balance, and concurrency errors.
- Prevent unsafe retry in a financial write path.

## Current error envelope baseline
- Current `/fx quote` uses `{ success: false, error: { code, message } }`.
- `/fx execute` should use the same envelope as a candidate.
- Final HTTP status mapping must be accepted before implementation.

## Candidate error table
| Code | HTTP status candidate | Meaning | Retryable? | Wallet mutation allowed? | Notes |
| --- | --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | Missing or invalid authenticated user. | No | No | Must fail before command/wallet work. |
| `INVALID_CURRENCY_PAIR` | 400 | Unsupported pair or same currency. | No | No | MVP supports only KRW/USD directions. |
| `INVALID_AMOUNT` | 400 | Missing, non-string, non-finite, or non-positive amount. | No | No | Amount values stay strings at API boundary. |
| `IDEMPOTENCY_REQUIRED` | 400 | Missing or empty idempotency key. | No | No | Candidate required for execute. |
| `IDEMPOTENCY_CONFLICT` | 409 | Same key with different request hash. | No | No | Must never mutate wallets. |
| `IDEMPOTENCY_PENDING` | 409 or 202 STOP | Same key/hash already pending. | Conditional | No new mutation | Exact status remains STOP. |
| `IDEMPOTENCY_FAILED` | 409 or replay original failure STOP | Same key/hash has failed row. | STOP | No new mutation until policy accepted | Failed replay/retry policy unresolved. |
| `SEASON_NOT_FOUND` | 404 | Current season not found. | Conditional after season setup | No | Matches quote-style candidate. |
| `SEASON_NOT_ACTIVE` | 409 | Current season is upcoming/ended/settled. | No | No | Ended/settled must block execute. |
| `SEASON_NOT_JOINED` | 403 | User has not joined active season. | No | No | Non-participation is blocked/guide, not empty. |
| `SOURCE_WALLET_NOT_FOUND` | 404 or 409 candidate | Source wallet missing. | No | No | Status needs final API decision. |
| `TARGET_WALLET_NOT_FOUND` | 404 or 409 candidate | Target wallet missing. | No | No | Status needs final API decision. |
| `INSUFFICIENT_BALANCE` | 409 | Source wallet cannot cover debit. | No | No | Must create no exchange/ledger rows. |
| `FX_RATE_UNAVAILABLE` | 503 | No eligible USD/KRW snapshot. | Conditional | No | May succeed after approved fresh rate input. |
| `FX_RATE_STALE` | 503 | Selected snapshot is stale. | Conditional | No | Candidate execute boundary mirrors quote. |
| `CONCURRENT_WALLET_UPDATE` | 409 or 503 candidate | Conditional debit affected zero rows while balance appeared sufficient. | Conditional | No partial rows | Retryability/status remain STOP. |
| `EXECUTE_TRANSACTION_FAILED` | 500 | DB transaction failed before safe completion. | Conditional only through idempotency proof | Rollback only | Must not leave partial writes. |
| `INTERNAL_ERROR` | 500 | Unexpected server error. | Conditional only through idempotency proof | Rollback or replay only | If commit succeeded but response failed, replay success. |

## Retryability candidate
Non-retryable candidates:
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `INSUFFICIENT_BALANCE`

Conditionally retryable candidates:
- `IDEMPOTENCY_PENDING`
- `CONCURRENT_WALLET_UPDATE`
- `FX_RATE_STALE`
- `FX_RATE_UNAVAILABLE`

Retryable candidate:
- Transient DB/network/internal infrastructure failure only if no wallet mutation committed or idempotency replay can prove a safe original outcome.

STOP:
- Exact retryability must be accepted before implementation.
- Client retry guidance must be documented together with idempotency lifecycle.

## Wallet mutation rule by error
- Validation and idempotency conflict errors must happen before wallet mutation.
- No FX snapshot and stale FX snapshot errors must happen before wallet mutation.
- Insufficient balance must not create `exchange_transactions` or `wallet_transactions`.
- Concurrency failure must not create partial exchange/ledger rows.
- Internal failure after partial write must roll back the transaction.
- If commit succeeded but response failed, idempotency replay must return the original success response.

## Defect scenarios
- `IDEMPOTENCY_CONFLICT` occurs but wallet mutation still happens.
- Stale rate is detected but execute succeeds.
- Insufficient balance still creates an `exchange_transactions` row.
- Concurrency error is marked retryable and the same request executes twice.
- Internal error after commit is stored as failure, then retry double debits.
- Frontend repeatedly retries a non-retryable business error.

## Required tests before implementation
Do not add these tests in this documentation task.

- Each error returns expected envelope.
- No wallet mutation on validation errors.
- No wallet mutation on stale/no rate.
- No wallet mutation on idempotency conflict.
- Insufficient balance creates no exchange/ledger.
- Concurrency zero affected row classification.
- Duplicate succeeded replay is safe.
- Internal rollback keeps no partial writes.

## Explicit non-goals
- No controller/service implementation.
- No test implementation.
- No schema change.
- No package/env/provider changes.
