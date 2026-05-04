# FX Execute STOP Decision Tracker

## Status
- Documentation only.
- `/fx execute` implementation remains STOP.
- This tracker consolidates unresolved decisions before implementation.
- Do not implement code/schema/migration/seed/package/provider changes from this document.

## Purpose
- Gather remaining `/fx execute` STOP decisions in one place before implementation.
- Provide a decision gate to prevent duplicate execution, wallet overspend, ledger mismatch, stale rate use, rounding drift, and command lifecycle drift.
- Separate candidate defaults from decisions that are still blocked.

## Current accepted baseline
- `/fx quote` read-only implementation is complete.
- `/fx quote` uses USD/KRW `fx_rate_snapshots`.
- Quote stale rule: if `now - effectiveAt > 60_000ms`, return `FX_RATE_STALE`.
- The exactly 60 seconds boundary is accepted by quote.
- `fx_execute_requests` owns idempotency.
- `exchange_transactions.idempotencyKey` does not exist.
- `fx_execute_requests` has `unique(userId, idempotencyKey)`.
- Successful execute creates one `exchange_transactions` row.
- Successful execute creates one source debit `wallet_transactions` row.
- Successful execute creates one target credit `wallet_transactions` row.
- MVP creates no separate fee wallet transaction row.
- Target wallet credit equals `netTargetAmount`.
- Near-term execute does not create `equity_snapshots`.
- All wallet, exchange, ledger, and command finalization writes must be atomic.
- Provider final selection is not confirmed.
- `sourceType` priority is not confirmed.

## STOP decision table
| ID | Area | Decision | Current candidate/default | Risk if wrong | Needed before implementation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FXE-001 | idempotencyKey required | Decide whether execute requires a non-empty `idempotencyKey` and the missing-key error. | Non-empty `idempotencyKey` required; missing -> `IDEMPOTENCY_REQUIRED`. | Retry after timeout can double debit. | Request validation and error code/status acceptance. | candidate |
| FXE-002 | requestHash normalization | Define canonical request hash fields, normalization, and hash algorithm. | Canonical request hash rule required. | Same request may conflict, or different payload may replay. | Accepted canonical JSON/decimal/currency normalization rule. | STOP |
| FXE-003 | same key + same hash + pending behavior | Decide fresh pending duplicate behavior. | Pending policy unresolved. | Duplicate can execute twice or block forever. | In-progress response, wait/retry, or recovery behavior accepted. | STOP |
| FXE-004 | same key + same hash + succeeded replay | Decide replay source for succeeded duplicate. | Replay stored `responsePayloadJson`. | Replay can drift from original rate, rounding, or balances. | Stored response shape and replay behavior accepted. | candidate |
| FXE-005 | same key + same hash + failed behavior | Decide failed duplicate replay/retry behavior. | Failed replay/retry policy unresolved. | Failed commands can block safe retry or re-execute unexpectedly. | Terminal vs retryable failure lifecycle accepted. | STOP |
| FXE-006 | same key + different hash conflict | Decide conflict behavior and mutation prohibition. | Return `IDEMPOTENCY_CONFLICT`; no wallet mutation. | Same key can execute a different payload. | Conflict error code/status accepted. | candidate |
| FXE-007 | stale pending recovery | Define stale pending timeout and recovery path. | Stale pending recovery policy required. | Stuck commands can permanently block retries or invite unsafe re-run. | Timeout, manual/recovery job, and transition rules accepted. | STOP |
| FXE-008 | responsePayloadJson storage/replay | Decide exactly what is stored and reused. | Store exact success response after successful transaction. | Duplicate response can disagree with committed rows. | Serialization and transaction timing accepted. | candidate |
| FXE-009 | wallet safety strategy | Choose conditional update vs row-level lock. | Conditional update candidate, but Prisma/raw SQL feasibility must be verified. | Concurrent requests can overspend source wallet. | Feasibility proof and chosen DB transaction pattern. | STOP |
| FXE-010 | affected row count 0 classification | Decide `INSUFFICIENT_BALANCE` vs `CONCURRENT_WALLET_UPDATE`. | Reread wallet; insufficient -> `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`. | Incorrect retry behavior and confusing user errors. | Classification rule and tests accepted. | candidate |
| FXE-011 | source/target wallet update order | Decide deterministic update/lock order. | Guarded source debit before target credit inside transaction; lock order deterministic if locking. | Deadlocks or incorrect balances. | Update/lock order accepted. | candidate |
| FXE-012 | wallet_transactions.balanceAfter source of truth | Decide how `balanceAfter` is computed. | Use actual post-update wallet balances inside transaction. | Ledger and wallet balances can diverge. | Returned/reread post-update balance strategy accepted. | candidate |
| FXE-013 | Decimal rounding/scale | Decide calculation precision, rounding mode, storage scale, and response scale. | Rounding/scale rule must be fixed before implementation. | Quote, execute, ledger, records, and wallet values can drift. | Accepted Decimal policy and boundary tests. | STOP |
| FXE-014 | execute-time FX snapshot selection | Decide snapshot selection for direct execute. | Direct execute selects latest eligible snapshot at execute time until durable quote exists. | Execute can use unexpected or unavailable rate. | Selection query and audit linkage accepted. | candidate |
| FXE-015 | execute-time 60-second freshness boundary | Decide execute stale threshold and boundary. | Same as quote: `> 60_000ms` stale, exactly 60s accepted. | Quote and execute can disagree on stale rate behavior. | Boundary rule accepted with tests. | candidate |
| FXE-016 | sourceType priority | Decide priority among `provider_api`, `official_batch`, and `admin_manual`. | SourceType priority unresolved. | Execute can select wrong operational source. | Accepted source priority or explicit single-source gate. | STOP |
| FXE-017 | provider_api/official_batch/admin_manual coexistence | Decide coexistence and fallback behavior. | Coexistence/fallback unresolved. | Manual or official rows can override provider rows unintentionally. | Coexistence policy accepted. | STOP |
| FXE-018 | equity_snapshots creation on execute | Decide near-term snapshot write behavior. | No `equity_snapshots` in near-term execute. | Cash-only snapshot can be mistaken for authoritative valuation. | Keep no-snapshot test in implementation task. | accepted |
| FXE-019 | fee wallet transaction row | Decide MVP fee ledger row behavior. | No separate fee wallet transaction row for MVP. | Ledger can double-count or conflict with net target credit. | Keep no-fee-row test in implementation task. | accepted |
| FXE-020 | error code/status mapping | Confirm exact HTTP statuses and error codes. | Exact HTTP/code mapping required. | Clients cannot distinguish retryable, conflict, stale, and validation errors. | Error table accepted. | STOP |
| FXE-021 | retryable vs non-retryable errors | Classify retryability. | Retryability classification required. | Clients can retry unsafe failures or miss safe retries. | Retry guidance accepted. | STOP |
| FXE-022 | rollback/partial write testing | Decide required rollback test coverage. | Rollback/partial-write tests required. | Partial financial writes can commit silently. | Unit/e2e failure injection tests accepted. | STOP |
| FXE-023 | records exchange mapping after execute | Confirm future records mapping from exchange row. | `exchange_transactions` fields map to records exchange response later. | Records can expose inconsistent `exchangeId`, `feeCurrency`, or `rate`. | Mapping assertion included in execute/records task. | candidate |
| FXE-024 | local smoke using approved fresh admin_manual snapshot | Decide local smoke data source without provider. | Local smoke can use approved fresh `admin_manual` snapshot, not fake/static/temp/sample/test. | Smoke may rely on forbidden fake data or provider work. | Approved CLI procedure available. | candidate |

