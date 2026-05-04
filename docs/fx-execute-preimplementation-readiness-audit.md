# FX Execute Preimplementation Readiness Audit

## Status
- Documentation only.
- `/fx execute` implementation remains STOP.
- This document is a preimplementation defect readiness audit, not an implementation instruction.
- Detailed unresolved decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- Accepted policy references: `docs/fx-decimal-rounding-scale-policy.md`, `docs/fx-execute-error-policy.md`, `docs/fx-idempotency-lifecycle-policy.md`.
- Error/status/retryability, idempotency pending/succeeded/failed MVP lifecycle, wallet safety strategy, and rollback/partial-write test gate are accepted, but `/fx execute` remains STOP on sourceType/provider coexistence, execute-time snapshot/freshness/sourceType final gate, implementation proof, and implementation test matrix.
- Do not implement controller, service, DTO, test, Prisma schema, migration, seed, provider ingestion, scheduler, package, or environment changes from this document.

## Purpose
- Prevent duplicate exchange execution.
- Prevent wallet overspend under concurrent requests.
- Prevent disagreement between wallet balances and `wallet_transactions`.
- Prevent lifecycle drift between `exchange_transactions` and `fx_execute_requests`.
- Prevent rate freshness or source policy mismatch between quote and execute.
- Prevent rounding and scale mismatches across response, wallet balances, and ledger rows.
- Prevent partial writes where one financial side commits without the matching audit rows.

## Current implemented baseline
- `POST /api/v1/fx/quote` read-only implementation is complete.
- `/fx quote` does not write wallets, `exchange_transactions`, `wallet_transactions`, `fx_execute_requests`, or `equity_snapshots`.
- `/fx quote` uses USD/KRW snapshots from `fx_rate_snapshots`.
- Missing eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- A selected snapshot whose `effectiveAt` is more than 60 seconds older than quote time returns `FX_RATE_STALE`.
- A selected snapshot exactly at the 60-second threshold is accepted.
- `/fx quote` returns `quoteId = null`, `expiresAt = null`, `rateCapturedAt`, and `rateEffectiveAt`.
- `/fx quote` calculates `feeAmount` in the target currency and credits only `netTargetAmount` in the response model.
- `fx_execute_requests` model exists.
- `fx_execute_requests` has `unique(userId, idempotencyKey)`.
- `fx_execute_requests` stores `requestHash`, `status`, `exchangeTransactionId`, `responsePayloadJson`, `errorCode`, `errorMessage`, `requestedAt`, and `completedAt`.
- `exchange_transactions` has nullable `fxRateSnapshotId`.
- `exchange_transactions` has no `idempotencyKey`.
- `wallet_transactions` has `[referenceType, referenceId]` index only and no idempotency unique key.
- `wallet_transactions` stores `amount` and `balanceAfter` as `Decimal(24, 8)`.
- `exchange_transactions.appliedRate` is `Decimal(18, 8)`.
- `seasons.fxFeeRate` is `Decimal(10, 6)`.
- `assets`, `asset_price_snapshots`, `positions`, `daily_portfolio_snapshots`, and `season_rankings` do not exist yet.
- `/home` full implementation remains blocked.
- Season join already creates KRW and USD wallets in one DB transaction and writes the initial KRW wallet transaction.
- `/fx execute` service/controller/test implementation does not exist.

