# FX API Contract Draft

## Status
- This document fixes the `/fx` quote/execute API contract candidate and implementation STOP decisions for agreement.
- This is documentation only.
- Do not implement `/fx`, `/wallets`, `/orders`, `/records`, or `/home` from this document.
- Do not add fake FX rates, temporary FX rates, Prisma schema changes, migrations, seed changes, Prisma Client generate, or package changes from this document.
- `/home` full implementation remains blocked.

## Source Rules
- Amount values are strings at the API boundary.
- Timestamps are UTC ISO strings.
- Exchange follows quote -> execute.
- MVP allows only KRW/USD pairs:
  - `KRW -> USD`
  - `USD -> KRW`
- `fromCurrency` and `toCurrency` must not be equal.
- `sourceAmount` must be greater than 0.
- Quote and execute are allowed only when the user has joined an active season.
- Upcoming, ended, and settled seasons block quote and execute.
- Fake FX rates and temporary FX rates are forbidden.
- `fx_rate_snapshots` does not exist yet, so the `appliedRate` source is an implementation STOP decision.

## Common Error Envelope
All `/fx` errors should use the common error envelope.

```json
{
  "success": false,
  "error": {
    "code": "<string>",
    "message": "<string>"
  }
}
```

## POST /api/v1/fx/quote

### Purpose
Return a KRW/USD exchange quote without changing wallet balances or writing exchange ledger rows.

### Request Shape

```json
{
  "fromCurrency": "KRW | USD",
  "toCurrency": "USD | KRW",
  "sourceAmount": "<amount string>"
}
```

### Success Response Shape Candidate

```json
{
  "success": true,
  "data": {
    "quoteId": "<string | null>",
    "fromCurrency": "KRW",
    "toCurrency": "USD",
    "sourceAmount": "<amount string>",
    "appliedRate": "<decimal string>",
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "netTargetAmount": "<amount string>",
    "expiresAt": "<UTC ISO string | null>"
  }
}
```

### Quote Calculation Direction
- `appliedRate` means KRW per 1 USD.
- KRW -> USD: `grossTargetAmount = sourceAmount / appliedRate`.
- USD -> KRW: `grossTargetAmount = sourceAmount * appliedRate`.
- Both directions: `feeAmount = grossTargetAmount * feeRate`.
- Both directions: `netTargetAmount = grossTargetAmount - feeAmount`.
- Fee is charged in the target currency.
- KRW -> USD uses `feeCurrency = USD`.
- USD -> KRW uses `feeCurrency = KRW`.
- Decimal rounding and scale rules must be fixed before implementation.

### Quote STOP Decisions
- Current schema has no durable quote table.
- `quoteId` cannot be durable unless a quote table, request table, or command table is designed.
- `expiresAt` policy is not fixed.
- MVP must decide whether stateless quote is allowed or quote persistence is required.
- `quoteId` and `expiresAt` are contract candidates only until that decision is made.
- `appliedRate` source must be decided before implementation because `fx_rate_snapshots` does not exist.

## POST /api/v1/fx/execute

### Purpose
Execute KRW/USD exchange, update cash wallets, create `exchange_transactions`, and create source/target `wallet_transactions` rows according to `docs/wallet-fx-write-path-plan.md`.

### Request Shape Candidate A: Quote-Based Execute

```json
{
  "quoteId": "<string>",
  "idempotencyKey": "<string>"
}
```

### Request Shape Candidate B: Direct Execute

```json
{
  "fromCurrency": "KRW | USD",
  "toCurrency": "USD | KRW",
  "sourceAmount": "<amount string>",
  "idempotencyKey": "<string>"
}
```

### Candidate Comparison
- Candidate A gives stronger quote/execute consistency, but requires durable quote storage or a command/request table.
- Candidate A can support quote expiry and exact replay of quoted values.
- Candidate B is simpler for near-term MVP because it does not require a quote table.
- Candidate B still must recompute using a legitimate `appliedRate` source at execution time.
- Candidate B still requires durable idempotency before implementation.

### Recommended Candidate
- Near-term MVP should document Candidate B, direct execute, as the preferred request shape.
- This recommendation is conditional: actual implementation must first add or choose durable idempotency storage.
- If a durable quote table is introduced later, execute can move to Candidate A.

### Success Response Shape Candidate

```json
{
  "success": true,
  "data": {
    "exchangeId": "<string>",
    "executedAt": "<UTC ISO string>",
    "fromCurrency": "KRW",
    "toCurrency": "USD",
    "sourceAmount": "<amount string>",
    "rate": "<decimal string>",
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "netTargetAmount": "<amount string>",
    "wallets": {
      "KRW": "<amount string>",
      "USD": "<amount string>"
    }
  }
}
```

### Response Mapping
- DB stores `exchange_transactions.appliedRate`.
- `/fx execute` response exposes that value as `rate`.
- This matches records exchanges mapping where `appliedRate -> rate`.
- `exchangeId` maps to `exchange_transactions.id`.
- `wallets.KRW` and `wallets.USD` are post-execute wallet balances.

