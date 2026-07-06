# FX API Contract Draft

## Status

- This document records the implemented `/fx quote` contract and `/fx execute` MVP behavior.
- `/fx quote` can use fresh `provider_api` USD/KRW first, preferring Korea EXIM exchange (`korea_exim_exchange_rate`) and falling back to ExchangeRate-API (`exchange_rate_api`), with approved safe `admin_manual` fallback only.
- `GET /api/v1/fx/rates/current` uses the same fresh provider source priority for DB rows: fresh Korea EXIM first, then fresh ExchangeRate-API, then approved `admin_manual` fallback only. A stale Korea EXIM row must not outrank a fresh ExchangeRate-API row.
- `/fx quote` stores an active durable quote and returns `quoteId`, `expiresAt`, and `maxChangeBps`.
- `/fx execute` requires a durable quote for new mutations, reprices at execute time from fresh `provider_api` USD/KRW, enforces quote movement threshold, and forbids default `admin_manual` fallback.
- `docs/policy-decisions.md` records the active provider-backed execute/write policy decisions (freshness thresholds, maxChangeBps, quote TTL).
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
- `/fx quote` verifies the joined participant's source cash wallet before rate selection and durable quote creation. `KRW -> USD` checks the KRW wallet; `USD -> KRW` checks the USD wallet. Missing source wallet or `balanceAmount < sourceAmount` returns `INSUFFICIENT_BALANCE` without creating a quote.
- Fake FX rates and temporary FX rates are forbidden.
- `/fx quote` first tries an eligible `provider_api` USD/KRW `fx_rate_snapshots` row by source priority: `korea_exim_exchange_rate`, then `exchange_rate_api`.
- `/fx quote` provider freshness uses `capturedAt <= now`, `effectiveAt <= now`, positive rate, and capturedAt age <= 300 seconds.
- `GET /api/v1/fx/rates/current` also selects fresh provider rows by the same source priority and 300-second provider freshness threshold. Stale provider rows are not returned ahead of fresh fallback providers; if all provider rows are stale, it uses approved `admin_manual` fallback or returns `FX_RATE_UNAVAILABLE`.
- If the provider row is missing, stale, future, non-positive, wrong-source, or otherwise ineligible, `/fx quote` falls back to an approved `admin_manual` selection.
- Existing `admin_manual` quote fallback keeps the established 60-second `effectiveAt` stale check.
- Unapproved `admin_manual` rows with `approvedByUserId = null` are ignored by current-rate and quote fallback selection.
- `/fx execute` uses execute-time fresh provider_api USD/KRW rows only, by source priority `korea_exim_exchange_rate` then `exchange_rate_api`. It compares executeRate against the durable quote quotedRate, rejects threshold breaches with `RATE_CHANGED_REQUOTE_REQUIRED`, and forbids default `admin_manual` fallback.
- `/fx quote` exposes optional public-safe `rateSource` metadata for source/outage visibility. Raw provider payloads, `metadataJson`, and secrets are never exposed.
- USD/KRW snapshots are also the KRW conversion evidence for USD-settled crypto valuation.
- MVP crypto uses Binance-based USD settlement and the USD Wallet; no `USDT` wallet/currency is introduced.
- Korea EXIM exchange request URL is `https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON` with `authkey`, `searchdate` formatted as KST `YYYYMMDD`, and `data=AP01`. USD/KRW uses the USD row's `DEAL_BAS_R` after comma removal, stored at 8 decimal places. Actual auth keys must stay only in `.env.local`; raw provider payloads, auth keys, and full request URLs are not exposed.

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

## GET /api/v1/fx/rates/current

### Purpose

Return the current USD/KRW rate without changing wallets, quotes, or exchange rows.

### Query

- `baseCurrency`: optional, defaults to `USD`.
- `quoteCurrency`: optional, defaults to `KRW`.
- `refresh`: optional boolean, defaults to `false`.

Only `USD/KRW` is supported. Other pairs return `UNSUPPORTED_FX_PAIR`.

When `refresh=true` or `refresh=1`, the backend may refresh Korea EXIM exchange data only when both `PROVIDER_INGESTION_ENABLED=true` and `KOREA_EXIM_EXCHANGE_ENABLED=true`. If either flag is disabled or the provider refresh fails with a provider config/HTTP error, the endpoint still attempts existing DB snapshot fallback and returns `FX_RATE_UNAVAILABLE` only when no usable DB row exists. When `refresh=false`, `refresh=0`, or the query is omitted, it reads DB rows only and does not call external provider APIs. Invalid refresh values return `INVALID_REFRESH`.

Current-rate DB selection order:

1. Fresh `provider_api` `korea_exim_exchange_rate`.
2. Fresh `provider_api` `exchange_rate_api`.
3. Approved `admin_manual` fallback.
4. `FX_RATE_UNAVAILABLE` when no usable DB row exists.

### Success Response Shape