## Safe defaults that can be carried into an implementation prompt later
These are candidate defaults only. This is not implementation permission. Do not implement until STOP items are resolved or explicitly approved as safe defaults.

- Require non-empty `idempotencyKey`.
- Return conflict on same key + different `requestHash`.
- Replay stored `responsePayloadJson` for succeeded duplicate.
- Do not create a fee wallet transaction row.
- Do not create `equity_snapshots` on execute.
- Target wallet credit uses `netTargetAmount`.
- Execute freshness should mirror quote boundary unless explicitly changed.
- Local smoke may use an approved fresh `admin_manual` snapshot.

## Decisions that must not be silently changed
- Do not add `exchange_transactions.idempotencyKey` unless an explicit schema review approves it.
- Do not create `equity_snapshots` in near-term execute.
- Do not add a fee wallet transaction row in MVP.
- Do not implement `provider_api` or scheduler before provider final selection is confirmed.
- Do not add fake/static/temporary/sample/test business FX rates.
- Do not bypass `/home` blockers.
- Do not decide `sourceType` priority implicitly in code.

## Implementation readiness checklist
- STOP tracker reviewed.
- `requestHash` normalization accepted.
- Pending/succeeded/failed lifecycle accepted.
- Wallet safety strategy accepted.
- Rounding/scale accepted.
- Execute-time snapshot/freshness/sourceType accepted.
- Rollback tests included.
- Idempotency tests included.
- No equity snapshot and no fee row tests included.
- Local smoke with approved fresh `admin_manual` snapshot available.

## Explicit non-goals
- No implementation.
- No schema/migration/seed changes.
- No package changes.
- No env changes.
- No provider ingestion.
- No fake data.
- No `/home` implementation.