### Required Error Code Candidates
- `UNAUTHORIZED`
- `SEASON_NOT_FOUND`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `INSUFFICIENT_BALANCE`
- `FX_RATE_UNAVAILABLE`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `QUOTE_EXPIRED`
- `CONCURRENT_WALLET_UPDATE`
- `INTERNAL_ERROR`

## Execute Idempotency

### Current State
- `exchange_transactions` has no `idempotencyKey` column.
- There is no unique key protecting duplicate execute requests.
- `wallet_transactions` has `[referenceType, referenceId]` index only, not an idempotency unique key.

### Candidate A: Add `exchange_transactions.idempotencyKey`
- Pros: simple lookup against the executed exchange row.
- Pros: can make duplicate execute return the original exchange response.
- Cons: requires schema and migration.
- Cons: less flexible for recording pending/failed command state before exchange row creation.

### Candidate B: Add `fx_execute_requests` Or Command Table
- Pros: can record request lifecycle before wallet mutation.
- Pros: can store request hash, status, response payload, failure reason, and linked `exchangeTransactionId`.
- Pros: clearer boundary for idempotent retries and conflicts.
- Cons: requires schema and migration.
- Cons: adds one more table and implementation path.

### Candidate C: API Layer Durable Store
- Pros: can avoid touching exchange table shape.
- Pros: may be reusable across order/fx commands.
- Cons: still needs durable storage semantics.
- Cons: must be transactionally consistent with DB writes or it can drift.

### Candidate D: Implement Without Idempotency
- Not recommended.
- Exchange execute is a financial write path.
- Client retry or network timeout could duplicate wallet debits and credits.
- Duplicate `exchange_transactions` and `wallet_transactions` rows would be hard to distinguish from real user actions.

### Recommendation
- Prefer Candidate B, a separate request/command table, when command lifecycle needs to be explicit.
- Candidate A, `exchange_transactions.idempotencyKey`, is acceptable for the smallest MVP if pending/failed request tracking is not needed.
- Do not implement execute until one of these durable strategies is agreed and reflected through schema/migration.

## Wallet Concurrency And Overspend Prevention

### Problem
- The same wallet can receive concurrent exchange and order execute requests.
- A simple read -> check -> update flow can race.
- Two concurrent requests can both see enough balance and overspend the source wallet.

### Candidate A: Row-Level Lock
- Lock source and target wallet rows inside an interactive transaction.
- Validate balance after the lock is acquired.
- Pros: clear transactional semantics.
- Cons: Prisma Client may require raw SQL for `SELECT ... FOR UPDATE`.

### Candidate B: Conditional Update
- Update the source wallet only where `balanceAmount >= sourceAmount`.
- Require exactly one affected row.
- Treat zero affected rows as `INSUFFICIENT_BALANCE` or `CONCURRENT_WALLET_UPDATE` depending on the observed state.
- Pros: good MVP fit and avoids stale read checks.
- Cons: may need raw SQL or careful Prisma support for Decimal comparisons and affected row checks.

### Candidate C: Serializable Transaction
- Run execute in serializable isolation and retry serialization failures.
- Pros: strong database-level protection.
- Cons: more retry/error complexity.
- Cons: may still need careful write ordering and conflict handling.

### Candidate D: Application-Level Mutex
- Serialize requests per wallet in application memory or a distributed lock.
- Pros: easy to reason about in a single process.
- Cons: unsafe across multiple server instances without durable distributed locking.
- Cons: should not be the only correctness boundary for wallet money.

### Recommendation
- MVP should first evaluate Candidate B, conditional update.
- Source wallet debit must be guarded by `balanceAmount >= sourceAmount`, and affected row count must be exactly 1.
- If Prisma Client cannot safely express this, use raw SQL inside the DB transaction or switch to interactive transaction plus row-level lock.
- Order execute must use the same wallet safety pattern as FX execute.
- Final strategy is a STOP decision before implementation.

## Equity Snapshots
- `/fx execute` should not create `equity_snapshots` yet.
- This matches `docs/wallet-fx-write-path-plan.md` Option A.
- Current schema still lacks `positions`, `asset_price_snapshots`, and `fx_rate_snapshots`.
- Without those source tables, an authoritative KRW total equity snapshot cannot be produced.
- Cash-only snapshots could be mistaken as `/home`, ranking, settlement, or final evaluation evidence.
- Revisit `equity_snapshots` write path after valuation source tables are designed.

## Implementation STOP Checklist
- Decide `appliedRate` source; fake or temporary FX rates are forbidden.
- Decide stateless quote vs durable quote storage.
- Decide quote expiry policy if `quoteId` is emitted.
- Decide execute idempotency storage and schema/migration.
- Decide wallet concurrency/overspend strategy.
- Decide Decimal rounding/scale rules.
- Keep `/home` full implementation blocked until valuation/ranking source tables exist.
