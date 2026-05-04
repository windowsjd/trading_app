# Wallet/Fx Write Path Plan

## Status
- This document fixes the near-term wallet/fx write path design for agreement.
- This is documentation only.
- `/fx quote` read-only implementation exists; this document is about future write paths.
- Detailed unresolved `/fx execute` decision tracker: `docs/fx-execute-stop-decision-tracker.md`.
- Accepted policy references: `docs/fx-decimal-rounding-scale-policy.md`, `docs/fx-execute-error-policy.md`, `docs/fx-idempotency-lifecycle-policy.md`.
- Error/status/retryability, idempotency pending/succeeded/failed MVP lifecycle, wallet safety strategy, and rollback/partial-write test gate are accepted, but `/fx execute` remains STOP on sourceType/provider coexistence, execute-time snapshot/freshness/sourceType final gate, implementation proof, and implementation test matrix.
- Do not implement `/wallets`, `/fx execute`, `/orders`, `/records`, or `/home` from this document.
- Do not add fake data, Prisma schema changes, migrations, seed changes, Prisma Client generate, or API contract changes from this document.
- Current schema and local DB already include `wallet_transactions`, `exchange_transactions`, and `equity_snapshots`.
- Current schema and local DB also include `fx_rate_snapshots`, `fx_execute_requests`, and nullable `exchange_transactions.fxRateSnapshotId`.
- `/home` full implementation remains blocked.

## Source Rules
- Financial values are exchanged through APIs as strings.
- Orders and exchange follow quote -> execute.
- Season non-participation is blocked/guide, not an empty state.
- US stocks use the USD wallet.
- Final evaluation is based on KRW total assets.
- Trading and exchange are blocked after season end.
- Prisma 7 adapter style and `PrismaService` reuse must be preserved in future implementation.

## Scope
- Target execute scenarios:
  - KRW -> USD
  - USD -> KRW
- Target tables:
  - `cash_wallets`
  - `fx_rate_snapshots`
  - `fx_execute_requests`
  - `exchange_transactions`
  - `wallet_transactions`
  - `equity_snapshots`
- This document describes transaction boundary, write order, ledger rows, records mapping, snapshot decision, idempotency risk, and concurrency risk.

## Non-Goals
- No source code changes.
- No Prisma schema changes.
- No migration changes or generation.
- No seed changes.
- No Prisma Client generate.
- No `/wallets`, `/fx execute`, `/orders`, `/records`, or `/home` API implementation.
- No fake or backfilled ledger/snapshot data.
- No changes to existing home or records API contracts.

## Common Execute Validation
- `fromCurrency` and `toCurrency` must be different.
- MVP allows only KRW/USD pairs:
  - `fromCurrency = KRW`, `toCurrency = USD`
  - `fromCurrency = USD`, `toCurrency = KRW`
- `sourceAmount` must be greater than 0.
- The user must be joined to an active season.
- Ended or settled seasons must block exchange execution.
- The source wallet balance must be greater than or equal to `sourceAmount`.
- Exchange execution must run inside one DB transaction.
- Source wallet debit, target wallet credit, `exchange_transactions`, and related `wallet_transactions` rows must be atomic.
- If any step fails, the whole DB transaction must roll back.

## Calculation Order
The calculation order should be fixed before write execution:

1. `sourceAmount`
2. `appliedRate`
3. `grossTargetAmount`
4. `feeRate`
5. `feeAmount`
6. `netTargetAmount`

Formula direction assumes `appliedRate` means KRW per 1 USD:

- KRW -> USD: `grossTargetAmount = sourceAmount / appliedRate`
- USD -> KRW: `grossTargetAmount = sourceAmount * appliedRate`
- Both directions: `feeAmount = grossTargetAmount * feeRate`
- Both directions: `netTargetAmount = grossTargetAmount - feeAmount`
- Decimal rounding/scale rules are accepted in `docs/fx-decimal-rounding-scale-policy.md`; implementation still remains blocked by other STOP decisions.

### KRW -> USD
- `sourceAmount` is KRW.
- `appliedRate` is the KRW per USD execution rate.
- `grossTargetAmount` is the USD amount before fee.
- `feeCurrency = USD`.
- `feeAmount` is deducted from `grossTargetAmount` in USD.
- `netTargetAmount` is credited to the USD wallet.

