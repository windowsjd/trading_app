# Near-Term Migration Plan Proposed Final Candidate

## Status
- Prisma schema reflection completed for the near-term 1 tables.
- Migration file created with `add_near_term_ledger_tables` and applied to the local DB.
- Prisma Client generate completed.
- Build verification passed.
- Target tables: `wallet_transactions`, `exchange_transactions`, `equity_snapshots`.
- Prisma generated client was updated by `prisma generate`.
- Seed and runtime API code are not changed by this work.
- Field names, enum values, precision, indexes, and relation policies below were reflected into Prisma schema.

## Source Context
- Current Prisma models are centered on `users`, `seasons`, `season_participants`, and `cash_wallets`.
- `GET /api/v1/home` full implementation is currently blocked.
- `/home` state response shapes are draft-only in `docs/home-api-contract.md`.
- Records orders/exchanges item response fields are fixed in `docs/records-api-contract.md`.
- All financial values exposed through APIs remain strings.
- Prisma 7 with `prisma.config.ts` and adapter-based `PrismaService` must be preserved.

## Shared Proposed Final Decisions
- Primary keys: `String @id @default(uuid())`
- Timestamps: `DateTime`, serialized as UTC ISO strings at the API boundary
- Money amounts: `Decimal @db.Decimal(24, 8)`
- Quantity fields: none in these three tables
- `feeRate`: `Decimal @db.Decimal(10, 6)`
- `appliedRate`: `Decimal @db.Decimal(18, 8)`
- Return rate and MDD-related values: `Decimal @db.Decimal(12, 8)`
- Currency fields: reuse existing `CurrencyCode` enum where values are limited to KRW/USD
- Precision alignment: `Decimal(24, 8)` matches existing `Season.initialCapitalKrw`, `SeasonParticipant.totalAssetKrw`, and `CashWallet.balanceAmount`
- Precision alignment: `Decimal(10, 6)` matches existing `Season.tradeFeeRate` and `Season.fxFeeRate`
- Precision alignment: `Decimal(12, 8)` matches existing `SeasonParticipant.totalReturnRate` and `SeasonParticipant.maxDrawdown`

## FK Delete Behavior Proposed Final Decision
- Ledger and snapshot tables are audit-oriented, so preserving rows is more important than convenient cascading deletion.
- Current `SeasonParticipant` relations from `seasons`, `users`, and `cash_wallets` use cascade behavior, which may conflict with audit preservation.
- Proposed final decision: review `Restrict`, soft-delete, or another preservation-first policy for ledger/snapshot relations before Prisma schema reflection.
- Do not reflect a cascade policy for these audit tables until that final decision is made.

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

### Proposed Final Decisions
- `WalletTransactionDirection`: use `credit` and `debit`.
- Reason: `credit/debit` is unambiguous for a wallet ledger and maps directly to balance increase/decrease.
- If API display later wants `in/out`, keep DB enum as `credit/debit` and map at the API boundary.
- `WalletTransactionType`: use detailed values instead of broad `exchange`, `order`, and `fee` only.
- Reason: separating exchange source/target and order buy/sell makes ledger verification and debugging easier.
- `WalletTransactionReferenceType`: use source categories that map to durable business events, not UI labels.
- `referenceId`: nullable, but should be present whenever the transaction is tied to a durable source row.
- `referenceId` may be null for manual or bootstrap cases only when no durable source row exists yet.
- Idempotency unique key: defer until actual execute logic is designed.
- Reason: unique key shape depends on quote/execute idempotency inputs that are not fixed yet.

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
- `WalletTransactionType`: `initial_grant`, `exchange_source`, `exchange_target`, `order_buy`, `order_sell`, `fee`, `adjustment`, `settlement`
- `WalletTransactionReferenceType`: `season_join`, `exchange_transaction`, `order`, `manual_adjustment`, `settlement`

### Relation Candidates
- `wallet_transactions.seasonParticipantId` -> `season_participants.id`
- `wallet_transactions.walletId` -> `cash_wallets.id`
- `referenceId` may point to `exchange_transactions.id` or future order/settlement tables depending on `referenceType`

### Unique and Index Candidates
- Primary key: `id`
- Index: `[seasonParticipantId, occurredAt]`
- Index: `[walletId, occurredAt]`
- Index: `[referenceType, referenceId]`
- Unique idempotency key: hold until exchange/order execute logic is fixed

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
- Which preservation-first FK delete behavior should be used in Prisma?
- Which execute idempotency key should later protect duplicate ledger writes?

