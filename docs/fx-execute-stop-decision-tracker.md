# FX Execute STOP Decision Tracker

## Status
- Documentation only.
- `/fx execute` is still not implemented.
- This tracker consolidates accepted decisions before a future implementation prompt.
- Do not implement code/schema/migration/seed/package/provider changes from this document.

## Purpose
- Gather remaining `/fx execute` STOP decisions in one place before implementation.
- Provide a decision gate to prevent duplicate execution, wallet overspend, ledger mismatch, stale rate use, rounding drift, and command lifecycle drift.
- Separate accepted implementation gates from provider-ingestion work that remains out of scope.

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
- Wallet safety strategy is accepted as guarded conditional source debit MVP default, with implementation proof/tests still required.
- Rollback/partial-write test gate is accepted, with test implementation required in the future implementation task.
- Execute source eligibility is accepted as explicit allowed sourceType gate.
- Near-term allowed execute sourceType is approved fresh `admin_manual` only.
- Execute-time snapshot selection and 60-second freshness are accepted.
- All wallet, exchange, ledger, and command finalization writes must be atomic.
- Provider final selection is not confirmed.
- `provider_api`, `official_batch`, and scheduler ingestion are not implemented.
- `official_batch` is not a real-time execute source; it remains settlement/reference/reconciliation candidate.

## Reference policy documents
- Decimal rounding/scale accepted policy: `docs/fx-decimal-rounding-scale-policy.md`.
- Execute error/status/retryability accepted policy: `docs/fx-execute-error-policy.md`.
- Idempotency lifecycle policy with accepted requestHash and MVP lifecycle rules: `docs/fx-idempotency-lifecycle-policy.md`.
- Readiness audit and test gates: `docs/fx-execute-preimplementation-readiness-audit.md`.
- Final implementation gate and complete test matrix: `docs/fx-execute-final-implementation-gate.md`.

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
| FXE-009 | wallet safety strategy | Choose conditional update vs row-level lock. | Accepted policy: guarded conditional source debit is MVP default strategy. Implementation proof and tests still required before execute implementation. | Concurrent requests can overspend source wallet. | Prove Prisma/raw SQL/locking implementation and include concurrency tests. | accepted |
| FXE-010 | affected row count 0 classification | Decide `INSUFFICIENT_BALANCE` vs `CONCURRENT_WALLET_UPDATE`. | Accepted: reread source wallet; missing -> `SOURCE_WALLET_NOT_FOUND`, insufficient -> `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`. | Incorrect retry behavior and confusing user errors. | Include classification tests. | accepted |
| FXE-011 | source/target wallet update order | Decide deterministic update/lock order. | Accepted: guarded source debit before target credit inside transaction; deterministic/atomic update order documented. | Deadlocks or incorrect balances. | Include update-order and no-partial-row tests. | accepted |
| FXE-012 | wallet_transactions.balanceAfter source of truth | Decide how `balanceAfter` is computed. | Accepted: actual post-update wallet balances inside transaction. | Ledger and wallet balances can diverge. | Include ledger/response balance equality tests. | accepted |
| FXE-013 | Decimal rounding/scale | Decide calculation precision, rounding mode, storage scale, and response scale. | Accepted half-up rounding with scale 8 monetary/rate strings and scale 6 `feeRate` strings. | Quote, execute, ledger, records, and wallet values can drift. | Implementation tests for half-up boundaries and stored/response equality; see `docs/fx-decimal-rounding-scale-policy.md`. | accepted |
| FXE-014 | execute-time FX snapshot selection | Decide snapshot selection for direct execute. | Accepted: direct execute selects the latest eligible allowed-sourceType USD/KRW snapshot at execute time. | Execute can use unexpected or unavailable rate. | Include snapshot selection tests; see `docs/fx-execute-final-implementation-gate.md`. | accepted |
| FXE-015 | execute-time 60-second freshness boundary | Decide execute stale threshold and boundary. | Accepted: same as quote, `> 60_000ms` stale, exactly 60s accepted. | Quote and execute can disagree on stale rate behavior. | Include boundary tests. | accepted |
| FXE-016 | sourceType priority | Decide priority among `provider_api`, `official_batch`, and `admin_manual`. | Accepted: no implicit priority; use explicit allowed sourceType gate. Near-term allowed sourceType is `admin_manual` only. `provider_api` and `official_batch` are not allowed for near-term execute. | Execute can select wrong operational source. | Include disallowed-sourceType tests. | accepted |
| FXE-017 | provider_api/official_batch/admin_manual coexistence | Decide coexistence and fallback behavior. | Accepted: no automatic fallback; approved fresh `admin_manual` snapshot is allowed for near-term/local/integration smoke; `provider_api` requires separate provider final selection/ingestion approval; `official_batch` remains settlement/reference/reconciliation candidate. | Manual or official rows can override provider rows unintentionally. | Keep provider ingestion separate from execute implementation. | accepted |
| FXE-018 | equity_snapshots creation on execute | Decide near-term snapshot write behavior. | No `equity_snapshots` in near-term execute. | Cash-only snapshot can be mistaken for authoritative valuation. | Keep no-snapshot test in implementation task. | accepted |
| FXE-019 | fee wallet transaction row | Decide MVP fee ledger row behavior. | No separate fee wallet transaction row for MVP. | Ledger can double-count or conflict with net target credit. | Keep no-fee-row test in implementation task. | accepted |
| FXE-020 | error code/status mapping | Confirm exact HTTP statuses and error codes. | Accepted error table in `docs/fx-execute-error-policy.md`. | Clients cannot distinguish retryable, conflict, stale, and validation errors. | Include accepted status/code tests. | accepted |
| FXE-021 | retryable vs non-retryable errors | Classify retryability. | Accepted retryability policy in `docs/fx-execute-error-policy.md`. | Clients can retry unsafe failures or miss safe retries. | Include retryability/no-mutation tests. | accepted |
| FXE-022 | rollback/partial write testing | Decide required rollback test coverage. | Accepted test gate: implementation cannot be considered complete without required rollback/partial-write tests. Test implementation itself is future task work. | Partial financial writes can commit silently. | Include full rollback/partial-write matrix in implementation task. | accepted |
| FXE-023 | records exchange mapping after execute | Confirm future records mapping from exchange row. | Accepted: `exchange_transactions` fields are the source for future records exchange mapping. | Records can expose inconsistent `exchangeId`, `feeCurrency`, or `rate`. | Include response/records-readiness assertions. | accepted |
| FXE-024 | local smoke using approved fresh admin_manual snapshot | Decide local smoke data source without provider. | Accepted: local/integration smoke may use approved fresh `admin_manual` snapshot, not fake/static/temp/sample/test. | Smoke may rely on forbidden fake data or provider work. | Use approved operating input path only. | accepted |

