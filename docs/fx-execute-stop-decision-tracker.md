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
- Decimal rounding mode and scale/formatting policy are accepted in `docs/fx-decimal-rounding-scale-policy.md`.
- `requestHash` canonical rule is accepted in `docs/fx-idempotency-lifecycle-policy.md`.
- All wallet, exchange, ledger, and command finalization writes must be atomic.
- Provider final selection is not confirmed.
- `sourceType` priority is not confirmed.

## Reference policy documents
- Decimal rounding/scale accepted policy: `docs/fx-decimal-rounding-scale-policy.md`.
- Execute error/status/retryability accepted policy: `docs/fx-execute-error-policy.md`.
- Idempotency lifecycle policy with accepted requestHash and MVP lifecycle rules: `docs/fx-idempotency-lifecycle-policy.md`.
- Readiness audit and test gates: `docs/fx-execute-preimplementation-readiness-audit.md`.

## STOP decision table
| ID | Area | Decision | Current candidate/default | Risk if wrong | Needed before implementation | Status |
| --- | --- | --- | --- | --- | --- | --- |
| FXE-001 | idempotencyKey required | Decide whether execute requires a non-empty `idempotencyKey` and the missing-key error. | Accepted: non-empty `idempotencyKey` required; missing -> `IDEMPOTENCY_REQUIRED`. | Retry after timeout can double debit. | Include required-key validation tests. | accepted |
| FXE-002 | requestHash normalization | Define canonical request hash fields, normalization, and hash algorithm. | Accepted canonical JSON with SHA-256, fixed fields, uppercase currencies, and scale 8 `sourceAmount`. | Same request may conflict, or different payload may replay. | Implementation tests for canonical equivalence; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-003 | same key + same hash + pending behavior | Decide fresh pending duplicate behavior. | Accepted: fresh pending -> `IDEMPOTENCY_PENDING`; no new wallet mutation. | Duplicate can execute twice or block forever. | Include fresh pending duplicate tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-004 | same key + same hash + succeeded replay | Decide replay source for succeeded duplicate. | Accepted: replay stored `responsePayloadJson`; no new wallet mutation. | Replay can drift from original rate, rounding, or balances. | Include exact replay tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-005 | same key + same hash + failed behavior | Decide failed duplicate replay/retry behavior. | Accepted: no automatic re-execute; return `IDEMPOTENCY_FAILED` or stored failure payload. | Failed commands can block safe retry or re-execute unexpectedly. | Include failed duplicate no-mutation tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-006 | same key + different hash conflict | Decide conflict behavior and mutation prohibition. | Accepted: return `IDEMPOTENCY_CONFLICT`; no wallet mutation. | Same key can execute a different payload. | Include conflict no-mutation tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-007 | stale pending recovery | Define stale pending timeout and recovery path. | Accepted MVP safety: automatic re-execution forbidden; return `IDEMPOTENCY_PENDING_STALE` and require manual/server recovery. Recovery tool/job is future work. | Stuck commands can permanently block retries or invite unsafe re-run. | Include stale pending recovery-required tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-008 | responsePayloadJson storage/replay | Decide exactly what is stored and reused. | Accepted: store and replay exact success `responsePayloadJson`; no silent recomputation. | Duplicate response can disagree with committed rows. | Include missing-payload recovery-required tests; see `docs/fx-idempotency-lifecycle-policy.md`. | accepted |
| FXE-009 | wallet safety strategy | Choose conditional update vs row-level lock. | Conditional update candidate, but Prisma/raw SQL feasibility must be verified. | Concurrent requests can overspend source wallet. | Feasibility proof and chosen DB transaction pattern. | STOP |
| FXE-010 | affected row count 0 classification | Decide `INSUFFICIENT_BALANCE` vs `CONCURRENT_WALLET_UPDATE`. | Reread wallet; insufficient -> `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`. | Incorrect retry behavior and confusing user errors. | Classification rule and tests accepted. | candidate |
| FXE-011 | source/target wallet update order | Decide deterministic update/lock order. | Guarded source debit before target credit inside transaction; lock order deterministic if locking. | Deadlocks or incorrect balances. | Update/lock order accepted. | candidate |
| FXE-012 | wallet_transactions.balanceAfter source of truth | Decide how `balanceAfter` is computed. | Use actual post-update wallet balances inside transaction. | Ledger and wallet balances can diverge. | Returned/reread post-update balance strategy accepted. | candidate |
| FXE-013 | Decimal rounding/scale | Decide calculation precision, rounding mode, storage scale, and response scale. | Accepted half-up rounding with scale 8 monetary/rate strings and scale 6 `feeRate` strings. | Quote, execute, ledger, records, and wallet values can drift. | Implementation tests for half-up boundaries and stored/response equality; see `docs/fx-decimal-rounding-scale-policy.md`. | accepted |
| FXE-014 | execute-time FX snapshot selection | Decide snapshot selection for direct execute. | Direct execute selects latest eligible snapshot at execute time until durable quote exists. | Execute can use unexpected or unavailable rate. | Selection query and audit linkage accepted. | candidate |
| FXE-015 | execute-time 60-second freshness boundary | Decide execute stale threshold and boundary. | Same as quote: `> 60_000ms` stale, exactly 60s accepted. | Quote and execute can disagree on stale rate behavior. | Boundary rule accepted with tests. | candidate |
| FXE-016 | sourceType priority | Decide priority among `provider_api`, `official_batch`, and `admin_manual`. | SourceType priority unresolved. | Execute can select wrong operational source. | Accepted source priority or explicit single-source gate. | STOP |
| FXE-017 | provider_api/official_batch/admin_manual coexistence | Decide coexistence and fallback behavior. | Coexistence/fallback unresolved. | Manual or official rows can override provider rows unintentionally. | Coexistence policy accepted. | STOP |
| FXE-018 | equity_snapshots creation on execute | Decide near-term snapshot write behavior. | No `equity_snapshots` in near-term execute. | Cash-only snapshot can be mistaken for authoritative valuation. | Keep no-snapshot test in implementation task. | accepted |
| FXE-019 | fee wallet transaction row | Decide MVP fee ledger row behavior. | No separate fee wallet transaction row for MVP. | Ledger can double-count or conflict with net target credit. | Keep no-fee-row test in implementation task. | accepted |
| FXE-020 | error code/status mapping | Confirm exact HTTP statuses and error codes. | Accepted error table in `docs/fx-execute-error-policy.md`. | Clients cannot distinguish retryable, conflict, stale, and validation errors. | Include accepted status/code tests. | accepted |
| FXE-021 | retryable vs non-retryable errors | Classify retryability. | Accepted retryability policy in `docs/fx-execute-error-policy.md`. | Clients can retry unsafe failures or miss safe retries. | Include retryability/no-mutation tests. | accepted |
| FXE-022 | rollback/partial write testing | Decide required rollback test coverage. | Rollback/partial-write tests required. | Partial financial writes can commit silently. | Include readiness audit and error policy rollback tests. | STOP |
| FXE-023 | records exchange mapping after execute | Confirm future records mapping from exchange row. | `exchange_transactions` fields map to records exchange response later. | Records can expose inconsistent `exchangeId`, `feeCurrency`, or `rate`. | Mapping assertion included in execute/records task. | candidate |
| FXE-024 | local smoke using approved fresh admin_manual snapshot | Decide local smoke data source without provider. | Local smoke can use approved fresh `admin_manual` snapshot, not fake/static/temp/sample/test. | Smoke may rely on forbidden fake data or provider work. | Approved CLI procedure available. | candidate |