### USD -> KRW
- `sourceAmount` is USD.
- `appliedRate` is the KRW per USD execution rate.
- `grossTargetAmount` is the KRW amount before fee.
- `feeCurrency = KRW`.
- `feeAmount` is deducted from `grossTargetAmount` in KRW.
- `netTargetAmount` is credited to the KRW wallet.

### Fee Rule
- Fee is charged in the target currency.
- Fee is deducted from `grossTargetAmount`.
- `exchange_transactions` must store both `feeAmount` and `feeCurrency`.
- MVP should not create a separate `wallet_transactions` fee row.
- The target wallet should receive only `netTargetAmount`.
- Whether a separate fee ledger row is required remains a future accounting/operations decision.

## DB Transaction Boundary
The whole exchange execute write path must be wrapped in a single DB transaction.

### Accepted Transaction-Internal Order
This order is a policy gate, not implementation permission. The exact command-row pending creation and DB transaction grouping remain implementation-sensitive, but partial writes must not commit.

1. Validate request and idempotency preconditions.
2. Select a fresh eligible FX snapshot according to the execute-time policy candidate/final gate.
3. Calculate rounded `sourceAmount`, `grossTargetAmount`, `feeAmount`, and `netTargetAmount` using the accepted Decimal policy.
4. Resolve source wallet and target wallet.
5. Perform guarded conditional source debit.
6. If debit fails, classify the failure and stop with no partial rows.
7. Perform target wallet credit in the same DB transaction.
8. Capture actual post-update balances for both wallets.
9. Create `exchange_transactions` row.
10. Create source debit `wallet_transactions` row using actual source `balanceAfter`.
11. Create target credit `wallet_transactions` row using actual target `balanceAfter`.
12. Finalize `fx_execute_requests` to `succeeded` with `exchangeTransactionId` and exact `responsePayloadJson`.
13. Commit transaction.
14. Succeeded duplicate later replays stored `responsePayloadJson`.

### Atomicity Rules
- Source wallet debit and target wallet credit must be committed together.
- `exchange_transactions` must be committed in the same transaction as both wallet balance updates.
- Both `wallet_transactions` rows must be committed in the same transaction as the exchange row.
- `fx_execute_requests` success finalization must be atomic with the wallet, exchange, and ledger writes, or a recovery-required behavior must be explicitly tested.
- `wallet_transactions.balanceAfter` must match each wallet balance after its update.
- If ledger row creation fails after wallet balance updates, the wallet balance updates must roll back.
- If any partial-write failure is injected, the implementation task must prove rollback or recovery-required behavior with tests.

## Accepted Wallet Safety Strategy
- MVP `/fx execute` source wallet debit uses guarded conditional debit as the default strategy.
- The source wallet debit must run inside the DB transaction.
- The guarded debit condition must include at least:
  - wallet id
  - `seasonParticipantId`
  - source `currencyCode`
  - `balanceAmount >= rounded sourceAmount`
- If source wallet debit does not succeed, target wallet credit, `exchange_transactions`, `wallet_transactions`, and `fx_execute_requests` succeeded update must not happen.
- Target wallet credit runs only after source debit succeeds and only inside the same DB transaction.
- `exchange_transactions`, source debit `wallet_transactions`, target credit `wallet_transactions`, and `fx_execute_requests` finalization must be handled as one atomic unit.
- Application-level mutex is not a correctness boundary for financial balances.
- Redis lock or process-local lock may be an auxiliary optimization, but cannot be the only financial consistency guarantee.
- Row-level lock remains a fallback/alternative. The MVP default strategy is guarded conditional debit.
- If Prisma Client cannot safely provide affected row count and actual post-update balances, implementation must switch to raw SQL or row-level lock.
- This accepted strategy is not code implementation permission. Prisma/raw SQL feasibility proof and tests are still required in the implementation task.