## Accepted decisions and safe defaults that can be carried into an implementation prompt later
These are not implementation permission. Do not implement until remaining STOP items are resolved or explicitly approved as safe defaults.

Reference documents:
- `docs/fx-decimal-rounding-scale-policy.md`
- `docs/fx-execute-error-policy.md`
- `docs/fx-idempotency-lifecycle-policy.md`
- `docs/fx-execute-final-implementation-gate.md`

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
- Use guarded conditional source debit as the MVP wallet safety default.
- Classify guarded debit affected row count 0 as missing wallet, insufficient balance, or concurrent update after a safe reread.
- Perform target wallet credit only after successful guarded source debit in the same DB transaction.
- Use actual post-update wallet balances as `wallet_transactions.balanceAfter`.
- Treat rollback/partial-write tests as a required implementation completion gate.
- Use explicit sourceType eligibility instead of implicit source priority.
- Near-term execute source eligibility allows approved fresh `admin_manual` only.
- Exclude `provider_api` and `official_batch` from near-term execute source selection.
- Do not use automatic fallback between source types.
- Select execute-time snapshot by USD/KRW, allowed sourceType, `effectiveAt <= executeNow`, positive rate, then `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- Store selected snapshot id in `exchange_transactions.fxRateSnapshotId`.
- Apply quote-matching freshness: `> 60_000ms` stale and exactly `60_000ms` accepted.
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
- Do not treat OANDA or Twelve Data as final provider selection.
- Do not allow `provider_api` as execute source before provider final selection, trial/contract validation, and ingestion implementation approval.
- Do not allow `official_batch` as real-time execute source.
- Do not add automatic admin_manual fallback without separate operational policy and audit requirements.
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
- Affected row count 0 classification accepted.
- Source/target wallet update order accepted.
- `wallet_transactions.balanceAfter` source of truth accepted.
- Rounding/scale accepted and included in tests.
- Execute-time snapshot/freshness/sourceType final gate resolved.
- Rollback/partial-write test gate accepted and tests included.
- Idempotency tests included.
- No equity snapshot and no fee row tests included.
- Local smoke with approved fresh `admin_manual` snapshot available.
- Provider/sourceType coexistence accepted.
- Execute-time snapshot selection accepted.
- Execute-time freshness boundary accepted.
- Final implementation test matrix documented in `docs/fx-execute-final-implementation-gate.md`.
- `/fx execute` implementation prompt may now be drafted after document review, but implementation is not performed in this task.
- Implementation task must include full test matrix and proof of wallet safety behavior.

## Explicit non-goals
- No implementation.
- No schema/migration/seed changes.
- No package changes.
- No env changes.
- No provider ingestion.
- No fake data.
- No `/home` implementation.