```json
{
  "success": true,
  "data": {
    "state": "available",
    "pair": "USD/KRW",
    "baseCurrency": "USD",
    "quoteCurrency": "KRW",
    "rate": "1389.50000000",
    "sourceType": "provider_api",
    "sourceName": "korea_exim_exchange_rate",
    "effectiveAt": "2026-06-18T15:00:00.000Z",
    "capturedAt": "2026-06-19T08:00:00.000Z",
    "freshnessAgeSeconds": 120,
    "providerPriority": 1,
    "fallbackUsed": false
  }
}
```

No available DB row returns HTTP 503 with `FX_RATE_UNAVAILABLE`. The response never includes auth keys, raw provider payloads, or full provider request URLs.

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
    "quoteId": "<string>",
    "fromCurrency": "KRW",
    "toCurrency": "USD",
    "sourceAmount": "<amount string>",
    "appliedRate": "<decimal string>",
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "netTargetAmount": "<amount string>",
    "expiresAt": "<UTC ISO string>",
    "maxChangeBps": "<bps string>",
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

### Quote Persistence

- `/fx quote` performs source wallet balance preflight after participant validation and before FX rate selection or durable quote persistence. This preflight does not replace execute-time guarded balance validation.
- `/fx quote` creates a `Quote` row with `quoteType=fx`, `status=active`, `sourceAmount`, `targetAmount`, `quotedRate`, `fxRateSnapshotId`, public-safe `fxRateSourceJson`, `maxChangeBps=30.0000`, `expiresAt=quoteAt+15s`, and canonical SHA-256 `requestHash`.
- `quoteId` is non-null when quote creation succeeds.
- `expiresAt` is non-null and defaults to 15 seconds after quote time.
- `rateCapturedAt` and `rateEffectiveAt` are returned for rate timing transparency.
- Optional `rateSource` returns selected provider/admin source metadata and fallback/rejected-provider reason visibility.
- `appliedRate` source is fresh `provider_api` USD/KRW first by `korea_exim_exchange_rate`, then `exchange_rate_api`; quote can still use the existing `admin_manual` fallback when provider rows are unavailable or stale.
- Missing eligible provider and manual snapshots return `FX_RATE_UNAVAILABLE`.
- Selected provider snapshot older than 300 seconds by `capturedAt`, or selected manual snapshot older than 60 seconds by `effectiveAt`, returns `FX_RATE_STALE` only when no safe fallback is available.
- Quote metadata stores only public-safe source decision fields; raw provider payloads and secrets are not stored in quote metadata.
- Execute after durable quote expiry returns `QUOTE_EXPIRED`.

### Quote Balance Error

```json
{
  "success": false,
  "error": {
    "code": "INSUFFICIENT_BALANCE",
    "message": "Cash wallet balance is insufficient."
  }
}
```

The response does not expose wallet ids, balances, private ledger rows, tokens, secrets, or raw provider payloads.

## POST /api/v1/fx/execute

### Purpose

Execute KRW/USD exchange, update cash wallets, create `exchange_transactions`, and create source/target `wallet_transactions` rows according to this API contract.

### Request Shape

```json
{
  "quoteId": "<string>",
  "fromCurrency": "KRW | USD",
  "toCurrency": "USD | KRW",
  "sourceAmount": "<amount string>",
  "idempotencyKey": "<string>"
}
```

- `quoteId` and `idempotencyKey` are required for new mutations.
- FX execute idempotency `requestHash` includes the trimmed `quoteId` together with user, participant, currency pair, and normalized `sourceAmount`.
- Existing idempotency replay is checked before quote validation, so a duplicate completed command can return the stored response without consuming a quote again.
- Same `userId + idempotencyKey + quoteId + request fields` can replay a stored successful response. Same `userId + idempotencyKey` with a different `quoteId` returns `IDEMPOTENCY_CONFLICT` and must not replay the previous response.
- `fromCurrency`, `toCurrency`, and `sourceAmount` must match the stored quote requestHash and fields.

### Execute-Time Snapshot Selection

- Execute selects the FX snapshot at execute time.
- Selection target:
  - pair USD/KRW
  - `sourceType = provider_api`
  - `sourceName = korea_exim_exchange_rate` first, then `exchange_rate_api`
  - `capturedAt <= executeNow`
  - `effectiveAt <= executeNow`
  - `executeNow - capturedAt <= 60_000ms`
  - positive `rate`
- Default `admin_manual` fallback is forbidden, and emergency manual override must be a separate operator override gate.
- Selection ordering:
  1. `effectiveAt desc`
  2. `capturedAt desc`
  3. `createdAt desc`