## Accepted decisions and safe defaults that can be carried into an implementation prompt later
These are not implementation permission. Do not implement until remaining STOP items are resolved or explicitly approved as safe defaults.

Reference documents:
- `docs/fx-decimal-rounding-scale-policy.md`
- `docs/fx-execute-error-policy.md`
- `docs/fx-idempotency-lifecycle-policy.md`

- Use half-up rounding.
- Use accepted scale/formatting rules from `docs/fx-decimal-rounding-scale-policy.md`.
- Use accepted `requestHash` canonical JSON and SHA-256 rule.
- Require non-empty `idempotencyKey`.
- Return conflict on same key + different `requestHash`.
- Replay stored `responsePayloadJson` for succeeded duplicate.
- Return `IDEMPOTENCY_PENDING` for fresh pending same-key/same-hash duplicate.
- Return `IDEMPOTENCY_PENDING_STALE` for stale pending same-key/same-hash duplicate; do not re-execute automatically.
- Return `IDEMPOTENCY_FAILED` or stored original failure payload for failed same-key/same-hash duplicate; do not re-execute automatically.
- Use accepted error code/status/retryability table from `docs/fx-execute-error-policy.md`.
- Do not create a fee wallet transaction row.
- Do not create `equity_snapshots` on execute.
- Target wallet credit uses `netTargetAmount`.
- Execute freshness should mirror quote boundary unless explicitly changed.
- Local smoke may use an approved fresh `admin_manual` snapshot.

## Decisions that must not be silently changed
- Do not add `exchange_transactions.idempotencyKey` unless an explicit schema review approves it.
- Do not create `equity_snapshots` in near-term execute.
- Do not add a fee wallet transaction row in MVP.
- Do not change accepted half-up rounding/scale policy without explicit document review.
- Do not change accepted `requestHash` canonical fields without explicit document review.
- Do not implement `provider_api` or scheduler before provider final selection is confirmed.
- Do not add fake/static/temporary/sample/test business FX rates.
- Do not bypass `/home` blockers.
- Do not decide `sourceType` priority implicitly in code.

## Implementation readiness checklist
- STOP tracker reviewed.
- Decimal rounding/scale policy reviewed.
- Execute error policy reviewed.
- Idempotency lifecycle policy reviewed.
- Error code/status mapping accepted.
- Retryability policy accepted.
- `idempotencyKey` required accepted.
- Pending/succeeded/failed lifecycle accepted.
- Stale pending automatic re-execution forbidden accepted.
- `requestHash` normalization accepted and included in tests.
- Wallet safety strategy accepted.
- Rounding/scale accepted and included in tests.
- Execute-time snapshot/freshness/sourceType accepted.
- Rollback tests included.
- Idempotency tests included.
- No equity snapshot and no fee row tests included.
- Local smoke with approved fresh `admin_manual` snapshot available.
- Still blocked by wallet safety, provider coexistence/sourceType, rollback tests, execute-time snapshot/freshness/sourceType final gate, and implementation test matrix inclusion.

## Explicit non-goals
- No implementation.
- No schema/migration/seed changes.
- No package changes.
- No env changes.
- No provider ingestion.
- No fake data.
- No `/home` implementation.