## Accepted decisions already reflected
- Idempotency ownership belongs to `fx_execute_requests`.
- `exchange_transactions.idempotencyKey` is intentionally not added.
- A successful `/fx execute` needs one `exchange_transactions` row.
- A successful `/fx execute` needs one source debit `wallet_transactions` row.
- A successful `/fx execute` needs one target credit `wallet_transactions` row.
- MVP does not create a separate fee wallet transaction row.
- Target wallet credit is `netTargetAmount`, not `grossTargetAmount`.
- Near-term `/fx execute` does not create `equity_snapshots`.
- `fxRateSnapshotId` should link the successful `exchange_transactions` row to the selected FX snapshot if execute confirms snapshot linkage.
- Source wallet debit, target wallet credit, exchange row, and wallet transaction rows must be atomic inside one DB transaction.
- `wallet_transactions.balanceAfter` must be based on the actual post-update wallet balance.
- Fake, static, temporary, sample, or test business FX rates are forbidden.
- Decimal rounding/scale policy is accepted as half-up with fixed scale/formatting, but `/fx execute` remains STOP because other safety decisions are unresolved.
- `requestHash` canonical rule is accepted.
- Error code/status/retryability policy is accepted.
- Idempotency pending/succeeded/failed MVP lifecycle is accepted.
- Stale pending automatic re-execution is forbidden; stale pending returns recovery-required behavior.
- Guarded conditional source debit is accepted as the MVP wallet safety default, with raw SQL or row-level lock fallback if Prisma cannot prove affected row count and post-update balance safety.
- Affected row count 0 classification is accepted: missing wallet -> `SOURCE_WALLET_NOT_FOUND`, insufficient balance -> `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`.
- Source/target wallet update order is accepted: guarded source debit before target credit inside one atomic unit.
- `wallet_transactions.balanceAfter` source of truth is accepted as actual post-update wallet balance inside the transaction.
- Rollback/partial-write test gate is accepted, but tests are not implemented in this documentation task.
- `/fx execute` remains STOP because sourceType/provider coexistence, execute-time snapshot/freshness/sourceType final gate, implementation proof, and implementation test matrix remain unresolved.

