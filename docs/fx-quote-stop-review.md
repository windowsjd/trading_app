# FX Quote STOP Review

## Status
- This document is the final pre-implementation STOP review for `/fx quote`.
- `/fx quote` read-only implementation is completed according to this review.
- This is documentation only.
- Do not implement `/fx quote`, `/fx execute`, `/wallets`, `/orders`, `/records`, `/home`, admin APIs, or CLI scripts from this document.
- Do not add Prisma schema changes, migrations, seed changes, Prisma Client generate, package changes, fake FX rates, static FX rates, or temporary FX rates from this document.

## Purpose
- Decide whether `/fx quote` read-only implementation can proceed.
- Finalize stale threshold policy for MVP quote.
- Finalize the `fx_rate_snapshots` selection rule at implementation level.
- Reconfirm implementation non-goals and forbidden write behavior.
- List the remaining blockers immediately before implementation.

## Current Premises
- `fx_rate_snapshots` schema and migration are created and applied locally.
- Prisma Client generate, build, test, and e2e verification passed.
- `docs/fx-rate-input-path-plan.md` defines `admin_manual` as the MVP rate input path candidate.
- There is still no rate input implementation.
- There is still no `/fx quote` implementation.
- There is still no `/fx execute` implementation.
- Fake, static, and temporary FX rates are forbidden.

## Quote Implementation Scope

`/fx quote` may be implemented only as a read-only API.

Allowed:
- Validate active season joined state.
- Validate `fromCurrency`, `toCurrency`, and `sourceAmount`.
- Read `fx_rate_snapshots`.
- Read the current season `fxFeeRate`.
- Calculate `grossTargetAmount`, `feeAmount`, and `netTargetAmount`.
- Return the quote response.

Forbidden:
- Wallet mutation.
- `exchange_transactions` creation.
- `wallet_transactions` creation.
- `fx_execute_requests` creation.
- `equity_snapshots` creation.
- Fake, static, or temporary fallback rate usage.
- `/fx execute` implementation.

DB write policy:
- MVP `/fx quote` must not write to the database.
- Quote request logging is deferred even if it becomes useful later.
- There is no durable quote table yet.
- `quoteId` and `expiresAt` should be `null` for MVP quote.

## Snapshot Selection Rule

Implementation-level rule:
- Query `fx_rate_snapshots` where:
  - `baseCurrency = USD`
  - `quoteCurrency = KRW`
  - `effectiveAt <= now`
- Order by:
  - `effectiveAt desc`
  - `capturedAt desc`
  - `createdAt desc`
- Take 1 row.
- If no row exists, return `FX_RATE_UNAVAILABLE`.

Both supported quote directions use the same USD/KRW snapshot:
- `rate` means KRW per 1 USD.
- KRW -> USD: `grossTargetAmount = sourceAmount / rate`.
- USD -> KRW: `grossTargetAmount = sourceAmount * rate`.

## Stale Threshold Decision

Candidates:
- 60 seconds: strong freshness, but too strict for manual input.
- 5 minutes: still too strict without provider or batch automation.
- 1 hour: more tolerant, but can still reject valid manually approved MVP rates.
- Current day: closer to manual operation, but needs business-day/time-zone policy.
- MVP no-threshold: use latest eligible `effectiveAt <= now` snapshot.

Recommended MVP decision:
- Start MVP `/fx quote` with no-threshold.
- Reason: with `admin_manual` input, the important condition is that an approved latest snapshot exists, not second-level freshness.
- Reason: without `provider_api` or `official_batch` automation, 60-second or 5-minute thresholds can make normal manual operation return `FX_RATE_UNAVAILABLE` too often.
- Reason: no-threshold can still be transparent if the response includes rate timestamps.

Required constraints:
- No-threshold does not allow fake/static/temporary fallback.
- No eligible snapshot still returns `FX_RATE_UNAVAILABLE`.
- Revisit stale threshold when `provider_api` or `official_batch` is introduced.
- Order execution, settlement, ranking, and valuation freshness need separate policies.

## Request Shape

Implementation standard:

```json
{
  "fromCurrency": "KRW | USD",
  "toCurrency": "USD | KRW",
  "sourceAmount": "<amount string>"
}
```

Use `sourceAmount`.
Do not introduce a request field named `amount`.

## Response Shape

Recommended success response:

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

Response decisions:
- `quoteId` should be `null` because there is no durable quote table.
- `expiresAt` should be `null` because stale threshold and quote expiry are not active in MVP quote.
- Include `rateCapturedAt`.
- Include `rateEffectiveAt`.
- Reason: no-threshold quote needs transparent rate timing for users and debugging.

## Error Codes

Required implementation codes:
- `UNAUTHORIZED`
- `SEASON_NOT_FOUND`
- `SEASON_NOT_ACTIVE`
- `SEASON_NOT_JOINED`
- `INVALID_CURRENCY_PAIR`
- `INVALID_AMOUNT`
- `FX_RATE_UNAVAILABLE`
- `INTERNAL_ERROR`

Reserved future code:
- `FX_RATE_STALE`
- Not used while MVP quote uses no-threshold.
- Use when a stale threshold policy is introduced later.

Common error envelope:

```json
{
  "success": false,
  "error": {
    "code": "<string>",
    "message": "<string>"
  }
}
```

## Remaining Pre-Implementation Checks
- Confirm whether no-threshold is accepted for MVP quote.
- Confirm `rateCapturedAt` and `rateEffectiveAt` response fields with frontend.
- Confirm Decimal rounding and display scale for quote calculations.
- Confirm `fxFeeRate` source from the active season.
- Confirm no quote request persistence in MVP.

## Final Decision
- `/fx quote` read-only implementation can proceed after this STOP review is accepted.
- `/fx quote` implementation must not include execute, wallet mutation, ledger writes, or fake fallback.
- `/fx execute` remains STOP.
- Rate input implementation is still needed to get successful quote responses.
- Without snapshot data, `/fx quote` returns `FX_RATE_UNAVAILABLE`.
