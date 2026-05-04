# FX Execute Preimplementation Readiness Audit

## Status
- Documentation only.
- `/fx execute` implementation remains STOP.
- This document is a preimplementation defect readiness audit, not an implementation instruction.
- Detailed unresolved decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
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
- Decimal rounding/scale is not fully accepted for execute and remains STOP.

## Remaining STOP decisions
| Area | Decision needed | Current risk if unresolved | Suggested default | Implementation allowed? |
| --- | --- | --- | --- | --- |
| `idempotencyKey` required 여부와 missing key error | Decide whether every execute request must include a non-empty `idempotencyKey` and which error code/status is returned when missing. | Client retries can double debit if execution is allowed without a durable key. | Require non-empty string and return `IDEMPOTENCY_REQUIRED`. | No |
| `requestHash` normalization rule | Define canonical payload fields, trim rules, decimal normalization, currency casing, and hash algorithm. | Same economic request can hash differently, or different payloads can hash the same by accident-prone normalization. | Hash canonical JSON of `fromCurrency`, `toCurrency`, normalized `sourceAmount`, active season/participant scope if accepted, and API version. | No |
| Same key + same hash + `pending` | Decide whether to return pending/in-progress, retry execution, wait, or recover stale pending. | Duplicate request can run twice or remain blocked forever. | Return deterministic `IDEMPOTENCY_PENDING` for fresh pending; recover only after stale-pending policy. | No |
| Same key + same hash + `succeeded` replay | Decide whether to return stored `responsePayloadJson` or rebuild response from `exchangeTransactionId`. | Successful retry can create another exchange or return a response that disagrees with committed rows. | Store and return `responsePayloadJson`; fallback rebuild only if explicitly tested. | No |
| Same key + same hash + `failed` | Decide whether failure is replayed, retryable, or creates a new attempt under same key. | A failed command can either block legitimate retry or execute unexpectedly after a client retry. | Persist terminal validation failures; allow retry only for explicitly retryable infrastructure failures after recovery rule. | No |
| Same key + different hash conflict | Decide conflict response code/status and whether any write occurs. | Same idempotency key can execute different payloads. | Return `IDEMPOTENCY_CONFLICT`; do not mutate wallets. | No |
| `responsePayloadJson` storage/reuse | Decide exact success response payload, serialization format, and replay source of truth. | Duplicate replay can drift from original execution values, balances, or rounding. | Store the exact success response JSON after all DB writes succeed in the same transaction. | No |
| Stale pending command recovery | Define pending timeout, recovery job/manual path, and status transition rules. | Stuck pending rows can permanently block retries or invite unsafe re-execution. | Treat recent pending as in-progress; review stale pending via explicit recovery policy before retrying. | No |
| Wallet conditional update vs row-level lock | Choose conditional update, row-level lock, serializable transaction, or a combined approach. | Concurrent requests can overspend the source wallet. | Start with conditional source wallet debit inside DB transaction; use raw SQL or row lock if Prisma cannot express it safely. | No |
| Affected row count 0 classification | Decide how to distinguish `INSUFFICIENT_BALANCE` from `CONCURRENT_WALLET_UPDATE`. | Users get misleading errors and retry policy becomes unsafe. | Reread source wallet after zero affected rows; insufficient balance returns `INSUFFICIENT_BALANCE`, otherwise `CONCURRENT_WALLET_UPDATE`. | No |
| Source/target wallet update order | Decide lock/update order for source and target wallets. | Deadlocks, partial assumptions, or incorrect `balanceAfter` values. | Lock/read wallets in deterministic currency/id order if using locks; perform guarded source debit before target credit inside one transaction. | No |
| `wallet_transactions.balanceAfter` basis | Decide whether balanceAfter uses returned update value, reread value, or calculated value. | Ledger can disagree with actual wallet balance. | Use actual post-update wallet balances captured inside the transaction. | No |
| Decimal rounding/scale rule | Decide input precision, calculation precision, rounding mode, storage scale, and response formatting. | Quote, execute, wallet, exchange, and records can disagree by one unit of scale. | Keep API strings; calculate with Decimal; store money as scale 8 and feeRate as scale 6 until a stricter currency-specific rule is accepted. | No |
| Execute-time FX snapshot selection | Decide whether execute reuses quote snapshot or selects latest fresh snapshot at execute time. | Execute can use a rate the user did not see or use an unavailable snapshot. | Near-term direct execute selects latest eligible USD/KRW snapshot at execute time, matching quote ordering, until durable quote exists. | No |
| Execute-time 60-second freshness | Decide stale threshold and exact boundary for execute. | Quote rejects stale rates while execute succeeds on stale rates. | Use the same `> 60_000 ms` stale rule and exactly-60-second acceptance as quote. | No |
| `sourceType` priority | Decide priority when `provider_api`, `official_batch`, and `admin_manual` rows coexist. | Execute can use an official batch/reference row or manual row unexpectedly. | STOP 유지; do not mix source types for execute until priority is accepted. | No |
| Provider coexistence | Decide provider_api/official_batch/admin_manual coexistence and fallback rules. | Manual correction or official reference rows can override provider rows without intent. | For local smoke, allow approved fresh `admin_manual`; production coexistence remains STOP. | No |
| `/fx execute` equity snapshot creation | Decide whether execute creates `equity_snapshots`. | Cash-only snapshots can be mistaken as authoritative valuation. | Do not create `equity_snapshots` in near-term execute. | No |
| Error envelope/code | Confirm execute error codes, HTTP statuses, and response envelope. | Frontend and retry logic cannot distinguish validation, stale rate, duplicate, or concurrency errors. | Reuse common `{ success: false, error: { code, message } }`; finalize execute-specific code list before coding. | No |
| Retryable vs non-retryable errors | Classify stale rate, insufficient balance, idempotency conflict, concurrency, and infrastructure failures. | Clients can retry non-retryable financial failures or fail to retry safe transient failures. | Non-retryable: validation, conflict, insufficient balance, stale rate. Retryable only after explicit infra/concurrency classification. | No |

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
- Pending duplicate behavior.
- Failed duplicate behavior.
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
- Wallet safety approach is confirmed.
- Decimal rounding/scale is confirmed.
- Execute-time FX snapshot selection, freshness, and `sourceType` policy are confirmed.
- Idempotency lifecycle is confirmed.
- The test matrix is included in the implementation task.
- There is a local smoke procedure using an approved fresh `admin_manual` snapshot independent of provider final selection.
- Partial-write rollback behavior is testable before production provider ingestion.
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
