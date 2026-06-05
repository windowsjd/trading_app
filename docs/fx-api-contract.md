# FX API Contract Draft

## Status

- This document records the implemented `/fx quote` contract and `/fx execute` MVP behavior.
- `/fx quote` can use fresh `provider_api` ExchangeRate-API USD/KRW first, with existing safe `admin_manual` fallback.
- `/fx execute` remains approved fresh `admin_manual` only.
- `docs/realtime-execution-policy.md` defines the future provider-backed execute/write policy foundation. It is not wired into the current `/fx execute` service.
- Do not add fake FX rates, temporary FX rates, Prisma schema changes, migrations, seed changes, package changes, scheduler/cron, provider ingestion trigger APIs, or real trading/account APIs from this document.

## Source Rules

- Amount values are strings at the API boundary.
- Timestamps are UTC ISO strings.
- Exchange follows quote -> execute.
- Current quote is a reference quote, not a guaranteed execution price.
- MVP allows only KRW/USD pairs:
  - `KRW -> USD`
  - `USD -> KRW`
- `fromCurrency` and `toCurrency` must not be equal.
- `sourceAmount` must be greater than 0.
- Quote and execute are allowed only when the user has joined an active season.
- Upcoming, ended, and settled seasons block quote and execute.
- Fake FX rates and temporary FX rates are forbidden.
- `/fx quote` first tries an eligible `provider_api` USD/KRW `fx_rate_snapshots` row with `sourceName=exchange_rate_api`.
- `/fx quote` provider freshness uses `capturedAt <= now`, `effectiveAt <= now`, positive rate, and capturedAt age <= 300 seconds.
- If the provider row is missing, stale, future, non-positive, wrong-source, or otherwise ineligible, `/fx quote` falls back to the existing `admin_manual` selection.
- Existing `admin_manual` quote fallback keeps the established 60-second `effectiveAt` stale check.
- Near-term `/fx execute` uses approved fresh `admin_manual` snapshots only as allowed sourceType.
- `provider_api` and `official_batch` source eligibility is not opened for `/fx execute`.
- Future provider-backed `/fx execute` must reprice at execute time from fresh provider_api USD/KRW, compare against the quote rate, reject threshold breaches with `RATE_CHANGED_REQUOTE_REQUIRED`, and forbid default `admin_manual` fallback.
- `/fx quote` exposes optional public-safe `rateSource` metadata for source/outage visibility. Raw provider payloads, `metadataJson`, and secrets are never exposed.
- USD/KRW snapshots are also the KRW conversion evidence for USD-settled crypto valuation.
- MVP crypto uses Binance-based USD settlement and the USD Wallet; no `USDT` wallet/currency is introduced.

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
    "rateEffectiveAt": "<UTC ISO string>",
    "rateSource": {
      "sourceType": "provider_api | admin_manual | null",
      "sourceName": "<string | null>",
      "snapshotId": "<string | null>",
      "effectiveAt": "<UTC ISO string | null>",
      "capturedAt": "<UTC ISO string | null>",
      "fallbackUsed": false,
      "fallbackReason": "provider_missing | provider_rejected | provider_not_selected | workflow_ineligible | asset_ineligible | fx_pair_ineligible | null",
      "rejectedProviderReason": "source_type_mismatch | source_name_mismatch | non_positive_value | effective_at_in_future | captured_at_in_future | captured_at_stale | null",
      "freshnessAgeSeconds": 12
    }
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
- Optional `rateSource` returns selected provider/admin source metadata and fallback/rejected-provider reason visibility.
- `appliedRate` source is fresh `provider_api` `exchange_rate_api` USD/KRW first, then existing `admin_manual` fallback.
- Missing eligible provider and manual snapshots return `FX_RATE_UNAVAILABLE`.
- Selected provider snapshot older than 300 seconds by `capturedAt`, or selected manual snapshot older than 60 seconds by `effectiveAt`, returns `FX_RATE_STALE` only when no safe fallback is available.
- `/fx execute` remains a separate STOP and must not be inferred from quote readiness.
- Durable quote storage, non-null `quoteId`, and quote expiry are future enhancements only.
- The future default quote TTL candidate is 10 seconds. Execute after durable quote expiry should return `QUOTE_EXPIRED`.

## POST /api/v1/fx/execute

### Purpose

Execute KRW/USD exchange, update cash wallets, create `exchange_transactions`, and create source/target `wallet_transactions` rows according to this API contract and the current implementation summary in `docs/current-status.md`.

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
- Candidate B uses the reflected `fx_execute_requests` durable idempotency foundation.

### Recommended Candidate

- Near-term MVP uses Candidate B, direct execute, for the implementation gate because durable quote storage does not exist.
- Historical implementation-gate detail is archived in `docs/archive/fx-execute-final-implementation-gate.md`; current implementation status is tracked in `docs/current-status.md`.
- If a durable quote table is introduced later, execute can move to Candidate A.
- Future Candidate A must follow `docs/realtime-execution-policy.md`: quote mismatch returns `QUOTE_MISMATCH`, expired quote returns `QUOTE_EXPIRED`, and fresh provider_api is required at execute time.

### Execute-Time Snapshot Selection

- Direct execute selects the FX snapshot at execute time.
- Selection target:
  - pair USD/KRW
  - allowed sourceType only
  - `effectiveAt <= executeNow`
  - positive `rate`