Why this strategy:
- Source debit must be guarded first because it is the only step that proves the source wallet can fund the exchange under concurrency.
- Target credit must wait for successful source debit so the system never credits target currency without debiting the source.
- Application-only locking cannot protect correctness across process restarts, multiple app instances, direct DB writes, or lock service failures.
- Partial write prevention must be tested because a financial write path is only safe if wallet balances, exchange rows, command status, and ledger rows commit or roll back together.

## Accepted Affected Row Count 0 Classification
- If guarded source debit affected row count is 0, do not treat the execute as successful.
- Reread the source wallet in the same transaction or another safe read context.
- If reread finds no source wallet, return `SOURCE_WALLET_NOT_FOUND`.
- If reread finds `balanceAmount < rounded sourceAmount`, return `INSUFFICIENT_BALANCE`.
- If reread finds `balanceAmount >= rounded sourceAmount` but guarded debit failed, return `CONCURRENT_WALLET_UPDATE`.
- In all three cases, do not create target wallet credit, exchange row, or wallet transaction rows.
- `CONCURRENT_WALLET_UPDATE` retry behavior follows `docs/fx-execute-error-policy.md`.
- This classification must be included in implementation tests.

## Accepted `balanceAfter` Source Of Truth
- `wallet_transactions.balanceAfter` uses the actual post-update wallet balance as source of truth.
- Do not write `balanceAfter` from an estimated `preReadBalance - amount` or `preReadBalance + amount` alone.
- Source debit row `balanceAfter` is the actual source wallet balance after debit.
- Target credit row `balanceAfter` is the actual target wallet balance after credit.
- If the response includes wallet balances, it must use the same post-update balances as the ledger rows.
- If DB update cannot directly return post-update balances, reread inside the same transaction or use a safe raw SQL/locking strategy.
- Ledger amount and wallet update amount must use the accepted Decimal scale/rounding policy.

## Accepted Rollback / Partial-Write Test Gate
Do not add tests in this documentation task. A future `/fx execute` implementation task is not complete unless it includes these tests:

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

## `cash_wallets` Write Rules
- Source wallet:
  - Currency must match `fromCurrency`.
  - Balance decreases by rounded `sourceAmount` through guarded conditional debit.
  - Actual post-update balance becomes source `wallet_transactions.balanceAfter`.
- Target wallet:
  - Currency must match `toCurrency`.
  - Balance increases by rounded `netTargetAmount` only after guarded source debit succeeds.
  - Actual post-update balance becomes target `wallet_transactions.balanceAfter`.
- No other wallet rows should be touched for one KRW/USD exchange.

## `wallet_transactions` Row Rules
One MVP exchange execution creates two wallet ledger rows.

### Source Wallet Debit Row
- `seasonParticipantId`: current participant id
- `walletId`: source wallet id
- `currencyCode`: `fromCurrency`
- `direction`: `debit`
- `txType`: `exchange_source`
- `referenceType`: `exchange_transaction`
- `referenceId`: `exchange_transactions.id`
- `amount`: `sourceAmount`
- `balanceAfter`: source wallet balance after debit
- `occurredAt`: exchange execution time

### Target Wallet Credit Row
- `seasonParticipantId`: current participant id
- `walletId`: target wallet id
- `currencyCode`: `toCurrency`
- `direction`: `credit`
- `txType`: `exchange_target`
- `referenceType`: `exchange_transaction`
- `referenceId`: `exchange_transactions.id`
- `amount`: `netTargetAmount`
- `balanceAfter`: target wallet balance after credit
- `occurredAt`: exchange execution time

### Fee Row Decision
- MVP should not create a separate fee row.
- `feeAmount` remains auditable from `exchange_transactions`.
- If accounting or operations later requires an explicit fee ledger row, use `txType: fee`.
- Before adding a fee row, separately agree on:
  - Which wallet balance the fee row represents.
  - Whether target credit should be gross or net.
  - How `balanceAfter` is calculated across target credit and fee rows.
  - How total ledger amount checks are performed.

## `exchange_transactions` Row Rules
One successful execute creates one exchange execution row.

### Required Stored Values
- `seasonParticipantId`
- `fromCurrency`
- `toCurrency`
- `sourceAmount`
- `grossTargetAmount`
- `feeRate`
- `feeAmount`
- `feeCurrency`
- `appliedRate`
- `fxRateSnapshotId` if the execute write path confirms snapshot linkage for the exchange row
- `netTargetAmount`
- `executedAt`

