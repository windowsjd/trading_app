# FX API Contract Draft

## Status
- This document records the implemented `/fx quote` contract and future `/fx execute` contract candidates.
- This is documentation only.
- Do not implement `/fx execute`, `/wallets`, `/orders`, `/records`, or `/home` from this document.
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
- `/fx quote` requires an eligible USD/KRW `fx_rate_snapshots` row.
- `/fx quote` blocks selected snapshots whose `effectiveAt` is older than 60 seconds.

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

### Implemented Success Response Shape

```json
{
  "success": true,
  "data": {
    "quoteId": null,
    "fromCurrency": "KRW",
    "toCurrency": "USD",
    "sourceAmount": "<amount string>",
    "appliedRate": "<decimal string>",
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "netTargetAmount": "<amount string>",
    "expiresAt": null,
    "rateCapturedAt": "<UTC ISO string>",
    "rateEffectiveAt": "<UTC ISO string>"
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
- Current quote returns decimal strings with implemented API formatting; broader execute, settlement, and valuation rounding policy remains a STOP item.

### Quote STOP Decisions
- Current schema has no durable quote table.
- `/fx quote` is implemented as stateless/read-only.
- `quoteId` is fixed to `null` for the current implementation.
- `expiresAt` is fixed to `null` for the current implementation.
- `rateCapturedAt` and `rateEffectiveAt` are returned for rate timing transparency.
- `appliedRate` source is `fx_rate_snapshots`.
- Missing eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- Selected snapshot older than 60 seconds by `effectiveAt` returns `FX_RATE_STALE`.
- `/fx execute` remains a separate STOP and must not be inferred from quote readiness.
- Durable quote storage, non-null `quoteId`, and quote expiry are future enhancements only.

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
- Candidate B uses the reflected `fx_execute_requests` durable idempotency foundation, but lifecycle policy remains STOP.

### Recommended Candidate
- Near-term MVP should document Candidate B, direct execute, as the preferred request shape.
- This recommendation is conditional: actual implementation must first finalize requestHash conflict handling, command lifecycle, wallet safety, and execute-time rate policy.
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
- `FX_RATE_STALE`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `QUOTE_EXPIRED`
- `CONCURRENT_WALLET_UPDATE`
- `INTERNAL_ERROR`

## Execute Idempotency

### Current State
- `exchange_transactions` has no `idempotencyKey` column.
- `fx_execute_requests` exists as the command/request table foundation.
- `fx_execute_requests` has `unique(userId, idempotencyKey)` for execute retry deduplication.
- `wallet_transactions` has `[referenceType, referenceId]` index only, not an idempotency unique key.
- `/fx execute` lifecycle code is not implemented yet.

### Candidate A: Add `exchange_transactions.idempotencyKey`
- Pros: simple lookup against the executed exchange row.
- Pros: can make duplicate execute return the original exchange response.
- Cons: would require a new schema/migration change because this column is intentionally absent.
- Cons: less flexible for recording pending/failed command state before exchange row creation.

### Candidate B: Use Reflected `fx_execute_requests` Command Table
- Pros: can record request lifecycle before wallet mutation.
- Pros: can store request hash, status, response payload, failure reason, and linked `exchangeTransactionId`.
- Pros: provides `unique(userId, idempotencyKey)`.
- Pros: clearer boundary for idempotent retries and conflicts.
- Cons: lifecycle implementation policy is still not finalized.

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
- Use the reflected `fx_execute_requests` command table.
- Keep `exchange_transactions.idempotencyKey` absent unless a later schema review deliberately changes ownership.
- Do not implement execute until requestHash conflict handling, pending/succeeded/failed lifecycle, and response replay policy are agreed.

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
- `fx_rate_snapshots` exists, but `positions` and `asset_price_snapshots` are still missing.
- Authoritative total equity snapshots require positions, asset price snapshots, and FX snapshot evidence together.
- `/fx execute` currently does not create `equity_snapshots`.
- Cash-only snapshots could be mistaken as `/home`, ranking, settlement, or final evaluation evidence.
- Revisit `equity_snapshots` write path after valuation source tables are designed.

## Implementation STOP Checklist
- Quote status:
  - `/fx quote` implementation is complete.
  - `/fx quote` is stateless/read-only.
  - `quoteId` and `expiresAt` are fixed to `null`.
  - `rateCapturedAt` and `rateEffectiveAt` are included.
  - `FX_RATE_UNAVAILABLE` and `FX_RATE_STALE` are distinguished.
- Execute STOP:
  - `/fx execute` remains STOP.
  - Wallet conditional update must be verified.
  - Decimal rounding/scale must be finalized.
  - Failed command lifecycle must be finalized.
  - Execute-time sourceType priority and snapshot freshness policy must be reviewed.
  - Provider/batch ingestion assumptions must be reviewed before long-running execute operation.
- Keep `/home` full implementation blocked until valuation/ranking source tables exist.
