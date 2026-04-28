# Near-Term Migration Plan Draft

## Status
- This document is a design draft only.
- Target tables: `wallet_transactions`, `exchange_transactions`, `equity_snapshots`.
- Prisma schema, migration files, seed, generated client, and runtime code are not changed by this document.
- Final table names, field types, enum values, precision, indexes, and relations require agreement before Prisma schema work.

## Source Context
- Current Prisma models are centered on `users`, `seasons`, `season_participants`, and `cash_wallets`.
- `GET /api/v1/home` full implementation is currently blocked.
- `/home` state response shapes are draft-only in `docs/home-api-contract.md`.
- Records orders/exchanges item response fields are fixed in `docs/records-api-contract.md`.
- All financial values exposed through APIs remain strings.
- Prisma 7 with `prisma.config.ts` and adapter-based `PrismaService` must be preserved.

## Shared Design Candidates
- Primary keys: `String @id @default(uuid())`
- Timestamps: `DateTime`, serialized as UTC ISO strings at the API boundary
- Money amounts: `Decimal @db.Decimal(24, 8)` candidate
- Rates and fee rates: `Decimal @db.Decimal(18, 8)` or existing `Decimal @db.Decimal(10, 6)` candidate, final scale needs agreement
- Return rates and MDD-related values: existing `Decimal @db.Decimal(12, 8)` candidate
- Currency fields: reuse existing `CurrencyCode` enum candidate where values are limited to KRW/USD
- Delete behavior: prefer preserving ledgers/snapshots; cascade strategy must be explicitly agreed before schema work

---

## wallet_transactions

### Purpose
- Ledger for `cash_wallets` balance changes.
- Track initial season grant, exchange, order, fee, and adjustment history.
- Enable ledger-based balance verification when balance mismatches occur.

### Source or Derived
- Source data for cash balance movement history.
- `balanceAfter` is a stored post-transaction balance snapshot derived from applying the transaction to the wallet balance.

### Why Needed
- `cash_wallets.balanceAmount` only stores the current balance.
- Records, audits, exchange execution, order cash movement, and future balance repair need an immutable movement history.
- `/home` can safely display cash only when wallet balances can be reconciled against a ledger.

### Field List and Type Candidates

| Field | Type Candidate | Required | Notes |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | yes | Ledger row id |
| `seasonParticipantId` | `String` | yes | FK to `season_participants.id` |
| `walletId` | `String` | yes | FK to `cash_wallets.id` |
| `currencyCode` | `CurrencyCode` | yes | Must match wallet currency |
| `direction` | `WalletTransactionDirection` | yes | `credit` or `debit` candidate |
| `txType` | `WalletTransactionType` | yes | Business reason candidate |
| `referenceType` | `WalletTransactionReferenceType` | yes | External source category candidate |
| `referenceId` | `String?` | no | Source row id when available |
| `amount` | `Decimal @db.Decimal(24, 8)` | yes | Positive movement amount |
| `balanceAfter` | `Decimal @db.Decimal(24, 8)` | yes | Wallet balance after movement |
| `occurredAt` | `DateTime` | yes | Business event time |
| `createdAt` | `DateTime @default(now())` | yes | Row creation time |

### Decimal Precision Candidates
- `amount`: `Decimal(24, 8)`
- `balanceAfter`: `Decimal(24, 8)`

### Enum Candidates
- `WalletTransactionDirection`: `credit`, `debit`
- `WalletTransactionType`: `initial_grant`, `exchange`, `order`, `fee`, `adjustment`, `settlement`
- `WalletTransactionReferenceType`: `season_join`, `exchange_transaction`, `order_execution`, `manual_adjustment`, `settlement`

### Relation Candidates
- `wallet_transactions.seasonParticipantId` -> `season_participants.id`
- `wallet_transactions.walletId` -> `cash_wallets.id`
- `referenceId` may point to `exchange_transactions.id` or future order/settlement tables depending on `referenceType`

### Unique and Index Candidates
- Primary key: `id`
- Index: `[seasonParticipantId, occurredAt]`
- Index: `[walletId, occurredAt]`
- Index: `[referenceType, referenceId]`
- Optional uniqueness to discuss: prevent duplicate ledger rows for the same wallet/reference/type/direction when idempotency rules are finalized

### Connectivity
- Records: provides cash movement audit support behind future records views.
- Home: supports reliable `summary.cashKrw` and `summary.cashUsd` validation.
- Future fx: each executed exchange should create source and target wallet ledger rows.
- Future orders: order fills and fees should create wallet ledger rows.
- Ranking: indirect input by supporting cash correctness before equity/ranking calculations.