### Records API Mapping
- `exchange_transactions.id` -> `exchangeId`
- `executedAt` -> `executedAt`
- `fromCurrency` -> `fromCurrency`
- `toCurrency` -> `toCurrency`
- `sourceAmount` -> `sourceAmount`
- `appliedRate` -> `rate`
- `feeAmount` -> `feeAmount`
- `feeCurrency` -> `feeCurrency`
- `netTargetAmount` -> `netTargetAmount`

## `equity_snapshots` Decision
### Selected Near-Term Option: A
- Near-term exchange execute should not create `equity_snapshots` yet.
- Reason: `fx_rate_snapshots` exists, but `positions` and `asset_price_snapshots` are still missing.
- Without position and asset price valuation sources, a complete authoritative KRW equity snapshot cannot be produced.
- Creating cash-only snapshots after exchange could be mistaken as `/home`, ranking, settlement, or final KRW evaluation evidence.
- `equity_snapshots` write path must be revisited after positions, asset price snapshots, and execute-time FX snapshot policy are finalized.

### Rejected Near-Term Option: B
- Cash-only snapshot creation is technically possible but should not be the default.
- If later selected, it must be explicitly labeled non-authoritative and must not power `/home` full implementation, rankings, settlement, or final evaluation.

## Idempotency
- `fx_execute_requests` command table is reflected in schema and migration.
- `fx_execute_requests` has `unique(userId, idempotencyKey)`.
- `exchange_transactions` still has no `idempotencyKey`; idempotency belongs to `fx_execute_requests`.
- `/fx execute` lifecycle behavior is not implemented.
- RequestHash canonical rule is accepted in `docs/fx-idempotency-lifecycle-policy.md`.
- Pending/succeeded/failed MVP behavior and `responsePayloadJson` replay policy are accepted in `docs/fx-idempotency-lifecycle-policy.md`.
- Wallet safety strategy and rollback/partial-write test gate are accepted policy, but implementation remains STOP until proof/tests are included in the implementation task and provider/sourceType/freshness final gates are resolved.

### Reflected Foundation
- Command/request table: `fx_execute_requests`.
- Unique retry boundary: `unique(userId, idempotencyKey)`.
- Linked success row candidate: `fx_execute_requests.exchangeTransactionId`.
- Stored response candidate: `fx_execute_requests.responsePayloadJson`.

### Accepted Idempotency Decisions To Carry Forward
- Use the accepted canonical request payload rule to compute `requestHash`.
- Use accepted same-key same-hash behavior for `pending`, `succeeded`, and `failed`.
- Use accepted different-hash `IDEMPOTENCY_CONFLICT`.
- Do not automatically re-execute failed same-key commands.
- Replay exact stored `responsePayloadJson` for succeeded duplicates.

## Concurrency And Balance Safety
- Concurrent exchange or order requests against the same wallet can cause race condition issues.
- If source wallet balance validation and update are separated without locking or conditional update, overspend can occur.
- The accepted MVP strategy is guarded conditional source debit inside the DB transaction.

### Implementation Alternatives
- Default: guarded conditional debit for source wallet where `balanceAmount >= rounded sourceAmount`, then require exactly one updated row.
- Fallback: raw SQL conditional update if Prisma cannot safely expose affected row count or post-update balances.
- Fallback: row-level lock if conditional update cannot be implemented safely.
- Application-level mutex, Redis lock, or process-local lock must not be the only correctness boundary.
- Order execution should reuse the accepted wallet safety pattern when it is implemented later.

## Implementation STOP Points
- `/fx quote` read-only implementation exists.
- `/fx execute` remains STOP.
- Guarded conditional source debit strategy is accepted, but implementation proof/tests are still required.
- Decimal rounding/scale policy is accepted and must be implemented with tests.
- Idempotency lifecycle policy is accepted and must be implemented with tests.
- Execute-time snapshot selection, freshness, and sourceType policy must be reviewed.
- Creating `equity_snapshots` on exchange execute requires a valuation-source agreement.
- Implementing `/home` remains blocked by missing valuation, ranking, position, and snapshot source tables.