- No eligible provider snapshot returns `PROVIDER_RATE_UNAVAILABLE`.
- Selected/rejected provider snapshot with `executeNow - capturedAt > 60_000ms` returns `PROVIDER_RATE_STALE`.
- Exactly `60_000ms` is accepted.
- Future `effectiveAt` snapshots are ignored.
- Selected snapshot id maps to `exchange_transactions.fxRateSnapshotId`, and selected `rate` is stored as `appliedRate`.
- Snapshot selection/freshness failure must happen before wallet mutation.
- If `abs(executeRate - quotedRate) / quotedRate * 10000 > quote.maxChangeBps`, execute returns `RATE_CHANGED_REQUOTE_REQUIRED`.

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
    "grossTargetAmount": "<amount string>",
    "feeRate": "<decimal string>",
    "feeAmount": "<amount string>",
    "feeCurrency": "USD",
    "appliedRate": "<decimal string>",
    "quoteId": "<string>",
    "quotedRate": "<decimal string>",
    "executeRate": "<decimal string>",
    "rateChangeBps": "<bps string>",
    "rateSource": {
      "sourceType": "provider_api",
      "sourceName": "korea_exim_exchange_rate",
      "snapshotId": "<string>",
      "effectiveAt": "<UTC ISO string>",
      "capturedAt": "<UTC ISO string>",
      "fallbackUsed": false
    },
    "idempotencyKey": "<string>",
    "netTargetAmount": "<amount string>",
    "sourceWalletId": "<string>",
    "targetWalletId": "<string>",
    "sourceWalletBalanceAfter": "<amount string>",
    "targetWalletBalanceAfter": "<amount string>",
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
- `/fx execute` response exposes that value as `appliedRate`, `quotedRate`, and `executeRate` according to the quote/execute context.
- Records exchanges mapping keeps `appliedRate`.
- `exchangeId` maps to `exchange_transactions.id`.
- `wallets.KRW` and `wallets.USD` are post-execute wallet balances.
- Existing compatibility fields `sourceWalletId`, `targetWalletId`, `sourceWalletBalanceAfter`, and `targetWalletBalanceAfter` remain present.
- `wallets.KRW` and `wallets.USD` are returned for both KRW -> USD and USD -> KRW success responses, including idempotency replay of stored successful responses.
- Failed or rolled-back execute responses do not return success-shaped `wallets`.
- `rateCapturedAt` maps to the selected snapshot `capturedAt`.
- `rateEffectiveAt` maps to the selected snapshot `effectiveAt`.

### Execute Error Codes

- `UNAUTHORIZED`
- `SEASON_NOT_FOUND`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `QUOTE_REQUIRED`
- `QUOTE_NOT_FOUND`
- `QUOTE_NOT_ACTIVE`
- `QUOTE_EXPIRED`
- `QUOTE_MISMATCH`
- `PROVIDER_RATE_UNAVAILABLE`
- `PROVIDER_RATE_STALE`
- `RATE_CHANGED_REQUOTE_REQUIRED`
- `INSUFFICIENT_BALANCE`
- `FX_RATE_UNAVAILABLE`
- `FX_RATE_STALE`
- `IDEMPOTENCY_REQUIRED`
- `IDEMPOTENCY_CONFLICT`
- `CONFLICT`
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
- `/fx execute` lifecycle code is implemented.

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
- Cons: command recovery tooling for stale pending rows remains future hardening work.

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
- This is the implemented approach.

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
- Treat zero affected rows as `INSUFFICIENT_BALANCE` or public `CONFLICT` depending on the observed state.
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

- Durable Quote provider execute is open only for fresh `provider_api` USD/KRW rows.
- Korea EXIM exchange is the preferred MVP FX provider; ExchangeRate-API remains the fallback provider. OANDA and Twelve Data are historical research candidates only.
- `official_batch`, scheduler ingestion, and default `admin_manual` fallback are not execute sources.
- `admin_manual` remains bootstrap/fallback/manual correction for quote/read paths only.
- `official_batch` is not a real-time execute source; it remains settlement/reference/reconciliation candidate.
- Near-term execute uses explicit allowed sourceType eligibility, not implicit priority.
- Current allowed execute sourceType: fresh eligible `provider_api` only.
- Automatic fallback is forbidden for MVP.
- Approved `admin_manual` snapshots used for quote/read smoke must not be fake/static/temporary/sample/test business FX rate data.

## Equity Snapshots

- `/fx execute` creates an `exchange_executed` `equity_snapshots` row inside the ledger transaction and triggers current ranking refresh after the ledger transaction.
- Authoritative total equity snapshots require positions, asset price snapshots, and FX snapshot evidence together.
- Ranking refresh failure after `/fx execute` is logged and must not roll back the successful financial ledger transaction.

## Implementation Gate Checklist

- Quote status:
  - `/fx quote` implementation is complete.
  - `/fx quote` persists durable quotes.
  - `quoteId`, `expiresAt`, and `maxChangeBps` are returned.
  - `rateCapturedAt` and `rateEffectiveAt` are included.
  - `FX_RATE_UNAVAILABLE` and `FX_RATE_STALE` are distinguished.
- Execute implementation gate:
  - `/fx execute` Durable Quote provider-backed MVP is implemented.
  - Wallet safety proof must be verified with tests.
  - `provider_api` is the required execute source.
  - `admin_manual` and `official_batch` are not default execute sources.
- `/home` live valuation has a separate read-only provider eligibility rule; settled/final result still does not use live provider rows.