## Remaining STOP decisions
| Area | Decision needed | Current risk if unresolved | Suggested default | Implementation allowed? |
| --- | --- | --- | --- | --- |
| `idempotencyKey` required 여부와 missing key error | Accepted rule must be carried into implementation tests. | Client retries can double debit if execution deviates from the accepted rule. | Require non-empty string and return `IDEMPOTENCY_REQUIRED`. | No; other STOP remain |
| `requestHash` normalization rule | Accepted rule must be carried into implementation tests. | Same economic request can hash differently if implementation deviates from the accepted rule. | Use accepted canonical JSON/SHA-256 rule in `docs/fx-idempotency-lifecycle-policy.md`. | No; other STOP remain |
| Same key + same hash + `pending` | Accepted MVP lifecycle must be carried into implementation tests. | Duplicate request can run twice or remain blocked forever if implementation deviates. | Fresh pending returns `IDEMPOTENCY_PENDING`; stale pending returns `IDEMPOTENCY_PENDING_STALE`; no automatic re-execution. | No; other STOP remain |
| Same key + same hash + `succeeded` replay | Accepted replay policy must be carried into implementation tests. | Successful retry can create another exchange or return a response that disagrees with committed rows. | Store and return exact `responsePayloadJson`; do not silently recompute. | No; other STOP remain |
| Same key + same hash + `failed` | Accepted MVP lifecycle must be carried into implementation tests. | A failed command can execute unexpectedly after a client retry. | Return `IDEMPOTENCY_FAILED` or stored original failure payload; do not automatically re-execute. | No; other STOP remain |
| Same key + different hash conflict | Accepted conflict policy must be carried into implementation tests. | Same idempotency key can execute different payloads. | Return `IDEMPOTENCY_CONFLICT`; do not mutate wallets. | No; other STOP remain |
| `responsePayloadJson` storage/reuse | Accepted replay policy must be carried into implementation tests. | Duplicate replay can drift from original execution values, balances, or rounding. | Store exact success response JSON; missing payload with `exchangeTransactionId` is recovery-required STOP. | No; other STOP remain |
| Stale pending command recovery | Accepted MVP safety behavior must be carried into implementation tests. | Stuck pending rows can permanently block retries or invite unsafe re-execution. | 2-minute stale threshold; automatic re-execution forbidden; recovery tool/job is future work. | No; other STOP remain |
| Wallet conditional update vs row-level lock | Accepted strategy must be proven in implementation tests. | Concurrent requests can overspend the source wallet if implementation deviates. | Guarded conditional source debit is MVP default; raw SQL or row-level lock fallback if Prisma cannot prove safety. | No; implementation proof/tests required |
| Affected row count 0 classification | Accepted classification must be carried into implementation tests. | Users get misleading errors and retry policy becomes unsafe. | Reread source wallet; missing -> `SOURCE_WALLET_NOT_FOUND`, insufficient -> `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`. | No; tests required |
| Source/target wallet update order | Accepted update order must be carried into implementation tests. | Deadlocks, partial assumptions, or incorrect `balanceAfter` values. | Guarded source debit before target credit inside one atomic unit; stop with no partial rows on debit failure. | No; tests required |
| `wallet_transactions.balanceAfter` basis | Accepted balance source must be carried into implementation tests. | Ledger can disagree with actual wallet balance. | Use actual post-update wallet balances captured inside the transaction; do not use estimated pre-read arithmetic alone. | No; tests required |
| Decimal rounding/scale rule | Accepted rule must be carried into implementation tests. | Quote, execute, wallet, exchange, and records can disagree by one unit of scale if implementation deviates from half-up/scale policy. | Use accepted half-up and scale policy in `docs/fx-decimal-rounding-scale-policy.md`. | No; other STOP remain |
| Execute-time FX snapshot selection | Decide whether execute reuses quote snapshot or selects latest fresh snapshot at execute time. | Execute can use a rate the user did not see or use an unavailable snapshot. | Near-term direct execute selects latest eligible USD/KRW snapshot at execute time, matching quote ordering, until durable quote exists. | No |
| Execute-time 60-second freshness | Decide stale threshold and exact boundary for execute. | Quote rejects stale rates while execute succeeds on stale rates. | Use the same `> 60_000 ms` stale rule and exactly-60-second acceptance as quote. | No |
| `sourceType` priority | Decide priority when `provider_api`, `official_batch`, and `admin_manual` rows coexist. | Execute can use an official batch/reference row or manual row unexpectedly. | STOP 유지; do not mix source types for execute until priority is accepted. | No |
| Provider coexistence | Decide provider_api/official_batch/admin_manual coexistence and fallback rules. | Manual correction or official reference rows can override provider rows without intent. | For local smoke, allow approved fresh `admin_manual`; production coexistence remains STOP. | No |
| `/fx execute` equity snapshot creation | Decide whether execute creates `equity_snapshots`. | Cash-only snapshots can be mistaken as authoritative valuation. | Do not create `equity_snapshots` in near-term execute. | No |
| Error envelope/code | Accepted error/status policy must be carried into implementation tests. | Frontend and retry logic cannot distinguish validation, stale rate, duplicate, or concurrency errors. | Use accepted table in `docs/fx-execute-error-policy.md`. | No; other STOP remain |
| Retryable vs non-retryable errors | Accepted retryability policy must be carried into implementation tests. | Clients can retry non-retryable financial failures or fail to retry safe transient failures. | Use accepted retryability policy in `docs/fx-execute-error-policy.md`. | No; other STOP remain |
| Rollback / partial-write test gate | Accepted rollback gate must be included in implementation task. | Partial financial writes can commit silently. | Required rollback/partial-write matrix is mandatory before implementation completion. | No; tests not implemented |

## Defect scenarios to prevent
- Client timeout after a successful commit leads to retry with the same request and the source wallet is debited twice.
- The same `idempotencyKey` is reused with a different payload and still executes.
- A `pending` command gets stuck and permanently blocks all later retries with the same key.
- Source wallet balance is checked, then a concurrent request updates the wallet before debit, causing overspend.
- Source wallet debit succeeds but target wallet credit or ledger row creation fails.
- Wallet balance and `wallet_transactions.balanceAfter` disagree after execute.
- `exchange_transactions` is created but `fx_execute_requests` is not updated to `succeeded`.
- Execute succeeds with a stale FX rate.
- Quote applies the 60-second freshness rule but execute uses a different threshold or boundary.
- Fee currency does not match target currency.
- A separate fee wallet transaction is created even though MVP decided not to create one.
- Target wallet is credited with `grossTargetAmount` instead of `netTargetAmount`.
- `fxRateSnapshotId` is missing or linked to a different snapshot than the applied rate used for calculation.
- Duplicate retry response is recomputed with a newer rate or newer wallet balance instead of replaying original execution.
- `/fx execute` creates `equity_snapshots`, causing a cash-only snapshot to be mistaken for authoritative valuation.
- Provider, official batch, and manual snapshots coexist and execute selects the wrong source type.
- A partial DB write leaves `fx_execute_requests.status = pending` after wallet mutation has committed.