### Questions To Finalize
- Should `referenceType` be required when `referenceId` is null?
- Should balance reconciliation be enforced transactionally in application code only, or also with database constraints where possible?
- Should adjustment rows require an operator/admin reference table later?
- Should delete behavior be restricted rather than cascade to preserve audit history?
- Should `txType` split exchange source, exchange target, order buy, order sell, and fee into separate enum values?

### Do Not Implement In This Step
- No Prisma model.
- No migration.
- No seed rows.
- No wallet balance recalculation job.
- No wallet API or records API implementation.
- No fake ledger rows for existing wallets.

---

## exchange_transactions

### Purpose
- Execution ledger for KRW/USD exchange.
- Verify quote/execute results.
- Provide the source of records exchanges item fields: `sourceAmount`, `rate`, `feeAmount`, `feeCurrency`, `netTargetAmount`.

### Source or Derived
- Source data for completed exchange executions.
- `grossTargetAmount`, `feeAmount`, and `netTargetAmount` are stored execution results from the accepted quote/execute flow.

### Why Needed
- `cash_wallets` alone cannot explain why KRW/USD balances changed.
- Records exchanges contract requires stable fields that need a durable execution source.
- Future fx quote/execute must be auditable and idempotency-safe.

### Field List and Type Candidates

| Field | Type Candidate | Required | Notes |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | yes | Exchange execution id; maps to `exchangeId` in records |
| `seasonParticipantId` | `String` | yes | FK to `season_participants.id` |
| `fromCurrency` | `CurrencyCode` | yes | Source wallet currency |
| `toCurrency` | `CurrencyCode` | yes | Target wallet currency |
| `sourceAmount` | `Decimal @db.Decimal(24, 8)` | yes | Records `sourceAmount` |
| `grossTargetAmount` | `Decimal @db.Decimal(24, 8)` | yes | Target amount before fee |
| `feeRate` | `Decimal @db.Decimal(10, 6)` | yes | Candidate follows current `seasons.fxFeeRate` precision |
| `feeAmount` | `Decimal @db.Decimal(24, 8)` | yes | Records `feeAmount` |
| `feeCurrency` | `CurrencyCode` | yes | Records `feeCurrency` |
| `appliedRate` | `Decimal @db.Decimal(18, 8)` | yes | Records `rate` source |
| `netTargetAmount` | `Decimal @db.Decimal(24, 8)` | yes | Records `netTargetAmount` |
| `executedAt` | `DateTime` | yes | Records `executedAt` |
| `createdAt` | `DateTime @default(now())` | yes | Row creation time |

### Decimal Precision Candidates
- `sourceAmount`: `Decimal(24, 8)`
- `grossTargetAmount`: `Decimal(24, 8)`
- `feeRate`: `Decimal(10, 6)` to align with current `seasons.fxFeeRate`
- `feeAmount`: `Decimal(24, 8)`
- `appliedRate`: `Decimal(18, 8)`
- `netTargetAmount`: `Decimal(24, 8)`

### Enum Candidates
- `fromCurrency`, `toCurrency`, `feeCurrency`: existing `CurrencyCode`
- Optional future `ExchangeDirection`: `krw_to_usd`, `usd_to_krw`

### Relation Candidates
- `exchange_transactions.seasonParticipantId` -> `season_participants.id`
- `wallet_transactions.referenceType = exchange_transaction` + `referenceId = exchange_transactions.id`
- Future relation to `fx_rate_snapshots` may be needed once that blocker table is designed

### Unique and Index Candidates
- Primary key: `id`
- Index: `[seasonParticipantId, executedAt]`
- Index: `[fromCurrency, toCurrency, executedAt]`
- Optional unique idempotency key is not included in this field set and needs separate agreement if quote/execute requires it

### Connectivity
- Records: directly backs `records/me/seasons/{seasonId}/exchanges` item fields.
- Home: supports cash movement audit and future section recovery after partial errors.
- Future fx: core execute ledger for quote/execute.
- Future orders: no direct dependency, but wallet ledger consistency should use the same transaction pattern.
- Ranking: indirect input through cash correctness and equity snapshot creation after exchange.

### Questions To Finalize
- Is `appliedRate` the public `rate` field name at API mapping only, or should DB field also be named `rate`?
- Should exchange rows store quote metadata or a quote id in a later design?
- Should `fromCurrency` and `toCurrency` be constrained to different values?
- Which currency should fee use for each exchange direction?
- Should `grossTargetAmount` be exposed anywhere, or remain internal audit data?
- Should a completed exchange always create two wallet transaction rows plus optional fee rows?

### Do Not Implement In This Step
- No Prisma model.
- No migration.
- No seed rows.
- No fx quote/execute code.
- No records exchanges endpoint.
- No fake exchange history.

---

## equity_snapshots

