# Wallet/Fx Write Path Plan

## Status
- This document fixes the near-term wallet/fx write path design for agreement.
- This is documentation only.
- Do not implement `/wallets`, `/fx`, `/orders`, `/records`, or `/home` from this document.
- Do not add fake data, Prisma schema changes, migrations, seed changes, Prisma Client generate, or API contract changes from this document.
- Current schema and local DB already include `wallet_transactions`, `exchange_transactions`, and `equity_snapshots`.
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
- No `/wallets`, `/fx`, `/orders`, `/records`, or `/home` API implementation.
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
- Decimal rounding/scale rules must be fixed before `/fx execute` implementation.

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

### Transaction-Internal Order
1. Read `seasonParticipant` and verify active season participation.
2. Read source wallet and target wallet.
3. Verify source wallet balance is greater than or equal to `sourceAmount`.
4. Determine `appliedRate`.
5. Calculate `grossTargetAmount`, `feeAmount`, and `netTargetAmount`.
6. Decrease source wallet balance by `sourceAmount`.
7. Increase target wallet balance by `netTargetAmount`.
8. Create one `exchange_transactions` row.
9. Create source debit `wallet_transactions` row.
10. Create target credit `wallet_transactions` row.
11. Decide whether an `equity_snapshots` row should be created.

### Atomicity Rules
- Source wallet debit and target wallet credit must be committed together.
- `exchange_transactions` must be committed in the same transaction as both wallet balance updates.
- Both `wallet_transactions` rows must be committed in the same transaction as the exchange row.
- `wallet_transactions.balanceAfter` must match each wallet balance after its update.
- If ledger row creation fails after wallet balance updates, the wallet balance updates must roll back.

## `cash_wallets` Write Rules
- Source wallet:
  - Currency must match `fromCurrency`.
  - Balance decreases by `sourceAmount`.
  - Updated balance becomes source `wallet_transactions.balanceAfter`.
- Target wallet:
  - Currency must match `toCurrency`.
  - Balance increases by `netTargetAmount`.
  - Updated balance becomes target `wallet_transactions.balanceAfter`.
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
- Reason: current schema still lacks `positions`, `asset_price_snapshots`, and `fx_rate_snapshots`.
- Without those source tables, a complete authoritative KRW equity snapshot cannot be produced.
- Creating cash-only snapshots after exchange could be mistaken as `/home`, ranking, settlement, or final KRW evaluation evidence.
- `equity_snapshots` write path must be revisited after positions, asset price snapshots, and FX rate snapshots are designed.

### Rejected Near-Term Option: B
- Cash-only snapshot creation is technically possible but should not be the default.
- If later selected, it must be explicitly labeled non-authoritative and must not power `/home` full implementation, rankings, settlement, or final evaluation.

## Idempotency
- Current schema has no `idempotencyKey`.
- Current schema has no unique key that protects exchange execute retry duplication.
- Exchange execute API implementation must decide idempotency before code is written.

### Candidate Strategies
- Add a request id or idempotency key column to `exchange_transactions`.
- Add a separate command/request table for execute requests.
- Manage idempotency at the API layer with a durable store.

### Near-Term Decision
- Do not change schema in this step.
- Keep idempotency as an implementation blocker.
- Before actual `/fx execute` implementation, decide the idempotency strategy and the unique constraint or durable storage boundary.

## Concurrency And Balance Safety
- Concurrent exchange or order requests against the same wallet can cause race condition issues.
- If source wallet balance validation and update are separated without locking or conditional update, overspend can occur.
- Future implementation must choose a safe balance update strategy before writing execute code.

### Prisma-Safe Implementation Candidates
- Use an interactive transaction and acquire row-level lock on the source and target wallet rows before balance validation.
- Use a conditional update for source wallet debit where `balanceAmount >= sourceAmount`, then require exactly one updated row.
- Use raw SQL inside the transaction for row-level lock or conditional update if Prisma Client cannot express the needed locking safely.
- Keep source wallet debit, target wallet credit, exchange row, and wallet ledger rows inside the same transaction regardless of the chosen locking strategy.

### Decision Still Needed
- Choose between row-level lock and conditional update before `/fx execute` implementation.
- Confirm how order execution will share the same wallet safety pattern.

## Implementation STOP Points
- Adding idempotency columns, unique keys, or command tables requires schema/migration agreement.
- Creating `equity_snapshots` on exchange execute requires a valuation-source agreement.
- Implementing `/fx quote` or `/fx execute` requires API contract agreement.
- Implementing `/home` remains blocked by missing valuation, ranking, position, and snapshot source tables.