## Required unit test matrix before implementation
Do not add these tests in this documentation task. Include them in the implementation task before or with execute code.

- Invalid pair.
- Invalid amount.
- Missing idempotency key.
- No season.
- Inactive season.
- Not joined.
- No FX snapshot.
- Stale FX snapshot.
- Exactly 60 seconds boundary.
- Insufficient source balance.
- Duplicate same `idempotencyKey` and same `requestHash` succeeded replay.
- Duplicate same `idempotencyKey` and different `requestHash` conflict.
- Fresh pending duplicate returns `IDEMPOTENCY_PENDING`.
- Stale pending duplicate returns `IDEMPOTENCY_PENDING_STALE`.
- Failed duplicate returns `IDEMPOTENCY_FAILED` or stored original failure payload without wallet mutation.
- KRW -> USD calculation.
- USD -> KRW calculation.
- Source wallet debit amount.
- Target wallet credit `netTargetAmount`.
- Source wallet transaction row shape.
- Target wallet transaction row shape.
- Exchange transaction row shape.
- No equity snapshot created.
- No fee wallet transaction row created.
- Rollback when ledger creation fails.
- Concurrent balance update protection.
- Source debit failure leaves no target credit, exchange row, wallet transaction rows, or succeeded command.
- Target credit failure after source debit attempt rolls back the entire transaction.
- `exchange_transactions` create failure rolls back wallet balances and creates no wallet transactions.
- Source or target `wallet_transactions` create failure rolls back wallet balances and exchange row.
- `fx_execute_requests` finalization failure rolls back wallet/exchange/ledger or enters explicitly tested recovery-required behavior.
- `responsePayloadJson` storage failure creates no committed success unless recovery path is proven.
- Duplicate retry after simulated response loss creates no second wallet mutation.
- Wallet not found creates no exchange/ledger rows.
- `fx_execute_requests` status transitions for success and handled failure.
- `responsePayloadJson` replay uses original execution values.

## Required e2e/smoke test matrix before implementation
Do not add these tests in this documentation task. Include them in the implementation task or a dedicated verification task.

- Unauthenticated execute request returns `UNAUTHORIZED`.
- Active joined user execute success path.
- Ended or settled season execute blocked.
- Duplicate retry does not double debit.
- Stale rate rejected.
- Wallet balances after execute match response.
- Exchange history can later map `exchangeId`, `feeCurrency`, and `rate`.
- No `/home` dependency introduced.
- Local smoke can execute against an approved fresh `admin_manual` snapshot without provider ingestion.
- Transaction rollback leaves no wallet, exchange, or command lifecycle drift after an injected ledger failure.

## Implementation gate
Move to implementation only after all of the following are true:

- This readiness audit has been reviewed.
- STOP decisions are resolved or explicitly deferred with a safe default.
- Wallet safety approach is accepted and implementation proof/tests are included.
- Decimal rounding/scale accepted policy is included in implementation tests.
- Execute-time FX snapshot selection, freshness, and `sourceType` policy are confirmed.
- `requestHash` canonical rule is included in implementation tests.
- Pending/succeeded/failed idempotency lifecycle is accepted and included in tests.
- The test matrix is included in the implementation task.
- There is a local smoke procedure using an approved fresh `admin_manual` snapshot independent of provider final selection.
- Partial-write rollback behavior is included in implementation tests before production provider ingestion.
- Error envelope, error codes, and retryability rules are accepted.

## Explicit non-goals
- No `/fx execute` implementation.
- No controller/service/DTO/test code additions.
- No Prisma schema changes.
- No migration creation or modification.
- No seed changes.
- No Prisma Client generate.
- No `package.json` or `pnpm-lock.yaml` changes.
- No `.env.example` changes.
- No `provider_api`, `official_batch`, or scheduler implementation.
- No `/home`, `/wallets`, `/orders`, `/records`, `/ranking`, or `/settlement` implementation.
- No fake/static/temporary/sample/test business FX rate additions.