### Purpose
- Snapshot total assets after orders/exchanges and on a periodic schedule.
- Provide MDD calculation evidence.
- Support ranking replay and settlement verification.

### Source or Derived
- Derived data.
- Values are captured outputs of portfolio valuation at a point in time.
- Source inputs still require wallet balances, positions, prices, and FX rates to be trustworthy.

### Why Needed
- `season_participants.totalAssetKrw`, `totalReturnRate`, and `maxDrawdown` are current aggregate fields without historical evidence.
- `/home` chart, ranking replay, settlement validation, and future records diagnostics need time-based equity evidence.
- MDD cannot be verified from only the current participant row.

### Field List and Type Candidates

| Field | Type Candidate | Required | Notes |
| --- | --- | --- | --- |
| `id` | `String @id @default(uuid())` | yes | Snapshot row id |
| `seasonParticipantId` | `String` | yes | FK to `season_participants.id` |
| `totalAssetKrw` | `Decimal @db.Decimal(24, 8)` | yes | KRW total asset snapshot |
| `returnRate` | `Decimal @db.Decimal(12, 8)` | yes | Candidate aligns with existing participant return rate |
| `krwCash` | `Decimal @db.Decimal(24, 8)` | yes | KRW cash component |
| `usdCashKrw` | `Decimal @db.Decimal(24, 8)` | yes | USD cash converted to KRW |
| `domesticStockValueKrw` | `Decimal @db.Decimal(24, 8)` | yes | Domestic stock valuation in KRW |
| `usStockValueKrw` | `Decimal @db.Decimal(24, 8)` | yes | US stock valuation in KRW |
| `cryptoValueKrw` | `Decimal @db.Decimal(24, 8)` | yes | Crypto valuation in KRW |
| `capturedAt` | `DateTime` | yes | Valuation capture time |

### Decimal Precision Candidates
- `totalAssetKrw`: `Decimal(24, 8)`
- `returnRate`: `Decimal(12, 8)`
- `krwCash`: `Decimal(24, 8)`
- `usdCashKrw`: `Decimal(24, 8)`
- `domesticStockValueKrw`: `Decimal(24, 8)`
- `usStockValueKrw`: `Decimal(24, 8)`
- `cryptoValueKrw`: `Decimal(24, 8)`

### Enum Candidates
- No required enum in the requested field set.
- Optional future `SnapshotReason`: `season_join`, `exchange_executed`, `order_executed`, `scheduled`, `settlement` if capture source needs to be tracked.

### Relation Candidates
- `equity_snapshots.seasonParticipantId` -> `season_participants.id`
- Future relation to `fx_rate_snapshots` may be needed to prove USD conversion.
- Future relation to price snapshot batches may be needed to prove asset valuation.

### Unique and Index Candidates
- Primary key: `id`
- Index: `[seasonParticipantId, capturedAt]`
- Optional unique: `[seasonParticipantId, capturedAt]` if only one snapshot per timestamp is allowed
- Future daily chart may need a separate daily aggregate table or an agreed query strategy before adding date-level uniqueness

### Connectivity
- Records: helps explain portfolio state around order/exchange history, but does not replace records item ledgers.
- Home: backs `summary`, `equityChart`, and section recovery once source tables exist.
- Future fx: exchange execution should trigger a fresh equity snapshot candidate.
- Future orders: order execution should trigger a fresh equity snapshot candidate.
- Ranking: provides replay and audit evidence for rankings and settlement, but `season_rankings` is still needed for authoritative ranking output.

### Questions To Finalize
- Should `equity_snapshots` include `createdAt`, even though the requested candidate list only includes `capturedAt`?
- Should snapshots include a reason/source field now, or defer until order/fx implementations?
- Which source tables must be present before snapshots are considered authoritative?
- Should there be one snapshot after every order/exchange, a scheduled snapshot, or both?
- Should daily chart use this table directly or wait for `daily_portfolio_snapshots`?
- How should incomplete valuation be represented when price or FX source is missing?

### Do Not Implement In This Step
- No Prisma model.
- No migration.
- No seed rows.
- No snapshot capture job.
- No MDD/ranking/settlement calculation.
- No `/home` summary or chart implementation.

---

## Implementation Order Candidate
1. Agree field names, enums, precision, and index strategy for the three near-term tables.
2. Review delete behavior and audit preservation rules.
3. After agreement, update Prisma schema using the current Prisma 7 config and adapter pattern.
4. Generate migration only after schema review.
5. Implement write paths only when fx/orders/wallet behavior is separately agreed.

## Explicit Non-Goals
- No API contract changes.
- No `/home`, `/wallets`, `/fx`, `/orders`, or `/records` implementation.
- No fake backfill data.
- No generated Prisma Client changes.
- No claim that `/home` full implementation is now possible.