### Do Not Implement In This Step
- Prisma model reflected.
- Migration file created.
- DB apply completed.
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

### Proposed Final Decisions
- DB field name: use `appliedRate`.
- API mapping: records exchanges item keeps `rate` from `docs/records-api-contract.md`.
- Reason: DB should state that this was the exchange rate applied at execution time, while API keeps the frontend contract.
- Fee currency rule: KRW -> USD uses `feeCurrency = USD`.
- Fee currency rule: USD -> KRW uses `feeCurrency = KRW`.
- Fee calculation rule: fee is deducted from `grossTargetAmount` in the target currency.
- Currency constraint: `fromCurrency` and `toCurrency` must not be equal.
- MVP currency scope: allow only KRW/USD and USD/KRW.
- Wallet ledger rule: one exchange transaction must create at least two `wallet_transactions` rows.
- Wallet ledger row 1: source wallet `debit`.
- Wallet ledger row 2: target wallet `credit`.
- Fee ledger representation: keep as final open question until execute logic is designed.

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
- Unique idempotency key: hold until quote/execute command shape is fixed

### Connectivity
- Records: directly backs `records/me/seasons/{seasonId}/exchanges` item fields.
- Home: supports cash movement audit and future section recovery after partial errors.
- Future fx: core execute ledger for quote/execute.
- Future orders: no direct dependency, but wallet ledger consistency should use the same transaction pattern.
- Ranking: indirect input through cash correctness and equity snapshot creation after exchange.

### Questions To Finalize
- Should exchange rows store quote metadata or a quote id in a later design?
- Should `grossTargetAmount` be exposed anywhere, or remain internal audit data?
- Should fee be represented as a separate `wallet_transactions` row, or only as netted target credit?
- Which execute idempotency key should later protect duplicate exchange writes?

### Do Not Implement In This Step
- Prisma model reflected.
- Migration file created.
- DB apply completed.
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

### Proposed Final Decisions
- Include both `capturedAt` and `createdAt`.
- `capturedAt`: valuation 기준 시각.
- `createdAt`: row 생성 시각.
- Add `snapshotReason` from the start.
- Reason: MDD, ranking replay, and settlement verification need to know which event produced each snapshot.
- Authoritative condition: `equity_snapshots` cannot be a complete valuation source without `positions`, `asset_price_snapshots`, and `fx_rate_snapshots`.
- Near-term step prepares the structure only and does not make `/home` full implementation possible.
- `equity_snapshots` and `daily_portfolio_snapshots` must stay separate.
- `equity_snapshots`: event/periodic valuation snapshots.
- `daily_portfolio_snapshots`: day-level summary for home/records charts.

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
| `snapshotReason` | `SnapshotReason` | yes | Capture trigger |
| `capturedAt` | `DateTime` | yes | Valuation capture time |
| `createdAt` | `DateTime @default(now())` | yes | Row creation time |

### Decimal Precision Candidates
- `totalAssetKrw`: `Decimal(24, 8)`
- `returnRate`: `Decimal(12, 8)`
- `krwCash`: `Decimal(24, 8)`
- `usdCashKrw`: `Decimal(24, 8)`
- `domesticStockValueKrw`: `Decimal(24, 8)`
- `usStockValueKrw`: `Decimal(24, 8)`
- `cryptoValueKrw`: `Decimal(24, 8)`

### Enum Candidates
- `SnapshotReason`: `season_join`, `exchange_executed`, `order_executed`, `scheduled`, `settlement`

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
- Which source tables must be present before snapshots are considered authoritative?
- Should there be one snapshot after every order/exchange, a scheduled snapshot, or both?
- How should incomplete valuation be represented when price or FX source is missing?
- Which preservation-first FK delete behavior should be used in Prisma?

### Do Not Implement In This Step
- Prisma model reflected.
- Migration file created.
- DB apply completed.
- No seed rows.
- No snapshot capture job.
- No MDD/ranking/settlement calculation.
- No `/home` summary or chart implementation.

---

## Implementation Order Candidate
1. Design wallet/fx write paths.
2. Define transaction boundaries for exchange execution and wallet ledger writes.
3. Decide fee ledger representation and idempotency strategy.
4. Implement write paths only when fx/orders/wallet behavior is separately agreed.

## Explicit Non-Goals
- No API contract changes.
- No `/home`, `/wallets`, `/fx`, `/orders`, or `/records` implementation.
- No fake backfill data.
- No claim that `/home` full implementation is now possible.