- Current allowed execute sourceType is approved fresh `admin_manual` only.
- Current not-allowed execute sourceTypes are `provider_api` and `official_batch`.
- Future provider-backed execute reverses this source rule: fresh `provider_api` is required, default `admin_manual` fallback is forbidden, and emergency manual override must be a separate operator override gate.
- Selection ordering:
  1. `effectiveAt desc`
  2. `capturedAt desc`
  3. `createdAt desc`
- No eligible snapshot returns `FX_RATE_UNAVAILABLE`.
- Selected snapshot with `executeNow - effectiveAt > 60_000ms` returns `FX_RATE_STALE`.
- Exactly `60_000ms` is accepted.
- Future `effectiveAt` snapshots are ignored.
- Selected snapshot id maps to `exchange_transactions.fxRateSnapshotId`, and selected `rate` is stored as `appliedRate`.
- Snapshot selection/freshness failure must happen before wallet mutation.

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
    "rateCapturedAt": "<UTC ISO string>",
    "rateEffectiveAt": "<UTC ISO string>",
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
- `rateCapturedAt` maps to the selected snapshot `capturedAt`.
- `rateEffectiveAt` maps to the selected snapshot `effectiveAt`.

### Execute Error Codes

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
- `CONCURRENT_WALLET_UPDATE`
- `SOURCE_WALLET_NOT_FOUND`
- `TARGET_WALLET_NOT_FOUND`
- `IDEMPOTENCY_PENDING`
- `IDEMPOTENCY_PENDING_STALE`
- `IDEMPOTENCY_FAILED`
- `EXECUTE_TRANSACTION_FAILED`
- `INTERNAL_ERROR`

## Execute Idempotency

### Current State

- `exchange_transactions` has no `idempotencyKey` column.
- `fx_execute_requests` exists as the command/request table foundation.
- `fx_execute_requests` has `unique(userId, idempotencyKey)` for execute retry deduplication.
- `wallet_transactions` has `[referenceType, referenceId]` index only, not an idempotency unique key.
- `/fx execute` lifecycle code is not implemented yet.
- Historical lifecycle planning is archived in `docs/archive/fx-idempotency-lifecycle-policy.md`; current behavior is tracked in `docs/current-status.md`.

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
- Cons: lifecycle implementation and tests are still future implementation work.

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
- Use accepted requestHash conflict handling, pending/succeeded/failed lifecycle, and response replay policy.
- Do not implement execute in this documentation task.

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

- MVP uses Candidate B, guarded conditional update, as the accepted wallet safety strategy.
- Source wallet debit must be guarded by `balanceAmount >= sourceAmount`, and affected row count must be exactly 1.
- If Prisma Client cannot safely express this, use raw SQL inside the DB transaction or switch to interactive transaction plus row-level lock.
- Order execute must use the same wallet safety pattern as FX execute.
- Guarded conditional source debit is the accepted MVP wallet safety strategy; implementation proof and tests remain required in the implementation task.

## Provider / SourceType Policy For Execute

- Provider API Source Eligibility Implementation Gate read-only/quote phase does not open execute.
- ExchangeRate-API is the current MVP FX provider for read-only `/fx quote`; OANDA and Twelve Data are historical/fallback research candidates only.
- `provider_api`, `official_batch`, and scheduler ingestion are not execute sources.
- `admin_manual` is bootstrap/fallback/manual correction.
- `official_batch` is not a real-time execute source; it remains settlement/reference/reconciliation candidate.
- Near-term execute uses explicit allowed sourceType eligibility, not implicit priority.
- Current allowed execute sourceType: `admin_manual` only.
- Automatic fallback is forbidden for MVP.
- Approved fresh `admin_manual` snapshots used for execute smoke must not be fake/static/temporary/sample/test business FX rate data.

## Equity Snapshots

- `/fx execute` should not create `equity_snapshots` yet.
- Historical write-path planning is archived in `docs/archive/wallet-fx-write-path-plan.md`; current behavior is summarized in `docs/current-status.md`.
- `fx_rate_snapshots` exists, but `positions` and `asset_price_snapshots` are still missing.
- Authoritative total equity snapshots require positions, asset price snapshots, and FX snapshot evidence together.
- `/fx execute` currently does not create `equity_snapshots`.
- Cash-only snapshots could be mistaken as `/home`, ranking, settlement, or final evaluation evidence.
- Revisit `equity_snapshots` write path after valuation source tables are designed.

## Implementation Gate Checklist

- Quote status:
  - `/fx quote` implementation is complete.
  - `/fx quote` is stateless/read-only.
  - `quoteId` and `expiresAt` are fixed to `null`.
  - `rateCapturedAt` and `rateEffectiveAt` are included.
  - `FX_RATE_UNAVAILABLE` and `FX_RATE_STALE` are distinguished.
- Execute implementation gate:
  - `/fx execute` direct execute MVP is implemented and remains `admin_manual` only.
  - Historical implementation-gate detail is archived in `docs/archive/fx-execute-final-implementation-gate.md`.
  - Wallet safety proof must be verified with tests.
  - Provider-backed execute remains separate and pending.
  - `provider_api` and `official_batch` are not near-term execute sources.
- `/home` live valuation has a separate read-only provider eligibility rule; settled/final result still does not use live provider rows.
